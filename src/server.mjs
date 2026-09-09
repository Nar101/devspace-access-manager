import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {BASE,ROOT,ACCESS,ACTIVE,JOURNAL,SESSION} from './paths.mjs';
import {readJSON,atomicJSON,loadActive} from './store.mjs';
import {canonicalFolder,propose} from './policy.mjs';
import {Supervisor} from './supervisor.mjs';
import {Transactions} from './transactions.mjs';
import {Assistant} from './assistant.mjs';
import {cliSnapshot,cliSetEnabled} from './cli-management.mjs';
const require=createRequire(path.join(BASE,'app/package.json'));
let express;
try {express=require('express');} catch(error) {
  if(error.code!=='MODULE_NOT_FOUND')throw error;
  express=createRequire(import.meta.url)('express');
}
const run=promisify(execFile);
const token=()=>crypto.randomBytes(32).toString('base64url');
const equal=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.length===b.length&&crypto.timingSafeEqual(Buffer.from(a),Buffer.from(b));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
export function createManager({port=7678,supervisor=new Supervisor(),transactions=new Transactions(supervisor),picker,assistant=new Assistant({supervisor}),clock=Date.now,idleMs=900000,idleSweepMs=10000,onIdle=()=>process.exit(0)}={}) {
  const app=express(), origin='http://127.0.0.1:'+port;
  const sessions=new Map(), launches=new Map(), previews=new Map();
  const launchSecret=token();
  let controlOperation=null;
  let lastActivity=clock(), picking=false, pickerAbort=null, operation=null, server, idleTimer;
  app.disable('x-powered-by');
  app.use((req,res,next)=>{
    res.set({
      'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY',
      'Referrer-Policy':'no-referrer',
      'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
    });
    if(req.headers.host!=='127.0.0.1:'+port)return res.status(403).json({error:'不允许的访问来源'});
    if(req.headers.origin&&req.headers.origin!==origin)return res.status(403).json({error:'拒绝跨站请求'});
    if(req.headers['sec-fetch-site']==='cross-site')return res.status(403).json({error:'拒绝跨站请求'});
    next();
  });
  app.use(express.json({limit:'8kb',strict:true}));
  app.get('/health',(_,res)=>res.json({name:'devspace-access-manager',version:1}));
  app.post('/internal/launch',(req,res)=>{
    if(!equal(req.headers['x-launch-secret'],launchSecret))return res.status(403).json({error:'未授权'});
    const nonce=token();launches.set(nonce,clock()+60000);lastActivity=clock();
    res.json({url:origin+'/#launch='+nonce});
  });
  app.post('/api/session',(req,res)=>{
    if(req.headers.origin!==origin)return res.status(403).json({error:'拒绝请求'});
    const nonce=req.body?.token, expires=launches.get(nonce);
    if(!expires||expires<clock())return res.status(401).json({error:'请重新双击启动管理页'});
    launches.delete(nonce);
    const id=token(),csrf=token();sessions.set(id,{csrf,expires:clock()+900000});lastActivity=clock();
    // Expire pre-upgrade cookies; management credentials are never ambient.
    res.setHeader('Set-Cookie','dsa_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    res.json({accessToken:id,csrf});
  });
  app.use('/api',(req,res,next)=>{
    const id=req.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/i)?.[1];
    const session=sessions.get(id);
    if(!session||session.expires<clock())return res.status(401).json({error:'管理会话已结束，请重新双击启动'});
    if(req.method!=='GET') {
      if(req.headers.origin!==origin || !req.is('application/json') || !equal(req.headers['x-csrf-token'],session.csrf))
        return res.status(403).json({error:'请求校验失败，请重新打开管理页'});
      lastActivity=clock();session.expires=clock()+900000;
    }
    req.managerSession=session;next();
  });
  app.get('/api/session',(req,res)=>res.json({csrf:req.managerSession.csrf}));
  app.get('/api/cli',async(req,res,next)=>{try{res.json(await cliSnapshot());}catch(e){next(e);}});
  app.post('/api/cli/enabled',async(req,res,next)=>{try{res.json(await cliSetEnabled(req.body?.enabled));}catch(e){next(e);}});
  app.post('/api/cli/refresh',async(req,res,next)=>{try{res.json(await cliSnapshot({refresh:true}));}catch(e){next(e);}});
  app.get('/api/state',async(req,res,next)=>{
    try {
      const current=await loadActive(), service=await supervisor.state();
      const grants=await Promise.all(current.grants.map(async g=>{
        let available=false;try{available=(await fs.stat(g.path)).isDirectory();}catch{}
        return {...g,name:path.basename(g.path),available};
      }));
      res.json({revision:current.revision,grants,
        service:{pid:service.service.pid,tunnelPid:service.tunnel.pid,running:service.service.running,tunnelRunning:service.tunnel.running,busy:service.busy,
          generation:service.telemetry?.generation||null,loaded:service.service.loaded},
        operation,picking});
    }catch(e){next(e);}
  });
  app.get('/api/assistant',async(req,res,next)=>{try{res.json({...await assistant.snapshot(),operation:controlOperation});}catch(e){next(e);}});
  app.post('/api/assistant/action',(req,res)=>{
    if(picking||(operation&&!['done','error','cancelled'].includes(operation.phase))||controlOperation?.phase==='running')return res.status(409).json({error:'请先完成当前操作'});
    controlOperation={id:token(),createdAt:clock(),phase:'running',action:req.body?.action,message:'正在处理…'};
    res.status(202).json(controlOperation);
    void assistant.action(req.body?.action,req.body||{}).then(message=>{controlOperation.phase='done';controlOperation.message=message;}).catch(e=>{controlOperation.phase='error';controlOperation.message=e.message;}).finally(()=>{lastActivity=clock();});
  });
  app.post('/api/activity',(_,res)=>res.json({ok:true}));
  app.post('/api/pick-folder',async(req,res,next)=>{
    if(controlOperation?.phase==='running'||picking||operation&&!['done','error','cancelled'].includes(operation.phase))return res.status(409).json({error:'请先完成当前操作'});
    picking=true;
    pickerAbort=new AbortController();
    try {
      const selected=picker?await picker({signal:pickerAbort.signal}):JSON.parse((await run(path.join(ROOT,'bin/folder-picker'),[],{timeout:300000,maxBuffer:16384,signal:pickerAbort.signal})).stdout);
      if(selected.cancelled)return res.json({cancelled:true});
      const real=await canonicalFolder(selected.path);
      res.json({cancelled:false,path:real,name:path.basename(real)});
    }catch(e){if(e.name==='AbortError')res.json({cancelled:true});else next(e);}finally{picking=false;pickerAbort=null;lastActivity=clock();}
  });
  app.post('/api/cancel-picker',(_,res)=>{pickerAbort?.abort();res.json({ok:true});});
  app.post('/api/preview',async(req,res,next)=>{
    try {
      const {action,path:input,id,mode='rw',revision}=req.body||{};
      const current=await loadActive();
      if(revision!==current.revision)return res.status(409).json({error:'授权列表已变化，请刷新后重试'});
      const selected=action==='add'?await canonicalFolder(input):id;
      const proposal=propose(current.grants,action,selected,mode);
      const previewId=token();
      previews.set(previewId,{...proposal,action,baseRevision:current.revision,expires:clock()+300000});
      res.json({previewId,action,target:proposal.target,merged:proposal.removed});
    }catch(e){next(e);}
  });
  async function applyJob(plan) {
    try {
      const draining=path.join(ACCESS,'drain.json');
      await atomicJSON(draining,{requestedAt:clock()});
      try {
        while(!operation.force) {
          if(operation.cancel){operation.phase='cancelled';operation.message='已取消，原授权未改变';return;}
          const state=await supervisor.state();
          if(!state.busy)break;
          operation.phase='waiting';operation.message='正在等待当前任务结束';await delay(750);
        }
        // Re-resolve selected roots immediately before compiling; never trust a stale picker path.
        for(const g of plan.grants) {
          const old=(await loadActive()).grants.find(x=>x.id===g.id&&x.mode===g.mode);
          if(!old && await canonicalFolder(g.path)!==g.path)throw new Error('目录目标已经变化，请重新选择');
        }
        await transactions.apply(plan,(phase,message)=>{operation.phase=phase;operation.message=message;});
      }finally{await fs.rm(draining,{force:true});}
    }catch(e){operation.phase='error';operation.message=e.message;}
    finally{lastActivity=clock();}
  }
  app.post('/api/apply',(req,res)=>{
    if(controlOperation?.phase==='running'||picking||operation&&!['done','error','cancelled'].includes(operation.phase))return res.status(409).json({error:'请先完成当前操作'});
    const plan=previews.get(req.body?.previewId);
    if(!plan||plan.expires<clock())return res.status(409).json({error:'确认已过期，请重新选择'});
    previews.delete(req.body.previewId);
    operation={id:token(),phase:'queued',message:'准备应用授权',force:false,cancel:false};
    res.status(202).json({operation});
    void applyJob(plan);
  });
  app.post('/api/operation',(req,res)=>{
    if(!operation||operation.id!==req.body?.id||!['waiting','queued'].includes(operation.phase))
      return res.status(409).json({error:'当前操作已进入应用阶段'});
    if(req.body.action==='interrupt')operation.force=true;
    else if(req.body.action==='cancel')operation.cancel=true;
    else return res.status(400).json({error:'操作无效'});
    res.json({ok:true});
  });
  const publicDir=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../public');
  app.use(express.static(publicDir,{dotfiles:'deny',index:'index.html',redirect:false}));
  app.use((err,req,res,next)=>{
    // Errors never include request bodies, credentials, or stack traces.
    res.status(err.type==='entity.too.large'?413:400).json({error:err.message||'操作失败，请重试',inherited:err.inherited||undefined});
  });
  return {
    app,launchSecret,origin,
    async start(){
      await transactions.recover();
      await fs.rm(path.join(ACCESS,'drain.json'),{force:true});
      server=await new Promise((resolve,reject)=>{const s=app.listen(port,'127.0.0.1',()=>resolve(s));s.once('error',reject);});
      await atomicJSON(SESSION,{pid:process.pid,port,launchSecret,startedAt:clock()});
      idleTimer=setInterval(async()=>{
        const busy=controlOperation?.phase==='running'||picking||operation&&!['done','error','cancelled'].includes(operation.phase);
        if(!busy&&clock()-lastActivity>idleMs){clearInterval(idleTimer);await this.close();onIdle();}
        for(const [id,e] of launches)if(e<clock())launches.delete(id);
        for(const [id,p] of previews)if(p.expires<clock())previews.delete(id);
        for(const [id,s] of sessions)if(s.expires<clock())sessions.delete(id);
      },idleSweepMs);idleTimer.unref();
      return server;
    },
    async close(){
      clearInterval(idleTimer);
      if(server)await new Promise(r=>server.close(r));
      try{if((await readJSON(SESSION)).pid===process.pid)await fs.rm(SESSION);}catch{}
    }
  };
}
if(process.argv[1]===fileURLToPath(import.meta.url)) {
  const manager=createManager();
  manager.start().catch(e=>{console.error('目录管理页启动失败：'+e.message);process.exit(1);});
  process.once('SIGTERM',()=>manager.close().then(()=>process.exit(0)));
}

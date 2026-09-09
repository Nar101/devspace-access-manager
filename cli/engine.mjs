import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {DIR,SETTINGS,HOME,BASE,json,save,hash,fail,id,redact} from './common.mjs';
import {verified,inventory,skills,readSkill} from './registry.mjs';
import {schema,validate,commandParts} from './schema.mjs';
import {execute} from './process.mjs';
export class Engine{
 constructor({run=execute,verify=verified,describe=schema,root=DIR,onSpawn=()=>{}}={}){Object.assign(this,{run,verify,describeSchema:describe,root,onSpawn});this.controllers=new Map();this.preparing=new Set();this.serial=Promise.resolve();this.calls=[];}
 async init(){
  await fs.mkdir(path.join(this.root,'jobs'),{recursive:true,mode:0o700});
  for(const name of await fs.readdir(path.join(this.root,'jobs'))){if(!name.endsWith('.json'))continue;const p=path.join(this.root,'jobs',name),j=await json(p);if(['running','queued'].includes(j.status)){j.status=j.effect==='read'?'interrupted':'needs_reconciliation';j.message='服务重启中断了结果回报；写入可能已发生，请先回读业务对象。';await save(p,j);}}
 }
 async enabled(){const p=await json(SETTINGS,{enabled:true});if(p.enabled===false)fail('disabled','CLI 接入已在本机暂停');if(await fs.stat(path.join(BASE,'config/access/drain.json')).catch(()=>null))fail('draining','文件夹授权正在切换，暂不启动新 CLI 任务');}
 async identity(entry,task){
  let identity,binding;
  if(entry.id==='dws'){
   const r=await this.run(entry,['profile','list','--format=json']);const list=r.data?.profiles?.filter(x=>x.isOrgCurrent);if(r.status!=='completed')fail('identity_unavailable','钉钉身份读取失败：'+r.stderr);if(list?.length!==1)fail('identity_ambiguous','钉钉当前组织缺失或不唯一');if(list[0].status!=='active')fail('identity_unavailable','钉钉当前组织存在，但登录凭据未能使用；请检查本机诊断。');
   identity=list[0].profile;binding={profile:identity,organization:list[0].corpName};
  }else if(entry.id==='lark-cli'){
   const r=await this.run(entry,['profile','list']);const list=Array.isArray(r.data)?r.data.filter(x=>x.active&&x.effective):[];if(r.status!=='completed'||list.length!==1)fail('identity_ambiguous','飞书当前账号缺失或不唯一，请在本机确认');
   identity=JSON.stringify({name:list[0].name,user:list[0].user,appId:list[0].appId});binding={profile:list[0].name,user:list[0].user};
  }else if(entry.id==='heptabase'){
   // Bind the CLI's own authentication session. The CLI does not expose a stable account ID.
   try{identity=hash(await fs.readFile(path.join(HOME,'.heptabase/local-server-token')));}catch{fail('app_unavailable','Heptabase 本地 CLI 服务尚未就绪');}
   binding={scope:'current_desktop_session',limitation:'CLI 不提供稳定账号 ID；会话变化会停止任务，写入需先确认目标对象。'};
  }else return {binding:{scope:'authorized_local_folders'}};
  const p=path.join(this.root,'bindings',task+'-'+entry.id+'.json'),previous=await json(p,null),digest=hash(identity);
  if(previous&&previous.digest!==digest)fail('identity_changed','此任务绑定的账号或桌面会话已变化；停止执行，请核对原目标与当前身份。');
  if(!previous)await save(p,{digest,binding});return {binding,identity};
 }
 async describe(a){await this.enabled();const e=await this.verify(a.cli);return {cli:a.cli,...await this.describeSchema(e,a.command||[])};}
 async submit(a){
  await this.enabled();
  if(!id(a.requestId)||!id(a.taskId))fail('invalid_request_id','requestId 与 taskId 必须为稳定、至少 8 位的字母数字标识');
  const digest=hash(JSON.stringify({cli:a.cli,command:a.command||[],parameters:a.parameters||{},positional:a.positional||[],taskId:a.taskId,authorizedWrite:a.authorizedWrite===true}));
  const p=path.join(this.root,'jobs',a.requestId+'.json');
  const old=await json(p,null);if(old){if(old.digest!==digest)fail('request_conflict','同一 requestId 的内容发生变化，已拒绝重复执行');return {...old,replayed:true};}
  if(this.preparing.has(a.requestId))fail('preparing','相同请求正在校验，请查询原 requestId');
  if(this.controllers.size+this.preparing.size>=4)fail('rate_limited','最多同时处理 4 个 CLI 任务');
  this.calls=this.calls.filter(t=>t>Date.now()-60000);if(this.calls.length>=30)fail('rate_limited','CLI 请求过于频繁，请稍后继续');this.calls.push(Date.now());
  this.preparing.add(a.requestId);
  try{
   const entry=await this.verify(a.cli);let plan;
   if(entry.provider==='local'){
    const args=a.parameters?.argv;
    if(Object.keys(a.parameters||{}).some(k=>!['argv','stdin'].includes(k)))fail('invalid_arguments','本地工具只接受 argv 和可选文本 stdin');
    if(!Array.isArray(args)||args.length>100||args.some(x=>typeof x!=='string'||x.includes('\0')||x.length>100000))fail('invalid_argv','本地工具使用 parameters.argv 字符串数组');
    const stdin=a.parameters?.stdin??'';if(typeof stdin!=='string'||stdin.length>100000||stdin.includes('\0'))fail('invalid_stdin','stdin 只接受有限大小的文本');
    const effect=['rg','jq','ffprobe','sleep','cat','wc','head','tail'].includes(entry.id)?'read':'unknown';
    if(effect!=='read'&&!a.authorizedWrite)fail('write_authorization_required','此本地命令可能修改文件，需要用户当前任务授权');
    plan={args,stdin,effect};
   }else{
    commandParts(a.command||[]);plan=validate(entry,await this.describeSchema(entry,a.command||[]),a.command||[],a.parameters||{},a.positional||[],a.authorizedWrite===true);
   }
   const who=await this.identity(entry,a.taskId);
   if(entry.id==='heptabase'&&plan.effect!=='read'){
    const target=a.parameters?.['parent-whiteboard-id']||a.parameters?.['whiteboard-id']||a.parameters?.input?.whiteboardId||a.positional?.[0];
    const anchors=await json(path.join(this.root,'anchors',a.taskId+'.json'),[]);
    if(typeof target!=='string'||!anchors.includes(target))fail('unbound_write_target','Heptabase 写入必须指向本任务已读取的明确对象；新建白板请指定已读取的父白板。CLI 未提供稳定账号/空间 ID，暂不开放写入默认空间。');
   }
   if(entry.id==='dws')plan.args.push('--profile='+who.binding.profile,'--format=json',...(plan.effect!=='read'?['--yes']:[]));
   if(entry.id==='lark-cli')plan.args.push('--profile='+who.binding.profile,'--as=user');
   const job={requestId:a.requestId,taskId:a.taskId,cli:a.cli,command:a.command||[],digest,effect:plan.effect,identity:who.binding,status:'queued',createdAt:new Date().toISOString()};
   await save(p,job);const controller=new AbortController();this.controllers.set(a.requestId,controller);
   const work=async()=>{
    try{
     await this.enabled();await this.verify(a.cli);await this.identity(entry,a.taskId);
     if(controller.signal.aborted)fail('cancelled','任务在执行前已取消');
     job.status='running';await save(p,job);
     const r=await this.run(entry,plan.args,{stdin:plan.stdin,signal:controller.signal,onSpawn:this.onSpawn});
     job.result=r;job.status=r.status;
     if(r.status!=='completed'&&plan.effect!=='read')job.status='needs_reconciliation';
     await this.identity(entry,a.taskId);
     if(r.status==='completed'&&(r.data?.ok===false||r.data?.success===false||r.data?.status==='failed'||r.data?.isError===true))job.status='business_failed';
     job.verification=plan.effect==='read'?'inspect_pagination_and_partial_results':'read_back_business_object_before_claiming_success';
     if(entry.id==='heptabase'&&plan.effect==='read'&&r.status==='completed'){
      const p=path.join(this.root,'anchors',a.taskId+'.json'),anchors=new Set(await json(p,[]));
      const collect=v=>{if(Array.isArray(v))v.forEach(collect);else if(v&&typeof v==='object')for(const [k,x]of Object.entries(v)){if(/^(id|whiteboardId|cardId)$/.test(k)&&typeof x==='string'&&/^[a-f\d-]{36}$/i.test(x))anchors.add(x);else if(typeof x==='object')collect(x);}};collect(r.data);await save(p,[...anchors].slice(-5000));
     }
    }catch(e){job.status=job.status==='running'&&plan.effect!=='read'?'needs_reconciliation':e.code||'failed';job.error=redact(e.message);}
    finally{job.finishedAt=new Date().toISOString();await save(p,job);this.controllers.delete(a.requestId);}
   };
   // Serialize business writes, including requests queued by different MCP sessions.
   if(plan.effect==='read')void work();else{this.serial=this.serial.then(work,work);}
   return job;
  }finally{this.preparing.delete(a.requestId);}
 }
 async result(requestId){if(!id(requestId))fail('invalid_request_id','请求 ID 无效');const j=await json(path.join(this.root,'jobs',requestId+'.json'),null);if(!j)fail('not_found','请求不存在，不能视为执行成功');return j;}
 async dispatch(method,a={}){
  if(method==='discover'){
   await this.enabled();const offset=a.offset??0,limit=a.limit??30;
   if(!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>100||a.query!==undefined&&typeof a.query!=='string')fail('invalid_pagination','查询或分页参数无效');
   let all;if(a.kind==='skills')all=await skills();else{const x=await inventory();all=[...x.entries,...x.discovered];}
   if(a.query)all=all.filter(x=>(x.id+' '+(x.description||'')).toLowerCase().includes(a.query.toLowerCase()));
   return {items:all.slice(offset,offset+limit),offset,limit,total:all.length,hasMore:offset+limit<all.length,nextOffset:offset+limit<all.length?offset+limit:null,defaults:'已核对的 CLI 自动可用；未知来源不执行。业务写入仍需用户当前明确授权。'};
  }
  if(method==='describe')return this.describe(a);
  if(method==='skill'){await this.enabled();return readSkill(a.id,a.relative);}
  if(method==='run')return this.submit(a);
  if(method==='result')return this.result(a.requestId);
  if(method==='cancel'){this.controllers.get(a.requestId)?.abort();return this.result(a.requestId);}
  fail('unknown_method','未知 CLI 操作');
 }
 stop(){for(const c of this.controllers.values())c.abort();}
}

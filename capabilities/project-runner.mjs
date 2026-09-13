import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {agentPolicy,digest,snapshot} from './policy.mjs';

export function registryPackages(lock){
 if(![2,3].includes(lock.lockfileVersion)||!lock.packages||Object.keys(lock.packages).length>1500)throw Error('需要npm第2或3版锁定清单，最多1500个依赖');
 const urls=new Set();for(const [name,p] of Object.entries(lock.packages)){if(!name)continue;
  if(!name.startsWith('node_modules/')||name.split('/').some(x=>x==='..'||x==='.')||p.link||p.inBundle)throw Error('暂不支持本地、链接或内嵌依赖');
  let u;try{u=new URL(p.resolved);}catch{throw Error('依赖必须有固定下载地址');}
  if(u.protocol!=='https:'||u.hostname!=='registry.npmjs.org'||u.port||u.username||u.password||u.search||u.hash||!/^\/[A-Za-z0-9@_./%+-]+\.tgz$/.test(u.pathname)||!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(p.integrity||''))throw Error('仅支持npm官方仓库且带sha512校验的依赖');urls.add(u.pathname);
 }return urls;
}
async function registry(urls){
 let total=0,calls=0;const children=new Set();const server=http.createServer((req,res)=>{
  if(req.method!=='GET'||!urls.has(req.url)||++calls>3000){res.writeHead(403).end();return;}
  const c=spawn('/usr/bin/curl',['-q','--fail','--silent','--show-error','--max-time','90','--max-filesize','50000000','https://registry.npmjs.org'+req.url],{env:{PATH:'/usr/bin:/bin'},stdio:['ignore','pipe','pipe']});children.add(c);c.stderr.resume();c.stdout.on('data',b=>{total+=b.length;if(total>250000000){c.kill();res.destroy();}else res.write(b);});c.on('error',()=>res.destroy());c.on('close',code=>{children.delete(c);if(code)res.destroy();else res.end();});res.on('close',()=>{if(!res.writableFinished)c.kill();});
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));return {port:server.address().port,close:async()=>{for(const c of children)c.kill();server.closeAllConnections();await new Promise(r=>server.close(r));}};
}
export async function projectCommand({root,workspace,runtime,args,port=1,preview=false,signal,onSpawn=()=>{}}){
 const node=runtime?.node||process.execPath;if(runtime?.hashes?.[node]&&digest(await fs.readFile(node))!==runtime.hashes[node])throw Error('Node运行程序已改变');
 const nodeRoot=path.dirname(path.dirname(node)),npm=path.join(nodeRoot,'lib/node_modules/npm/bin/npm-cli.js');await fs.access(npm);
 const home=path.join(root,'project-home'),tmp=path.join(root,'project-tmp'),sb=path.join(root,'project-policy.sb');await fs.mkdir(home,{recursive:true});await fs.mkdir(tmp,{recursive:true});
 await fs.writeFile(path.join(home,'user.npmrc'),'');await fs.writeFile(path.join(home,'global.npmrc'),'');
 await fs.writeFile(sb,agentPolicy({workspace,home,tmp,binary:node,readRoots:[nodeRoot],proxyPort:port})+(preview?'\n(allow network-bind network-inbound (local tcp '+JSON.stringify('localhost:'+port)+'))\n':''));
 const env={HOME:home,PATH:path.dirname(node)+':/usr/bin:/bin',TMPDIR:tmp,LANG:'en_US.UTF-8',CI:'1',PORT:String(port),HOST:'127.0.0.1',HOSTNAME:'127.0.0.1',npm_config_userconfig:path.join(home,'user.npmrc'),npm_config_globalconfig:path.join(home,'global.npmrc'),npm_config_cache:path.join(home,'cache'),npm_config_ignore_scripts:'true',npm_config_audit:'false',npm_config_fund:'false',npm_config_update_notifier:'false',npm_config_fetch_retries:'0'};
 return new Promise(resolve=>{let output='',bytes=0,reason,previewEvidence,probe;let probing=false,closed=false;const c=spawn('/usr/bin/python3',['-I',fileURLToPath(new URL('./resource-wrapper.py',import.meta.url)),'/usr/bin/sandbox-exec','-f',sb,node,npm,...args],{cwd:workspace,env,detached:true,stdio:['ignore','pipe','pipe']});onSpawn(c.pid);const stop=r=>{reason??=r;try{process.kill(-c.pid,'SIGKILL');}catch{}};const abort=()=>stop('cancelled');signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();const timer=setTimeout(()=>stop('timeout'),preview?45000:180000);if(preview)probe=setInterval(async()=>{if(probing||closed)return;probing=true;try{const response=await fetch('http://127.0.0.1:'+port,{redirect:'error',signal:AbortSignal.timeout(1000)});const reader=response.body.getReader();let body='',size=0;for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>200000){await reader.cancel();throw Error('preview too large');}body+=Buffer.from(value).toString('utf8');}if(response.status===200&&!closed){previewEvidence={status:200,title:body.match(/<title>([^<]*)<\/title>/i)?.[1]||null,bodySha256:digest(body),bytes:size};stop('preview_complete');}}catch{}finally{probing=false;}},500);for(const stream of [c.stdout,c.stderr]){stream.setEncoding('utf8');stream.on('data',s=>{bytes+=Buffer.byteLength(s);if(bytes>1000000)stop('output_limit');else output+=s;});}c.on('error',()=>stop('spawn_error'));c.on('close',exitCode=>{closed=true;clearInterval(probe);clearTimeout(timer);signal?.removeEventListener('abort',abort);try{process.kill(-c.pid,'SIGKILL');}catch{}resolve({command:preview?'start':args[0]==='ci'?'install':args.at(-1),exitCode:reason==='preview_complete'?0:exitCode,reason:reason==='preview_complete'?undefined:reason,preview:previewEvidence,output});});});
}
export async function installProject(options){
 const {workspace}=options;if(await fs.access(path.join(workspace,'npm-shrinkwrap.json')).then(()=>true,()=>false))throw Error('暂不支持npm-shrinkwrap，请使用package-lock');const pkg=JSON.parse(await fs.readFile(path.join(workspace,'package.json'),'utf8'));if(pkg.workspaces)throw Error('暂不支持多工作区依赖安装');const lockPath=path.join(workspace,'package-lock.json'),original=await fs.readFile(lockPath,'utf8'),lock=JSON.parse(original);const urls=registryPackages(lock);const proxy=await registry(urls);
 try{for(const [name,p] of Object.entries(lock.packages))if(name)p.resolved='http://127.0.0.1:'+proxy.port+new URL(p.resolved).pathname;await fs.writeFile(lockPath,JSON.stringify(lock));return await projectCommand({...options,port:proxy.port,args:['ci','--ignore-scripts','--no-audit','--no-fund','--registry=http://127.0.0.1:'+proxy.port]});}finally{await fs.writeFile(lockPath,original);await proxy.close();}
}
export async function runProject(options){
 // Tests/builds may write files. Execute them on another disposable copy.
 const {root,workspace}=options,copy=path.join(root,'verification-copy');await snapshot(workspace,copy);const opts={...options,workspace:copy},steps=[];
 const install=await installProject(opts);steps.push(install);if(!install.exitCode&&!install.reason){const pkg=JSON.parse(await fs.readFile(path.join(copy,'package.json'),'utf8'));for(const script of ['test','build'])if(typeof pkg.scripts?.[script]==='string'){const step=await projectCommand({...opts,args:['run','--ignore-scripts',script]});steps.push(step);if(step.exitCode||step.reason)break;}}
 if(steps.every(s=>s.exitCode===0&&!s.reason)){const pkg=JSON.parse(await fs.readFile(path.join(copy,'package.json'),'utf8'));if(typeof pkg.scripts?.start==='string'){const holder=http.createServer();await new Promise(r=>holder.listen(0,'127.0.0.1',r));const port=holder.address().port;await new Promise(r=>holder.close(r));const args=['run','--ignore-scripts','start'];if(/^next start(?: |$)/.test(pkg.scripts.start))args.push('--','--hostname','127.0.0.1','--port',String(port));steps.push(await projectCommand({...opts,args,port,preview:true}));}}
 const passed=steps.length>1&&steps.every(s=>s.exitCode===0&&!s.reason);const report={passed,steps,scope:'npm locked dependencies; install scripts disabled; test/build and optional short-lived localhost start check; no browser acceptance'};await fs.writeFile(path.join(workspace,'devspace-verification.json'),JSON.stringify(report,null,2));return {exitCode:passed?0:1,reason:steps.find(s=>s.reason)?.reason,stderr:passed?'':'安装或验证失败，或项目没有test/build脚本',modelRequests:0,events:[{type:passed?'turn.completed':'turn.failed'},{type:'item.completed',item:{type:'agent_message',text:JSON.stringify(report)}}]};
}

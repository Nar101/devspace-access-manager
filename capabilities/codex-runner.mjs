import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {StringDecoder} from 'node:string_decoder';
import {agentPolicy,digest} from './policy.mjs';
import {startModelProxy} from './model-proxy.mjs';
export async function runCodex({root,workspace,prompt,model='gpt-6-astra',signal,onEvent=()=>{},onSpawn=()=>{},timeoutMs=600000,runtime}){
 const binary=runtime?.binary||await fs.realpath(path.join(os.homedir(),'.local/bin/codex'));
 if(runtime)for(const [file,expected] of Object.entries(runtime.hashes))if(digest(await fs.readFile(file))!==expected)throw Error('开发运行库已变化，需要本机重新核验');
 const node=runtime?.node||path.join(os.homedir(),'.local/share/devspace-air/node-v24.20.0-darwin-arm64/bin/node');
 const home=path.join(root,'home'),tmp=path.join(root,'tmp');await fs.mkdir(path.join(home,'.codex'),{recursive:true});await fs.mkdir(tmp,{recursive:true});
 const proxy=await startModelProxy({model,maxRequests:25});
 const sb=path.join(root,'policy.sb');await fs.writeFile(sb,agentPolicy({workspace,home,binary,proxyPort:proxy.port,tmp,helpers:[path.join(path.dirname(binary),'codex-code-mode-host'),node,path.join(path.dirname(node),'npm'),path.join(path.dirname(path.dirname(node)),'lib/node_modules/npm/bin/npm-cli.js')],readRoots:[path.dirname(path.dirname(node))]}),{mode:0o600});
 const args=['-f',sb,binary,'-c','model_provider="devspace"','-c','model_reasoning_effort="low"','-c','model_providers.devspace.name="DevSpace private relay"','-c',`model_providers.devspace.base_url="http://127.0.0.1:${proxy.port}/v1"`,'-c','model_providers.devspace.wire_api="responses"','-c','model_providers.devspace.env_key="DEVSPACE_AGENT_TOKEN"','-c','features.shell_snapshot=false','-c','features.multi_agent=false','app-server','--listen','stdio://'];
 const child=spawn('/usr/bin/python3',['-I',fileURLToPath(new URL('./resource-wrapper.py',import.meta.url)),'/usr/bin/sandbox-exec',...args],{cwd:workspace,detached:true,stdio:['pipe','pipe','pipe'],env:{HOME:home,CODEX_HOME:path.join(home,'.codex'),TMPDIR:tmp,PATH:path.dirname(node)+':/Library/Developer/CommandLineTools/usr/bin:/usr/bin:/bin',LANG:'en_US.UTF-8',TERM:'dumb',npm_config_ignore_scripts:'true',npm_config_audit:'false',npm_config_fund:'false',DEVSPACE_AGENT_TOKEN:proxy.nonce,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_SYSTEM:'/dev/null'}});onSpawn(child.pid);child.stdin.on('error',()=>{});
 let serial=0,buffer='',stderr='',bytes=0,reason=null,turnResolve,exitCode=null;const pending=new Map(),events=[],decoder=new StringDecoder('utf8');
 const send=x=>{if(!child.stdin.destroyed)child.stdin.write(JSON.stringify(x)+'\n');};
 const rpc=(method,params)=>new Promise((resolve,reject)=>{const id=++serial;pending.set(id,{resolve,reject});send({id,method,params});});
 const stop=r=>{reason??=r;try{process.kill(-child.pid,'SIGTERM');}catch{};const t=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}},1000);t.unref();};
 const turnDone=new Promise(r=>turnResolve=r);const abort=()=>stop('cancelled');signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();const timer=setTimeout(()=>stop('timeout'),timeoutMs);
 child.stdout.on('data',b=>{bytes+=b.length;if(bytes>2000000){stop('output_limit');return;}buffer+=decoder.write(b);let i;while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i);buffer=buffer.slice(i+1);let e;try{e=JSON.parse(line);}catch{continue;}
  if(e.id!==undefined&&!e.method){const p=pending.get(e.id);if(p){pending.delete(e.id);e.error?p.reject(Error(e.error.message)):p.resolve(e.result);}continue;}
  if(e.id!==undefined&&e.method){send({id:e.id,error:{code:-32601,message:'Interactive escalation is not exposed by this bounded runner'}});continue;}
  const p=e.params||{};if(e.method==='item/completed'){const item=p.item;const normalized={type:'item.completed',item:item?.type==='agentMessage'?{type:'agent_message',text:item.text}:item};events.push(normalized);onEvent(normalized);}
  if(e.method==='error'){events.push({type:'error',error:p.error});onEvent(events.at(-1));}
  if(e.method==='turn/completed'){events.push({type:p.turn?.status==='completed'?'turn.completed':'turn.failed',turn:p.turn});turnResolve();}
 }});
 child.stderr.on('data',b=>{stderr=(stderr+b.toString()).slice(-12000);});
 const closed=new Promise(resolve=>{child.on('error',e=>{stderr=e.message;});child.on('close',code=>{exitCode=code;for(const p of pending.values())p.reject(Error('Codex process closed'));pending.clear();turnResolve();resolve();});});
 try{
  await rpc('initialize',{clientInfo:{name:'devspace_bounded_worker',version:'0.1.0'},capabilities:{}});send({method:'initialized',params:{}});
  const t=await rpc('thread/start',{cwd:workspace,model,approvalPolicy:'never',sandbox:'read-only',ephemeral:true});
  await rpc('turn/start',{threadId:t.thread.id,input:[{type:'text',text:prompt}],approvalPolicy:'never',sandboxPolicy:{type:'externalSandbox',networkAccess:'restricted'},effort:'low'});
  await turnDone;
 }catch(e){stderr+='\n'+e.message;}finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);if(exitCode===null){try{child.stdin.end();}catch{};const t=setTimeout(()=>stop('shutdown_timeout'),2000);await closed;clearTimeout(t);}await proxy.close();}
 return {exitCode:events.some(e=>e.type==='turn.completed')?0:exitCode,reason,stderr,events,modelRequests:proxy.calls()};
}

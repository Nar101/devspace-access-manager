import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {BASE,ACCESS} from './paths.mjs';
import {atomicJSON,readJSON,acquireLock} from './store.mjs';
import {Supervisor} from './supervisor.mjs';
const run=promisify(execFile);
const stateFile=path.join(ACCESS,'connection-health.json');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export function decision(sample,previous={},now=Date.now(),manual=false){
  const attempts=(previous.attempts||[]).filter(t=>now-t<3600000);
  if(sample.maintenance)return {action:'skip',failures:0,attempts,message:'正在修改权限，稍后再检查连接。'};
  if(!sample.loaded)return {action:'skip',failures:0,attempts,message:sample.localOK?'本机主服务已运行，但隧道未启动；点击修复连接可补齐启动。':'服务尚未启动；点击修复连接可启动，自动检查不会自行启动。'};
  if(!sample.localOK)return {action:'skip',failures:0,attempts,message:'本机服务未就绪；没有中断主服务，请查看服务日志。'};
  if(sample.publicOK)return {action:'healthy',failures:0,attempts,message:'连接正常，可以回到 ChatGPT 继续。'};
  if(sample.connections===null)return {action:'skip',failures:0,attempts,message:'无法读取隧道状态；暂未自动重启，请稍后手动重试。'};
  if(sample.connections>0)return {action:'skip',failures:0,attempts,message:'隧道仍在线，但公网检测未通过；请检查网络或代理，稍后重试。'};
  const failures=(previous.failures||0)+1;
  if(!manual && failures<3)return {action:'wait',failures,attempts,message:'隧道暂时断开，正在等待自动重连。'};
  if(!manual && (attempts.length>=3 || (attempts.length&&now-attempts.at(-1)<300000)))return {action:'wait',failures,attempts,message:'自动修复已进入冷却期；请检查网络，或从 Raycast 手动修复。'};
  return {action:'restart-tunnel',failures,attempts:[...attempts,now],message:'正在重新连接 DevSpace 隧道…'};
}
async function get(url,timeout=6000){try{const r=await fetch(url,{signal:AbortSignal.timeout(timeout),redirect:'error'});return {ok:r.ok,text:await r.text()};}catch{return {ok:false,text:''};}}
async function sample(supervisor){
  const [core,tunnel]=await Promise.all([supervisor.job('com.nar.devspace-air'),supervisor.job('com.nar.devspace-air-tunnel')]);
  let maintenance=false;for(const f of ['drain.json','transaction.json'])try{await fs.access(path.join(ACCESS,f));maintenance=true;}catch{}
  const [local,metrics]=await Promise.all([get('http://127.0.0.1:7676/.well-known/oauth-authorization-server'),get('http://127.0.0.1:7677/metrics')]);
  let issuer;try{issuer=JSON.parse(local.text).issuer;}catch{}
  const localOK=local.ok&&typeof issuer==='string'&&issuer.startsWith('https://');
  const match=metrics.text.match(/^cloudflared_tunnel_ha_connections\s+(\d+)/m);
  const connections=match?Number(match[1]):null;
  let publicOK=false;
  if(localOK){const remote=await get(issuer.replace(/\/$/,'')+'/.well-known/oauth-authorization-server');try{publicOK=remote.ok&&JSON.parse(remote.text).issuer===issuer;}catch{}}
  return {loaded:core.loaded&&tunnel.loaded,localOK,connections,publicOK,maintenance,corePid:core.pid,tunnelPid:tunnel.pid};
}
export async function check(mode='status'){
  const supervisor=new Supervisor();
  let release;
  try{release=await acquireLock();}catch{return {message:'另一项权限或连接操作正在进行，请稍后重试。',action:'skip'};}
  try{
    const current=await sample(supervisor);
    let previous={};try{previous=await readJSON(stateFile);}catch{}
    const result=decision(current,previous,Date.now(),mode==='repair');
    if(mode==='status')return {...result,sample:current};
    if(result.action==='restart-tunnel'){
      // Recheck jobs while holding the permission-operation lock. Never start a stopped job.
      const [core,tunnel]=await Promise.all([supervisor.job('com.nar.devspace-air'),supervisor.job('com.nar.devspace-air-tunnel')]);
      if(!core.loaded||!tunnel.loaded){result.action='skip';result.message='服务已经停止，未执行重连。';}
      else{
        await atomicJSON(stateFile,{...result,checkedAt:Date.now(),sample:current});
        await run('/bin/launchctl',['kickstart','-k','gui/'+process.getuid()+'/com.nar.devspace-air-tunnel'],{timeout:20000});
        if(mode==='repair'){
          let after;
          for(let i=0;i<4;i++){await sleep(2000);after=await sample(supervisor);if(after.connections>0&&after.publicOK)break;}
          result.message=after?.publicOK&&after.connections>0?'连接已恢复，可以回到 ChatGPT 回复“继续”。':'已尝试重连，暂未恢复。请确认电脑已唤醒、网络和代理可用，再运行一次修复。';
          result.sample=after;
        }
      }
    }
    const output={...result,checkedAt:Date.now(),sample:result.sample||current};
    await atomicJSON(stateFile,output);return output;
  }finally{await release();}
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===path.resolve(process.argv[1])){
  const mode=process.argv[2]||'status';
  if(!['status','watch','repair'].includes(mode))throw new Error('Unknown mode');
  // Defer the CLI entry until this module finishes evaluating; Assistant imports check.
  void (async()=>{
   try{if(mode==='repair'){const {Assistant}=await import('./assistant.mjs');console.log(await new Assistant().action('repair'));}else{const result=await check(mode);if(mode!=='watch'||result.action==='restart-tunnel')console.log(result.message);}}
   catch(e){console.error('连接检查未完成：'+e.message);process.exitCode=1;}
  })();
}

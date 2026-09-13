import fs from 'node:fs/promises';import path from 'node:path';import {spawn} from 'node:child_process';import {fileURLToPath} from 'node:url';import {snapshot,inside,digest} from './policy.mjs';import crypto from 'node:crypto';
async function inspect(j,root){
 if(j.state!=='needs_review'||!j.sealed||!['codex.develop','grok.develop'].includes(j.kind))throw Error('只能应用已封存的开发结果');
 const check=path.join(root,'apply-check-'+crypto.randomUUID());let current;const previews={};let bytes=0;async function collect(dir,manifest,side){for(const f of Object.keys(manifest)){const b=await fs.readFile(path.join(dir,f));bytes+=b.length;if(bytes<=200000)(previews[f]??={})[side]=b.toString('utf8');}}try{current=await snapshot(j.project,check);await collect(check,current.files,'beforeText');}finally{await fs.rm(check,{recursive:true,force:true});}
 if(current.revision!==j.sourceRevision)throw Error('原项目已改变，请重新核对，未写入任何文件');
 const result=path.join(root,'result-check-'+crypto.randomUUID());let output;try{output=await snapshot(path.join(root,'result'),result);await collect(result,output.files,'afterText');}finally{await fs.rm(result,{recursive:true,force:true});}
 if(output.revision!==j.outputRevision)throw Error('封存结果已经改变');
 const changes=[...new Set([...Object.keys(current.files),...Object.keys(output.files)])].sort().filter(p=>current.files[p]!==output.files[p]).map(p=>({path:p,before:current.files[p]||null,after:output.files[p]||null}));
 return {requestId:j.requestId,project:j.project,preview:changes.map(c=>({...c,...previews[c.path]})),previewMayBeTruncated:bytes>200000,revision:digest(JSON.stringify({source:j.sourceRevision,output:j.outputRevision,changes})),changes,sourceRevision:j.sourceRevision,outputRevision:j.outputRevision};
}
async function execute(plan){return new Promise((resolve,reject)=>{const c=spawn('/usr/bin/python3',['-I',fileURLToPath(new URL('./apply-files.py',import.meta.url))],{env:{PATH:'/usr/bin:/bin'},stdio:['pipe','pipe','pipe']});let out='',err='';c.stdin.end(JSON.stringify(plan));c.stdout.on('data',b=>out+=b);c.stderr.on('data',b=>err+=b);c.on('error',reject);c.on('close',code=>{if(code)reject(Error('应用未完成，请查看恢复记录：'+err.slice(-700)));else resolve(JSON.parse(out));});});}
export async function applyTask({method,a,j,root,grants}){
 if(Object.keys(a).some(k=>!['requestId','revision','authorizedWrite'].includes(k)))throw Error('应用参数无效');
 const receipt=path.join(root,'apply-receipt.json');let old;try{old=JSON.parse(await fs.readFile(receipt,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
 if(method==='task_apply_status')return old||{state:'not_applied'};
 if(method==='task_apply_preview')return inspect(j,root);
 if(a.authorizedWrite!==true||typeof a.revision!=='string')throw Error('必须先展示修改并取得用户对该版本的明确同意');
 const authorize=async()=>{if(!(await grants()).grants.some(g=>g.mode==='rw'&&inside(j.project,g.path)))throw Error('原项目没有写入授权');};await authorize();
 const lock=path.join(root,'apply.lock');let handle;try{handle=await fs.open(lock,'wx',0o600);}catch{throw Error('已有应用操作或中断记录，先查看状态');}
 try{
  if(old){if(old.revision!==a.revision)throw Error('确认版本与原操作不一致');if(method==='task_apply'||old.state==='reverted')return old;}
  if(method==='task_revert'){
   if(!old||old.state!=='applied')throw Error('没有完整应用可撤回');
   const changes=old.changes.map(c=>({path:c.path,before:c.after,after:c.before}));await authorize();const result=await execute({source:j.project,payload:old.backup,backup:path.join(root,'revert-backup'),receipt:path.join(root,'revert-receipt.json'),changes});old={...old,state:'reverted',revert:result};await fs.writeFile(receipt,JSON.stringify(old));return old;
  }
  const plan=await inspect(j,root);if(plan.revision!==a.revision)throw Error('确认版本不匹配');
  // Persist the exact authorization binding before starting file writes.
  await fs.writeFile(path.join(root,'apply-approval.json'),JSON.stringify({revision:a.revision,at:new Date().toISOString()}),{mode:0o600});
  await authorize();try{await execute({source:j.project,payload:path.join(root,'result'),backup:path.join(root,'apply-backup'),receipt,changes:plan.changes});}finally{let r=JSON.parse(await fs.readFile(receipt,'utf8'));r.revision=a.revision;await fs.writeFile(receipt,JSON.stringify(r));}
  return JSON.parse(await fs.readFile(receipt,'utf8'));
 }finally{await handle.close();await fs.rm(lock,{force:true});}
}

import fs from 'node:fs/promises';import path from 'node:path';import {snapshot,inside,digest} from './policy.mjs';import crypto from 'node:crypto';
export async function workspaceReview({method,args,root,grants}){
 if(typeof args.workspaceId!=='string'||!/^[-_a-zA-Z0-9]{1,100}$/.test(args.workspaceId))throw Error('Invalid workspace ID');
 const dir=path.join(root,'reviews',args.workspaceId),record=path.join(dir,'checkpoint.json');
 if(method==='workspace_checkpoint'){
  const project=await fs.realpath(args.project);if(!(await grants()).grants.some(g=>inside(project,g.path)))throw Error('Workspace no longer authorized');await fs.mkdir(dir,{recursive:true});
  const location=path.join(dir,crypto.randomUUID());let info;
  try{const baseline=await snapshot(project,location);info={project,at:new Date().toISOString(),location,baseline};}catch{await fs.rm(location,{recursive:true,force:true});info={project,at:new Date().toISOString(),unavailable:true};}
  let previous;try{previous=JSON.parse(await fs.readFile(record,'utf8'));}catch{}await fs.writeFile(record,JSON.stringify(info),{mode:0o600});if(previous?.location)await fs.rm(previous.location,{recursive:true,force:true});return {ready:!info.unavailable};
 }
 const info=JSON.parse(await fs.readFile(record,'utf8').catch(()=>{throw Error('Open this workspace first to establish a review baseline');}));if(!(await grants()).grants.some(g=>inside(info.project,g.path)))throw Error('Workspace no longer authorized');
 if(info.unavailable)return {available:false,reason:'该目录超过安全快照范围或包含无法快照的文件。请使用task_changes/task_apply_preview查询具体开发任务；不能据此判断没有改动。'};
 const location=path.join(dir,crypto.randomUUID());try{
  const current=await snapshot(info.project,location);const paths=[...new Set([...Object.keys(info.baseline.files),...Object.keys(current.files)])].sort().filter(f=>info.baseline.files[f]!==current.files[f]);let bytes=0;const files=[];
  for(const file of paths){const item={path:file,kind:!info.baseline.files[file]?'added':!current.files[file]?'deleted':'modified',beforeSha256:info.baseline.files[file]||null,afterSha256:current.files[file]||null};for(const [key,base,exists]of [['before',info.location,info.baseline.files[file]],['after',location,current.files[file]]])if(exists){const b=await fs.readFile(path.join(base,file));bytes+=b.length;if(bytes<=200000)item[key]=b.toString('utf8');}files.push(item);}
  return {available:true,workspaceId:args.workspaceId,baselineAt:info.at,scope:'Net file changes since the latest open_workspace checkpoint on this service; not Git history or a chat-specific turn. Excludes credentials, dependencies and build output.',files,truncated:bytes>200000,revision:digest(JSON.stringify(files))};
 }finally{await fs.rm(location,{recursive:true,force:true});}
}

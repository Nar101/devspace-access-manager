import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {BASE,ROOT} from '../src/paths.mjs';
import {Supervisor} from '../src/supervisor.mjs';
import {acquireLock,loadActive} from '../src/store.mjs';
import {enroll,REGISTRY} from '../cli/registry.mjs';
import {save} from '../cli/common.mjs';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
if(!process.argv.includes('--apply')){console.log('安装通用 CLI 执行层：node scripts/install-cli.mjs --apply；保留文件夹、登录和上下文同步。');process.exit(0);}
const supervisor=new Supervisor(),unlock=await acquireLock();let stopped=false,before;
const backup=path.join(BASE,'backups','cli-update-'+Date.now());
const targets=[...['src','public','runtime','cli'].map(x=>[path.join(repo,x),path.join(ROOT,x),x]),[path.join(repo,'runtime/serve.py'),path.join(BASE,'bin/serve'),'serve'],[path.join(repo,'runtime/server.mjs'),path.join(BASE,'bin/server.mjs'),'server.mjs'],[path.join(repo,'runtime/agent.md'),path.join(BASE,'config/agent/AGENTS.md'),'agent.md']];
try{
 for(const [source]of targets)await fs.access(source);
 before=await supervisor.state();if(before.busy)throw new Error('有 MCP 任务运行或状态不明；本次没有替换服务，请任务结束后重新更新。');
 await fs.mkdir(backup,{recursive:true,mode:0o700});
 for(const [,target,name]of targets)try{await fs.cp(target,path.join(backup,name),{recursive:true});}catch(e){if(e.code!=='ENOENT')throw e;}
 try{await fs.copyFile(REGISTRY,path.join(backup,'registry.json'));}catch(e){if(e.code!=='ENOENT')throw e;}
 const entries=await enroll();
 before=await supervisor.stop();stopped=true;
 for(const [source,target]of targets)await fs.cp(source,target,{recursive:true});await fs.chmod(path.join(BASE,'bin/serve'),0o755);
 const active=await loadActive();await supervisor.start(before,active.revision);stopped=false;
 await save(path.join(BASE,'config/cli-installation.json'),{version:'0.3.2',source:repo,backup,installedAt:new Date().toISOString(),entries:entries.length});
 console.log('通用 CLI 执行层已安装：'+entries.length+' 个已核对来源；原目录权限、登录与上下文同步保持。');
}catch(e){
 if(stopped){try{await supervisor.stop({allowUncertain:true});}catch{}
  for(const [,target,name]of targets)try{await fs.cp(path.join(backup,name),target,{recursive:true});}catch{}
  try{await fs.copyFile(path.join(backup,'registry.json'),REGISTRY);}catch{}
  try{await supervisor.start(before,(await loadActive()).revision);}catch{}
 }
 throw e;
}finally{await unlock();}

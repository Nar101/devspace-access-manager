import {workspaceReview} from './workspace-review.mjs';
import {runProject,installProject} from './project-runner.mjs';
import {applyTask} from './apply.mjs';
import {runGrokSearch} from './grok-search.mjs';
import fs from 'node:fs/promises';
import {isUtf8} from 'node:buffer';
import path from 'node:path';
import {BASE,json,save,id,redact} from '../cli/common.mjs';
import {loadActive} from '../src/store.mjs';
import {snapshot,inside,digest} from './policy.mjs';
import {catalog} from './catalog.mjs';
import {runCodex} from './codex-runner.mjs';
import {runGrok} from './grok-runner.mjs';
export class CapabilityJobs{
 constructor({root=path.join(BASE,'manager/capability-runtime'),configPath=path.join(BASE,'config/capabilities.json'),grants=loadActive,runner=runCodex,grokRunner=runGrok,onSpawn=()=>{}}={}){Object.assign(this,{root,configPath,grants,runner,grokRunner,onSpawn});this.active=new Map();this.chain=Promise.resolve();}
 async init(){await fs.mkdir(path.join(this.root,'jobs'),{recursive:true});for(const d of await fs.readdir(path.join(this.root,'jobs'))){if(!id(d))continue;const p=this.recordPath(d),j=await json(p,null);if(j&&['preparing','running'].includes(j.state)){j.state='interrupted';j.message='进程重启；原项目未写入，结果待核对，不自动重跑';await save(p,j);}}}
 recordPath(key){return path.join(this.root,'jobs',key,'job.json');}
 dispatch(method,args={}){const p=this.chain.then(()=>this.handle(method,args));this.chain=p.catch(()=>{});return p;}
 async handle(method,a){
 if(['workspace_checkpoint','workspace_changes'].includes(method))return workspaceReview({method,args:a,root:this.root,grants:this.grants});
 const config=await json(this.configPath,{enabled:false,codex:false});
 if(method==='capabilities_list')return {items:catalog({codexReady:config.enabled&&config.codex,grokReady:config.enabled&&config.grok,grokSearchReady:config.enabled&&config.grok&&config.grokSearch,projectReady:config.enabled&&config.projectDelivery}),policy:'权限只由本机配置与当前目录授权决定；失败不会触发提权'};
 if(!id(a.requestId))throw Error('无效任务编号');
 if(['task_apply_preview','task_apply','task_apply_status','task_revert'].includes(method)){if(!config.enabled||!config.projectDelivery)throw Error('项目交付能力未开启');if(this.active.size)throw Error('请等当前开发任务结束');const j=await this.result(a.requestId);return applyTask({method,a,j,root:path.join(this.root,'jobs',a.requestId),grants:this.grants});}
 if(method==='task_verify'){if(Object.keys(a).some(k=>!['requestId','parentId'].includes(k)))throw Error('验证参数无效');a={...a,prompt:'Run independent package tests and build'};}
 if(method==='task_result')return this.result(a.requestId);
 if(method==='task_cancel'){this.active.get(a.requestId)?.abort();return this.result(a.requestId);}
 if(method==='task_changes'){
  const j=await this.result(a.requestId);if(!j.sealed)throw Error('旧任务尚无封存产物，请重新生成或续接');const changed=[];let total=0;for(const file of j.artifacts||[]){const bytes=await fs.readFile(path.join(this.root,'jobs',a.requestId,'result',file));if(j.resultFiles?.[file]&&digest(bytes)!==j.resultFiles[file])throw Error('封存产物发生变化');total+=bytes.length;if(total>200000)throw Error('变更包过大，请按文件读取产物');const encoding=isUtf8(bytes)?'utf8':'base64',content=bytes.toString(encoding);changed.push({path:file,kind:j.input.files[file]?'modify':'add',beforeSha256:j.input.files[file]||null,afterSha256:digest(bytes),encoding,content});}for(const file of j.removed||[])changed.push({path:file,kind:'delete',beforeSha256:j.input.files[file]});return {requestId:j.requestId,revision:j.outputRevision,sourceModified:false,base:j.parentId||'original_project',changes:changed};
 }
 if(method==='task_artifact'){
  const j=await this.result(a.requestId);if(!j.artifacts?.includes(a.path))throw Error('文件不在任务产物清单');
  const p=path.join(this.root,'jobs',a.requestId,j.sealed?'result':'workspace',a.path);if(await fs.realpath(p)!==p)throw Error('拒绝符号链接产物');const b=await fs.readFile(p);if(j.resultFiles?.[a.path]&&digest(b)!==j.resultFiles[a.path])throw Error('封存产物发生变化');if(b.length>200000)throw Error('产物过大，请在本机查看');const encoding=isUtf8(b)?'utf8':'base64';return {path:a.path,encoding,content:b.toString(encoding),sha256:digest(b)};
 }
 let parent;const continuing=['task_continue','task_verify'].includes(method);if(continuing){if(Object.keys(a).some(k=>!['requestId','parentId','prompt'].includes(k))||!id(a.parentId))throw Error('续接参数无效');parent=await this.result(a.parentId);if(['preparing','running'].includes(parent.state))throw Error('父任务尚未结束');a={...a,kind:method==='task_verify'?'project.verify':parent.kind,project:parent.project};}
 if(method!=='task_submit'&&!continuing)throw Error('不支持的任务操作');
 if(Object.keys(a).some(k=>!(continuing?['requestId','parentId','kind','project','prompt']:['requestId','kind','project','prompt']).includes(k)))throw Error('任务不接受模型、命令、权限或凭据覆盖参数');
 if(a.kind==='grok.search'&&!config.grokSearch)throw Error('X搜索能力未开启');
 if(!config.enabled||!['codex.develop','grok.develop','grok.search','project.verify'].includes(a.kind)||(a.kind==='project.verify'?!config.projectDelivery:a.kind==='codex.develop'?!config.codex:!config.grok))throw Error('该能力未开启或未完成安全验收');
 if(typeof a.prompt!=='string'||!a.prompt.trim()||a.prompt.length>20000)throw Error('任务描述无效或过长');
 const source=await fs.realpath(a.project);if(!(await fs.stat(source)).isDirectory())throw Error('项目不是目录');
 const access=await this.grants();if(!access.grants.some(g=>inside(source,g.path)))throw Error('项目不在当前授权目录中');
 if(config.projects!=='authorized'&&!config.projects?.includes(source))throw Error('项目尚未允许委派开发');
 const requestHash=digest(JSON.stringify({kind:a.kind,source,prompt:a.prompt,...(continuing?{parentId:a.parentId}:{})})),old=await json(this.recordPath(a.requestId),null);if(old){if(old.requestHash!==requestHash)throw Error('任务编号已用于不同请求');return old;}
 if(this.active.size)throw Error('当前已有开发任务，请先查询或取消');
 const root=path.join(this.root,'jobs',a.requestId),workspace=path.join(root,'workspace');await fs.mkdir(workspace,{recursive:true});
 const j={requestId:a.requestId,...(continuing?{parentId:a.parentId}:{}),kind:a.kind,project:source,state:'preparing',requestHash,createdAt:new Date().toISOString(),artifacts:[],sourceModified:false};await save(this.recordPath(a.requestId),j);
 try{if(continuing){const current=await snapshot(source,path.join(root,'source-check'));if(current.revision!==(parent.sourceRevision||parent.input.revision))throw Error('原项目在任务期间发生变化，请先核对差异');const parentRoot=path.join(this.root,'jobs',parent.requestId,parent.sealed?'result':'workspace');j.input=await snapshot(parentRoot,workspace);j.sourceRevision=parent.sourceRevision||parent.input.revision;}else{j.input=await snapshot(source,workspace);j.sourceRevision=j.input.revision;}}catch(e){j.state='failed';j.error=e.message;await save(this.recordPath(a.requestId),j);throw e;}
 // Recheck authorization after copying, before the trusted runner starts.
 if(!(await this.grants()).grants.some(g=>inside(source,g.path))){j.state='failed';j.error='项目授权已撤销';await save(this.recordPath(a.requestId),j);throw Error(j.error);}
 const controller=new AbortController();this.active.set(a.requestId,controller);j.state='running';await save(this.recordPath(a.requestId),j);
 void this.execute(j,{root,workspace,controller,config,prompt:a.prompt});return j;
 }
 async result(key){const j=await json(this.recordPath(key),null);if(!j)throw Error('任务不存在');if(!(await this.grants()).grants.some(g=>inside(j.project,g.path)))throw Error('项目授权已撤销，任务内容不可读取');const application=await json(path.join(this.root,'jobs',key,'apply-receipt.json'),null);if(application){j.application=application;j.sourceModified=application.state==='applied'?true:application.state==='reverted'?false:null;j.message=application.state==='applied'?'已按确认版本写入原项目':application.state==='reverted'?'本次写入已撤回':'应用状态需查看恢复记录';}return j;}
 async execute(j,{root,workspace,controller,config,prompt}){
 try{
  const watchdog=setInterval(()=>{void Promise.all([this.grants(),json(this.configPath)]).then(([a,c])=>{if(!c.enabled||(j.kind==='project.verify'?!c.projectDelivery:j.kind.startsWith('grok.')?(!c.grok||(j.kind==='grok.search'&&!c.grokSearch)):!c.codex)||!a.grants.some(g=>inside(j.project,g.path)))controller.abort();}).catch(()=>controller.abort());},1000);watchdog.unref();let result;try{if(config.projectDelivery&&['codex.develop','grok.develop'].includes(j.kind)){const hasLock=await fs.access(path.join(workspace,'package-lock.json')).then(()=>true,()=>false);if(hasLock){j.preparation=await installProject({root,workspace,runtime:config.runtime,signal:controller.signal,onSpawn:this.onSpawn});if(j.preparation.exitCode||j.preparation.reason)throw Error('项目依赖安装失败：'+j.preparation.output.slice(-3000));}}result=await (j.kind==='project.verify'?runProject:j.kind==='grok.search'?runGrokSearch:j.kind==='grok.develop'?this.grokRunner:this.runner)({root,workspace,prompt,onSpawn:this.onSpawn,runtime:config.runtime,model:j.kind==='grok.develop'?(config.grokModel||'grok-4.6'):(config.model||'gpt-6-astra'),timeoutMs:config.timeoutMs||600000,signal:controller.signal});}finally{clearInterval(watchdog);}
  j.state=result.reason||((result.exitCode===0&&result.events.some(e=>e.type==='turn.completed'))?'needs_review':'failed');j.exitCode=result.exitCode;j.modelRequests=result.modelRequests;
  j.message='代理执行结果不等于验收通过；原项目没有修改';j.output=redact(result.events.filter(e=>e.type==='item.completed'&&e.item?.type==='agent_message').map(e=>e.item.text).join('\n').slice(-30000));j.error=redact(result.stderr).slice(-4000);
  const frozen=await snapshot(workspace,path.join(root,'result'));j.sealed=true;j.resultFiles=frozen.files;j.artifacts=Object.keys(frozen.files).filter(f=>j.input.files[f]!==frozen.files[f]);j.removed=Object.keys(j.input.files).filter(f=>!(f in frozen.files));j.outputRevision=frozen.revision;
 }catch(e){j.state='failed';j.error=redact(e.message);}finally{j.finishedAt=new Date().toISOString();await save(this.recordPath(j.requestId),j);this.active.delete(j.requestId);}
 }
 stop(){for(const c of this.active.values())c.abort();}
}

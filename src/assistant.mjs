import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {BASE,ACCESS,NODE} from './paths.mjs';
import {readJSON,atomicJSON,acquireLock} from './store.mjs';
import {Supervisor} from './supervisor.mjs';
import {check as connectionCheck} from './connection-health.mjs';
const exec=promisify(execFile), sleep=ms=>new Promise(r=>setTimeout(r,ms));
export const CONTEXT=path.join(os.homedir(),'.local/share/codex-context-exporter');
export const LABELS=['com.nar.devspace-air','com.nar.devspace-air-tunnel','com.nar.devspace-air-health','com.nar.codex-context-exporter'];
export const PREFS=path.join(BASE,'config/assistant-preferences.json');
const safeRead=async p=>{try{return await readJSON(p);}catch{return null;}};
export class Assistant {
 constructor({supervisor=new Supervisor(),run=exec,base=BASE,context=CONTEXT,wait=sleep,checkConnection=connectionCheck}={}){Object.assign(this,{supervisor,run,base,context,wait,checkConnection});this.access=path.join(base,'config/access');}
 async preferences(){return {autoStart:true,enabled:true,contextEnabled:true,...await safeRead(path.join(this.base,'config/assistant-preferences.json'))};}
 async preferencesSet(change){const p={...await this.preferences(),...change};await atomicJSON(path.join(this.base,'config/assistant-preferences.json'),p);return p;}
 async snapshot(){
  const [health,status,permission,preferences,exporter,recovery,request,result,cfg]=await Promise.all([
   safeRead(path.join(this.access,'connection-health.json')),safeRead(path.join(this.context,'state/status.json')),safeRead(path.join(this.context,'state/access-helper.json')),this.preferences(),this.supervisor.job(LABELS[3]),this.supervisor.job(LABELS[2]),safeRead(path.join(this.context,'state/sync-request.json')),safeRead(path.join(this.context,'state/sync-request-result.json')),safeRead(path.join(this.context,'config.json'))]);
  let summaries=null;try{summaries=(await fs.readdir(path.join(cfg.output,'计算机历史/摘要'))).filter(x=>x.endsWith('.md')).length;}catch{}
  const excluded=await safeRead(path.join(this.context,'state/excluded-sessions.json'))||[];
  const recent=[];try{const text=await fs.readFile(path.join(cfg.output,'最近进展.md'),'utf8');for(const m of text.matchAll(/^## \[([^\]\n]+)\]\(会话\/[^/]+\/([A-Za-z0-9_-]{8,100})\.md\)/gm))recent.push({title:m[1],id:m[2]});}catch{}
  return {version:'0.3.2',health,healthFresh:!!health&&Date.now()-health.checkedAt<180000,context:{...status,output:cfg?.output||null,summaries,job:exporter,permission:permission?{ok:permission.ok,at:permission.at,message:permission.message,pid:permission.pid}:null,stale:!status||Date.now()-Date.parse(status.checked_at)>600000,excluded,recent,request,result},preferences,recovery};
 }
 async plist(label){const p=path.join(this.base,'config/launchagents',label+'.plist');try{await fs.access(p);return p;}catch{return path.join(os.homedir(),'Library/LaunchAgents',label+'.plist');}}
 async startJob(label){for(let i=0;i<10;i++){if((await this.supervisor.job(label)).loaded)return;try{await this.run('/bin/launchctl',['bootstrap','gui/'+process.getuid(),await this.plist(label)],{timeout:10000});return;}catch(e){if(i===9)throw e;await sleep(300);}}}
 async stopJob(label){
  const job=await this.supervisor.job(label);if(!job.loaded)return;
  const procs=await this.supervisor.processes(),ids=new Set(job.pid?[job.pid]:[]);let again=true;
  while(again){again=false;for(const p of procs)if(p.uid===process.getuid()&&ids.has(p.ppid)&&!ids.has(p.pid)){ids.add(p.pid);again=true;}}
  const groups=new Set(procs.filter(p=>ids.has(p.pid)).map(p=>p.pgid));
  for(const g of groups)if(g<=1||procs.some(p=>p.pgid===g&&p.uid!==process.getuid()))throw new Error('后台进程身份不一致，未执行停止');
  await this.run('/bin/launchctl',['bootout','gui/'+process.getuid()+'/'+label],{timeout:15000});
  for(const g of groups){
   const members=(await this.supervisor.processes()).filter(p=>p.pgid===g&&!p.stat.startsWith('Z'));
   if(!members.length)continue;
   try{process.kill(-g,'SIGTERM');}catch(e){if(e.code==='ESRCH')continue;const alive=(await this.supervisor.processes()).some(p=>p.pgid===g&&!p.stat.startsWith('Z'));if(alive)throw e;}
  }
  for(let i=0;i<15;i++){if(!(await this.supervisor.processes()).some(p=>groups.has(p.pgid)&&!p.stat.startsWith('Z')))return;await sleep(200);}
  throw new Error('后台仍有进程，未确认停止完成');
 }
 async start(login=false){
  const p=await this.preferences();if(login&&(!p.autoStart||!p.enabled))return '登录自动启动已关闭。';
  const unlock=await acquireLock(this.access);try{
   for(const f of ['transaction.json','drain.json']){if(await safeRead(path.join(this.access,f)))throw new Error('存在未完成的权限操作，请先恢复权限管理。');}
   if(!login)await this.preferencesSet({enabled:true});
   await this.startJob(LABELS[0]);let ready=false;
   for(let i=0;i<180;i++){const s=await this.supervisor.state();if(s.service.running&&s.telemetry){ready=true;break;}await this.wait(500);}
   if(!ready)throw new Error('本机服务未就绪，尚未开启公网连接。');
   await this.startJob(LABELS[1]);await this.startJob(LABELS[2]);if(p.contextEnabled)await this.startJob(LABELS[3]);
   return '服务已启动，正在核对连接和同步状态。';
  }finally{await unlock();}
 }
 async stop(){const unlock=await acquireLock(this.access);try{
  const s=await this.supervisor.state();if(s.busy)throw new Error('仍有任务执行或执行状态未知，请任务结束后再停止。');
  await this.preferencesSet({enabled:false});await this.stopJob(LABELS[2]);await this.supervisor.stop();await this.stopJob(LABELS[3]);return '已停止连接和同步，文件与配置保留。';
 }finally{await unlock();}}
 async action(action,args={}){
  if(action==='repair'){await this.start();return (await this.checkConnection('repair')).message;}
  if(action==='check-connection'){const r=await connectionCheck('status');if(!r.sample)return r.message;const old=await safeRead(path.join(this.access,'connection-health.json'));const message=r.action==='restart-tunnel'?'检测到隧道断开，可以点击修复连接。':r.message;await atomicJSON(path.join(this.access,'connection-health.json'),{...r,message,action:r.sample.publicOK?'healthy':'checked',attempts:old?.attempts||[],checkedAt:Date.now()});return message;}
  if(action==='start')return this.start();
  if(action==='stop')return this.stop();
  if(action==='remove-integration'){
   await this.stop();await this.preferencesSet({autoStart:false,enabled:false});
   const backup=path.join(this.base,'backups','removed-integration-'+Date.now());await fs.mkdir(backup,{recursive:true});
   await this.run('/bin/launchctl',['bootout','gui/'+process.getuid()+'/com.nar.devspace-assistant']).catch(()=>{});
   const files=[path.join(os.homedir(),'Library/LaunchAgents/com.nar.devspace-assistant.plist'),...['devspace-assistant.sh','devspace-folder-permissions.sh','devspace-repair-connection.sh','devspace-connection-status.sh','sync-codex-context.sh','status-codex-context.sh'].map(f=>path.join(os.homedir(),'Documents/Raycast Scripts',f)),...['DevSpace 本机助手.command','DevSpace 文件夹权限.command'].map(f=>path.join(os.homedir(),'Applications',f))];
   for(const f of files)try{await fs.rename(f,path.join(backup,path.basename(f)));}catch(e){if(e.code!=='ENOENT')throw e;}
   return '已停用并移除启动与快捷入口。安装文件、系统授权助手和所有数据保留，可用更新脚本恢复。';
  }
  if(action==='autostart'){if(typeof args.value!=='boolean')throw new Error('自动启动选项无效');await this.preferencesSet({autoStart:args.value});return args.value?'已开启登录自动启动。':'已关闭登录自动启动；当前运行不受影响。';}
  if(action==='context-pause'||action==='context-resume'){
   const unlock=await acquireLock(this.access);try{await this.preferencesSet({contextEnabled:action==='context-resume'});if(action==='context-pause')await this.stopJob(LABELS[3]);else await this.startJob(LABELS[3]);return action==='context-pause'?'已暂停上下文同步，现有记录保留。':'已启动上下文同步。';}finally{await unlock();}
  }
  if(action==='context-sync'){
   if(!(await this.supervisor.job(LABELS[3])).running)throw new Error('请先恢复上下文同步。');
   await atomicJSON(path.join(this.context,'state/sync-request.json'),{id:crypto.randomUUID(),at:Date.now()});return '已提交补同步请求，后台正在处理。';
  }
  if(action==='exclude'||action==='include'){
   if(typeof args.id!=='string'||!/^[-\w]{8,100}$/.test(args.id))throw new Error('请输入有效的会话 ID');
   const {stdout}=await this.run('/usr/bin/python3',[path.join(this.context,'bin/exporter.py'),action,'--config',path.join(this.context,'config.json'),'--session-id',args.id],{timeout:45000,maxBuffer:16384});
   if(stdout.includes('已有同步'))throw new Error('同步正在进行，请稍后重试。');return '导出范围已更新，原会话未修改。';
  }
  const targets={'open-context':(await safeRead(path.join(this.context,'config.json')))?.output,'permissions':path.join(os.homedir(),'Applications/本地上下文同步.app'),'logs':path.join(this.base,'logs')};
  if(Object.hasOwn(targets,action)){if(!targets[action])throw new Error('目标位置不可用');await this.run('/usr/bin/open',action==='permissions'?['-n',targets[action]]:[targets[action]],{timeout:5000});return '已打开。';}
  if(action==='diagnostics'){
   const snapshot=await this.snapshot();const report={at:new Date().toISOString(),version:snapshot.version,health:snapshot.health,context:{phase:snapshot.context.phase,checked_at:snapshot.context.checked_at,sessions:snapshot.context.sessions,errors:snapshot.context.errors,job:snapshot.context.job},preferences:snapshot.preferences};
   const p=path.join(this.base,'logs/assistant-diagnostics.json');await atomicJSON(p,report);await this.run('/usr/bin/open',['-R',p],{timeout:5000});return '已保存诊断摘要，不含会话正文或凭据。';
  }
  throw new Error('不支持的操作');
 }
}

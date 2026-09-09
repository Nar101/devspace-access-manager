import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {BASE,ROOT,NODE} from '../src/paths.mjs';
import {Assistant,LABELS,CONTEXT} from '../src/assistant.mjs';
import {acquireLock,atomicJSON,loadActive} from '../src/store.mjs';
const run=promisify(execFile),repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
if(!process.argv.includes('--apply')){console.log('本机整合更新：node scripts/install-assistant.mjs --apply。需要现有已验证的 DevSpace 与上下文部署；保留所有数据。');process.exit(0);}
await loadActive();await fs.access(path.join(CONTEXT,'config.json'));
const service=new Assistant(),unlock=await acquireLock();let wasContext=false;
const backup=path.join(BASE,'backups','assistant-update-'+Date.now());await fs.mkdir(backup,{recursive:true});
try{
 const contextJob=await service.supervisor.job(LABELS[3]);wasContext=contextJob.loaded;
 for(const [src,name] of [[ROOT,'manager'],[path.join(CONTEXT,'bin'),'context-bin'],[path.join(os.homedir(),'Applications/本地上下文同步.app'),'context-app']])await fs.cp(src,path.join(backup,name),{recursive:true});
 await fs.copyFile(path.join(BASE,'bin/control'),path.join(backup,'control'));
 const definitions=path.join(BASE,'config/launchagents');await fs.mkdir(definitions,{recursive:true});
 for(const label of LABELS){const old=path.join(os.homedir(),'Library/LaunchAgents',label+'.plist'),target=path.join(definitions,label+'.plist');try{await fs.copyFile(old,path.join(backup,label+'.plist'));await fs.copyFile(old,target);}catch(e){if(e.code!=='ENOENT')throw e;await fs.access(target);}}
 if(wasContext)await service.stopJob(LABELS[3]);
 for(const folder of ['src','public','runtime','scripts','context'])await fs.cp(path.join(repo,folder),path.join(ROOT,folder),{recursive:true});
 for(const f of ['exporter.py','watcher.mjs'])await fs.copyFile(path.join(repo,'context',f),path.join(CONTEXT,'bin',f));
 await fs.copyFile(path.join(repo,'runtime/control.py'),path.join(BASE,'bin/control'));await fs.chmod(path.join(BASE,'bin/control'),0o755);
 const app=path.join(os.homedir(),'Applications/本地上下文同步.app');
 const nativeSource=path.join(repo,'context/native/HistoryAccessApp.swift'),nativeSha=crypto.createHash('sha256').update(await fs.readFile(nativeSource)).digest('hex');
 let oldReceipt;try{oldReceipt=JSON.parse(await fs.readFile(path.join(BASE,'config/assistant-installation.json'),'utf8'));}catch{}
 if(oldReceipt?.nativeSha!==nativeSha)await run('/usr/bin/xcrun',['swiftc',nativeSource,'-o',path.join(app,'Contents/MacOS/ContextAccess')],{timeout:120000});
 const manifest={};for(const p of [path.join(CONTEXT,'bin/watcher.mjs'),path.join(CONTEXT,'bin/exporter.py'),NODE])manifest[p]=crypto.createHash('sha256').update(await fs.readFile(p)).digest('hex');
 await atomicJSON(path.join(app,'Contents/Resources/runtime-manifest.json'),manifest);
 await run('/usr/bin/codesign',['--force','--sign','-','--identifier','com.nar.codex-context-access',app]);await run('/usr/bin/codesign',['--verify','--strict',app]);
 const prefs=await service.preferences();await service.preferencesSet(prefs);
 // Only one login entry remains; component definitions stay private for controlled starts.
 for(const label of LABELS)await fs.rm(path.join(os.homedir(),'Library/LaunchAgents',label+'.plist'),{force:true});
 const master=path.join(os.homedir(),'Library/LaunchAgents/com.nar.devspace-assistant.plist');
 const esc=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;');
 await fs.writeFile(master,`<?xml version="1.0"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>com.nar.devspace-assistant</string><key>ProgramArguments</key><array><string>${esc(NODE)}</string><string>${esc(path.join(ROOT,'src/lifecycle.mjs'))}</string><string>login</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict><key>ThrottleInterval</key><integer>30</integer><key>EnvironmentVariables</key><dict><key>HOME</key><string>${esc(os.homedir())}</string><key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin</string></dict><key>StandardOutPath</key><string>${esc(path.join(BASE,'logs/assistant-startup.log'))}</string><key>StandardErrorPath</key><string>${esc(path.join(BASE,'logs/assistant-startup-error.log'))}</string></dict></plist>`);
 await run('/usr/bin/plutil',['-lint',master]);
 if(wasContext){
  const since=Date.now();await service.startJob(LABELS[3]);let ready=false;
  for(let i=0;i<40;i++){let permission;try{permission=JSON.parse(await fs.readFile(path.join(CONTEXT,'state/access-helper.json'),'utf8'));}catch{}
   const job=await service.supervisor.job(LABELS[3]);if(job.running&&permission?.ok&&permission.pid===job.pid&&Date.parse(permission.at)>=since-2000){ready=true;break;}
   await new Promise(r=>setTimeout(r,500));
  }
  if(!ready)throw new Error('更新后的系统目录授权未通过后台验证，将恢复上一版本。');
 }
 const raycast=path.join(os.homedir(),'Documents/Raycast Scripts');await fs.mkdir(path.join(raycast,'images'),{recursive:true});await fs.copyFile(path.join(repo,'raycast/images/devspace-access.png'),path.join(raycast,'images/devspace-access.png'));
 const quote=s=>"'"+s.replaceAll("'","'\"'\"'")+"'";
 for(const name of ['DevSpace 本机助手.command','DevSpace 文件夹权限.command']){const file=path.join(os.homedir(),'Applications',name);await fs.writeFile(file,'#!/bin/sh\nexec '+quote(NODE)+' '+quote(path.join(ROOT,'src/launch.mjs'))+'\n',{mode:0o755});await fs.chmod(file,0o755);}
 const script=path.join(raycast,'devspace-folder-permissions.sh');await fs.writeFile(script,'#!/bin/sh\n# @raycast.schemaVersion 1\n# @raycast.title DevSpace 本机助手\n# @raycast.mode compact\n# @raycast.icon images/devspace-access.png\n# @raycast.packageName DevSpace 本机助手\n# @raycast.description 管理连接、文件夹、上下文同步和诊断。\nexec '+quote(NODE)+' '+quote(path.join(ROOT,'src/launch.mjs'))+'\n',{mode:0o755});await fs.chmod(script,0o755);
 for(const name of ['devspace-folder-permissions.sh','devspace-repair-connection.sh','devspace-connection-status.sh','sync-codex-context.sh','status-codex-context.sh']){const src=path.join(repo,'raycast',name),dst=path.join(raycast,name);try{await fs.access(dst);}catch{try{await fs.copyFile(src,dst);await fs.chmod(dst,0o755);}catch{}}}

 await atomicJSON(path.join(BASE,'config/assistant-installation.json'),{version:'0.3.2',nativeSha,source:repo,backup,updatedAt:new Date().toISOString(),componentLabels:LABELS});
 console.log('本机整合已安装，数据与原授权保留。备份：'+backup);
}catch(e){
 console.error('安装未完成：'+e.message+'；备份位于 '+backup);
 // Restore runtime components and original login definitions on failure.
 try{await service.stopJob(LABELS[3]);}catch{}
 for(const [name,target] of [['manager',ROOT],['context-bin',path.join(CONTEXT,'bin')],['context-app',path.join(os.homedir(),'Applications/本地上下文同步.app')]])try{await fs.cp(path.join(backup,name),target,{recursive:true});}catch{}
 try{await fs.copyFile(path.join(backup,'control'),path.join(BASE,'bin/control'));}catch{}
 for(const label of LABELS)try{await fs.copyFile(path.join(backup,label+'.plist'),path.join(os.homedir(),'Library/LaunchAgents',label+'.plist'));}catch{}
 if(wasContext)try{await service.startJob(LABELS[3]);}catch{}
 throw e;
}finally{await unlock();}
try{await run('/bin/launchctl',['bootstrap','gui/'+process.getuid(),path.join(os.homedir(),'Library/LaunchAgents/com.nar.devspace-assistant.plist')]);}catch{console.log('统一启动入口可能已加载；请查看助手状态。');}
await run(NODE,[path.join(repo,'scripts/install-cli.mjs'),'--apply'],{timeout:120000,maxBuffer:1048576});

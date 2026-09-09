import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {BASE,DIR,HOME,redact,json} from './common.mjs';
const children=new Set();let spawnObserver=()=>{};
export function observeSpawns(fn){spawnObserver=fn;}
export function stopWorkers(){for(const pid of children)try{process.kill(-pid,'SIGKILL');}catch{}}

// A worker gets only its executable/runtime, own CLI state and a disposable cwd.
// No business folders, shell/interpreters, or manager credentials are inherited.
export function workerPolicy(entry,cwd){
 const q=JSON.stringify;
 const read=['/System','/usr/lib','/usr/share','/Library/Apple','/private/etc/ssl','/private/etc/resolv.conf','/private/etc/hosts','/private/etc/localtime','/private/var/db/timezone',entry.file,...(entry.runtime||[])];
 let sb='(version 1)\n(deny default)\n(allow file-read-metadata sysctl-read file-map-executable)\n(deny sysctl-read (sysctl-name "kern.procargs") (sysctl-name "kern.procargs2"))\n';
 sb+='(allow file-read* (literal "/") (subpath "/private/preboot/Cryptexes/OS") '+read.map(p=>'(subpath '+q(p)+')').join(' ')+')\n';
 sb+='(allow file-read* file-write* (subpath '+q(cwd)+') (literal "/dev/null"))\n(allow file-read* (literal "/dev/urandom") (literal "/dev/random"))\n';
 sb+='(allow process-exec (literal '+q(entry.file)+'))\n(allow process-fork)\n(allow signal (target same-sandbox))\n';
 sb+='(allow mach-lookup (global-name "com.apple.system.logger") (global-name "com.apple.system.opendirectoryd.libinfo") (global-name "com.apple.networkd") (global-name "com.apple.SystemConfiguration.configd"))\n';
 for(const p of entry.credentials||[])sb+='(allow file-read* file-write* (subpath '+q(p)+'))\n';
 if(entry.network==='https')sb+='(allow network-outbound (remote tcp "*:443") (literal "/private/var/run/mDNSResponder"))\n(allow file-read* (literal "/private/var/run/resolv.conf"))\n(allow system-info (info-type "net.link.addr"))\n(allow mach-lookup (global-name "com.apple.trustd") (global-name "com.apple.trustd.agent"))\n';
 if(entry.network==='loopback')sb+='(allow network-outbound (remote tcp "localhost:*"))\n';
 if(entry.id==='heptabase')sb+='(allow signal (target others))\n(allow mach-lookup (global-name "com.apple.securityd.xpc"))\n';
 if(['dws','lark-cli'].includes(entry.id)){
  sb+='(allow file-read* (literal "/usr/bin/security") (literal "/usr/bin") (subpath "/Library/Preferences") (subpath '+q(path.join(HOME,'Library/Keychains'))+') (subpath '+q(path.join(HOME,'Library/Preferences'))+'))\n';
  sb+='(allow process-exec (literal "/usr/bin/security"))\n(allow mach-lookup (global-name "com.apple.securityd") (global-name "com.apple.securityd.xpc") (global-name "com.apple.SecurityServer"))\n';
 }
 return sb;
}
export async function execute(entry,args,{stdin='',timeout=45000,maxBytes=1024*1024,signal,onSpawn=()=>{},sandbox=true}={}){
 const cwd=path.join(DIR,'scratch',crypto.randomUUID());await fs.mkdir(cwd,{recursive:true,mode:0o700});
 const sb=path.join(cwd,'worker.sb');let policy=workerPolicy(entry,cwd);
 if(entry.provider==='local'){
  const active=await json(path.join(BASE,'config/access/active.json'));
  if(!/^[a-zA-Z0-9-]+$/.test(active.revision))throw new Error('Invalid generation');
  policy=await fs.readFile(path.join(BASE,'config/access/generations',active.revision,'server.sb'),'utf8');
  policy+='\n(deny process-exec)\n(allow process-exec (literal '+JSON.stringify(entry.file)+'))\n(deny network*)\n';
  policy+='(allow file-read* (literal '+JSON.stringify(entry.file)+'))\n(allow file-read* file-write* (subpath '+JSON.stringify(cwd)+'))\n';
 }
 await fs.writeFile(sb,policy,{mode:0o600});
 const env={HOME,PATH:'/usr/bin:/bin',LANG:'en_US.UTF-8',TZ:'Asia/Shanghai',TMPDIR:cwd,NO_COLOR:'1',TERM:'dumb',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_SYSTEM:'/dev/null',GIT_TERMINAL_PROMPT:'0',...(entry.env||{})};
 let result;
 try{result=await new Promise(resolve=>{
  const child=spawn(sandbox?'/usr/bin/sandbox-exec':entry.file,sandbox?['-f',sb,entry.file,...(entry.prefix||[]),...args]:[...(entry.prefix||[]),...args],{cwd,env,stdio:['pipe','pipe','pipe'],shell:false,detached:true});
  let out=[],err=[],size=0,reason=null,finished=false,killTimer;
  const stop=r=>{reason??=r;try{process.kill(-child.pid,'SIGTERM');}catch{};killTimer=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}},300);killTimer.unref();};
  const abort=()=>stop('cancelled');signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  const timer=setTimeout(()=>stop('timeout'),timeout);
  child.once('spawn',()=>{children.add(child.pid);spawnObserver(child.pid);onSpawn(child.pid);});
  const collect=xs=>b=>{size+=b.length;if(size>maxBytes)stop('output_limit');else xs.push(b);};
  child.stdout.on('data',collect(out));child.stderr.on('data',collect(err));
  child.stdin.on('error',()=>{});child.stdin.end(stdin);
  function done(code,error){if(finished)return;finished=true;clearTimeout(timer);clearTimeout(killTimer);signal?.removeEventListener('abort',abort);
   // Also terminate descendants left behind after the CLI itself exits.
   try{process.kill(-child.pid,'SIGKILL');}catch{}
   children.delete(child.pid);
   const stdout=Buffer.concat(out).toString('utf8'),stderr=redact(Buffer.concat(err).toString('utf8'));
   let data;try{data=redact(JSON.parse(stdout));}catch{data=redact(stdout);}
   resolve({exitCode:code,status:reason||error||(code===0?'completed':'failed'),data,stderr,outputBytes:size,truncated:reason==='output_limit'});
  }
  child.once('error',e=>done(null,e.code||'spawn_failed'));child.once('close',code=>done(code));
 });}finally{await fs.rm(cwd,{recursive:true,force:true});}
 return result;
}

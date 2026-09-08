import fs from 'node:fs/promises';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {BASE,ROOT,SESSION,NODE} from './paths.mjs';
const run=promisify(execFile);
async function urlForExisting() {
  const session=JSON.parse(await fs.readFile(SESSION,'utf8'));
  if(session.port!==7678)throw new Error('管理端口不匹配');
  process.kill(session.pid,0);
  const res=await fetch('http://127.0.0.1:7678/internal/launch',{method:'POST',headers:{'x-launch-secret':session.launchSecret},signal:AbortSignal.timeout(1500)});
  if(!res.ok)throw new Error('管理实例校验失败');
  const {url}=await res.json();
  if(!url.startsWith('http://127.0.0.1:7678/#launch='))throw new Error('启动地址不匹配');
  return url;
}
let url;
try{url=await urlForExisting();}catch{}
if(!url){
  const log=await fs.open(path.join(BASE,'logs/access-manager.log'),'a',0o600);
  const child=spawn(NODE,[path.join(ROOT,'src/server.mjs')],{
    detached:true,stdio:['ignore',log.fd,log.fd],
    env:{PATH:'/usr/bin:/bin:/usr/sbin:/sbin',HOME:process.env.HOME,DEVSPACE_HOME:BASE,LANG:'en_US.UTF-8'}
  });child.unref();await log.close();
  for(let i=0;i<40;i++){await new Promise(r=>setTimeout(r,250));try{url=await urlForExisting();break;}catch{}}
}
if(!url) {console.error('管理页未能启动。请检查本机 7678 端口或 access-manager.log。');process.exit(1);}
if(process.argv.includes('--no-open'))console.log('管理页已就绪：http://127.0.0.1:7678（请用启动入口建立管理会话）');
else {await run('/usr/bin/open',[url]);console.log('文件夹权限管理页已打开。此终端窗口可以关闭。');}

import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {BASE, STATUS, KEY, NODE} from './paths.mjs';
const run=promisify(execFile);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export class Supervisor {
  constructor(base=BASE) {this.base=base;this.uid=process.getuid();}
  async job(label) {
    try {
      const {stdout}=await run('/bin/launchctl',['print','gui/'+this.uid+'/'+label],{timeout:4000});
      return {loaded:true,pid:Number(stdout.match(/^\s*pid = (\d+)/m)?.[1]||0),running:/^\s*state = running/m.test(stdout)};
    } catch {return {loaded:false,pid:0,running:false};}
  }
  async state() {
    const [service,tunnel]=await Promise.all([this.job('com.nar.devspace-air'),this.job('com.nar.devspace-air-tunnel')]);
    let telemetry=null;
    try {
      const packet=JSON.parse(await fs.readFile(STATUS,'utf8'));
      const key=await fs.readFile(KEY,'utf8');
      const expected=crypto.createHmac('sha256',key.trim()).update(JSON.stringify(packet.data)).digest('hex');
      if(typeof packet.signature==='string' && packet.signature.length===expected.length &&
        crypto.timingSafeEqual(Buffer.from(packet.signature),Buffer.from(expected)) &&
        packet.data.pid===service.pid && Date.now()-packet.data.at<6000)telemetry=packet.data;
    } catch {}
    return {service,tunnel,telemetry,busy:service.running && (!telemetry || telemetry.activeRequests>0 || telemetry.groups.length>0)};
  }
  async processes() {
    const {stdout}=await run('/bin/ps',['-axo','pid=,ppid=,pgid=,uid=,stat='],{timeout:4000});
    return stdout.split('\n').map(line=>line.trim().split(/\s+/)).filter(a=>a.length>=5)
      .map(a=>({pid:+a[0],ppid:+a[1],pgid:+a[2],uid:+a[3],stat:a[4]}));
  }
  async stop({allowUncertain=false}={}) {
    const before=await this.state();
    const uncertain=before.service.running && !before.telemetry;
    const tracked=before.telemetry?.groups||[];
    const groups=new Set(tracked.map(g=>g.pgid));
    const procs=await this.processes();
    const descendants=new Set(before.service.pid?[before.service.pid]:[]);
    let changed=true;
    while(changed){changed=false;for(const p of procs)if(p.uid===this.uid && descendants.has(p.ppid) && !descendants.has(p.pid)){descendants.add(p.pid);changed=true;}}
    for(const p of procs)if(descendants.has(p.pid))groups.add(p.pgid);
    // Only signal authenticated groups whose live members belong to this user.
    for(const pgid of groups) {
      if(pgid<=1 || procs.some(p=>p.pgid===pgid && p.uid!==this.uid))throw new Error('执行进程身份不一致，已阻止权限切换');
    }
    await run(path.join(this.base,'bin/control'),['stop'],{timeout:40000});
    for(const sig of ['SIGTERM','SIGKILL']){
      for(const pgid of groups){try{process.kill(-pgid,sig);}catch(e){if(e.code!=='ESRCH')throw new Error('无法结束旧执行进程，权限尚未撤销');}}
      await sleep(sig==='SIGTERM'?700:250);
    }
    const remaining=(await this.processes()).filter(p=>groups.has(p.pgid)&&!p.stat.startsWith('Z'));
    if(remaining.length)throw new Error('旧执行进程仍在运行，权限尚未撤销');
    const after=await this.state();
    if(after.service.loaded || after.tunnel.loaded)throw new Error('旧服务尚未退出');
    if(uncertain && !allowUncertain){const error=new Error('服务已停止，但执行任务记录无法验证；未确认权限已撤销，已阻止重启。');error.noRestart=true;throw error;}
    return before;
  }
  async start(before, revision) {
    const domain='gui/'+this.uid;
    const launch=async label=>{await run('/bin/launchctl',['bootstrap',domain,path.join(process.env.HOME,'Library/LaunchAgents',label+'.plist')],{timeout:10000});};
    if(before.service.loaded) {
      await launch('com.nar.devspace-air');
      let ready=false;
      for(let i=0;i<60;i++){const s=await this.state();if(s.service.running&&s.telemetry?.generation===revision){ready=true;break;}await sleep(500);}
      if(!ready)throw new Error('新服务未能加载授权版本');
    }
    if(before.tunnel.loaded)await launch('com.nar.devspace-air-tunnel');
  }
  async validate(dir, grants, probeIds=[]) {
    const profile=path.join(dir,'server.sb');
    await run('/usr/bin/sandbox-exec',['-f',profile,NODE,'-e','process.exit(0)'],{timeout:10000});
    for(const grant of grants.filter(g=>probeIds.includes(g.id))) {
      const code="const fs=require('fs');const p=process.argv[1];fs.readdirSync(p);if(process.argv[2]==='rw'){const t=require('path').join(p,'.devspace-permission-'+require('crypto').randomUUID());let fd;try{fd=fs.openSync(t,'wx',0o600);fs.writeSync(fd,'');}finally{if(fd!==undefined){fs.closeSync(fd);fs.unlinkSync(t)}}}";
      try {await run('/usr/bin/sandbox-exec',['-f',profile,NODE,'-e',code,grant.path,grant.mode],{timeout:10000});}
      catch {throw new Error('macOS 或文件系统不允许所选权限：'+grant.path+'。原授权未改变。');}
    }
  }
}

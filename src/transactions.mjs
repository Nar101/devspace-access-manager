import fs from 'node:fs/promises';
import path from 'node:path';
import {ACCESS,ACTIVE,JOURNAL,BASE} from './paths.mjs';
import {readJSON,atomicJSON,loadActive,acquireLock} from './store.mjs';
import {stageGeneration} from './policy.mjs';
export class Transactions {
  constructor(supervisor,{root=ACCESS,active=ACTIVE,journal=JOURNAL,base=BASE}={}) {
    Object.assign(this,{supervisor,root,active,journal,base});
  }
  async stage(grants) {
    return stageGeneration(grants,{root:this.root,
      template:await fs.readFile(path.join(this.root,'base-policy.sb'),'utf8'),
      baseConfig:await readJSON(path.join(this.root,'base-config.json')),base:this.base});
  }
  async recover() {
    let tx;try{tx=await readJSON(this.journal);}catch(e){if(e.code==='ENOENT')return;throw e;}
    if(!tx.previous || !tx.before)throw new Error('权限恢复记录损坏，服务保持原状，请查看诊断记录');
    const release=await acquireLock(this.root);
    try {
      await this.supervisor.stop();
      await atomicJSON(this.active,{revision:tx.previous});
      await loadActive(this.root,this.active);
      await this.supervisor.start(tx.before,tx.previous);
      await fs.rm(this.journal);
    } catch(error) {
      await this.supervisor.stop({allowUncertain:true}).catch(()=>{});
      throw error;
    } finally {await release();}
  }
  async apply(plan,onState=()=>{}) {
    const release=await acquireLock(this.root);
    let before,previous;
    try {
      const current=await loadActive(this.root,this.active);
      if(current.revision!==plan.baseRevision)throw new Error('授权已被修改，请重新确认');
      previous=current.revision;
      onState('validating','正在检查目录与权限');
      const next=await this.stage(plan.grants);
      const probes=plan.grants.filter(g=>!current.grants.some(c=>c.id===g.id&&c.mode===g.mode)).map(g=>g.id);
      await this.supervisor.validate(next.dir,next.grants,probes);
      before=await this.supervisor.state();
      await atomicJSON(this.journal,{previous,next:next.revision,before,phase:'prepared'});
      onState('stopping','正在结束旧连接');
      await this.supervisor.stop();
      await atomicJSON(this.journal,{previous,next:next.revision,before,phase:'stopped'});
      await atomicJSON(this.active,{revision:next.revision});
      await atomicJSON(this.journal,{previous,next:next.revision,before,phase:'switched'});
      onState('starting',before.service.loaded?'正在加载新授权':'正在保存授权');
      await this.supervisor.start(before,next.revision);
      await fs.rm(this.journal);
      onState('done',before.service.loaded?'授权已生效':'授权已保存，服务仍保持停止');
      return next;
    } catch(error) {
      if(error.noRestart)throw error;
      if(before&&previous) {
        onState('rolling_back','正在恢复上一有效配置');
        try {
          await this.supervisor.stop();
          await atomicJSON(this.active,{revision:previous});
          await this.supervisor.start(before,previous);
          await fs.rm(this.journal,{force:true});
        } catch {
          let stopped=false;
          try{await this.supervisor.stop({allowUncertain:true});stopped=true;}catch{}
          // Never announce a revoke on uncertain process state. Keep journal for recovery.
          throw new Error(stopped?'修改失败，自动恢复未完成；服务已停止，恢复记录已保留。':'修改失败，自动恢复未完成，无法确认服务及旧进程已退出；未确认权限已撤销。');
        }
      }
      throw error;
    } finally {await release();}
  }
}

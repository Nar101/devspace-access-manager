import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
export function createHook({manifest,key,base}) {
  const groups=new Map();
  let activeRequests=0,stopped=false;
  const statusPath=path.join(base,'state/access-status.json');
  const drain=path.join(base,'config/access/drain.json');
  function alive(pgid){try{process.kill(-pgid,0);return true;}catch(e){return e.code!=='ESRCH';}}
  function publish(){
    for(const [id,g] of groups)if(!alive(g.pgid))groups.delete(id);
    const data={pid:process.pid,at:Date.now(),generation:manifest.revision,activeRequests,groups:[...groups.values()]};
    const signature=crypto.createHmac('sha256',key).update(JSON.stringify(data)).digest('hex');
    const tmp=statusPath+'.tmp';
    fs.writeFileSync(tmp,JSON.stringify({data,signature}),{mode:0o600});fs.renameSync(tmp,statusPath);
  }
  const timer=setInterval(publish,500);timer.unref();publish();
  return {
    register(server) {
      const register=server.registerTool.bind(server);
      server.registerTool=(name,definition,handler)=>register(name,definition,async(...args)=>{
        if(fs.existsSync(drain))throw new Error('Folder permissions are being updated; retry after reconnecting.');
        activeRequests++;publish();
        try{return await handler(...args);}
        finally{activeRequests--;publish();}
      });
      server.registerTool('list_authorized_folders',{
        title:'已授权文件夹',
        description:'List this Mac’s currently authorized business folders, permissions and availability. Call this when selecting a workspace or when folder access changes. This tool cannot change permissions.',
        inputSchema:{},annotations:{readOnlyHint:true,openWorldHint:false}
      },async()=>({
        content:[{type:'text',text:JSON.stringify({generation:manifest.revision,folders:manifest.grants.map(g=>({name:path.basename(g.path),path:g.path,permission:g.mode==='rw'?'read-write':'read-only',available:fs.existsSync(g.path)}))})}]
      }));
    },
    beforeRequest(req,res){
      if(req.body?.method!=='tools/call')return true;
      if(fs.existsSync(drain)) {
        res.status(409).json({jsonrpc:'2.0',id:req.body?.id??null,error:{code:-32000,message:'Folder permissions are being updated. Reconnect and list_authorized_folders after the update.'}});
        return false;
      }
      return true;
    },
    spawned(pid) {if(pid)groups.set(pid,{pid,pgid:pid,startedAt:Date.now()});publish();},
    shutdown(){
      if(stopped)return;stopped=true;
      clearInterval(timer);
      for(const g of groups.values())try{process.kill(-g.pgid,'SIGTERM');}catch{}
      publish();
    }
  };
}

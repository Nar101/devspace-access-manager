import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
export function requestOutcome(exitCode,report,id,stopping=false){
 if(stopping)return 'cancelled';
 if(exitCode!==0)return 'error';
 if(report?.request_id!==id||!['idle','partial'].includes(report.phase))return null;
 return 'done';
}
export function startWatching(configPath){
const cfg=JSON.parse(fs.readFileSync(configPath,'utf8'));
let activeRequest=null;
let worker=null,queue=new Set(),full=true,timer=null,firstEvent=0,stopping=false;
const code=path.join(path.dirname(fileURLToPath(import.meta.url)),'exporter.py');
function schedule(){if(stopping)return;if(!firstEvent)firstEvent=Date.now();clearTimeout(timer);timer=setTimeout(pump,Date.now()-firstEvent>12000?0:3000);}
function pump(){timer=null;if(worker)return;if(!full&&!queue.size)return;
 const args=[code,'sync','--config',configPath];
 if(activeRequest)args.push('--request-id',activeRequest.id);if(!full)args.push('--paths',...[...queue].slice(0,500));
 full=false;queue.clear();firstEvent=0;
 worker=spawn('/usr/bin/python3',args,{stdio:['ignore','inherit','inherit']});
 worker.on('error',e=>{console.error('Exporter spawn failed: '+e.code);worker=null;full=true;if(!stopping)setTimeout(pump,15000);});
 worker.on('exit',status=>{worker=null;
 if(activeRequest){try{const report=JSON.parse(fs.readFileSync(path.join(cfg.state,'status.json'),'utf8'));const outcome=requestOutcome(status,report,activeRequest.id,stopping);if(outcome){const target=path.join(cfg.state,'sync-request-result.json'),temp=target+'.'+process.pid+'.tmp';fs.writeFileSync(temp,JSON.stringify({id:activeRequest.id,phase:outcome,at:Date.now(),syncPhase:report.phase,errors:report.errors||[]}),{mode:0o600});fs.renameSync(temp,target);activeRequest=null;}else full=true;}catch{full=true;}}
if(stopping)return;if(status){console.error('Exporter exited: '+status);full=true;setTimeout(pump,15000);}else if(full||queue.size)schedule();});
}
const watchers=[];
for(const key of ['sessions','archives','history_segments','history_summaries']){
 const root=cfg[key];try{const w=fs.watch(root,{recursive:true},(event,file)=>{
   if(!file){full=true;schedule();return;}
   const p=path.join(root,String(file));
   if((key==='history_segments'&&p.endsWith('/events.jsonl'))||(key==='history_summaries'&&p.endsWith('.md'))||((key==='sessions'||key==='archives')&&p.endsWith('.jsonl'))){queue.add(p);if(queue.size>500)full=true;schedule();}
 });w.on('error',()=>{full=true;schedule();});watchers.push(w);}catch(e){console.error('Source watcher unavailable: '+key+' '+e.code);}
}
// FSEvents can miss writes from some apps; compare metadata only, never reread unchanged logs.
let snapshot=new Map(),seeded=false;
function poll(){
 const request=path.join(cfg.state,'sync-request.json');try{const r=JSON.parse(fs.readFileSync(request,'utf8'));if(typeof r.id==='string'){activeRequest=r;full=true;}fs.unlinkSync(request);}catch{}
 const next=new Map();
 function walk(dir,key){let items;try{items=fs.readdirSync(dir,{withFileTypes:true});}catch{return;}
  for(const e of items){if(e.isSymbolicLink())continue;const p=path.join(dir,e.name);if(e.isDirectory()){walk(p,key);continue;}
   if(!(key==='history_segments'?e.name==='events.jsonl':key==='history_summaries'?e.name.endsWith('.md'):e.name.endsWith('.jsonl')))continue;
   try{const st=fs.statSync(p),stamp=st.size+':'+st.mtimeMs;next.set(p,stamp);if(seeded&&snapshot.get(p)!==stamp)queue.add(p);}catch{}
  }
 }
 for(const key of ['sessions','archives','history_segments','history_summaries'])walk(cfg[key],key);
 if(seeded&&[...snapshot.keys()].some(p=>!next.has(p)))full=true;
 snapshot=next;seeded=true;if(queue.size>500)full=true;if(full||queue.size)schedule();
}
poll();const fallback=setInterval(poll,5000);
const sweep=setInterval(()=>{full=true;schedule();},300000);
for(const sig of ['SIGTERM','SIGINT'])process.on(sig,()=>{stopping=true;clearInterval(sweep);clearInterval(fallback);clearTimeout(timer);for(const w of watchers)w.close();if(worker)worker.kill('SIGTERM');else process.exit(0);});
pump();

}
if(process.argv[1]&&fileURLToPath(import.meta.url)===path.resolve(process.argv[1]))startWatching(process.argv[2]);

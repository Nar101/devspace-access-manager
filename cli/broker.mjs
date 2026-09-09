import net from 'node:net';
import {StringDecoder} from 'node:string_decoder';
import {Engine} from './engine.mjs';
import {redact,json,SETTINGS} from './common.mjs';
import {observeSpawns,stopWorkers} from './process.mjs';
// An inherited socketpair is the sole ingress. No listening port, pathname socket,
// environment bearer token, or endpoint reachable by a browser or CLI worker.
const fd=Number(process.argv[2]);if(!Number.isInteger(fd)||fd<3)throw new Error('Missing inherited broker channel');
const socket=new net.Socket({fd,readable:true,writable:true});
const send=p=>{if(!socket.destroyed)socket.write(JSON.stringify(p)+'\n');};
observeSpawns(pid=>send({event:'spawned',pid}));
const engine=new Engine();await engine.init();
const timer=setInterval(()=>{void json(SETTINGS,{enabled:true}).then(p=>{if(!p.enabled){engine.stop();stopWorkers();}}).catch(()=>{engine.stop();stopWorkers();});},500);timer.unref();
let buffer='',pending=0;const decoder=new StringDecoder('utf8');
socket.on('data',chunk=>{
 buffer+=decoder.write(chunk);if(Buffer.byteLength(buffer)>512000){socket.destroy();return;}
 for(let at;(at=buffer.indexOf('\n'))>=0;){const line=buffer.slice(0,at);buffer=buffer.slice(at+1);let packet;
  try{packet=JSON.parse(line);if(!Number.isSafeInteger(packet.id)||typeof packet.method!=='string')throw Error();}catch{socket.destroy();return;}
  if(pending>=8){send({id:packet.id,error:{code:'rate_limited',message:'CLI 后台繁忙'}});continue;}
  pending++;void engine.dispatch(packet.method,packet.args).then(result=>send({id:packet.id,result})).catch(e=>send({id:packet.id,error:{code:e.code||'failed',message:redact(e.message)}})).finally(()=>pending--);
 }
});
function stop(){engine.stop();stopWorkers();socket.destroy();setTimeout(()=>process.exit(0),600).unref();}
socket.on('close',stop);socket.on('error',()=>{});process.once('SIGTERM',stop);process.once('SIGINT',stop);

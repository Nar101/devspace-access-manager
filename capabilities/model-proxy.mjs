import {grokToken,grokEnv} from './grok-auth.mjs';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
// Credentials are read by this trusted parent only; the worker sees a disposable nonce.
export async function startModelProxy({model,maxRequests=40,provider='codex',authFile,onDiagnostic=()=>{}}={}){
 if(!['codex','grok'].includes(provider))throw Error('Unknown model provider');authFile??=provider==='grok'?(process.env.GROK_AUTH_FILE||path.join(os.homedir(),'.grok/auth.json')):path.join(os.homedir(),'.codex/auth.json');
 const auth=JSON.parse(await fs.readFile(authFile,'utf8'));let token,account;
 if(provider==='codex'){if(auth.auth_mode!=='chatgpt'||!auth.tokens?.access_token||!auth.tokens?.account_id)throw Error('需要可用的Codex ChatGPT登录身份');token=auth.tokens.access_token;account=auth.tokens.account_id;}else{const entries=Object.values(auth);if(entries.length!==1||typeof entries[0].key!=='string')throw Error('Grok登录身份缺失或不唯一');token=await grokToken({authFile});}
 const nonce=crypto.randomBytes(32).toString('hex');let calls=0,totalInputBytes=0;const children=new Set();
 const server=http.createServer(async(req,res)=>{
  if(req.method!=='POST'||!(provider==='codex'?['/v1/responses']:['/v1/chat/completions','/v1/responses']).includes(req.url)||req.headers.authorization!=='Bearer '+nonce){res.writeHead(403).end();return;}
  if(++calls>maxRequests){res.writeHead(429).end('Request budget exhausted');return;}
  try{
   const chunks=[];let bytes=0;for await(const c of req){bytes+=c.length;if(bytes>2000000)throw Error('Request too large');chunks.push(c);}
   totalInputBytes+=bytes;if(totalInputBytes>8000000)throw Error('Task input budget exhausted');const data=JSON.parse(Buffer.concat(chunks));if(data.background||data.tools?.some(t=>t.type!=='function'))throw Error('Only local function tools are allowed');if(data.model!==model)throw Error('Model is fixed by task policy');data.store=false;data.stream=true;
   if(provider==='grok')token=await grokToken({authFile});const requestHeaders=['Authorization: Bearer '+token,'Content-Type: application/json','Accept: text/event-stream'];if(provider==='codex')requestHeaders.push('ChatGPT-Account-Id: '+account,'OpenAI-Beta: responses=experimental','originator: codex_cli_rs');const upstream=provider==='codex'?'https://chatgpt.com/backend-api/codex/responses':'https://api.x.ai'+req.url;
   const lines=['url = '+JSON.stringify(upstream),'request = "POST"',...requestHeaders.map(h=>'header = '+JSON.stringify(h)),'data-binary = '+JSON.stringify(JSON.stringify(data))].join('\n');
   onDiagnostic({stage:'forwarding',route:req.url});const child=spawn('/usr/bin/curl',['--silent','--show-error','--no-buffer','--include','--suppress-connect-headers','--max-time','180','--config','-'],{stdio:['pipe','pipe','pipe'],env:provider==='grok'?grokEnv():process.env});children.add(child);child.stdin.end(lines+'\n');
   let headers=Buffer.alloc(0),sent=false;
   child.stdout.on('data',b=>{if(sent){res.write(b);return;}headers=Buffer.concat([headers,b]);const i=headers.indexOf('\r\n\r\n');if(i<0){if(headers.length>65536)child.kill();return;}const h=headers.subarray(0,i).toString();const status=Number(h.match(/^HTTP\/\S+ (\d+)/)?.[1]||502);onDiagnostic({stage:'upstream',status,route:req.url});res.writeHead(status,{'content-type':h.match(/content-type:\s*([^\r\n]+)/i)?.[1]||'text/event-stream'});sent=true;res.write(headers.subarray(i+4));headers=Buffer.alloc(0);});
   child.stderr.resume();child.on('error',()=>{if(!sent)res.writeHead(502);res.end('Model transport unavailable');});child.on('close',()=>{children.delete(child);if(!sent)res.writeHead(502);res.end();});res.on('close',()=>{if(!res.writableFinished)child.kill('SIGTERM');});
  }catch(e){onDiagnostic({stage:'rejected',reason:e.message});if(!res.headersSent)res.writeHead(400);res.end('Invalid bounded model request');}
 });await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 return {port:server.address().port,nonce,calls:()=>calls,close:async()=>{for(const p of children)p.kill('SIGTERM');server.closeAllConnections();await new Promise(r=>server.close(r));}};
}

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
export const grokEnv=()=>process.env.GROK_BUILD_PROXY?({...process.env,HTTPS_PROXY:process.env.GROK_BUILD_PROXY,HTTP_PROXY:process.env.GROK_BUILD_PROXY,ALL_PROXY:process.env.GROK_BUILD_PROXY}):{...process.env};
// Fixed OAuth endpoint. Secrets travel over stdin, never argv or error output.
async function refresh(body){
 return new Promise((resolve,reject)=>{const c=spawn('/usr/bin/curl',['--silent','--show-error','--max-time','30','--config','-'],{env:grokEnv(),stdio:['pipe','pipe','pipe']});let out='',size=0;const fail=()=>reject(Error('Grok登录刷新失败，请重新登录后重试'));c.stdin.on('error',fail);c.stdin.end(['url = "https://auth.x.ai/oauth2/token"','request = "POST"','header = "Content-Type: application/x-www-form-urlencoded"','data-binary = '+JSON.stringify(body)].join('\n')+'\n');c.stdout.on('data',b=>{size+=b.length;if(size>100000){c.kill();fail();}else out+=b;});c.stderr.resume();c.on('error',fail);c.on('close',code=>{try{const r=JSON.parse(out);if(code||!r.access_token||!Number.isFinite(r.expires_in)||r.expires_in<=0)return fail();resolve(r);}catch{fail();}});});
}
const pending=new Map();
export async function grokToken({authFile=process.env.GROK_AUTH_FILE||path.join(os.homedir(),'.grok/auth.json'),refreshFn=refresh,now=()=>Date.now()}={}){
 if(pending.has(authFile))return pending.get(authFile);
 const task=(async()=>{const original=await fs.readFile(authFile,'utf8'),auth=JSON.parse(original),entries=Object.entries(auth);if(entries.length!==1||typeof entries[0][1].key!=='string')throw Error('Grok登录身份缺失或不唯一');const [name,a]=entries[0];if(a.auth_mode!=='oidc')return a.key;
 let expires=Date.parse(a.expires_at);try{const jwt=JSON.parse(Buffer.from(a.key.split('.')[1],'base64url'));if(Number.isFinite(jwt.exp))expires=Math.min(expires||Infinity,jwt.exp*1000);}catch{}
 if(Number.isFinite(expires)&&expires>now()+120000)return a.key;
 if(a.oidc_issuer!=='https://auth.x.ai'||!a.refresh_token||!a.oidc_client_id)throw Error('Grok登录过期且无法刷新，请重新登录');
 const r=await refreshFn(new URLSearchParams({grant_type:'refresh_token',refresh_token:a.refresh_token,client_id:a.oidc_client_id}).toString());
 // Do not overwrite a concurrent native login or rotated credential.
 if(await fs.readFile(authFile,'utf8')!==original)throw Error('Grok登录刚被其他进程更新，请重试');
 auth[name]={...a,key:r.access_token,refresh_token:r.refresh_token||a.refresh_token,expires_at:new Date(now()+r.expires_in*1000).toISOString()};const tmp=authFile+'.'+crypto.randomUUID()+'.tmp';try{await fs.writeFile(tmp,JSON.stringify(auth,null,2),{mode:0o600,flag:'wx'});await fs.rename(tmp,authFile);}finally{await fs.rm(tmp,{force:true});}return r.access_token;
 })();pending.set(authFile,task);try{return await task;}finally{pending.delete(authFile);}
}

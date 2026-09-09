import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
export const HOME=os.homedir();
export const BASE=process.env.DEVSPACE_HOME||path.join(HOME,'.local/share/devspace-air');
export const DIR=path.join(BASE,'cli');
export const SETTINGS=path.join(BASE,'config/cli-access.json');
export const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
export const fileHash=async p=>hash(await fs.readFile(p));
export async function json(p,fallback){try{return JSON.parse(await fs.readFile(p,'utf8'));}catch(e){if(e.code==='ENOENT'&&fallback!==undefined)return fallback;throw e;}}
export async function save(p,value){await fs.mkdir(path.dirname(p),{recursive:true,mode:0o700});const t=p+'.'+crypto.randomUUID()+'.tmp';const h=await fs.open(t,'wx',0o600);try{await h.writeFile(JSON.stringify(value));await h.sync();}finally{await h.close();}await fs.rename(t,p);}
export function fail(code,message){const e=new Error(message);e.code=code;throw e;}
export function redact(v){
 if(Array.isArray(v))return v.map(redact);
 if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,/^(?:token|access.?token|refresh.?token|client.?secret|app.?secret|password|authorization|api.?key|webhook.?token)$/i.test(k)?'[redacted]':redact(x)]));
 if(typeof v==='string')return v.replace(/\b(?:ghp_|github_pat_|sk-proj-|sk-ant-)[\w-]{16,}/g,'[redacted]').replace(/Bearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi,'Bearer [redacted]').replace(/((?:access_token|refresh_token|client_secret|api_key|password)["']?\s*[:=]\s*["']?)[^\s,"'}&]+/gi,'$1[redacted]');
 return v;
}
export const word=s=>typeof s==='string'&&/^[a-zA-Z0-9_+][a-zA-Z0-9_+.:-]{0,99}$/.test(s);
export const id=s=>typeof s==='string'&&/^[a-zA-Z0-9_-]{8,100}$/.test(s);

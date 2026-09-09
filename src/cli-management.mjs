import fs from 'node:fs/promises';
import path from 'node:path';
import {inventory} from '../cli/registry.mjs';
import {SETTINGS,DIR,json,save} from '../cli/common.mjs';
let cached=null,at=0;
export async function cliSnapshot({refresh=false}={}){
 if(refresh||!cached||Date.now()-at>60000){cached=await inventory();at=Date.now();}
 const settings=await json(SETTINGS,{enabled:true});const jobs=[];
 try{const names=await fs.readdir(path.join(DIR,'jobs'));for(const n of names.filter(n=>/^[\w-]+\.json$/.test(n))){const j=await json(path.join(DIR,'jobs',n));jobs.push({requestId:j.requestId,cli:j.cli,status:j.status,createdAt:j.createdAt,finishedAt:j.finishedAt});}}catch(e){if(e.code!=='ENOENT')throw e;}
 jobs.sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
 return {...cached,enabled:settings.enabled!==false,jobs:jobs.slice(0,10)};
}
export async function cliSetEnabled(enabled){
 if(typeof enabled!=='boolean')throw new Error('CLI 启停值无效');
 await save(SETTINGS,{enabled,updatedAt:new Date().toISOString()});
 return {enabled,message:enabled?'CLI 接入已恢复':'已暂停新 CLI 请求；正在执行的请求将被取消，已发生的业务写入不会撤销。'};
}

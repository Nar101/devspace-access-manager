import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {loadActive} from '../src/store.mjs';
import {BASE,HOME,json,save,hash,id,redact} from './common.mjs';
const inside=(p,r)=>p===r||p.startsWith(r+path.sep);
export async function captureArticle(article,writingRoot){
 const root=await fs.realpath(writingRoot),p=path.resolve(article);
 if(path.dirname(p)!==root||!p.endsWith('.md')||path.basename(p)==='AGENTS.md')throw Error('只接受写作目录根级的文章母稿');
 if(await fs.realpath(p)!==p)throw Error('文章不能是符号链接');
 const source=await fs.readFile(p,'utf8');if(/<\s*(?:img|script|iframe|object|embed)\b/i.test(source))throw Error('文章含未核对的 HTML 嵌入');if(Buffer.byteLength(source)>1000000)throw Error('文章过大');
 if(!/^写作状态:\s*(待发布|已发布)\s*$/m.test(source))throw Error('正文尚未确认');
 const slug=source.match(/^BlogSlug:\s*([a-z0-9]+(?:-[a-z0-9]+)*)\s*$/m)?.[1];if(!slug)throw Error('缺少有效 BlogSlug');
 const assets=[];
 for(const m of source.matchAll(/!\[[^\]]*\]\((?:<([^>]+)>|([^\s)]+))(?:\s+"[^"]*")?\)|!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)){
  const ref=m[1]||m[2]||m[3];if(/^[a-z]+:|^\/\//i.test(ref)||path.isAbsolute(ref))throw Error('图片必须是文章目录中的本地相对路径');
  const file=path.resolve(root,ref);if(!inside(file,path.join(root,'assets',slug))||await fs.realpath(file)!==file)throw Error('图片必须位于当前文章 assets/slug 中且不能经过符号链接');
  if(!/\.(png|jpe?g|webp|svg)$/i.test(file))throw Error('不支持的图片类型');
  const bytes=await fs.readFile(file);if(bytes.length>12000000)throw Error('图片过大');if(file.endsWith('.svg')&&/<script|foreignObject|(?:href|src)\s*=\s*["'](?!#)|url\(\s*(?!#)/i.test(bytes.toString()))throw Error('SVG 含活动内容或外部引用');assets.push({relative:path.relative(root,file),bytes});
 }
 // Reject unparsed image syntax instead of letting the privileged renderer resolve it.
 if((source.match(/!\[/g)||[]).length!==assets.length)throw Error('存在无法核对的图片引用');
 return {source,slug,file:p,assets,revision:hash(source+'\n'+assets.map(a=>a.relative+':'+hash(a.bytes)).join('\n'))};
}
export class Publisher{
 constructor({root=path.join(BASE,'manager','publisher-runtime'),onSpawn=()=>{},grants=loadActive,configPath=path.join(BASE,'config/publisher.json')}={}){this.grants=grants;this.configPath=configPath;this.root=root;this.onSpawn=onSpawn;this.children=new Map();this.serial=Promise.resolve();}
 async init(){await fs.mkdir(path.join(this.root,'jobs'),{recursive:true,mode:0o700});for(const f of await fs.readdir(path.join(this.root,'jobs'))){if(!f.endsWith('.json'))continue;const p=path.join(this.root,'jobs',f),j=await json(p);if(j.status==='running'){j.status='needs_reconciliation';j.message='后台重启，结果需核对；不要换任务编号重复发布';await save(p,j);}}}
 async dispatch(method,a){const operation=async()=>this.handle(method,a);const p=this.serial.then(operation,operation);this.serial=p.catch(()=>{});return p;}
 async handle(method,a={}){
 const config=await json(this.configPath);
 if(!config.enabled)throw Error('内容发布入口已暂停');
 if(method==='publisher_result'){if(!id(a.requestId))throw Error('任务编号无效');return json(this.jobPath(a.requestId));}
 if(typeof config.siteBaseUrl!=='string'||!/^https:\/\//.test(config.siteBaseUrl))throw Error('Configure your own publisher siteBaseUrl first');
 const blogMethod=method;const wechat=method.startsWith('publisher_wechat_');if(wechat)method=method==='publisher_wechat_prepare'?'publisher_prepare':method==='publisher_wechat_upload'?'publisher_publish':method;
 const allowed=method==='publisher_inspect'?['article']:method==='publisher_prepare'?['article','revision','requestId']:method==='publisher_publish'?['article','revision','requestId','prepareId','authorizedWrite']:[];
 if(!allowed.length||Object.keys(a).some(k=>!allowed.includes(k)))throw Error('不支持的发布操作或参数');
 const access=await this.grants();if(!access.grants.some(g=>inside(path.resolve(a.article),g.path)))throw Error('文章目录不在当前授权范围');
 const captured=await captureArticle(a.article,config.writingRoot);
 if(method==='publisher_inspect')return {article:captured.file,revision:captured.revision,slug:captured.slug,images:captured.assets.length,channels:{blog:'available',wechat:'draft_available'},instructions:'先 prepare 并查询结果；用户确认同一版本后 publish。公众号使用 publisher_wechat_prepare / publisher_wechat_upload，只保存草稿。'};
 if(!id(a.requestId)||a.revision!==captured.revision)throw Error('任务编号无效或文章/图片已变化，请重新 inspect');
 const digest=hash(JSON.stringify({method:blogMethod,...a})),old=await json(this.jobPath(a.requestId),null);if(old){if(old.digest!==digest)throw Error('同一任务编号不能用于不同请求');return old;}
 if(this.children.size)throw Error('已有发布任务执行中，请先查询其结果');
 let prepared=null;
 if(method==='publisher_publish'){
  if(a.authorizedWrite!==true||!id(a.prepareId))throw Error('发布需要用户对当前文章版本的明确授权和预览任务编号');
  prepared=await json(this.jobPath(a.prepareId));if(prepared.method!=='publisher_prepare'||!!prepared.wechat!==wechat||prepared.status!=='completed'||prepared.revision!==a.revision||prepared.article!==captured.file)throw Error('没有匹配当前版本的已完成预览');
  const other=(await Promise.all((await fs.readdir(path.join(this.root,'jobs'))).filter(f=>f.endsWith('.json')).map(f=>json(path.join(this.root,'jobs',f))))).find(j=>j.method==='publisher_publish'&&j.prepareId===a.prepareId);if(other)throw Error('这个预览已有发布任务 '+other.requestId+'，请查询该任务避免重复发布');
 }
 const sandbox=prepared?.snapshot||path.join(this.root,'snapshots',a.requestId),writing=path.join(sandbox,'303 内容与个人品牌','写作');
 if(!prepared){await fs.mkdir(writing,{recursive:true,mode:0o700});await fs.writeFile(path.join(writing,path.basename(captured.file)),captured.source,{mode:0o600});for(const asset of captured.assets){const p=path.join(writing,asset.relative);await fs.mkdir(path.dirname(p),{recursive:true});await fs.writeFile(p,asset.bytes);}}
 const j={requestId:a.requestId,prepareId:a.prepareId,method,wechat,digest,revision:a.revision,article:captured.file,slug:captured.slug,snapshot:sandbox,status:'running',startedAt:new Date().toISOString()};await save(this.jobPath(a.requestId),j);
 let args=[path.join(this.root,'vendor','scripts','blog-publisher.mjs'),method==='publisher_prepare'?'preview':'publish','--article',path.join(writing,path.basename(captured.file)),'--workspace-root',sandbox,'--blog-root',config.blogRoot,'--runtime-root',path.join(sandbox,'runtime')];
 if(wechat)args=[path.join(BASE,'manager/cli/wechat-runner.mjs'),method==='publisher_prepare'?'prepare':'upload',path.join(writing,path.basename(captured.file)),path.join(this.root,'vendor'),config.blogRoot,config.siteBaseUrl];
 const child=spawn(config.node,args,{detached:true,stdio:['ignore','pipe','pipe'],cwd:this.root,env:{HOME,PATH:config.path,LANG:'en_US.UTF-8',NAR_RELEASE_SCRIPT:path.join(this.root,'vendor','article-release.mjs')}});this.children.set(a.requestId,child);this.onSpawn(child.pid);
 let output='';const deadline=setTimeout(()=>{try{process.kill(-child.pid,'SIGTERM');}catch{}},25*60*1000);const collect=b=>{output=(output+b.toString()).slice(-1000000);};child.stdout.on('data',collect);child.stderr.on('data',collect);
 child.once('error',e=>{output+='\n'+e.message;});child.once('close',async code=>{clearTimeout(deadline);try{const lines=output.split('\n');let result;for(const line of lines){try{const p=JSON.parse(line);if(p.type==='result')result=p;}catch{}}j.status=code===0&&result?.ok?'completed':method==='publisher_publish'?'needs_reconciliation':'failed';j.finishedAt=new Date().toISOString();j.exitCode=code;j.result=redact(result||{error:output.slice(-5000)});if(j.status==='completed'&&method==='publisher_publish'&&!wechat){const now=await captureArticle(captured.file,config.writingRoot);if(now.revision===a.revision&&(await this.grants()).grants.some(g=>g.mode==='rw'&&inside(captured.file,g.path))){let updated=now.source;for(const [key,value] of Object.entries({'Blog状态':'已发布','Blog链接':config.siteBaseUrl.replace(/\/$/,'')+'/articles/'+captured.slug,'Blog发布时间':j.finishedAt,'写作状态':'已发布','待解决':'','下一步':''})){updated=updated.replace(new RegExp('^'+key+':.*$','m'),key+': '+value);}await fs.writeFile(captured.file,updated);j.articleUpdated=true;}else j.articleUpdated=false;}await save(this.jobPath(a.requestId),j);}finally{this.children.delete(a.requestId);}});
 return j;
 }
 jobPath(requestId){return path.join(this.root,'jobs',requestId+'.json');}
 stop(){for(const child of this.children.values())try{process.kill(-child.pid,'SIGTERM');}catch{}}
}

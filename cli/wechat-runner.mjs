import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
const [action,article,vendor,blogRoot,siteBaseUrl]=process.argv.slice(2);
try{
 const source=await fs.readFile(article,'utf8'),dir=path.dirname(article),slug=source.match(/^BlogSlug:\s*(\S+)/m)?.[1],out=path.join(dir,'wechat');await fs.mkdir(out,{recursive:true});
 const md=path.join(out,'article.md'),html=path.join(out,'content.html'),preview=path.join(out,'preview.html');
 const renderer=path.join(vendor,'wechat-draft-publisher/scripts/push-draft.mjs');
 const run=(cmd,args)=>execFileSync(cmd,args,{encoding:'utf8',maxBuffer:2000000,timeout:180000});
 let cover;
 if(action==='prepare'){
  const sharp=createRequire(path.join(vendor,'package.json'))('sharp');let content=source;let n=0;
  for(const m of source.matchAll(/!\[[^\]]*\]\((?:<([^>]+)>|([^\s)]+))(?:\s+"[^"]*")?\)/g)){
   const file=path.resolve(dir,m[1]||m[2]),png=path.join(out,'image-'+(++n)+'.png');await sharp(file,{density:160}).resize(1200,900,{fit:'contain',background:'#101114'}).png({compressionLevel:9}).toFile(png);if(!cover)cover=png;content=content.replace(m[0],`![配图 ${n}](${path.basename(png)})`);
  }
  if(!cover)throw Error('缺少公众号封面图');await fs.writeFile(md,content);await fs.writeFile(path.join(out,'cover.json'),JSON.stringify(cover));
  run(process.execPath,[renderer,md,'--theme','graphite','--no-body-cover','--no-remote-images','--image-profile','pc','--cover',cover,'--content-out',html,'--out',preview]);
  run('/usr/bin/python3',[path.join(vendor,'validate_gzh_html.py'),html]);
  console.log(JSON.stringify({type:'result',ok:true,command:'wechat_prepare',preview,html,images:n}));
 }else if(action==='upload'){
  cover=JSON.parse(await fs.readFile(path.join(out,'cover.json'),'utf8'));
  run('/usr/bin/python3',[path.join(vendor,'validate_gzh_html.py'),html]);
  const output=run(process.execPath,[renderer,md,'--theme','graphite','--no-body-cover','--no-remote-images','--image-profile','pc','--cover',cover,'--content-html',html,'--source-url',siteBaseUrl.replace(/\/$/,'')+'/articles/'+slug,'--push']);
  const draftId=output.match(/draft_media_id:\s*(\S+)/)?.[1],verifiedTitle=output.match(/draft_verified_title:\s*(.+)/)?.[1]?.trim();if(!draftId||!verifiedTitle)throw Error('未取得草稿回读结果');
  console.log(JSON.stringify({type:'result',ok:true,command:'wechat_upload',draftId,verifiedTitle,published:false}));
 }else throw Error('不支持的公众号操作');
}catch(e){console.log(JSON.stringify({type:'result',ok:false,error:e.message}));process.exitCode=1;}

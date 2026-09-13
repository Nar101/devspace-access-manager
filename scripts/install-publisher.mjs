import fs from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {BASE,ROOT,NODE} from '../src/paths.mjs';
import {Supervisor} from '../src/supervisor.mjs';
import {atomicJSON} from '../src/store.mjs';
const source=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),home=os.homedir(),workspace=process.env.DEVSPACE_WORKSPACE,blog=process.env.DEVSPACE_BLOG_ROOT;
if(!process.argv.includes('--apply')){console.log('Use --apply to install the reviewed publication adapter into an existing DevSpace deployment.');process.exit(0);}
if(!workspace||!blog||!process.env.DEVSPACE_SITE_URL)throw Error('Set DEVSPACE_WORKSPACE, DEVSPACE_BLOG_ROOT and DEVSPACE_SITE_URL before installing your own publishing adapter');
const supervisor=new Supervisor(),state=await supervisor.state();if(state.busy)throw Error('DevSpace 有任务执行中，请等待完成再安装');
const backup=path.join(BASE,'backups','publisher-'+Date.now());await fs.mkdir(backup,{recursive:true});
const files=['cli/broker.mjs','cli/publisher.mjs','cli/wechat-runner.mjs','runtime/cli-compat.mjs','runtime/cli-client.mjs'];
for(const f of files){await fs.mkdir(path.dirname(path.join(backup,f)),{recursive:true});try{await fs.copyFile(path.join(ROOT,f),path.join(backup,f));}catch(e){if(e.code!=='ENOENT')throw e;}await fs.copyFile(path.join(source,f),path.join(ROOT,f));}
const vendor=path.join(ROOT,'publisher-runtime/vendor');await fs.mkdir(vendor,{recursive:true});
await fs.cp(path.join(blog,'scripts'),path.join(vendor,'scripts'),{recursive:true});
await fs.copyFile(path.join(workspace,'.agents/skills/writing-orchestrator/scripts/article-release.mjs'),path.join(vendor,'article-release.mjs'));
for(const n of ['wechat-draft-publisher','publisher-shared-utils'])await fs.cp(path.join(workspace,'303 内容与个人品牌/写作/.agents/skills',n),path.join(vendor,n),{recursive:true});
await fs.copyFile(path.join(workspace,'.agents/skills/gzh-design/scripts/validate_gzh_html.py'),path.join(vendor,'validate_gzh_html.py'));
await fs.writeFile(path.join(vendor,'package.json'),JSON.stringify({name:'devspace-publisher-runtime',private:true,dependencies:{sharp:'0.35.4'}}));
execFileSync(path.join(path.dirname(NODE),'npm'),['install','--ignore-scripts','--no-audit','--no-fund'],{cwd:vendor,env:{...process.env,PATH:path.dirname(NODE)+':'+process.env.PATH},stdio:'pipe',timeout:180000});
await atomicJSON(path.join(BASE,'config/publisher.json'),{enabled:true,siteBaseUrl:process.env.DEVSPACE_SITE_URL,writingRoot:path.join(workspace,'303 内容与个人品牌/写作'),blogRoot:blog,node:NODE,path:path.dirname(NODE)+':/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin'});
console.log(JSON.stringify({installed:true,backup,restartRequired:state.service.running}));

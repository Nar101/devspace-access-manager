import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {captureArticle} from '../cli/publisher.mjs';
test('publisher binds article and asset bytes and refuses escapes',async t=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'publisher-test-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));await fs.mkdir(path.join(root,'assets/sample'),{recursive:true});const image=path.join(root,'assets/sample/a.png'),article=path.join(root,'article.md');await fs.writeFile(image,'image');await fs.writeFile(article,'---\n写作状态: 待发布\nBlogSlug: sample\n---\n# Test\n![a](assets/sample/a.png)');const a=await captureArticle(article,root);await fs.writeFile(image,'changed');assert.notEqual((await captureArticle(article,root)).revision,a.revision);
 await fs.writeFile(article,'---\n写作状态: 待发布\nBlogSlug: sample\n---\n![secret](../../secret.png)');await assert.rejects(captureArticle(article,root));await fs.unlink(image);await fs.symlink('/etc/passwd',image);await fs.writeFile(article,'---\n写作状态: 待发布\nBlogSlug: sample\n---\n![a](assets/sample/a.png)');await assert.rejects(captureArticle(article,root));await assert.rejects(captureArticle('/etc/passwd',root));
});
import {Publisher} from '../cli/publisher.mjs';
test('publication rejects stale revisions, unknown actions, and unapproved writes before spawning',async t=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'publisher-auth-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));const article=path.join(root,'article.md');await fs.writeFile(article,'---\n写作状态: 待发布\nBlogSlug: example\n---\n# Example\nText');const configPath=path.join(root,'config.json');await fs.writeFile(configPath,JSON.stringify({enabled:true,siteBaseUrl:'https://example.com',writingRoot:root}));const p=new Publisher({root:path.join(root,'runtime'),configPath,grants:async()=>({grants:[{path:root,mode:'rw'}]})});await p.init();const a=await p.dispatch('publisher_inspect',{article});await assert.rejects(p.dispatch('publisher_prepare',{article,revision:'bad',requestId:'test-prepare'}));await assert.rejects(p.dispatch('publisher_publish',{article,revision:a.revision,requestId:'test-publish',prepareId:'fake-preview',authorizedWrite:false}));await assert.rejects(p.dispatch('publisher_shell',{article,cmd:'whoami'}));await assert.rejects(p.dispatch('publisher_result',{requestId:'../config'}));p.grants=async()=>({grants:[]});await assert.rejects(p.dispatch('publisher_inspect',{article}),/当前授权/);assert.equal(p.children.size,0);
});

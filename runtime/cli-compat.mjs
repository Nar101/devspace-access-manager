export const compatibilityGuide=`DevSpace CLI is available even when this client's imported tool list only shows the original tools. Use exec_command with the workspaceId just opened and cmd exactly "devspace-cli " followed by one JSON object. This is a server-side structured RPC, NOT a shell program and NOT permission to bypass the sandbox. Example: devspace-cli {"method":"discover","args":{"query":"heptabase"}}. show_changes now provides read-only net changes since the latest workspace open; fallback via devspace-cli method workspace_changes with {workspaceId}. It is not Git history; isolated task diffs use task_changes. For capability discovery use capabilities_list with args {}. For public X searches use grok.search (query only, no local file upload); grok.develop is coding-only with search disabled. Tasks: task_submit {requestId,kind:"codex.develop" or "grok.develop" or "grok.search",project:absolutePath,prompt}; task_continue {requestId:newId,parentId:previousId,prompt}; task_changes {requestId} returns a bounded change bundle for review, not source application; task_result {requestId}; task_cancel {requestId}; task_artifact {requestId,path:returnedArtifactPath}. Jobs run in isolated copies; needs_review is not verification or source modification. Project delivery: task_verify {requestId:newId,parentId:developmentId} independently installs locked npm dependencies and runs test/build; task_apply_preview {requestId:developmentId} returns exact revision and changes; task_apply {requestId:developmentId,revision,authorizedWrite:true} only after explicit current user approval of those changes; task_apply_status {requestId}; task_revert with the same revision and explicit approval restores backed-up changes unless files changed. Never invent approval. Other methods: discover, describe, skill, run, result, cancel; publishing: publisher_inspect {article:absolutePath}, publisher_prepare {article,revision,requestId}, publisher_result {requestId}, publisher_publish {article,revision,prepareId,requestId,authorizedWrite:true}. Inspect returns a content+image revision. Prepare creates an isolated snapshot and validates it; poll publisher_result until completed. Publish requires current user approval of this exact revision; return and query the original requestId after interruptions, never blindly repeat. WeChat draft preparation/upload use publisher_wechat_prepare / publisher_wechat_upload with the same parameters, revision and matching prepareId; upload saves and reads back a draft, never publishes or mass-sends. Local Codex/computer history is available as read-only exported files at ~/Workspace/CodexHistory; open that directory and read README.md and 同步状态.md, not ~/.codex. describe args: {"cli":"heptabase","command":["whiteboard","list"]}. run args: {"cli":"heptabase","command":["whiteboard","list"],"parameters":{"limit":"20"},"taskId":"stable-task-id","requestId":"unique-request-id"}. Query result with the same requestId; preserve pagination. Prefer dedicated cli_* tools if present. Business writes still require the current user's actual authorization, and all CLI policy checks remain enforced. Do not substitute the separate Heptabase connector when validating this CLI path.`;
export function parseCompatibility(cmd){
 if(typeof cmd!=='string'||!/^\s*devspace-cli(?:\s|$)/.test(cmd))return null;
 if(Buffer.byteLength(cmd)>256000)throw new Error('CLI 请求过大');
 let p;try{p=JSON.parse(cmd.trimStart().slice('devspace-cli'.length).trim());}catch{throw new Error('devspace-cli 后必须是单个 JSON 对象；不支持 shell 拼接');}
 if(!p||Array.isArray(p)||typeof p!=='object'||Object.keys(p).some(k=>!['method','args'].includes(k))||!['workspace_changes','capabilities_list','task_submit','task_verify','task_apply_preview','task_apply','task_apply_status','task_revert','task_continue','task_changes','task_result','task_cancel','task_artifact','discover','describe','skill','run','result','cancel','publisher_inspect','publisher_prepare','publisher_publish','publisher_result','publisher_wechat_prepare','publisher_wechat_upload'].includes(p.method)||!p.args||typeof p.args!=='object'||Array.isArray(p.args))throw new Error('CLI 请求必须包含有效的 method 与 args 对象');
 return p;
}
export function wrapCompatibility(name,handler,client,workspaces){
 return async(...args)=>{
  if(name==='exec_command'){
   const p=parseCompatibility(args[0]?.cmd);
   if(p){
    if(!workspaces.has(args[0].workspaceId))throw new Error('请先用 open_workspace 打开一个当前授权目录，再使用返回的 workspaceId 调用 CLI');
    if(args[0].tty||args[0].workingDirectory&&args[0].workingDirectory!=='.')throw new Error('CLI 兼容通道不使用 PTY 或相对工作目录；文件参数请使用已授权的绝对路径');
    const started=Date.now(),result=JSON.stringify(await client.call(p.method,p.args));
    return {content:[{type:'text',text:result}],structuredContent:{result,running:false,exitCode:0,outputTruncated:false,wallTimeMs:Date.now()-started}};
   }
  }
  const result=await handler(...args);
  if(name==='open_workspace'&&!result.isError&&result.structuredContent?.workspaceId){
   workspaces.add(result.structuredContent.workspaceId);
   if(result.structuredContent.root)await client.call('workspace_checkpoint',{workspaceId:result.structuredContent.workspaceId,project:result.structuredContent.root});
   return {...result,structuredContent:{...result.structuredContent,instruction:(result.structuredContent.instruction||'')+'\n\n'+compatibilityGuide},content:[...(result.content||[]),{type:'text',text:compatibilityGuide}]};
  }
  return result;
 };
}

export const compatibilityGuide=`DevSpace CLI is available even when this client's imported tool list only shows the original tools. Use exec_command with the workspaceId just opened and cmd exactly "devspace-cli " followed by one JSON object. This is a server-side structured RPC, NOT a shell program and NOT permission to bypass the sandbox. Example: devspace-cli {"method":"discover","args":{"query":"heptabase"}}. Methods: discover, describe, skill, run, result, cancel. describe args: {"cli":"heptabase","command":["whiteboard","list"]}. run args: {"cli":"heptabase","command":["whiteboard","list"],"parameters":{"limit":"20"},"taskId":"stable-task-id","requestId":"unique-request-id"}. Query result with the same requestId; preserve pagination. Prefer dedicated cli_* tools if present. Business writes still require the current user's actual authorization, and all CLI policy checks remain enforced. Do not substitute the separate Heptabase connector when validating this CLI path.`;
export function parseCompatibility(cmd){
 if(typeof cmd!=='string'||!/^\s*devspace-cli(?:\s|$)/.test(cmd))return null;
 if(Buffer.byteLength(cmd)>256000)throw new Error('CLI 请求过大');
 let p;try{p=JSON.parse(cmd.trimStart().slice('devspace-cli'.length).trim());}catch{throw new Error('devspace-cli 后必须是单个 JSON 对象；不支持 shell 拼接');}
 if(!p||Array.isArray(p)||typeof p!=='object'||Object.keys(p).some(k=>!['method','args'].includes(k))||!['discover','describe','skill','run','result','cancel'].includes(p.method)||!p.args||typeof p.args!=='object'||Array.isArray(p.args))throw new Error('CLI 请求必须包含有效的 method 与 args 对象');
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
   return {...result,structuredContent:{...result.structuredContent,instruction:(result.structuredContent.instruction||'')+'\n\n'+compatibilityGuide},content:[...(result.content||[]),{type:'text',text:compatibilityGuide}]};
  }
  return result;
 };
}

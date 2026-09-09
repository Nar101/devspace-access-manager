import {execute} from './process.mjs';
import {fail,word} from './common.mjs';
const forbiddenCommand=/^(auth|config|profile|login|logout|install|update|upgrade|plugin|plugins|api|raw|exec|eval|shell|run|completion|skills|schema|helper|init-volc)$/i;
const sensitiveFlag=/(?:^|[-_])(?:token|secret|password|credential|debug|verbose|profile|client|endpoint|base-url|host|proxy|env|shell|exec|eval|command|config|plugin|webhook|as|identity|output|download|upload|file|path|directory|dir)(?:$|[-_])/i;
export function commandParts(command){if(!Array.isArray(command)||command.length>6||command.some(x=>!word(x)))fail('invalid_command','命令必须是结构化子命令数组');return command;}
export function parseHelp(text){
 const parameters={};
 for(const line of text.split('\n')){
  const m=line.match(/^\s+(?:-[A-Za-z],\s+)?--([a-zA-Z0-9-]+)(?:[ =](<[^>]+>|\[[^\]]+\]|string(?:Array|Slice)?|int(?:64)?|float|bool))?\s{2,}(.*)$/);
  if(m)parameters[m[1]]={type:!m[2]?'boolean':/^int/.test(m[2])?'integer':'string',description:m[3]};
 }
 const commands=[];let inCommands=false;
 for(const line of text.split('\n')){
  if(/^(Commands|Available Commands|Lark domains):/.test(line)){inCommands=true;continue;}
  if(inCommands&&/^\S/.test(line))inCommands=false;
  if(inCommands){const m=line.match(/^  ([a-zA-Z0-9_+.-]+)(?:\s|$)/);if(m&&m[1]!=='help')commands.push(m[1]);}
 }
 const usage=text.match(/^Usage:\s*\n?\s*(.+)$/m)?.[1]||'';
 const positional=[...usage.replace(/\[options\]|\[flags\]|\[command\]/g,'').matchAll(/<([\w-]+)>|\[([\w-]+)\]/g)].map(m=>({name:m[1]||m[2],required:!!m[1]}));
 return {parameters,commands,positional};
}
const cache=new Map();
export async function help(entry,command=[]){
 commandParts(command);const key=entry.id+JSON.stringify(command);if(cache.has(key))return cache.get(key);
 // Never turn an arbitrary path into a help invocation: traverse discovered children.
 if(command.length){const parent=await help(entry,command.slice(0,-1));if(!parent.commands.includes(command.at(-1)))fail('unknown_command','未在 CLI 帮助中找到这个子命令');}
 const r=await execute(entry,[...command,'--help'],{maxBytes:192000});if(r.status!=='completed')fail('help_failed','无法读取 CLI 帮助：'+r.stderr);
 const text=typeof r.data==='string'?r.data:JSON.stringify(r.data);const parsed={...parseHelp(text),text};cache.set(key,parsed);return parsed;
}
export async function schema(entry,command=[]){
 commandParts(command);
 if(entry.provider==='local'){
  const r=await execute({...entry,provider:'inspect',runtime:['/opt/homebrew/Cellar']},['--help'],{maxBytes:96000,timeout:5000});
  return {command,help:r.data,helpStatus:r.status,parameters:{argv:{type:'array',description:'原生 argv；无 shell 展开。用绝对路径选择已授权业务文件。'},stdin:{type:'string',description:'可选文本标准输入'}},effect:['rg','jq','ffprobe','sleep','cat','wc','head','tail'].includes(entry.id)?'read':'unknown',executable:true,scope:'current_folder_sandbox_no_network'};
 }
 if(entry.provider==='dws'){
  if(!command.length){const r=await execute(entry,['schema','--compact'],{maxBytes:512000});if(r.status!=='completed')fail('schema_failed','无法读取 dws 能力目录');return {catalog:r.data,command:[],executable:false};}
  if(command.some(x=>forbiddenCommand.test(x)))fail('restricted_command','登录、配置和原始执行入口只能在本机使用');
  const r=await execute(entry,['schema','--cli-path',command.join(' '),'--compact'],{maxBytes:256000});
  if(r.status!=='completed'||typeof r.data!=='object')fail('schema_failed','CLI 没有返回有效 Schema');
  const s=r.data;return {...s,command,executable:s.cli_path===command.join(' ')&&['read','write'].includes(s.effect),parameters:s.parameters||{}};
 }
 const h=await help(entry,command),leaf=h.commands.length===0;
 let effect='unknown';
 if(entry.provider==='lark')effect=h.text.match(/^Risk:\s*(read|write|high-risk-write)/m)?.[1]||'unknown';
 if(entry.provider==='commander'){
  if(/^(read(?:-layout)?|list|cards|lint|metadata|properties|messages)$/.test(command.at(-1)||''))effect='read';
  else if(/^(create|append|save|set-property|rename|trash|restore|add|remove|add-card|remove-card|move|create-shortcut|place-objects|move-objects|move-objects-across|arrange-objects|align-objects|resize-objects|recolor-objects|remove-objects|create-section|create-connections|update-connection|create-mind-map|update-mind-map)$/.test(command.at(-1)||''))effect='write';
 }
 return {...h,command,effect,executable:leaf&&['read','write'].includes(effect),risk:effect==='write'?'write':'low'};
}
export function validate(entry,s,command,parameters={},positional=[],authorizedWrite=false){
 if(!parameters||typeof parameters!=='object'||Array.isArray(parameters)||!Array.isArray(positional))fail('invalid_arguments','参数必须是对象，位置参数必须是数组');
 if(command.some(x=>forbiddenCommand.test(x))||command[0]==='local-file')fail('restricted_command','该命令可能改变执行权限、身份或间接读取本地文件，只能在本机使用');
 if(!s.executable)fail('unknown_effect','该命令没有可核验的执行语义，尚未开放远程执行');
 if(s.effect!=='read'&&!authorizedWrite)fail('write_authorization_required','写入需对应用户当前明确请求；请先确认目标、动作与内容');
 if(/permission|member.*(?:add|remove)|owner|admin|credential|secret|token|webhook|auth/i.test(command.join(' ')))fail('elevated_risk','凭据、权限或成员管理未开放远程执行');
 const args=[...command];let stdin='';
 for(const [name,v]of Object.entries(parameters)){
  if(!/^[a-z][a-z0-9-]*$/.test(name)||!Object.hasOwn(s.parameters,name))fail('unknown_parameter','Schema 中不存在参数 '+name);
  if(sensitiveFlag.test(name)||['yes','dry-run','mock','jq','transform','format','json','help','version'].includes(name))fail('restricted_parameter','参数 '+name+' 由本机管理或存在越界风险');
  const p=s.parameters[name];
  if(name==='input'){
   if(entry.provider!=='commander'||!v||typeof v!=='object'||JSON.stringify(v).length>100000)fail('invalid_input','input 只接受有限大小的内联 JSON，不接受路径');
   stdin=JSON.stringify(v);args.push('--input=-');continue;
  }
  const t=p.type;
  if(t==='boolean'&&typeof v!=='boolean'||t==='integer'&&!Number.isSafeInteger(v)||t==='number'&&(typeof v!=='number'||!Number.isFinite(v))||t==='string'&&typeof v!=='string'||t==='array'&&(!Array.isArray(v)||v.some(x=>typeof x!=='string')))fail('invalid_type','参数 '+name+' 类型错误');
  if(!['boolean','integer','number','string','array'].includes(t))fail('unsupported_type','参数结构尚未适配：'+name);
  if(p.enum&&!p.enum.includes(v))fail('invalid_enum','参数 '+name+' 不在允许选项内');
  const value=Array.isArray(v)?v.join(','):String(v);if(value.length>100000||value.includes('\0')||value.startsWith('@'))fail('invalid_value','参数过长、含无效字符或使用了本地文件展开语法');
  args.push('--'+name+'='+value);
 }
 for(const [name,p]of Object.entries(s.parameters))if(p.required&&!Object.hasOwn(parameters,name))fail('required_parameter','缺少必填参数 '+name);
 if(positional.length>(s.positional||[]).length||positional.length<(s.positional||[]).filter(p=>p.required).length)fail('invalid_positional','位置参数数量与帮助不一致');
 for(const value of positional){if(typeof value!=='string'||value.startsWith('-')||value.includes('\0')||value.length>2000)fail('invalid_positional','位置参数无效');args.push(value);}
 return {args,stdin,effect:s.effect};
}

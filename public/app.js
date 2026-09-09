const $=id=>document.getElementById(id);
let pendingAutoStart=null,firstAssistantRender=true,assistantState=null,lastControl='',accessToken='',csrf='',state=null,edit=null,preview=null,lastOperation='',polling=false,activity=0,previewRequest=0,firstRender=true;
const sessionKey='devspace.manager.session.v2';
function clearSession(){accessToken='';csrf='';try{sessionStorage.removeItem(sessionKey);}catch{}}
function rememberSession(session){accessToken=session.accessToken;csrf=session.csrf;try{sessionStorage.setItem(sessionKey,JSON.stringify({accessToken,csrf}));}catch{}}
const busy=()=>state?.operation&&!['done','error','cancelled'].includes(state.operation.phase);
function notice(message,error=false){$('notice').textContent=message;$('notice').className=error?'error':'';$('notice').hidden=!message;}
async function api(url,body){
  const headers=accessToken?{Authorization:'Bearer '+accessToken}:{};
  if(body!==undefined)Object.assign(headers,{'Content-Type':'application/json','X-CSRF-Token':csrf});
  const res=await fetch('/api/'+url,{method:body===undefined?'GET':'POST',credentials:url==='session'&&body!==undefined?'same-origin':'omit',redirect:'error',headers,body:body===undefined?undefined:JSON.stringify(body)});
  const data=await res.json();
  if(res.status===401)clearSession();
  if(!res.ok)throw new Error(data.error||'请求失败');
  return data;
}
function closeEditor(){previewRequest++;edit=null;preview=null;$('editor').hidden=true;}
function render(){
  if(firstRender){if(state.operation&&!busy())lastOperation=state.operation.id+state.operation.phase;firstRender=false;}
  const s=state.service;
  $('service-dot').className='dot'+(s.running&&s.tunnelRunning?' online':'');
  $('service-status').textContent=s.running?(s.tunnelRunning?'服务已连接':'本机服务运行中'):'服务已停止';
  $('service-detail').textContent=s.busy?'有任务正在执行':s.running?'授权变更会自动重新连接':'修改会保存，服务保持停止';
  $('count').textContent=state.grants.length;
  $('rows').replaceChildren();
  for(const g of state.grants){
    const row=document.createElement('div');row.className='folder-row';
    row.innerHTML='<div class="folder-info"><span class="folder-icon" aria-hidden="true"></span><div><span class="folder-name"></span><span class="folder-path"></span></div></div><div><button class="permission-button"><span></span><span class="chevron">⌄</span></button></div><span class="state-label"><i></i><span></span></span><button class="revoke">撤销</button>';
    row.querySelector('.folder-name').textContent=g.name;
    row.querySelector('.folder-path').textContent=g.path;row.querySelector('.folder-path').title=g.path;
    const mode=row.querySelector('.permission-button');mode.querySelector('span').textContent=g.mode==='rw'?'读写':'只读';mode.setAttribute('aria-label','修改 '+g.name+' 的权限');mode.disabled=!!busy()||assistantState?.operation?.phase==='running';mode.onclick=()=>openEditor({action:'mode',id:g.id,path:g.path,name:g.name,mode:g.mode});
    const status=row.querySelector('.state-label');status.querySelector('span').textContent=!g.available?'路径不可用':!s.running?'已保存':s.generation===state.revision?'已生效':'待生效';if(!g.available)status.classList.add('unavailable');
    const revoke=row.querySelector('.revoke');revoke.disabled=!!busy()||assistantState?.operation?.phase==='running';revoke.setAttribute('aria-label','撤销 '+g.name+' 的授权');revoke.onclick=()=>openEditor({action:'remove',id:g.id,path:g.path,name:g.name,mode:g.mode});
    $('rows').append(row);
  }
  $('empty').hidden=state.grants.length!==0;
  $('add').disabled=!!busy()||state.picking||assistantState?.operation?.phase==='running';
  $('picker-status').hidden=!state.picking;
  $('progress').hidden=!busy();
  if(busy()){
    $('progress-text').textContent=state.operation.message;
    $('waiting-actions').hidden=!['waiting','queued'].includes(state.operation.phase);
  } else if(state.operation&&lastOperation!==state.operation.id+state.operation.phase){
    lastOperation=state.operation.id+state.operation.phase;
    notice(state.operation.message,state.operation.phase==='error');
  }
}
async function refresh(){
  if(polling)return;polling=true;
  try{[state,assistantState]=await Promise.all([api('state'),api('assistant')]);render();renderAssistant();}
  catch(e){notice(e.message||'管理页连接已结束，请重新双击启动。',true);$('add').disabled=true;for(const b of document.querySelectorAll('[data-action],#exclude-session,#stop-services,#remove-integration,#autostart'))b.disabled=true;}
  finally{polling=false;}
}
async function getPreview(){
  const request=++previewRequest;
  const selected={...edit};
  preview=null;$('confirm').disabled=true;
  try{
    const received=await api('preview',{action:selected.action,path:selected.path,id:selected.id,mode:selected.mode,revision:state.revision});
    if(request!==previewRequest||!edit)return;
    preview=received;
    $('merge-note').hidden=!(edit.action==='add'&&preview.merged.length);
    if(!$('merge-note').hidden)$('merge-note').textContent='将合并以下授权，并统一为'+(edit.mode==='rw'?'读写':'只读')+'：\n'+preview.merged.map(g=>'• '+g.path+'（原为'+(g.mode==='rw'?'读写':'只读')+'）').join('\n');
    $('confirm').disabled=false;
  }catch(e){if(request===previewRequest&&edit)notice(e.message,true);}
}
function openEditor(item){
  edit=item;notice('');$('editor').hidden=false;
  $('editor-title').textContent=item.action==='remove'?'撤销此文件夹的授权':item.action==='mode'?'修改访问权限':'授权此文件夹';
  $('selected-name').textContent=item.name;$('selected-path').textContent=item.path;
  $('mode-field').hidden=item.action==='remove';
  document.querySelector('input[name=mode][value='+item.mode+']').checked=true;
  $('scope-note').textContent=item.action==='remove'?'ChatGPT 将不能再访问此目录及其子目录。文件不会被删除。':'包括全部子文件夹。账户凭据和运行配置仍受保护。';
  $('confirm').textContent=item.action==='remove'?'确认撤销':item.action==='mode'?'应用权限':'确认授权';
  $('merge-note').hidden=true;void getPreview();$('editor').scrollIntoView({behavior:'smooth',block:'nearest'});
}
$('add').onclick=async()=>{
  notice('');$('add').disabled=true;$('add').textContent='等待选择文件夹…';
  try{const folder=await api('pick-folder',{});if(!folder.cancelled)openEditor({...folder,action:'add',mode:'rw'});}
  catch(e){notice(e.message,true);}
  finally{$('add').textContent='＋ 添加文件夹';await refresh();}
};
for(const radio of document.querySelectorAll('input[name=mode]'))radio.onchange=()=>{if(edit){edit.mode=radio.value;void getPreview();}};
$('editor-close').onclick=closeEditor;$('cancel-edit').onclick=closeEditor;
$('cancel-picker').onclick=async()=>{try{await api('cancel-picker',{});}catch(e){notice(e.message,true);}};
$('confirm').onclick=async()=>{
  if(!preview)return;$('confirm').disabled=true;
  try{await api('apply',{previewId:preview.previewId});closeEditor();await refresh();}
  catch(e){notice(e.message,true);$('confirm').disabled=false;}
};
$('cancel-wait').onclick=async()=>{try{await api('operation',{id:state.operation.id,action:'cancel'});await refresh();}catch(e){notice(e.message,true);}};
$('interrupt').onclick=async()=>{
  if(!confirm('会中断正在执行的 DevSpace 任务，再应用本次权限修改。确认继续？'))return;
  try{await api('operation',{id:state.operation.id,action:'interrupt'});await refresh();}catch(e){notice(e.message,true);}
};
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&edit)closeEditor();});
for(const event of ['pointerdown','keydown'])document.addEventListener(event,()=>{if(csrf&&Date.now()-activity>60000){activity=Date.now();void api('activity',{}).catch(()=>{});}});
async function start(){
  try {
    const nonce=new URLSearchParams(location.hash.slice(1)).get('launch');
    history.replaceState(null,'',location.pathname);
    if(nonce){clearSession();rememberSession(await api('session',{token:nonce}));}
    else {
      let saved;try{saved=JSON.parse(sessionStorage.getItem(sessionKey));}catch{}
      if(!saved||typeof saved.accessToken!=='string'||typeof saved.csrf!=='string')throw new Error('请用启动入口打开管理页。');
      accessToken=saved.accessToken;csrf=(await api('session')).csrf;rememberSession({accessToken,csrf});
    }
    await refresh();setInterval(refresh,5000);
  }catch(e){notice(e.message||'请用双击启动入口打开此页面。',true);$('service-status').textContent='管理会话未建立';$('service-detail').textContent='请重新双击启动入口';}
}
void start();

function go(page){for(const p of document.querySelectorAll('.panel'))p.hidden=p.id!=='page-'+page;for(const b of document.querySelectorAll('[data-page]'))b.classList.toggle('selected',b.dataset.page===page);if(page==='cli')void loadCLI();}
for(const b of document.querySelectorAll('[data-page]'))b.onclick=()=>go(b.dataset.page);
for(const b of document.querySelectorAll('[data-go]'))b.onclick=()=>go(b.dataset.go);
const when=value=>{if(!value)return '尚无记录';const d=new Date(value);return Number.isNaN(+d)?'未知':d.toLocaleString('zh-CN',{hour12:false});};
function renderAssistant(){
 if(!assistantState)return;
 const a=assistantState,c=a.context,h=a.health,s=state.service;
 const fresh=a.healthFresh&&h?.sample?.corePid===s.pid&&h?.sample?.tunnelPid===s.tunnelPid;
 const connected=s.running&&s.tunnelRunning&&fresh&&h?.sample?.publicOK;
 $('overview-connection').textContent=!s.running?'服务已停止':connected?'可以连接':fresh?'连接需检查':'等待连接检查';
 $('overview-connection').className=connected?'good':'warn';
 $('overview-connection-detail').textContent=fresh?'最近检查 '+when(h.checkedAt):'启动后由后台检查公网是否可达。';
 $('service-status').textContent=!s.running?'服务已停止':connected?'服务已连接':'连接待检查';$('service-dot').className='dot'+(connected?' online':'');
 const phase=!c.job.loaded?'已暂停':!c.job.running?'后台未就绪':c.stale?'记录已过期':c.phase==='idle'?'同步正常':c.phase==='partial'?'部分来源需处理':'正在同步';
 $('overview-sync').textContent=phase;$('overview-sync').className=c.job.running&&!c.stale&&c.phase==='idle'?'good':'warn';
 $('overview-sync-detail').textContent='最近处理 '+when(c.checked_at);
 $('overview-folders').textContent=state.grants.length;$('overview-sessions').textContent=c.sessions??'—';$('overview-summaries').textContent=c.summaries??'—';
 $('context-status').textContent=phase;$('context-updated').textContent=when(c.checked_at);$('context-count').textContent=c.sessions??'—';$('context-summary-count').textContent=c.summaries??'—';
 $('context-permission').textContent=c.job.running&&c.permission?.ok&&c.permission.pid===c.job.pid?'活动目录读取已通过':!c.job.running?'恢复同步后检查':'需要检查授权';
 $('context-errors').hidden=!c.errors?.length;$('context-errors').textContent=(c.errors||[]).join('\n');
 $('context-toggle').dataset.action=c.job.loaded?'context-pause':'context-resume';$('context-toggle').textContent=c.job.loaded?'暂停同步':'恢复同步';
 $('context-request').textContent=c.request?'补同步请求等待处理':c.request_id&&c.request_id!==c.result?.id&&c.job.running?'本次补同步正在执行':c.result?'最近补同步：'+(c.result.phase==='done'?(c.result.syncPhase==='partial'?'完成，有来源提示':'已完成'):c.result.phase==='cancelled'?'已中断':'需检查')+' · '+when(c.result.at):'';
 if(pendingAutoStart!==null&&(a.preferences.autoStart===pendingAutoStart||a.operation?.phase==='error'))pendingAutoStart=null;
 $('autostart').checked=pendingAutoStart??a.preferences.autoStart;
 $('recovery-state').textContent=a.recovery.loaded?'自动恢复已开启：每分钟检查，持续断线后受限重连。':'自动恢复当前未运行。';
 const locked=a.operation?.phase==='running'||busy()||state.picking;
 for(const b of document.querySelectorAll('[data-action],#exclude-session,#stop-services,#remove-integration,#autostart'))b.disabled=locked;
 $('excluded-list').replaceChildren();const selection=$('recent-session').value;const choices=JSON.stringify(c.recent||[]);if($('recent-session').dataset.choices!==choices){$('recent-session').replaceChildren(new Option('选择最近会话…',''));for(const item of c.recent||[])$('recent-session').append(new Option(item.title.startsWith('未命名会话')?'未命名会话 · '+item.id.slice(-8):item.title,item.id));$('recent-session').value=selection;$('recent-session').dataset.choices=choices;}
 for(const id of c.excluded){const row=document.createElement('div');row.className='excluded-row';const text=document.createElement('span');text.textContent=(c.recent||[]).find(r=>r.id===id)?.title||id;const button=document.createElement('button');button.className='text-button';button.textContent='恢复导出';button.disabled=locked;button.onclick=()=>control('include',{id});row.append(text,button);$('excluded-list').append(row);}
 if(a.operation){const ack=a.operation.action==='context-sync'&&c.result?.at>=a.operation.createdAt?c.result:null;const marker=a.operation.id+a.operation.phase+(ack?.id||'');if(firstAssistantRender&&a.operation.phase!=='running')lastControl=marker;if(marker!==lastControl){lastControl=marker;notice(ack?(ack.phase==='done'?(ack.syncPhase==='partial'?'补同步已完成，部分来源需要处理。':'补同步已完成。'):'补同步失败，请查看同步状态。'):a.operation.message,a.operation.phase==='error'||ack?.phase==='error');}}
 firstAssistantRender=false;
}
async function control(action,args={}){try{notice('正在处理…');await api('assistant/action',{action,...args});await refresh();}catch(e){notice(e.message,true);}}
for(const b of document.querySelectorAll('[data-action]'))b.onclick=()=>control(b.dataset.action);
$('autostart').onchange=()=>{pendingAutoStart=$('autostart').checked;void control('autostart',{value:pendingAutoStart});};
$('stop-services').onclick=()=>{if(confirm('停止连接和上下文同步？文件与配置保留，有任务执行时会拒绝停止。'))void control('stop');};
$('exclude-session').onclick=()=>{const id=$('excluded-id').value.trim();if(id&&confirm('排除此会话的导出副本？原会话保留，历史摘要可能仍提到它。'))void control('exclude',{id});};

for(const b of document.querySelectorAll('[data-action],#exclude-session,#stop-services,#remove-integration,#autostart'))b.disabled=true;

$('remove-integration').onclick=()=>{if(confirm('停止连接与同步，并移除登录启动和快捷入口？安装文件、系统授权助手和所有数据保留；有任务执行时会拒绝操作。'))void control('remove-integration');};

$('recent-session').onchange=()=>{$('excluded-id').value=$('recent-session').value;};

let cliState=null;
function cliRow(entry){
 const row=document.createElement('div');row.className='cli-row';const title=document.createElement('strong'),body=document.createElement('span');title.textContent=entry.id;body.textContent=entry.status==='ready'?entry.scope:entry.reason;body.className='muted';row.append(title,body);return row;
}
function renderCLI(){
 if(!cliState)return;
 $('cli-status').textContent=cliState.enabled?'CLI 接入已开启':'CLI 接入已暂停';$('cli-toggle').textContent=cliState.enabled?'暂停接入':'恢复接入';
 const ready=cliState.entries.filter(e=>e.status==='ready');$('cli-summary').textContent=ready.filter(e=>e.provider!=='local').length+' 个业务 CLI · '+ready.filter(e=>e.provider==='local').length+' 个本机命令已核对 · '+cliState.discovered.length+' 个待核对';
 $('cli-business').replaceChildren(...cliState.entries.filter(e=>e.provider!=='local').map(cliRow));
 const query=$('cli-search').value.trim().toLowerCase(),native=[...cliState.entries.filter(e=>e.provider==='local'),...cliState.discovered].filter(e=>!query||e.id.toLowerCase().includes(query));
 $('cli-native').replaceChildren(...native.slice(0,25).map(cliRow));if(native.length>25){const p=document.createElement('p');p.className='muted';p.textContent='共 '+native.length+' 项，输入名称缩小范围。';$('cli-native').append(p);}
 const labels={completed:'进程已完成',failed:'执行失败',business_failed:'业务失败',queued:'等待执行',running:'执行中',cancelled:'已取消',needs_reconciliation:'写入结果待核对',interrupted:'已中断',timeout:'执行超时',output_limit:'输出超出限制'};
 $('cli-jobs').replaceChildren();for(const j of cliState.jobs){const p=document.createElement('p');p.className='muted';p.textContent=j.cli+' · '+(labels[j.status]||j.status)+' · '+j.requestId;$('cli-jobs').append(p);}if(!cliState.jobs.length)$('cli-jobs').textContent='还没有通过新入口执行的请求。';
}
async function loadCLI(force=false){try{cliState=await api(force?'cli/refresh':'cli',force?{}:undefined);renderCLI();}catch(e){notice(e.message,true);}}
$('cli-refresh').onclick=()=>loadCLI(true);$('cli-search').oninput=renderCLI;
$('cli-toggle').onclick=async()=>{if(!cliState)return;try{const r=await api('cli/enabled',{enabled:!cliState.enabled});notice(r.message);await loadCLI();}catch(e){notice(e.message,true);}};

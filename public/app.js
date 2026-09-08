const $=id=>document.getElementById(id);
let csrf='',state=null,edit=null,preview=null,lastOperation='',polling=false,activity=0,previewRequest=0,firstRender=true;
const busy=()=>state?.operation&&!['done','error','cancelled'].includes(state.operation.phase);
function notice(message,error=false){$('notice').textContent=message;$('notice').className=error?'error':'';$('notice').hidden=!message;}
async function api(url,body){
  const res=await fetch('/api/'+url,{method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:body===undefined?undefined:JSON.stringify(body)});
  const data=await res.json();
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
    const mode=row.querySelector('.permission-button');mode.querySelector('span').textContent=g.mode==='rw'?'读写':'只读';mode.setAttribute('aria-label','修改 '+g.name+' 的权限');mode.disabled=!!busy();mode.onclick=()=>openEditor({action:'mode',id:g.id,path:g.path,name:g.name,mode:g.mode});
    const status=row.querySelector('.state-label');status.querySelector('span').textContent=!g.available?'路径不可用':!s.running?'已保存':s.generation===state.revision?'已生效':'待生效';if(!g.available)status.classList.add('unavailable');
    const revoke=row.querySelector('.revoke');revoke.disabled=!!busy();revoke.setAttribute('aria-label','撤销 '+g.name+' 的授权');revoke.onclick=()=>openEditor({action:'remove',id:g.id,path:g.path,name:g.name,mode:g.mode});
    $('rows').append(row);
  }
  $('empty').hidden=state.grants.length!==0;
  $('add').disabled=!!busy()||state.picking;
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
  try{state=await api('state');render();}
  catch(e){notice(e.message||'管理页连接已结束，请重新双击启动。',true);$('add').disabled=true;}
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
    csrf=nonce?(await api('session',{token:nonce})).csrf:(await api('session')).csrf;
    await refresh();setInterval(refresh,2000);
  }catch(e){notice(e.message||'请用双击启动入口打开此页面。',true);$('service-status').textContent='管理会话未建立';$('service-detail').textContent='请重新双击启动入口';}
}
void start();

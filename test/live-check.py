import base64, hashlib, json, os, secrets, sys
from pathlib import Path
from urllib.parse import urlparse, parse_qs
import requests

BASE = sys.argv[1].rstrip("/") if len(sys.argv) > 1 else ""
if not BASE or os.environ.get("DEVSPACE_LIVE_CHECK") != "1":
    raise SystemExit("Opt-in required: DEVSPACE_LIVE_CHECK=1 python3 test/live-check.py https://YOUR-OWN-ENDPOINT")
DEPLOY = Path(os.environ.get("DEVSPACE_HOME", str(Path.home()/".local/share/devspace-air")))
TEST_ROOT = Path(os.environ.get("DEVSPACE_TEST_ROOT", str(Path.home()/"Workspace")))
assert BASE.startswith("https://") or BASE == "http://127.0.0.1:7676", "Use HTTPS or the local endpoint"
session = requests.Session()
session.trust_env = not BASE.startswith("http://127.0.0.1")
results = []
def check(label, ok, detail=None):
    results.append({"check": label, "passed": bool(ok), "detail": detail})
    print(json.dumps(results[-1], ensure_ascii=False), flush=True)
    if not ok: raise AssertionError(label)

def rpc(method, params=None, notification=False):
    body = {"jsonrpc": "2.0", "method": method}
    if not notification: body["id"] = secrets.randbelow(1000000)
    if params is not None: body["params"] = params
    r = session.post(BASE + "/mcp", json=body, timeout=30)
    if r.headers.get("mcp-session-id"):
        session.headers["Mcp-Session-Id"] = r.headers["mcp-session-id"]
    if notification:
        r.raise_for_status()
        return None
    r.raise_for_status()
    r.encoding = "utf-8"
    if "text/event-stream" in r.headers.get("content-type", ""):
        packets = [json.loads(x[6:]) for x in r.text.split("\n") if x.startswith("data: ")]
        packet = next(x for x in packets if x.get("id") == body["id"])
    else:
        packet = r.json()
    if "error" in packet: return {"isError": True, "rpcError": packet["error"]}
    return packet["result"]

def tool(name, args):
    return rpc("tools/call", {"name": name, "arguments": args})


import tempfile,time,shutil,subprocess
local=requests.Session();local.trust_env=False
admin='http://127.0.0.1:7678'
manager=json.loads((DEPLOY/'access-manager-session.json').read_text())
r=local.post(admin+'/internal/launch',headers={'x-launch-secret':manager['launchSecret']});r.raise_for_status()
nonce=urlparse(r.json()['url']).fragment.split('=',1)[1]
r=local.post(admin+'/api/session',json={'token':nonce},headers={'Origin':admin});r.raise_for_status()
csrf=r.json()['csrf'];local.headers.update({'Origin':admin,'X-CSRF-Token':csrf})
def admincall(method,body=None):
 r=local.get(admin+'/api/'+method,timeout=10) if body is None else local.post(admin+'/api/'+method,json=body,timeout=10)
 r.raise_for_status();return r.json()
def finish():
 for _ in range(100):
  state=admincall('state');op=state.get('operation') or {}
  if op.get('phase') in ['done','error','cancelled']:
   assert op['phase']=='done',op
   return state
  time.sleep(.5)
 raise AssertionError('apply timeout')
def change(action,selected,mode='rw',wait=True):
 state=admincall('state')
 payload={'action':action,'revision':state['revision'],'mode':mode}
 payload['path' if action=='add' else 'id']=selected
 plan=admincall('preview',payload)
 job=admincall('apply',{'previewId':plan['previewId']})
 return finish() if wait else job
meta=session.get(BASE+'/.well-known/oauth-authorization-server',timeout=20).json()
client=session.post(meta['registration_endpoint'],json={'client_name':'Access manager integration','redirect_uris':['http://127.0.0.1:8765/callback'],'grant_types':['authorization_code','refresh_token'],'response_types':['code'],'token_endpoint_auth_method':'none'},timeout=20).json()
verifier=secrets.token_urlsafe(48);challenge=base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip('=')
form={'client_id':client['client_id'],'redirect_uri':'http://127.0.0.1:8765/callback','response_type':'code','scope':'devspace','resource':BASE+'/mcp','code_challenge':challenge,'code_challenge_method':'S256','state':secrets.token_urlsafe(16)}
owner=json.loads((DEPLOY/'secrets/owner.json').read_text())['ownerToken']
r=session.post(meta['authorization_endpoint'],data={**form,'owner_token':owner},allow_redirects=False,timeout=20);assert r.status_code==302
code=parse_qs(urlparse(r.headers['Location']).query)['code'][0]
r=session.post(meta['token_endpoint'],data={'grant_type':'authorization_code','code':code,'code_verifier':verifier,'redirect_uri':form['redirect_uri'],'client_id':client['client_id'],'resource':BASE+'/mcp'},timeout=20);r.raise_for_status();tokens=r.json()
session.headers.update({'Authorization':'Bearer '+tokens['access_token'],'Accept':'application/json, text/event-stream'})
def connect():
 session.headers.pop('Mcp-Session-Id',None)
 for _ in range(20):
  try:
   init=rpc('initialize',{'protocolVersion':'2025-03-26','capabilities':{},'clientInfo':{'name':'access-manager-integration','version':'1'}})
   assert 'serverInfo' in init
   session.headers['MCP-Protocol-Version']=init['protocolVersion'];rpc('notifications/initialized',notification=True);return
  except Exception:time.sleep(.5)
 raise AssertionError('MCP reconnect failed')
root=Path(tempfile.mkdtemp(prefix='DevSpace权限验收-',dir=TEST_ROOT))
folder=root/'中文 空格 "目录"';folder.mkdir()
baseline=admincall('state')['grants'];grant_id=None
try:
 connect();names=[t['name'] for t in rpc('tools/list')['tools']];check('Read-only directory discovery tool registered','list_authorized_folders' in names)
 check('No permission-management MCP tool',not any(x in names for x in ['authorize_folder','grant_folder','revoke_folder','apply_permissions']))
 r=session.get(BASE+'/api/state',timeout=20);check('Manager API not exposed through public tunnel',r.status_code==404,r.status_code)
 state=change('add',str(folder),'rw');grant_id=next(g['id'] for g in state['grants'] if g['path']==str(folder));check('Outside folder added without changing existing roots',all(any(g['path']==old['path'] and g['mode']==old['mode'] for g in state['grants']) for old in baseline))
 connect();listing=tool('list_authorized_folders',{});check('ChatGPT-side directory list updates',any(g['path']==str(folder) for g in json.loads(listing['content'][0]['text'])['folders']))
 opened=tool('open_workspace',{'path':str(folder)});assert not opened.get('isError'),opened;wid=opened['structuredContent']['workspaceId']
 patched=tool('apply_patch',{'workspaceId':wid,'patch':'*** Begin Patch\n*** Add File: access.txt\n+original\n*** End Patch'});check('Read-write file operation',not patched.get('isError'))
 executed=tool('exec_command',{'workspaceId':wid,'cmd':"node -e 'require(\"fs\").writeFileSync(\"command.txt\",\"ok\")'"});check('Read-write command operation',executed.get('structuredContent',{}).get('exitCode')==0)
 # The management session file must not be accessible from the granted workspace.
 import shlex
 probe='try{require("fs").readFileSync('+json.dumps(str(DEPLOY/'access-manager-session.json'))+');process.exit(9)}catch(e){console.log(e.code)}'
 result=tool('exec_command',{'workspaceId':wid,'cmd':'node -e '+shlex.quote(probe)})
 check('Management credentials remain inaccessible','EPERM' in result.get('structuredContent',{}).get('result',''))
 state=change('mode',grant_id,'ro');connect()
 read=tool('read',{'workspaceId':wid,'path':'access.txt'});check('Read-only folder and old workspace ID still permit reads',not read.get('isError'))
 patched=tool('apply_patch',{'workspaceId':wid,'patch':'*** Begin Patch\n*** Update File: access.txt\n@@\n-original\n+changed\n*** End Patch'});check('Read-only file write rejected',bool(patched.get('isError')))
 executed=tool('exec_command',{'workspaceId':wid,'cmd':"node -e 'require(\"fs\").writeFileSync(\"access.txt\",\"changed\")'"});check('Read-only command write rejected',executed.get('structuredContent',{}).get('exitCode')!=0)
 check('Read-only contents unchanged',(folder/'access.txt').read_text().strip()=='original')
 slow=tool('exec_command',{'workspaceId':wid,'cmd':"node -e 'console.log(process.pid);setTimeout(()=>{},120000)'",'yieldTimeMs':0})
 assert slow.get('structuredContent',{}).get('running'),slow
 time.sleep(.7)
 job=change('remove',grant_id,wait=False)
 for _ in range(20):
  op=admincall('state')['operation']
  if op['phase']=='waiting':break
  time.sleep(.2)
 check('Permission update waits for running command',op['phase']=='waiting')
 admincall('operation',{'id':op['id'],'action':'cancel'})
 for _ in range(20):
  if admincall('state')['operation']['phase']=='cancelled':break
  time.sleep(.2)
 check('Cancelling wait keeps original permission',any(g['id']==grant_id for g in admincall('state')['grants']))
 job=change('remove',grant_id,wait=False)
 time.sleep(.3);op=admincall('state')['operation'];admincall('operation',{'id':op['id'],'action':'interrupt'})
 state=finish();check('Explicit interrupt completes revoke',not any(g['id']==grant_id for g in state['grants']))
 connect();read=tool('read',{'workspaceId':wid,'path':'access.txt'});check('Revoked old workspace ID rejected',bool(read.get('isError')))
 check('Revoking does not delete files',(folder/'access.txt').exists())
 check('Original permissions preserved',sorted((g['path'],g['mode']) for g in state['grants'])==sorted((g['path'],g['mode']) for g in baseline))
 (DEPLOY/'config/access-manager-live-check.json').write_text(json.dumps({'results':results,'checkedAt':time.time()},ensure_ascii=False,indent=2)+'\n')
finally:
 try:
  if grant_id and any(g['id']==grant_id for g in admincall('state')['grants']):
   change('remove',grant_id,wait=False);time.sleep(.5);op=admincall('state')['operation']
   if op['phase']=='waiting':admincall('operation',{'id':op['id'],'action':'interrupt'})
   finish()
 except Exception as e:print('Cleanup requires attention:',type(e).__name__,str(e))
 for k in ['access_token','refresh_token']:
  try:session.post(meta['revocation_endpoint'],data={'token':tokens[k],'client_id':client['client_id']},timeout=20)
  except Exception:pass
 if not any(g['path']==str(folder) for g in admincall('state')['grants']):shutil.rmtree(root)

"""Isolated watcher acceptance: never writes the real Codex history."""
import tempfile,subprocess,json,time,sys
from pathlib import Path
repo=Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix='context-watch-test-') as tmp:
 r=Path(tmp);cfg={k:str(r/k) for k in ['sessions','archives','history_segments','history_summaries','output','state']};cfg['thread_db']=str(r/'absent.sqlite')
 for k in cfg:
  if k!='thread_db':Path(cfg[k]).mkdir()
 p=r/'config.json';p.write_text(json.dumps(cfg));source=Path(cfg['sessions'])/'sample.jsonl';sid='watch-integration-123'
 def event(text):return {'type':'response_item','timestamp':'2026-09-09T00:00:01Z','payload':{'type':'message','role':'user','content':[{'type':'input_text','text':text}]}}
 source.write_text(json.dumps({'type':'session_meta','timestamp':'2026-09-09T00:00:00Z','payload':{'id':sid}})+'\n'+json.dumps(event('initial'))+'\n')
 out=Path(cfg['output'])/'会话/2026-09'/f'{sid}.md'
 def wait_for(text):
  end=time.monotonic()+20
  while time.monotonic()<end:
   if out.exists() and text in out.read_text():return
   time.sleep(.25)
  raise AssertionError('export timeout: '+text)
 with (r/'log').open('w') as log:
  child=subprocess.Popen([sys.argv[1],str(repo/'watcher.mjs'),str(p)],stdout=log,stderr=log)
  try:
   wait_for('initial');start=time.monotonic()
   with source.open('a') as f:f.write(json.dumps(event('incremental marker API_KEY=credentialExample123'))+'\n')
   wait_for('incremental marker');elapsed=time.monotonic()-start
   assert 'credentialExample123' not in out.read_text()
   out.unlink();request_id='manual-request-test'
   (Path(cfg['state'])/'sync-request.json').write_text(json.dumps({'id':request_id,'at':time.time()*1000}))
   wait_for('initial');deadline=time.monotonic()+10;result=None
   while time.monotonic()<deadline:
    result_file=Path(cfg['state'])/'sync-request-result.json'
    if result_file.exists():
     result=json.loads(result_file.read_text())
     if result.get('id')==request_id:break
    time.sleep(.25)
   assert result and result.get('phase')=='done',result
   print(json.dumps({'initial_export':True,'incremental_seconds':round(elapsed,2),'redaction':True,'manual_request_acknowledged':True}))
  finally:
   child.terminate()
   try:child.wait(timeout=5)
   except subprocess.TimeoutExpired:child.kill();child.wait()

import unittest,tempfile,json,sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from exporter import Exporter,clean,user_text
class ExportTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.r=Path(self.tmp.name);self.cfg={k:str(self.r/k) for k in ['sessions','archives','history_segments','history_summaries','output','state']};self.cfg['thread_db']=str(self.r/'absent.sqlite')
  for k in self.cfg:
   if k!='thread_db':Path(self.cfg[k]).mkdir()
  self.p=Path(self.cfg['sessions'])/'rollout.jsonl';self.sid='session-test-123'
  self.put([{'type':'session_meta','timestamp':'2026-09-09T00:00:00Z','payload':{'id':self.sid,'cwd':'/Demo/Project'}},self.msg('user','hello')]);self.e=Exporter(self.cfg,Path(self.cfg['state']))
 def tearDown(self):self.e.db.close();self.tmp.cleanup()
 def msg(self,role,text,channel=None):return {'type':'response_item','timestamp':'2026-09-09T00:00:01Z','payload':{'type':'message','role':role,'channel':channel,'content':[{'type':'input_text' if role=='user' else 'output_text','text':text}]}}
 def put(self,rows,mode='w'):
  with self.p.open(mode) as f:
   for x in rows:f.write(json.dumps(x)+'\n')
 def page(self):return (Path(self.cfg['output'])/'会话/2026-09'/f'{self.sid}.md').read_text()
 def test_append_partial_and_no_reasoning_or_tool_arguments(self):
  self.e.scan();self.put([self.msg('assistant','visible reply'),self.msg('assistant','secret internal reasoning','analysis'),{'type':'response_item','payload':{'type':'function_call','name':'exec_command','arguments':'password=neverexport'}}],'a')
  with self.p.open('a') as f:f.write(json.dumps(self.msg('user','partial'))[:-1])
  self.e.scan([str(self.p)]);s=self.page();self.assertIn('visible reply',s);self.assertNotIn('secret internal',s);self.assertNotIn('neverexport',s);self.assertNotIn('partial',s)
  with self.p.open('a') as f:f.write('}\n')
  self.e.scan([str(self.p)]);self.assertIn('partial',self.page());self.assertEqual(self.page().count('visible reply'),1)
 def test_replacement_and_source_removal(self):
  self.e.scan();self.put([{'type':'session_meta','timestamp':'2026-09-09T00:00:00Z','payload':{'id':self.sid}},self.msg('user','replacement')]);self.e.scan([str(self.p)]);self.assertNotIn('hello',self.page());self.assertIn('replacement',self.page());self.p.unlink();self.e.scan();self.assertIn('源记录已移除',self.page())
 def test_redaction_and_instruction_filter(self):
  text='password="reallySecret123" https://x.test/path?token=anything#secret Bearer abcdefghijklmn\n-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----'
  s=clean(text)
  for value in ['reallySecret123','token=anything','abcdefghijklmn','AAAA']:self.assertNotIn(value,s)
  self.assertEqual(user_text('# AGENTS.md instructions for abc\ninternal'), '')
 def test_activity_does_not_export_keyboard_or_ax(self):
  p=Path(self.cfg['history_segments'])/'events.jsonl';p.write_text(json.dumps({'kind':'window.changed','timestamp':'2026-09-09T01:00:00Z','app':{'name':'Editor'},'window':{'title':'Project','url':'https://example.test/work?token=abc'},'ax':{'text':'DO NOT EXPORT'}})+'\n'+json.dumps({'kind':'keyboard.text_input','timestamp':'2026-09-09T01:00:00Z','app':{'name':'Editor'},'window':{'title':'Project'},'keyboard':{'text':'secret typing'}})+'\n')
  self.e.scan();s=(Path(self.cfg['output'])/'计算机历史/时间线/2026-09-09.md').read_text();self.assertIn('Editor',s);self.assertNotIn('DO NOT EXPORT',s);self.assertNotIn('secret typing',s);self.assertNotIn('token=',s)
 def test_bad_complete_record_keeps_cursor_and_reports_partial(self):
  self.e.scan();offset=self.e.db.execute('select offset from sources where path=?',(str(self.p),)).fetchone()[0]
  with self.p.open('a') as f:f.write('{bad}\n')
  self.e.scan([str(self.p)]);self.assertEqual(self.e.db.execute('select offset from sources where path=?',(str(self.p),)).fetchone()[0],offset);self.assertTrue(self.e.errors)
 def test_voice_and_mixed_user_blocks(self):
  self.put([{'type':'realtime_item','timestamp':'2026-09-09T01:00:00Z','payload':{'type':'transcript_segment','role':'user','text':'voice request'}},{'type':'response_item','timestamp':'2026-09-09T01:01:00Z','payload':{'type':'message','role':'user','content':[{'type':'input_text','text':'# AGENTS.md instructions\ninternal rules'},{'type':'input_text','text':'real user request'}]}}],'a')
  self.e.scan();s=self.page();self.assertIn('voice request',s);self.assertIn('real user request',s);self.assertNotIn('internal rules',s)
 def test_full_scan_repairs_missing_output(self):
  self.e.scan();p=Path(self.cfg['output'])/'会话/2026-09'/f'{self.sid}.md';p.unlink();self.e.scan();self.assertIn('hello',p.read_text())

 def test_exclusion_cli_preserves_source_and_stays_excluded(self):
  import subprocess
  self.e.scan();before=self.p.read_bytes();cfg=self.r/'config.json';cfg.write_text(json.dumps(self.cfg));code=Path(__file__).resolve().parents[1]/'exporter.py'
  def run(mode):subprocess.run([sys.executable,str(code),mode,'--config',str(cfg),'--session-id',self.sid],check=True,capture_output=True)
  out=Path(self.cfg['output'])/'会话/2026-09'/f'{self.sid}.md'
  run('exclude');self.assertFalse(out.exists());self.assertFalse((Path(self.cfg['output'])/'索引/2026-09.md').exists())
  self.assertIsNone(self.e.db.execute('select sha from outputs where path=?',('索引/2026-09.md',)).fetchone())
  self.assertTrue(all(self.sid not in p.read_text() for p in Path(self.cfg['output']).rglob('*.md')))
  run('sync');self.assertFalse(out.exists());self.assertFalse((Path(self.cfg['output'])/'索引/2026-09.md').exists())
  run('include');self.assertTrue(out.exists());self.assertIn(self.sid,(Path(self.cfg['output'])/'索引/2026-09.md').read_text());self.assertEqual(self.p.read_bytes(),before)


 def test_guardian_is_never_exported(self):
  self.put([{'type':'session_meta','timestamp':'2026-09-09T00:00:00Z','payload':{'id':self.sid,'source':{'subagent':{'other':'guardian'}}}},self.msg('user','internal approval transcript'),self.msg('assistant','internal result')])
  self.e.scan();self.assertFalse((Path(self.cfg['output'])/'会话/2026-09'/f'{self.sid}.md').exists());self.assertEqual(self.e.db.execute('select count(*) from entries where sid=?',(self.sid,)).fetchone()[0],0)

 def test_month_reconciliation_preserves_other_sessions_and_months(self):
  for sid,month in [('second-session-456','2026-09'),('older-session-789','2026-08')]:
   p=Path(self.cfg['sessions'])/(sid+'.jsonl');p.write_text(json.dumps({'type':'session_meta','timestamp':month+'-01T00:00:00Z','payload':{'id':sid}})+'\n'+json.dumps(self.msg('user',sid))+'\n')
  self.e.scan();older=(self.e.root/'索引/2026-08.md').read_bytes();self.e.excluded.add(self.sid);self.e.indexes()
  current=(self.e.root/'索引/2026-09.md').read_text();self.assertNotIn(self.sid,current);self.assertIn('second-session-456',current);self.assertEqual((self.e.root/'索引/2026-08.md').read_bytes(),older)
 def test_month_reconciliation_cleans_untracked_generated_files_only(self):
  self.e.scan();old=self.e.root/'索引/2025-01.md';old.write_text('obsolete metadata');manual=self.e.root/'索引/notes.md';manual.write_text('keep me')
  self.e.indexes();self.assertFalse(old.exists());self.assertEqual(manual.read_text(),'keep me');self.assertTrue((self.e.root/'索引/2026-09.md').exists())
 def test_unknown_month_is_removed_when_empty_and_rebuilt_on_include(self):
  self.e.scan();self.e.db.execute('update sessions set stamp=? where id=?',('invalid',self.sid));self.e.indexes();unknown=self.e.root/'索引/未知月份.md';self.assertTrue(unknown.exists())
  self.e.excluded.add(self.sid);self.e.indexes();self.assertFalse(unknown.exists());self.assertIsNone(self.e.db.execute('select sha from outputs where path=?',('索引/未知月份.md',)).fetchone())
  self.e.excluded.remove(self.sid);self.e.indexes();self.assertIn(self.sid,unknown.read_text())
 def test_month_cleanup_refuses_symlink_file_and_directory(self):
  self.e.scan();outside=self.r/'outside.md';outside.write_text('do not change');bad=self.e.root/'索引/2025-01.md';bad.symlink_to(outside)
  with self.assertRaisesRegex(RuntimeError,'symlink'):self.e.indexes()
  self.assertEqual(outside.read_text(),'do not change');bad.unlink()
  directory=self.e.root/'索引';moved=self.r/'outside-index';directory.rename(moved);directory.symlink_to(moved,target_is_directory=True)
  with self.assertRaisesRegex(RuntimeError,'symlink'):self.e.indexes()
  self.assertTrue((moved/'2026-09.md').exists());self.assertEqual(outside.read_text(),'do not change')

if __name__=='__main__':unittest.main()

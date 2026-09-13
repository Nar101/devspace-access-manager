"""Apply a reviewed manifest using descriptor-relative operations, backups and a journal."""
import os,sys,json,stat,hashlib,uuid
p=json.load(sys.stdin)
flags=os.O_RDONLY|os.O_NOFOLLOW|os.O_DIRECTORY
def rootfd(path):
 fd=os.open('/',flags)
 for part in path.split('/'):
  if part:
   child=os.open(part,flags,dir_fd=fd);os.close(fd);fd=child
 return fd
root=rootfd(p['source']);payload=rootfd(p['payload'])
def parent(root,key,create=False):
 parts=key.split('/')
 if any(x in ('','.','..','.git','.env','.codex','.grok','.agents','.npmrc') or x.startswith('.env.') for x in parts):raise RuntimeError('受保护路径')
 fd=os.dup(root)
 try:
  for part in parts[:-1]:
   if create:
    try:os.mkdir(part,0o700,dir_fd=fd)
    except FileExistsError:pass
   child=os.open(part,flags,dir_fd=fd);os.close(fd);fd=child
  return fd,parts[-1]
 except:os.close(fd);raise
def read(root,key):
 try:fd,name=parent(root,key)
 except FileNotFoundError:return None,0o600
 try:
  try:f=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=fd)
  except FileNotFoundError:return None,0o600
  try:
   s=os.fstat(f)
   if not stat.S_ISREG(s.st_mode) or s.st_nlink!=1:raise RuntimeError('拒绝链接或特殊文件')
   if s.st_size>50000000:raise RuntimeError('文件超限')
   data=b''
   while True:
    b=os.read(f,1048576)
    if not b:break
    data+=b
    if len(data)>50000000:raise RuntimeError('文件超限')
   return data,stat.S_IMODE(s.st_mode)&0o777
  finally:os.close(f)
 finally:os.close(fd)
def sha(data):return hashlib.sha256(data).hexdigest() if data is not None else None
def journal(state,done,error=None):
 value={'state':state,'applied':done,'error':error,'source':p['source'],'changes':p['changes'],'backup':p['backup']}
 tmp=p['receipt']+'.tmp'
 with open(tmp,'w') as f:json.dump(value,f);f.flush();os.fsync(f.fileno())
 os.replace(tmp,p['receipt'])
done=[]
try:
 contents={}
 for c in p['changes']:
  before,mode=read(root,c['path'])
  if sha(before)!=c['before']:raise RuntimeError('原文件已改变: '+c['path'])
  after,_=read(payload,c['path']) if c['after'] else (None,0o600)
  if sha(after)!=c['after']:raise RuntimeError('结果文件已改变: '+c['path'])
  contents[c['path']]=(before,after,mode)
 os.makedirs(p['backup'],mode=0o700,exist_ok=False)
 for key,(before,after,mode) in contents.items():
  if before is not None:
   dest=os.path.join(p['backup'],key);os.makedirs(os.path.dirname(dest),exist_ok=True)
   with open(dest,'xb') as f:f.write(before)
 journal('applying',done)
 for c in p['changes']:
  key=c['path'];before,after,mode=contents[key]
  if sha(read(root,key)[0])!=c['before']:raise RuntimeError('写入前文件已改变: '+key)
  fd,name=parent(root,key,create=after is not None)
  try:
   if after is None:os.unlink(name,dir_fd=fd)
   else:
    temp='.devspace-'+uuid.uuid4().hex;f=os.open(temp,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,mode,dir_fd=fd)
    try:
     with os.fdopen(f,'wb') as out:out.write(after);out.flush();os.fsync(out.fileno())
     os.rename(temp,name,src_dir_fd=fd,dst_dir_fd=fd)
    finally:
     try:os.unlink(temp,dir_fd=fd)
     except FileNotFoundError:pass
  finally:os.close(fd)
  done.append(key);journal('applying',done)
 journal('applied',done);print(json.dumps({'state':'applied','files':done,'backup':p['backup']}))
except Exception as e:
 journal('needs_recovery' if done else 'refused',done,str(e));raise
finally:os.close(root);os.close(payload)

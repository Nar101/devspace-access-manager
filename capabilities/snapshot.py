"""Descriptor-relative source snapshot. Never follows source symlinks or hardlinks."""
import os,sys,stat,json,hashlib,re
source,target=sys.argv[1:3];max_bytes=int(sys.argv[3]);max_files=int(sys.argv[4])
skip={'.git','.codex','.grok','.claude','.agents','.mcp.json','.env','.npmrc','node_modules','.next','dist','build','.DS_Store','.ssh','.aws','secrets','credentials'}
manifest={};size=0;count=0
flags=os.O_RDONLY|os.O_NOFOLLOW
fd=os.open('/',flags|os.O_DIRECTORY)
try:
 for part in source.split('/'):
  if not part:continue
  child=os.open(part,flags|os.O_DIRECTORY,dir_fd=fd);os.close(fd);fd=child
 def walk(parent,rel=''):
  global size,count
  for name in sorted(os.listdir(parent)):
   if name in skip or name.startswith('.env.'):continue
   key=(rel+'/'+name).lstrip('/')
   st=os.stat(name,dir_fd=parent,follow_symlinks=False)
   if stat.S_ISLNK(st.st_mode):raise RuntimeError('符号链接需单独审核: '+key)
   child=os.open(name,flags|(os.O_DIRECTORY if stat.S_ISDIR(st.st_mode) else os.O_NONBLOCK),dir_fd=parent)
   try:
    actual=os.fstat(child)
    if stat.S_ISDIR(actual.st_mode):walk(child,key);continue
    if not stat.S_ISREG(actual.st_mode) or actual.st_nlink!=1:raise RuntimeError('特殊文件或硬链接: '+key)
    if re.search(r'\.(pem|key|p12|pfx|sqlite|db)$',name,re.I):raise RuntimeError('凭据或数据库文件: '+key)
    if actual.st_size>max_bytes-size or count>=max_files:raise RuntimeError('项目超过隔离快照容量')
    chunks=[];length=0
    while True:
     b=os.read(child,min(1048576,max_bytes-size-length+1))
     if not b:break
     length+=len(b)
     if length>max_bytes-size:raise RuntimeError('文件增长超过容量')
     chunks.append(b)
    after=os.fstat(child)
    if (after.st_size,after.st_mtime_ns)!=(actual.st_size,actual.st_mtime_ns):raise RuntimeError('源文件正在变化，请重试')
    data=b''.join(chunks)
    if re.search(rb'PRIVATE KEY-----|\b(?:ghp_|github_pat_|sk-proj-)[A-Za-z0-9_]{20,}',data):raise RuntimeError('疑似凭据: '+key)
    dest=os.path.join(target,key);os.makedirs(os.path.dirname(dest),exist_ok=True)
    out=os.open(dest,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    with os.fdopen(out,'wb') as stream:stream.write(data)
    size+=length;count+=1;manifest[key]=hashlib.sha256(data).hexdigest()
   finally:os.close(child)
 walk(fd)
 print(json.dumps({'files':manifest,'count':count,'bytes':size},ensure_ascii=False))
finally:os.close(fd)

import os,resource,sys
resource.setrlimit(resource.RLIMIT_FSIZE,(64*1024*1024,64*1024*1024))
resource.setrlimit(resource.RLIMIT_CPU,(300,300))
os.execv(sys.argv[1],sys.argv[1:])

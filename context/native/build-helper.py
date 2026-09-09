from pathlib import Path
import plistlib,subprocess,json,hashlib,shutil
repo=Path(__file__).resolve().parents[1];home=Path.home();base=home/'.local/share/codex-context-exporter';app=home/'Applications/本地上下文同步.app'
if app.exists():raise SystemExit('Helper already exists; inspect and back up before rebuilding.')
mac=app/'Contents/MacOS';res=app/'Contents/Resources';mac.mkdir(parents=True);res.mkdir()
info={'CFBundleIdentifier':'com.nar.codex-context-access','CFBundleName':'本地上下文同步','CFBundleDisplayName':'本地上下文同步','CFBundleExecutable':'ContextAccess','CFBundlePackageType':'APPL','CFBundleVersion':'1','CFBundleShortVersionString':'0.1.0','NSHighResolutionCapable':True}
(app/'Contents/Info.plist').write_bytes(plistlib.dumps(info))
files=[base/'bin/watcher.mjs',base/'bin/exporter.py',home/'.local/share/devspace-air/node-v24.20.0-darwin-arm64/bin/node']
(res/'runtime-manifest.json').write_text(json.dumps({str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in files},indent=2))
subprocess.run(['/usr/bin/xcrun','swiftc',str(repo/'native/HistoryAccessApp.swift'),'-o',str(mac/'ContextAccess')],check=True)
subprocess.run(['/usr/bin/codesign','--force','--sign','-','--identifier',info['CFBundleIdentifier'],str(app)],check=True)
subprocess.run(['/usr/bin/codesign','--verify','--strict',str(app)],check=True)
print(app)

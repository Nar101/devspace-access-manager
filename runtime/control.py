#!/usr/bin/python3
"""Control only the two DevSpace Air LaunchAgents."""
import argparse, json, os, subprocess, time, urllib.request
from pathlib import Path

base = Path(os.environ.get("DEVSPACE_HOME", str(Path.home() / ".local/share/devspace-air")))
labels = ["com.nar.devspace-air", "com.nar.devspace-air-tunnel"]
domain = "gui/" + str(os.getuid())
parser = argparse.ArgumentParser(description="DevSpace Air 本机启停")
parser.add_argument("action", choices=["status", "start", "stop", "restart", "copy-password"])
action = parser.parse_args().action
def launch(label):
    target = domain + "/" + label
    probe = subprocess.run(["/bin/launchctl", "print", target], capture_output=True)
    if probe.returncode:
        subprocess.run(["/bin/launchctl", "bootstrap", domain, str((base / "config/launchagents" / (label + ".plist")) if (base / "config/launchagents" / (label + ".plist")).exists() else (Path.home() / "Library/LaunchAgents" / (label + ".plist")))], check=True)
def stop():
    for label in reversed(labels):
        subprocess.run(["/bin/launchctl", "bootout", domain + "/" + label], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for attempt in range(60):
        if all(subprocess.run(["/bin/launchctl", "print", domain + "/" + label], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode != 0 for label in labels):
            return
        time.sleep(0.25)
    raise RuntimeError("服务尚未退出，未开始重复启动")
if action == "copy-password":
    secret = json.loads((base / "secrets/owner.json").read_text())["ownerToken"]
    subprocess.run(["/usr/bin/pbcopy"], input=secret.encode(), check=True)
    print("DevSpace Air 连接密码已复制到剪贴板；未打印密码。")
elif action == "stop":
    stop()
    print("DevSpace Air 与专用隧道已停止。")
elif action in ["start", "restart"]:
    if action == "restart":
        stop()
    launch(labels[0])
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    for attempt in range(20):
        try:
            with opener.open("http://127.0.0.1:7676/.well-known/oauth-authorization-server", timeout=2) as r:
                if r.status == 200:
                    break
        except Exception:
            time.sleep(0.5)
    else:
        raise RuntimeError("本机服务未就绪，隧道未启动；请检查 server-error.log")
    launch(labels[1])
    print("DevSpace Air 与专用隧道已启动。")
else:
    for label in labels:
        r = subprocess.run(["/bin/launchctl", "print", domain + "/" + label], capture_output=True, text=True)
        lines = [line.strip() for line in r.stdout.splitlines() if line.strip().startswith(("state =", "pid =", "last exit code ="))]
        print(label + ": " + ("; ".join(lines) if r.returncode == 0 else "未加载"))

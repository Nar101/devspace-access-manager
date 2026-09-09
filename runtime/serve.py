#!/usr/bin/python3
"""Launch DevSpace in Seatbelt without putting its owner secret in argv or env."""
import os, socket, subprocess
from pathlib import Path
import json, hashlib, re

base = Path(os.environ.get("DEVSPACE_HOME", str(Path.home() / ".local/share/devspace-air")))
os.umask(0o077)
active = json.loads((base / "config/access/active.json").read_text())
if not re.fullmatch(r"[a-zA-Z0-9-]+", active["revision"]): raise RuntimeError("Invalid access generation")
generation = base / "config/access/generations" / active["revision"]
manifest = json.loads((generation / "manifest.json").read_text())
for filename in ["config.json", "server.sb"]:
    if hashlib.sha256((generation / filename).read_bytes()).hexdigest() != manifest["hashes"][filename]: raise RuntimeError("Access configuration integrity mismatch")
os.chdir(base)
payload = json.loads((base / "secrets/owner.json").read_text())
payload["telemetryKey"] = (base / "secrets/access-telemetry.key").read_text().strip()
registry = base / "config/cli-registry.json"
if registry.exists():
    # The broker's only request channel is a private inherited socketpair.
    parent_socket, child_socket = socket.socketpair()
    broker_log = open(base / "logs/cli-broker-error.log", "ab", buffering=0)
    broker = subprocess.Popen([str(base / "node-v24.20.0-darwin-arm64/bin/node"),
        str(base / "manager/cli/broker.mjs"), str(child_socket.fileno())], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
        stderr=broker_log, close_fds=True, pass_fds=(child_socket.fileno(),), env={"HOME": str(Path.home()), "PATH": "/usr/bin:/bin"})
    child_socket.close()
    # Keep it away from the temporary pipe descriptors until stdin has been set.
    cli_fd = os.dup(parent_socket.fileno())
    parent_socket.close()
    payload["cliEnabled"] = True
credential = json.dumps(payload).encode()
if len(credential) > 4096:
    raise RuntimeError("Unexpected credential size")
read_fd, write_fd = os.pipe()
os.write(write_fd, credential)
os.close(write_fd)
os.dup2(read_fd, 0)
os.close(read_fd)
if registry.exists():
    os.dup2(cli_fd, 3, inheritable=True)
    if cli_fd != 3: os.close(cli_fd)
env = {
    "PATH": str(base / "bin") + ":" + str(base / "node-v24.20.0-darwin-arm64/bin") + ":/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    "SHELL": str(base / "bin/sh"),
    "HOME": str(Path.home()), "USER": os.environ.get("USER", ""), "LOGNAME": os.environ.get("LOGNAME", ""),
    "LANG": "en_US.UTF-8", "TZ": "Asia/Shanghai",
    "TMPDIR": str(base / "tmp"),
    "XDG_CONFIG_HOME": str(base / "home/config"),
    "XDG_CACHE_HOME": str(base / "home/cache"),
    "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_SYSTEM": "/dev/null",
    "GIT_OPTIONAL_LOCKS": "0",
    "DEVSPACE_CONFIG_DIR": str(generation),
    "DEVSPACE_AGENT_DIR": str(base / "config/agent"),
    "DEVSPACE_TOOL_MODE": "codex", "DEVSPACE_WIDGETS": "full",
    "DEVSPACE_SKILLS": "1", "DEVSPACE_SUBAGENTS": "0",
    "DEVSPACE_SKILL_PATHS": str(Path.home() / "Workspace/Workbench/.agents/skills") + "," + str(Path.home() / ".codex/skills"),
    "DEVSPACE_LOG_SHELL_COMMANDS": "0", "DEVSPACE_LOG_LEVEL": "info",
}
args = [
    "/usr/bin/sandbox-exec", "-f", str(generation / "server.sb"),
    str(base / "node-v24.20.0-darwin-arm64/bin/node"),
    "--max-old-space-size=512", str(base / "bin/server.mjs"),
]
os.execve(args[0], args, env)

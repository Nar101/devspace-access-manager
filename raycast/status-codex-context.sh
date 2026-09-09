#!/bin/sh
# @raycast.schemaVersion 1
# @raycast.title 本地会话同步状态
# @raycast.mode fullOutput
# @raycast.icon 📚
# @raycast.packageName 本地上下文
exec /usr/bin/python3 "$HOME/.local/share/codex-context-exporter/bin/exporter.py" status --config "$HOME/.local/share/codex-context-exporter/config.json"

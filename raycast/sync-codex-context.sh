#!/bin/sh
# @raycast.schemaVersion 1
# @raycast.title 同步本地会话
# @raycast.mode fullOutput
# @raycast.icon 📚
# @raycast.packageName DevSpace 本机助手
exec "$HOME/.local/share/devspace-air/node-v24.20.0-darwin-arm64/bin/node" "$HOME/.local/share/devspace-air/manager/src/lifecycle.mjs" context-sync

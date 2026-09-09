#!/bin/sh
# @raycast.schemaVersion 1
# @raycast.title DevSpace 连接状态
# @raycast.mode fullOutput
# @raycast.icon images/devspace-access.png
# @raycast.packageName DevSpace
# @raycast.description 检查本机服务、隧道连接和公网入口。
exec "$HOME/.local/share/devspace-air/node-v24.20.0-darwin-arm64/bin/node" "$HOME/.local/share/devspace-air/manager/src/connection-health.mjs" status

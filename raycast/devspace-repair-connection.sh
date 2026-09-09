#!/bin/sh
# @raycast.schemaVersion 1
# @raycast.title 修复 DevSpace 连接
# @raycast.mode fullOutput
# @raycast.icon images/devspace-access.png
# @raycast.packageName DevSpace
# @raycast.description 检查并恢复 DevSpace 公网隧道，不重启正在工作的主服务。
exec "$HOME/.local/share/devspace-air/node-v24.20.0-darwin-arm64/bin/node" "$HOME/.local/share/devspace-air/manager/src/connection-health.mjs" repair

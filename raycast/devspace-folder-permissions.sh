#!/bin/sh
# @raycast.schemaVersion 1
# @raycast.title DevSpace 本机助手
# @raycast.mode compact
# @raycast.icon images/devspace-access.png
# @raycast.packageName DevSpace 本机助手
# @raycast.description 管理连接、文件夹、上下文同步和诊断。
exec "$HOME/.local/share/devspace-air/node-v24.20.0-darwin-arm64/bin/node" "$HOME/.local/share/devspace-air/manager/src/launch.mjs"

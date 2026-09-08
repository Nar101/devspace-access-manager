# 集成前提

v0.1.0 是源码预览。可以运行测试和纯界面演示；不能据此直接在空白 Mac 上安装完整的 ChatGPT 本机服务。

## 可直接运行的部分

```sh
npm ci
DEVSPACE_NODE="$(command -v node)" npm test
npm run check:public
npm run demo
```

演示页位于 `http://127.0.0.1:7680`，使用原始前端与内存示例数据，页面明确标记“界面演示”。添加、修改和撤销只改内存中的示例授权；不运行 DevSpace、不开系统目录窗口、不读写真实文件、不修改电脑权限。退出程序即可结束。

## 真实部署需要什么

迁移器默认拒绝执行。只有已经核对下面的部署基线，才考虑 `node src/install.mjs --migrate-existing`：

- macOS、Swift 命令行工具，以及经过核对的 Node 运行库；
- `DEVSPACE_HOME` 下已经安装 DevSpace 1.0.8；核心文件匹配 `runtime/upstream-hashes.json`；
- 既有 `bin/serve`、`bin/server.mjs`、`bin/control`、根 `server.sb`、`config/config.json` 和 `config/installation.json`；
- 上述启动器按匿名管道传递私有凭据，并支持清单版本核对；
- 现有 OAuth 与隧道部署已运行；本项目不创建域名、隧道或客户端身份；
- 服务标签为 `com.nar.devspace-air` 与 `com.nar.devspace-air-tunnel`；这是适配标识，不是通用服务发现；
- `src/policy.mjs` 中 `Workspace/Workbench`、`PrivateInfrastructure`、`Archive` 等是公开版示例保护路径，应与自己的只读/禁止访问区域一起审查，不是自动扫描结果。

当前代码没有提供以上完整部署基线的生成器。不要为了通过检查而填充空文件、删掉哈希检查、放宽沙箱或关闭认证。

默认部署根目录是用户主目录下 `.local/share/devspace-air`。`DEVSPACE_HOME` 可以覆盖它；`DEVSPACE_NODE` 可以指定 Node 可执行文件。改变这些值不意味着整个适配已自动完成，LaunchAgent、运行启动器和沙箱仍需配套核验。

## 验证层级

自动测试在临时目录中运行；macOS 额外执行真实 Seatbelt 检查，其他系统跳过该项。通过测试不等于完整服务可部署。

`test/live-check.py` 只供维护人员在自己已部署的实例上验证，依赖 Python requests，并会短暂重启该实例、创建测试 OAuth 客户端、增加临时授权和随后撤销。必须明确指定自己的地址和设置 `DEVSPACE_LIVE_CHECK=1`；默认不连接任何实例。不要在其他真实任务运行时执行。

历史的 18 项真实联调来自原本机安装版本。公开版只做了路径脱敏、依赖和测试入口整理，未在另一台 Mac 上完整安装验证。

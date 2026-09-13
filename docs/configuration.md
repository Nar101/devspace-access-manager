# 运行配置与发布范围

当前仍要求既有 macOS Apple Silicon DevSpace 1.0.8 集成及独立Node24运行库。DEVSPACE_HOME指定本机部署目录，DEVSPACE_NODE指定Node路径。现有默认服务标签含devspace-air，这是兼容标识，不代表可以把Air配置复制给别人；Mini服务标签和入口需要在升级时保留。

## 可选能力

能力配置在部署目录config/capabilities.json，只留本机。install-capabilities.mjs的--enable-grok、--enable-grok-search、--enable-project-delivery分别显式开启Grok、只读X搜索和npm验证/确认应用。默认保留原有停用设置。

Grok默认使用当前用户的~/.grok/auth.json和~/.grok/bin/grok；可通过GROK_AUTH_FILE、GROK_BINARY指定本人已有安装。GROK_BUILD_PROXY为可选代理，未设置时不强制任何作者私有端口。设置必须进入实际启动服务环境，不能只在另一个终端设置。刷新令牌仅在本机父进程使用；不要在Git提交这些文件。

Codex需要本人已登录的CLI，其配置和账号不会复制到任务。任务只得到临时转发口令。两种模型的登录兼容接口均需随CLI升级复核。

## 发布适配器

源码不包括个人网站与付费/第三方发布工具。操作者须准备自己核验的blog-publisher、article-release、公众号渲染器与验证器，按install-publisher.mjs引用结构配置。先设置DEVSPACE_WORKSPACE、DEVSPACE_BLOG_ROOT、DEVSPACE_SITE_URL；最后一项应为自己的HTTPS站点，不得沿用作者站点。安装后publisher.json的siteBaseUrl用于正文来源链接。未配置则拒绝发布。

## 安装范围

install-assistant为既有部署整合更新器；install-capabilities为能力模块更新器，二者均不是从零安装。源码包没有Cloudflare账号、域名、隧道、OAuth配置、目录书签、个人历史、发布器vendor或模型CLI。需要的组件由每位使用者自行取得并遵守原许可证。

升级前备份当前部署配置及运行文件；保持正在运行任务完成或主动结束；安装新版本后在ChatGPT网页运行新的测试任务。失败保留回执并恢复上一可用版本。不要把构建成功当作新电脑安装验收通过。

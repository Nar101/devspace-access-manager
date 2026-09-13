export function catalog({codexReady=false,grokReady=false,grokSearchReady=false,projectReady=false}={}){
 return [
 {id:'files',state:'existing',description:'沿用当前目录授权的文件读写'},
 {id:'cli',state:'existing',description:'已接入CLI；各账号/参数继续按原规则核验'},
 {id:'tasks',state:'implemented',description:'隔离任务、封存产物、续接、变更包、查询和取消'},
 {id:'codex.develop',state:codexReady?'enabled':'disabled',description:'在独立副本中调用Codex；不修改原项目，不继承本机密钥、插件和Hooks',network:'model-relay-only'},
 {id:'grok.develop',state:grokReady?'enabled':'disabled',description:'Grok Build在隔离副本执行，认证留在父进程，子进程仅访问本机模型代理'},
 {id:'grok.search',state:grokSearchReady?'enabled':'disabled',description:'公开X帖子只读搜索，返回引用；不读本地文件，不发帖；开发模式不含搜索'},
 {id:'project.verify',state:projectReady?'enabled':'disabled',description:'npm锁定依赖安装及独立test/build；禁用安装脚本'},
 {id:'project.apply',state:projectReady?'enabled':'disabled',description:'按预览版本确认后应用；备份、重复请求记录、检测改动后停止、可撤回'},
 ...['claude.develop','opencode.develop','git.pull_request','browser.read','browser.interact','desktop.read','desktop.interact','office','media','database.read','database.write','remote.ssh','local.models','events','notifications'].map(id=>({id,state:'pending_adapter',description:'未接入本轮统一任务入口；不自动扩大权限'})),
 {id:'publisher',state:'existing',description:'复用原发布器，仍需确认当前版本及渠道'},
 {id:'admin.full_access',state:'denied',description:'不开放无沙箱、任意管理员执行或原始凭据读取'}
 ];
}

import {Assistant} from '../src/assistant.mjs';
if(!process.argv.includes('--apply')){console.log('停止服务并移除登录与快捷入口，保留安装文件和所有数据。执行时添加 --apply。');process.exit(0);}
console.log(await new Assistant().action('remove-integration'));

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {ACCESS, ACTIVE} from './paths.mjs';

export async function readJSON(file) { return JSON.parse(await fs.readFile(file, 'utf8')); }
export async function atomicJSON(file, value) {
  await fs.mkdir(path.dirname(file), {recursive:true, mode:0o700});
  const tmp = file + '.' + crypto.randomUUID() + '.tmp';
  const handle = await fs.open(tmp, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n'); await handle.sync(); }
  finally { await handle.close(); }
  await fs.rename(tmp, file);
}
export async function loadActive(root = ACCESS, pointer = ACTIVE) {
  const active = await readJSON(pointer);
  if (!/^[a-zA-Z0-9-]+$/.test(active.revision)) throw new Error('授权版本标识无效');
  const dir = path.join(root, 'generations', active.revision);
  const manifest = await readJSON(path.join(dir, 'manifest.json'));
  if (manifest.revision !== active.revision) throw new Error('授权版本不一致');
  for (const file of ['config.json', 'server.sb']) {
    const digest = crypto.createHash('sha256').update(await fs.readFile(path.join(dir,file))).digest('hex');
    if (digest !== manifest.hashes[file]) throw new Error('配置被外部修改，请恢复有效版本');
  }
  return {revision:active.revision, grants:manifest.grants, dir, manifest};
}
export async function acquireLock(root = ACCESS) {
  const lock = path.join(root, '.apply-lock');
  await fs.mkdir(root, {recursive:true, mode:0o700});
  try { await fs.mkdir(lock, {mode:0o700}); }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    let owner;
    try { owner = await readJSON(path.join(lock,'owner.json')); } catch {}
    if (owner?.pid) {
      try { process.kill(owner.pid,0); throw new Error('另一项权限修改正在进行'); }
      catch (err) { if (err.code !== 'ESRCH') throw err; }
    } else {
      const stat = await fs.stat(lock);
      if (Date.now() - stat.mtimeMs < 30000) throw new Error('另一项权限修改正在启动');
    }
    await fs.rm(lock,{recursive:true,force:true});
    await fs.mkdir(lock,{mode:0o700});
  }
  await atomicJSON(path.join(lock,'owner.json'),{pid:process.pid,at:Date.now()});
  return () => fs.rm(lock,{recursive:true,force:true});
}

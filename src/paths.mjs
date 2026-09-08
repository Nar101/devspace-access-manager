import path from 'node:path';
import os from 'node:os';
export const BASE = process.env.DEVSPACE_HOME || path.join(os.homedir(), '.local/share/devspace-air');
export const ROOT = path.join(BASE, 'manager');
export const ACCESS = path.join(BASE, 'config/access');
export const ACTIVE = path.join(ACCESS, 'active.json');
export const JOURNAL = path.join(ACCESS, 'transaction.json');
export const SESSION = path.join(BASE, 'access-manager-session.json');
export const STATUS = path.join(BASE, 'state/access-status.json');
export const KEY = path.join(BASE, 'secrets/access-telemetry.key');
export const NODE = process.env.DEVSPACE_NODE || path.join(BASE, 'node-v24.20.0-darwin-arm64/bin/node');
export const inside = (child, parent) => {
  const r = path.relative(parent, child);
  return r === '' || (!r.startsWith('..' + path.sep) && r !== '..' && !path.isAbsolute(r));
};

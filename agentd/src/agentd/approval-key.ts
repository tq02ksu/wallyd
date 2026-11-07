/**
 * 共享审批验签秘密的**零人工**信任根。
 *
 * 用户没有屏幕/键盘，不存在「手动配置一个密钥」的路径。agentd 第一次启动时
 * 自己在应用私有数据目录生成 256 位随机 key；robotd 从同一路径读取。
 * 不覆盖已存在的合法 key（重启前后凭据仍然可验），内容非法时才重写。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { approvalSecretPath } from './paths.ts';

const KEY_BYTES = 32;
const HEX_KEY = /^[0-9a-f]{64}$/;

export interface ApprovalKeyInfo {
  /** 秘密文件路径（内容永不写日志）。 */
  path: string;
  /** 本次调用是否新建（或修复）了文件。 */
  created: boolean;
}

function readExisting(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch (e: any) {
    if (e?.code === 'ENOENT') return null;
    throw new Error(`无法读取共享审批秘密 ${file}: ${e?.message ?? e}`);
  }
}

function writeKey(file: string, key: string): void {
  const fd = fs.openSync(file, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, `${key}\n`, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(file, 0o600);
}

/**
 * 确保共享验签秘密存在。返回路径与是否创建，**不返回 key 本身**。
 *
 * 并发首次启动时 `wx` 只会成功一次；另一进程读到已生成的 key 后正常返回。
 */
export function ensureApprovalSigningKey(): ApprovalKeyInfo {
  const file = approvalSecretPath();
  const existing = readExisting(file);
  if (existing !== null && HEX_KEY.test(existing)) return { path: file, created: false };

  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const key = crypto.randomBytes(KEY_BYTES).toString('hex');

  if (existing !== null) {
    // 文件存在但内容不可用（截断、旧格式）。robotd 每次请求重读，所以就地修复后
    // 不需要重启；直接覆盖比让两个进程都拒绝服务更安全。
    fs.writeFileSync(file, `${key}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.chmodSync(file, 0o600);
    return { path: file, created: true };
  }

  try {
    writeKey(file, key);
    return { path: file, created: true };
  } catch (e: any) {
    if (e?.code === 'EEXIST') {
      const raced = readExisting(file);
      if (raced !== null && HEX_KEY.test(raced)) return { path: file, created: false };
    }
    throw new Error(`无法创建共享审批秘密 ${file}: ${e?.message ?? e}`);
  }
}

/**
 * GH-18 的 issuer 侧地基：共享验签秘密必须零人工、幂等、权限收紧。
 *
 * 只测 key 的生成与路径，不测签发（签发在 #11）。真实路径由
 * `WALLY_APP_DATA_DIR` 隔离到 work/，不碰用户主目录。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureApprovalSigningKey } from '../../src/agentd/approval-key.ts';
import { approvalSecretPath } from '../../src/agentd/paths.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..');
const root = path.join(REPO, 'work', 'agentd-test', `approval-key-${process.pid}`);
fs.rmSync(root, { recursive: true, force: true });
process.env.WALLY_APP_DATA_DIR = root;

let failed = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failed += 1;
    console.log(`  FAIL ${name}`, extra ?? '');
  }
}

const expected = path.join(root, 'robot', 'agentd', 'approval-signing-key');
check('秘密路径沿用应用私有数据目录', approvalSecretPath() === expected, approvalSecretPath());

const first = ensureApprovalSigningKey();
check('首次启动自动创建', first.created === true);
check('路径与解析函数一致', first.path === expected);
const text = fs.readFileSync(expected, 'utf8').trim();
check('内容为 256 位 hex', /^[0-9a-f]{64}$/.test(text), text.slice(0, 8));
check('权限为 0600', (fs.statSync(expected).mode & 0o777) === 0o600, (fs.statSync(expected).mode & 0o777).toString(8));

const second = ensureApprovalSigningKey();
check('重复启动不覆盖已有秘密', second.created === false && fs.readFileSync(expected, 'utf8').trim() === text);

fs.rmSync(root, { recursive: true, force: true });
delete process.env.WALLY_APP_DATA_DIR;

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);

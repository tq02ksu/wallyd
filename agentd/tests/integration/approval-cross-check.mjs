/**
 * 跨语言凭据守卫：**TypeScript 签发 → robotd Python 校验**。
 *
 * 为什么需要：`args_digest` 的规范化规则只有一份（contracts/approval-digest.json），
 * 但实现有两份（TS / Python）。只测其中一侧，另一侧漂移时不会有任何东西变红。
 * 本脚本用 agentd 真实的签发函数生成 `X-Wally-Approval`，再交给 robotd 真实的
 * `enforce_approval` 校验，是最接近生产的两端对照。
 *
 * 运行环境：integration lane（Node + robotd 的 Python venv 都在）。不碰硬件、不绑端口。
 * `ROBOTD_PYTHON` 可覆盖解释器（本地可用 `python3`）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { mintApprovalCredential } from '../../src/agentd/approval-credential.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..');
const python = process.env.ROBOTD_PYTHON ?? path.join(REPO, 'robotd', '.venv', 'bin', 'python');

let failed = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failed += 1;
    console.log(`  FAIL ${name}`, extra ?? '');
  }
}

if (path.isAbsolute(python) && !fs.existsSync(python)) {
  console.log(`SKIP: 找不到 robotd Python 解释器（${python}）；integration lane 安装后运行`);
  process.exit(0);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wally-approval-cross-'));
process.env.WALLY_APP_DATA_DIR = tmp;
fs.mkdirSync(path.join(tmp, 'robot', 'agentd'), { recursive: true });
fs.writeFileSync(
  path.join(tmp, 'robot', 'agentd', 'approval-signing-key'),
  `${'11'.repeat(32)}\n`,
  { mode: 0o600 },
);

const VERIFY = `
import json, sys
from pathlib import Path
from robotd.approval import enforce_approval
header, work, spec_json = sys.argv[1], Path(sys.argv[2]), sys.argv[3]
spec = json.loads(spec_json)
enforce_approval(
    header_value=header,
    capability=spec["capability"],
    approval_params=spec["params"],
    body=spec["body"],
    work_dir=work,
)
print("accepted")
`;

function verify(header, spec, workDir) {
  const env = {
    ...process.env,
    WALLY_APP_DATA_DIR: tmp,
    PYTHONPATH: path.join(REPO, 'robotd', 'src') + (process.env.PYTHONPATH ? `:${process.env.PYTHONPATH}` : ''),
  };
  return spawnSync(python, ['-c', VERIFY, header, workDir, JSON.stringify(spec)], { env, encoding: 'utf8' });
}

const FOLLOW = { capability: 'robot_follow', params: ['target_track_id', 'target'], body: { target_track_id: 'abc' } };

try {
  const cred = mintApprovalCredential({
    capability: 'robot_follow',
    args: { target_track_id: 'abc' },
    approvalParams: ['target_track_id', 'target'],
  });

  const ok = verify(cred.header, FOLLOW, path.join(tmp, 'work-ok'));
  check(
    'robotd 接受 TS 签发的凭据（签名 + 摘要 + nonce）',
    ok.status === 0 && ok.stdout.includes('accepted'),
    `${ok.status} ${ok.stderr}`,
  );

  // 同一凭据换参数必须被拒：证明 args_digest 真的绑定到了这组参数。
  const mismatch = verify(cred.header, { ...FOLLOW, body: { target_track_id: 'xyz' } }, path.join(tmp, 'work-mismatch'));
  check(
    '换参数后 robotd 拒绝（args_digest_mismatch）',
    mismatch.status !== 0 && `${mismatch.stderr}`.includes('args_digest_mismatch'),
    `${mismatch.status} ${mismatch.stderr}`,
  );

  // 同一个 nonce 再验一次必须被拒（一次性）。
  const replay = verify(cred.header, FOLLOW, path.join(tmp, 'work-ok'));
  check(
    '同一 nonce 重放被拒绝',
    replay.status !== 0 && `${replay.stderr}`.includes('nonce_replayed'),
    `${replay.status} ${replay.stderr}`,
  );

  // GH-74：数值参数（distance_mm / speed_mm_s）的摘要必须两端一致——
  // 这是 agentd 真的能把 robot_move 交给 robotd 的最后一跳。
  const MOVE = { capability: 'robot_move', params: ['distance_mm', 'speed_mm_s'], body: { distance_mm: 300, speed_mm_s: 150 } };
  const moveCred = mintApprovalCredential({
    capability: 'robot_move',
    args: MOVE.body,
    approvalParams: MOVE.params,
  });
  const moveOk = verify(moveCred.header, MOVE, path.join(tmp, 'work-move'));
  check(
    'robotd 接受 robot_move 的数值参数凭据',
    moveOk.status === 0 && moveOk.stdout.includes('accepted'),
    `${moveOk.status} ${moveOk.stderr}`,
  );
  const moveMismatch = verify(
    mintApprovalCredential({ capability: 'robot_move', args: MOVE.body, approvalParams: MOVE.params }).header,
    { ...MOVE, body: { distance_mm: 301, speed_mm_s: 150 } },
    path.join(tmp, 'work-move-mismatch'),
  );
  check(
    'robot_move 换距离后 robotd 拒绝（args_digest_mismatch）',
    moveMismatch.status !== 0 && `${moveMismatch.stderr}`.includes('args_digest_mismatch'),
    `${moveMismatch.status} ${moveMismatch.stderr}`,
  );
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.WALLY_APP_DATA_DIR;
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);

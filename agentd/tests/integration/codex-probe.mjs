/**
 * A01 探针：Codex app-server 是否可用、是否与主机隔离。
 *
 * 这个脚本只做「能不能接」的取证，不碰真机、不提交任何机器人任务。
 *
 * ## 首要目标：证明隔离
 *
 * 主机 `~/.codex` 有 2 GB 真实会话历史，**绝不能**被这个探针读到或写入。
 * 隔离手段是 `CODEX_HOME` 指向项目 `work/` 下的临时目录。
 * 所以本脚本第一个断言是「主机目录没被动过」——如果这条不成立，
 * 后面所有测试结论都不可信，应该直接停下。
 *
 * ## 用法
 *
 *   cd <wallyd-root>/agentd
 *   node --experimental-strip-types tests/integration/codex-probe.mjs
 *
 * 需要 `CODEX_API_KEY` 或 `OPENAI_API_KEY` 才会尝试真实 turn；
 * 没有凭证时只验证「能 spawn、能握手、隔离生效」，不判失败。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { codexHomePath } from '../../src/agentd/paths.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AGENTD_ROOT = path.resolve(HERE, '..', '..');

const HOST_CODEX_HOME = path.join(os.homedir(), '.codex');
// 沙箱位置统一由 paths.ts 决定（macOS 下是 ~/Library/Application Support/robot/agentd/codex-home）。
// 探针不自己拼路径，避免「代码里一处、测试里另一处」的漂移。
const SANDBOX_HOME = codexHomePath();
// 工作目录是真正的一次性产物，放项目 work/ 下即可（与沙箱 home 是两回事）。
const PROBE_CWD = path.resolve(AGENTD_ROOT, '..', 'work', 'codex-probe', 'cwd');

let failed = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failed += 1;
    console.log(`  FAIL ${name}`, extra ?? '');
  }
}

// ---------------------------------------------------------------- 0. 隔离前置检查
console.log('— 隔离前置检查');

if (!fs.existsSync(HOST_CODEX_HOME)) {
  console.log('  （主机没有 ~/.codex，无需隔离保护）');
} else {
  // 快照只统计**文件数与文件集合**，不用「最新 mtime」。
  // 原因：主机上可能同时有别的 Codex 进程在写自己的日志
  // （实测观察到 ~/.codex/logs_2.sqlite-wal 被常驻进程持续写入），
  // 用「最新 mtime」当判据会把别人的正常写入误判成本探针的污染。
  const snapshot = () => {
    const files = new Set();
    const walk = (dir, depth) => {
      if (depth > 2) return; // 只统计浅层，够用于「有没有新增/删除」的判断
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, depth + 1);
        else files.add(p);
      }
    };
    walk(HOST_CODEX_HOME, 0);
    return files;
  };

  const before = snapshot();
  console.log(`       主机 ~/.codex 快照：${before.size} 个文件（depth≤2）`);

  // 探针**不删**沙箱目录。它是会话历史的存放处，不是缓存：
  // 删掉会让 resumeThread 失效。需要干净环境时由人显式删除，
  // 不要让「跑个测试」变成「清空会话历史」。
  fs.mkdirSync(SANDBOX_HOME, { recursive: true });

  check('沙箱 CODEX_HOME 独立于主机 ~/.codex', !SANDBOX_HOME.startsWith(HOST_CODEX_HOME));
  check(
    '沙箱 CODEX_HOME 不在 git 工作区内',
    !SANDBOX_HOME.startsWith(path.resolve(AGENTD_ROOT, '..')),
    SANDBOX_HOME,
  );
  // macOS 上应在 Application Support（系统不主动回收）；其他平台允许 XDG 目录。
  if (process.platform === 'darwin') {
    check('沙箱 CODEX_HOME 在 Application Support 下', SANDBOX_HOME.includes('Application Support'), SANDBOX_HOME);
    check('沙箱 CODEX_HOME 不与主机 ~/Library/Caches/Codex 重名', !SANDBOX_HOME.includes(`${path.sep}Caches${path.sep}`));
  }
  console.log(`       沙箱：${SANDBOX_HOME}`);

  const apiKey = process.env.CODEX_API_KEY ?? process.env.OPENAI_API_KEY ?? null;

  // ------------------------------------------------------------ 1. SDK 能否加载并找到二进制
  console.log('— SDK 与二进制');
  let Codex;
  try {
    ({ Codex } = await import('@openai/codex-sdk'));
    check('@openai/codex-sdk 可 import', typeof Codex === 'function');
  } catch (e) {
    check('@openai/codex-sdk 可 import', false, e.message);
  }

  // 显式指向 npm 包自带的二进制，**不用 PATH 里的主机 codex**。
  const localBinary = path.join(
    AGENTD_ROOT,
    'node_modules',
    '@openai',
    'codex-darwin-arm64',
    'vendor',
    'aarch64-apple-darwin',
    'bin',
    'codex',
  );
  check('npm 包自带二进制存在', fs.existsSync(localBinary), localBinary);

  if (Codex && fs.existsSync(localBinary)) {
    // -------------------------------------------------------- 2. 握手：startThread 不触发模型调用
    console.log('— 启动与握手（不产生模型调用）');
    const codex = new Codex({
      codexPathOverride: localBinary,
      apiKey: apiKey ?? 'sk-not-a-real-key',
      // env 一旦提供就不继承 process.env，这是 SDK 文档写明行为。
      // 必须显式传 PATH，否则子进程找不到基础命令。
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: process.env.HOME ?? '',
        CODEX_HOME: SANDBOX_HOME,
        ...(apiKey ? { CODEX_API_KEY: apiKey } : {}),
      },
      config: {
        // 关掉一切可能联网或有副作用的特性，探针只验证协议。
        web_search: 'disabled',
      },
    });

    let thread;
    try {
      thread = codex.startThread({
        sandboxMode: 'read-only',
        approvalPolicy: 'never',
        workingDirectory: PROBE_CWD,
        skipGitRepoCheck: true,
      });
      fs.mkdirSync(PROBE_CWD, { recursive: true });
      check('startThread 返回 Thread 实例', typeof thread?.runStreamed === 'function');
    } catch (e) {
      check('startThread 返回 Thread 实例', false, e.message);
    }

    if (thread) {
      // ---------------------------------------------------- 3. 真实 turn（有凭证才跑）
      if (!apiKey) {
        console.log('  --   跳过真实 turn：没有 CODEX_API_KEY / OPENAI_API_KEY');
        console.log('       （这不判失败：无凭证时只验证「能启动、隔离生效」）');
      } else {
        console.log('— 真实 turn（流式）');
        try {
          const streamed = await thread.runStreamed('只回复两个字：收到。不要调用任何工具。');
          let events = 0;
          let sawText = false;
          let sawCompleted = false;
          const types = new Set();
          const deadline = Date.now() + 90_000;
          for await (const ev of streamed.events) {
            events += 1;
            types.add(ev.type);
            if (ev.type === 'item.completed' || ev.type === 'item.updated') sawText = true;
            if (ev.type === 'turn.completed') sawCompleted = true;
            if (Date.now() > deadline) {
              check('turn 在 90 秒内结束', false, '超时');
              break;
            }
          }
          check('收到流式事件', events > 0, `${events} 个`);
          check('收到 turn.completed', sawCompleted, [...types].join(','));
          console.log(`       事件类型：${[...types].join(', ')}`);
        } catch (e) {
          check('真实 turn 成功', false, `${e.name}: ${e.message}`);
        }
      }
    }

    // -------------------------------------------------------- 4. 隔离实证：真 spawn 一次
    // 注意：`startThread()` 只是构造对象，**不会 spawn 子进程**；只有跑 turn 才会。
    // 所以「沙箱目录空」不等于「CODEX_HOME 没生效」。要证明隔离，必须真的启动一次
    // 二进制并让它自己报出 home 在哪——这是唯一可信的判据。
    console.log('— 隔离实证（真启动二进制，让它自报 home）');
    try {
      const { execFileSync } = await import('node:child_process');
      let out = '';
      try {
        out = execFileSync(localBinary, ['doctor'], {
          env: {
            PATH: process.env.PATH ?? '/usr/bin:/bin',
            HOME: process.env.HOME ?? '',
            CODEX_HOME: SANDBOX_HOME,
          },
          encoding: 'utf8',
          timeout: 60_000,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (e) {
        // doctor 发现缺凭证/CDN 不可达时退出码非零，那是**报告结果**不是执行失败。
        // 只要它输出了诊断内容，就说明二进制真的跑起来了。
        out = String(e.stdout ?? '');
        check('doctor 有输出（退出码非零属正常：它报告了问题）', out.length > 0, e.message);
      }
      // doctor 会把长路径截断成 `~/Library/Application Su…robot/agentd/codex-home (dir)`
      // （注意含 `…` 与空格），所以不能逐字比对。只断言它落在机器人专属的路径片段下，
      // 且**不**指向主机 ~/.codex —— 这两点才是「隔离生效」的实质。
      const homeLine = /CODEX_HOME\s+(.+?)\s+\((?:dir|missing)\)/.exec(out)?.[1] ?? null;
      check('doctor 报出了 CODEX_HOME', Boolean(homeLine), homeLine ?? '(未解析到)');
      check(
        '自报 home 指向 robot/agentd 专属目录',
        Boolean(homeLine && /robot\/agentd\/codex-home/.test(homeLine)),
        homeLine ?? '(未解析到)',
      );
      check('二进制没有指向主机 ~/.codex', Boolean(homeLine && !/(^|\/)\.codex(\/|$|\s)/.test(homeLine)), homeLine ?? '');
      check('二进制读不到主机凭证', /no Codex credentials/i.test(out));
      console.log(`       自报 home：${homeLine ?? '(未解析到)'}`);
    } catch (e) {
      check('二进制可执行并自报 home', false, `${e.name}: ${e.message}`);
    }
    console.log('— 隔离复检（主机目录无新增文件）');
    const after = snapshot();
    const added = [...after].filter((f) => !before.has(f));
    const removed = [...before].filter((f) => !after.has(f));
    check('主机 ~/.codex 没有新增文件', added.length === 0, added.slice(0, 5).join(', '));
    check('主机 ~/.codex 没有文件被删除', removed.length === 0, removed.slice(0, 5).join(', '));
    console.log(`       文件数 ${before.size} → ${after.size}`);
    // 注意：这里**不**断言「沙箱目录非空」。startThread 不会 spawn，只有跑 turn 才建会话文件，
    // 无凭证时沙箱本来就是空的——断言非空会得出「隔离没生效」的错误结论。
    // 隔离是否生效，由上面对二进制自报 home 的断言来证明。
    console.log(`       沙箱 CODEX_HOME：${SANDBOX_HOME}`);
    console.log(`       沙箱子项：${fs.readdirSync(SANDBOX_HOME).join(', ') || '(空，未跑 turn 属正常)'}`);

    // 把沙箱里的东西也报出来，便于确认会话确实落在沙箱
    const walkCount = (dir) => {
      let n = 0;
      const walk = (d) => {
        let es;
        try {
          es = fs.readdirSync(d, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of es) {
          if (e.isDirectory()) walk(path.join(d, e.name));
          else n += 1;
        }
      };
      walk(dir);
      return n;
    };
    console.log(`       沙箱文件总数：${walkCount(SANDBOX_HOME)}`);
  }
}

console.log('');
if (failed > 0) {
  console.log(`${failed} 项失败`);
  process.exit(1);
}
console.log('探针通过');

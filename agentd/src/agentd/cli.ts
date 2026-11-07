/**
 * agentd 命令行入口。
 *
 * 用法：
 *   node --experimental-strip-types agentd/src/cli.ts [--port 8791] [--robotd http://127.0.0.1:8787]
 *
 * 设计约束：
 * - 只监听回环，没有 `--host` 选项（也就没有「不小心开到 0.0.0.0」的可能）。
 * - `--allow-manual-approve` 是唯一的测试开关，且会在 `/healthz` 与总览里显式标出。
 */
import process from 'node:process';
import { ensureApprovalSigningKey } from './approval-key.ts';
import { createRuntime, defaultConfig, makeLogger, type AgentdConfig } from './service.ts';

function parseArgs(argv: string[]): AgentdConfig {
  const config = defaultConfig();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = (): string => {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`${arg} 缺少参数值`);
      i += 1;
      return v;
    };
    switch (arg) {
      case '--port':
      case '--http': {
        const n = Number(next());
        if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error('--port 必须是 0-65535 的整数');
        config.httpPort = n;
        break;
      }
      case '--robotd':
        config.robotdUrl = next();
        break;
      case '--data-dir':
        config.dataDir = next();
        break;
      case '--static-dir':
        config.staticDir = next();
        break;
      case '--harness':
        config.harnessBinary = next();
        break;
      case '--log-level': {
        const v = next();
        if (!['debug', 'info', 'warn', 'error'].includes(v)) {
          throw new Error('--log-level 只能是 debug/info/warn/error');
        }
        config.logLevel = v as AgentdConfig['logLevel'];
        break;
      }
      case '--allow-manual-approve':
        config.allowManualApprove = true;
        break;
      case '--help':
      case '-h':
        process.stdout.write(
          [
            'agentd — 大脑与管家',
            '',
            '  --port N                  监听端口（默认 8791；只绑 127.0.0.1）',
            '  --robotd URL              robotd 端点（默认 http://127.0.0.1:8787）',
            '  --data-dir DIR            数据目录（默认 work/agentd）',
            '  --static-dir DIR          UI 静态目录',
            '  --harness PATH            Harness 可执行文件（可选）',
            '  --log-level LEVEL         debug/info/warn/error',
            '  --allow-manual-approve    显式测试模式：允许手工批准（生产禁用）',
            '',
            '停止机器人不经过 agentd：浏览器可信客户端直达 robotd 的 robot_stop。',
            '',
          ].join('\n'),
        );
        process.exit(0);
        break;
      default:
        if (arg.startsWith('--')) throw new Error(`未知参数 ${arg}`);
    }
  }
  return config;
}

async function main(): Promise<void> {
  let config: AgentdConfig;
  try {
    config = parseArgs(process.argv.slice(2));
  } catch (e: any) {
    process.stderr.write(`参数错误：${e.message}\n`);
    process.exit(2);
    return;
  }

  const log = makeLogger(config.logLevel);

  // 共享审批秘密的信任根：首次启动自动生成，无需任何人工初始化。
  // robotd 可能先于 agentd 启动；它每次请求重读该文件，所以这里晚一步也不影响。
  const approvalKey = ensureApprovalSigningKey();
  log(approvalKey.created ? '审批验签秘密已生成' : '审批验签秘密已就绪', {
    path: approvalKey.path,
  });

  if (config.allowManualApprove) {
    log('WARNING: 测试模式已开启（allow_manual_approve）。生产运行时不得开启。');
  }

  const runtime = await createRuntime(config, { log });
  const base = `http://127.0.0.1:${runtime.port}`;
  process.stdout.write(`agentd 已启动：${base}（boot ${runtime.bootId}）\n`);
  process.stdout.write(`  总览 ${base}/api/state\n`);
  process.stdout.write('  停止机器人不依赖 agentd\n');

  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;
    process.stdout.write(`\n收到 ${signal}，正在关闭 agentd…\n`);
    try {
      await runtime.close();
    } catch (e: any) {
      process.stderr.write(`关闭时出错：${e.message}\n`);
    }
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((e) => {
  process.stderr.write(`agentd 启动失败：${e?.stack ?? e}\n`);
  process.exit(1);
});

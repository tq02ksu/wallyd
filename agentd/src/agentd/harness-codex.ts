/**
 * `@openai/codex-sdk` 适配层（GH-10）。
 *
 * 这是**唯一** import 模型 SDK 的文件。执行器（harness.ts）只认结构化接口，
 * 因此单测不需要 361 MB 的原生二进制，也不需要网络。
 *
 * 隔离要点：
 * - `codexPathOverride` 指向 `--harness` 给的二进制，不用 PATH 里的主机 codex；
 * - 显式 `env`（buildCodexEnv）让 SDK 不继承 `process.env`；
 * - `CODEX_HOME` 永远是 codexHomePath()，主机 `~/.codex` 不可达；
 * - 模型看不到 robotd 的 HTTP 直连：不开网络、不注册任何 MCP server。
 */
import type {
  HarnessClientFactory,
  HarnessClientLike,
  HarnessEvent,
  HarnessStream,
  HarnessThreadLike,
} from './harness.ts';
import { buildCodexEnv } from './harness.ts';

export const createCodexHarnessClient: HarnessClientFactory = async (opts) => {
  const { Codex } = await import('@openai/codex-sdk');

  const codex = new Codex({
    codexPathOverride: opts.binary,
    apiKey: opts.apiKey,
    // 显式传入后 SDK 不再继承 process.env。
    env: buildCodexEnv(process.env, opts.codexHome, opts.apiKey),
    config: {
      // 机器人任务不需要联网检索；关掉它也减少数据出本机的路径。
      web_search: 'disabled',
    },
  });

  const threadOptions = {
    // 读只读、无网络：模型只能做理解与规划，副作用必须走受管工具面。
    sandboxMode: 'read-only' as const,
    approvalPolicy: 'never' as const,
    workingDirectory: opts.workingDirectory,
    skipGitRepoCheck: true,
    networkAccessEnabled: false,
    webSearchMode: 'disabled' as const,
    ...(opts.model ? { model: opts.model } : {}),
  };

  return {
    startThread: () => adaptThread(codex.startThread(threadOptions)),
    resumeThread: (threadId: string) => adaptThread(codex.resumeThread(threadId, threadOptions)),
  } satisfies HarnessClientLike;
};

function adaptThread(thread: {
  id: string | null;
  runStreamed(input: string, opts?: { signal?: AbortSignal }): Promise<{ events: AsyncIterable<unknown> }>;
}): HarnessThreadLike {
  return {
    get id() {
      return thread.id;
    },
    async runStreamed(input, opts): Promise<HarnessStream> {
      const streamed = await thread.runStreamed(input, opts);
      return { events: toHarnessEvents(streamed.events) };
    },
  };
}

async function* toHarnessEvents(events: AsyncIterable<unknown>): AsyncIterable<HarnessEvent> {
  for await (const event of events) yield event as HarnessEvent;
}

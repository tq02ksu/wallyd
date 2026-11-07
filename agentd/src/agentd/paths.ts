/**
 * Codex 沙箱目录的解析。
 *
 * ## 为什么不用项目内的 work/
 *
 * Codex 的 `CODEX_HOME` 里放的是**会话历史**（`thread/resume` 依赖它）。这不是临时产物：
 * 系统清理、`git clean`、换分支都不该让它消失。放在项目 `work/` 下，一次清理就把历史带走。
 *
 * ## 为什么不用 ~/Library/Caches
 *
 * macOS 的 `Caches` 语义是「系统可以随时回收」。会话历史被回收后 `resumeThread` 会失效，
 * 而且失败得很安静（表现为「找不到线程」而不是「缓存没了」）。所以用
 * `Application Support`——macOS 给「应用私有数据」的官方位置，系统不会主动清。
 *
 * ## 为什么要在主机 Codex 之外另起一个
 *
 * 主机 `~/.codex` 是用户真实使用的 Codex，有 GB 级历史。agentd 是**另一个进程、
 * 另一套用途**，共用目录会互相干扰：agentd 重启对账看到一堆不相干的线程，
 * 用户也可能在 Codex 里看到机器人任务。所以独立 `CODEX_HOME` 是硬要求。
 *
 * ## 路径
 *
 *   ~/Library/Application Support/robot/agentd/codex-home
 *
 * 注意**不能**叫 `.../Codex` 或 `.../Caches/Codex`：主机 Codex 已经占了那些名字。
 * 在 macOS 之外（CI、Linux）退回 `$XDG_DATA_HOME` 或 `~/.local/share`。
 */
import os from 'node:os';
import path from 'node:path';

/** 应用私有数据根。macOS 用 Application Support，其他平台按 XDG 约定。 */
export function appDataRoot(): string {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support');
  }
  const xdg = process.env.XDG_DATA_HOME;
  return xdg && xdg.length > 0 ? xdg : path.join(home, '.local', 'share');
}

/** Codex 沙箱 home（会话历史落这里）。 */
export function codexHomePath(): string {
  // 允许显式覆盖：CI 里想完全隔离、或想复用某个固定目录时用。
  const override = process.env.AGENTD_CODEX_HOME;
  if (override && override.length > 0) return path.resolve(override);
  return path.join(appDataRoot(), 'robot', 'agentd', 'codex-home');
}

/** agentd 的其他应用私有数据（将来放日志、缓存索引等）。 */
export function agentdDataDir(): string {
  return path.join(appDataRoot(), 'robot', 'agentd');
}

/**
 * 两进程共享的审批验签秘密（HMAC key）。
 *
 * 由 agentd 首次启动时自动生成，robotd 每次需审批请求重读同一个文件。
 * 位置与 `agentdDataDir()` 一致，但**不放**项目内的 `work/`：`work/` 是可清理的
 * 运行产物目录，秘密跟着被清掉会让所有审批凭据突然验签失败。
 *
 * `WALLY_APP_DATA_DIR` 只用于测试隔离或显式布局；robotd 侧同名读取。
 */
export function approvalSecretPath(): string {
  const override = process.env.WALLY_APP_DATA_DIR;
  const root = override && override.length > 0 ? path.resolve(override) : appDataRoot();
  return path.join(root, 'robot', 'agentd', 'approval-signing-key');
}

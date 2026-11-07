/**
 * 语音批准后的执行：签发一次性凭据 → 记录 tool_call → 调用被批准的能力。
 *
 * 单独成模块的原因：这条路径是「批准 → 真的执行」的最后一跳，必须能脱离 HTTP
 * 服务器单测。装配层（service.ts）只负责把依赖传进来。
 *
 * 纪律：
 * - 签发失败 / 能力不存在 → run failed，**不调用 robotd**（fail closed）；
 * - `tool_calls` 必须带 `requires_approval` 与 `approval_id`，批准只对原参数有效；
 * - 不调用 `robot_speak`：复述已由系统播报路径完成。
 */
import { Store, nowIso, compactJson } from './store.ts';
import type { RunService } from './runs.ts';
import type { CapabilityInfo } from './robotd-client.ts';
import { mintApprovalCredential, authorizationRecord } from './approval-credential.ts';

/** 执行器只需要 robotd 客户端的一小部分能力（便于用替身测试）。 */
export interface ApprovalExecutorRobotd {
  capabilities: { current: CapabilityInfo[] | null };
  discoverCapabilities(instanceId: string | null): Promise<CapabilityInfo[]>;
  callCapability(
    name: string,
    args: Record<string, unknown>,
    opts?: { instanceId?: string | null; approvalHeader?: string | null },
  ): Promise<{ body: unknown; robot_task_id: string | null }>;
}

export interface ApprovalExecutorDeps {
  runs: RunService;
  robotd: ApprovalExecutorRobotd;
  store: Store;
  log: (msg: string, extra?: Record<string, unknown>) => void;
}

export interface ExecuteApprovedInput {
  approvalId: string;
  runId: string;
  capability: string;
  args: Record<string, unknown>;
  actionLabel: string;
}

export async function executeApprovedCapability(
  deps: ApprovalExecutorDeps,
  input: ExecuteApprovedInput,
): Promise<void> {
  const { runs, robotd, store, log } = deps;
  const { approvalId, runId, capability, args, actionLabel } = input;
  let toolCallId: string | null = null;
  try {
    let tools = robotd.capabilities.current;
    if (!tools) {
      try {
        tools = await robotd.discoverCapabilities(null);
      } catch (e: any) {
        runs.transition(runId, 'failed', {
          reason: 'capability_discovery_failed',
          detail: `无法确认能力：${e.message}`,
        });
        return;
      }
    }
    const tool = tools.find((t) => t.name === capability);
    if (!tool) {
      runs.transition(runId, 'failed', {
        reason: 'capability_missing',
        detail: `对端没有提供能力 ${capability}，未执行任何动作`,
      });
      return;
    }
    const approvalParams = tool.approvalParams ?? [];

    let credential;
    try {
      credential = mintApprovalCredential({ capability, args, approvalParams });
    } catch (e: any) {
      runs.transition(runId, 'failed', {
        reason: 'approval_credential_failed',
        detail: `无法签发一次性授权：${e?.message ?? e}`,
      });
      return;
    }

    store.transaction((tx) => {
      tx.run(
        'UPDATE approvals SET authorization_json = ? WHERE approval_id = ?',
        compactJson(authorizationRecord(credential)),
        approvalId,
      );
      toolCallId = runs.recordToolCall(
        tx,
        runId,
        capability,
        actionLabel,
        compactJson(args).slice(0, 200),
        'requested',
        { args, approvalParams, approvalId },
      );
    });

    const res = await robotd.callCapability(capability, args, {
      approvalHeader: credential.header,
    });
    const detail = res.robot_task_id ? `robotd 任务 ${res.robot_task_id}` : '已下发';
    store.transaction((tx) => {
      tx.run(
        `UPDATE tool_calls SET state = 'succeeded', robot_task_id = ?, finished_at = ?, detail = ?
         WHERE tool_call_id = ?`,
        res.robot_task_id,
        nowIso(),
        detail,
        toolCallId,
      );
      tx.run('UPDATE approvals SET authorization_consumed = 1 WHERE approval_id = ?', approvalId);
      const sid = runs.addStep(tx, runId, `执行 ${capability}`, 'active');
      tx.run(
        'UPDATE run_steps SET state = ?, finished_at = ?, note = ? WHERE step_id = ?',
        'done',
        nowIso(),
        detail,
        sid,
      );
    });
    runs.transition(runId, 'succeeded', { reason: 'voice_approved', detail });
  } catch (e: any) {
    const detail = e?.message ? String(e.message) : String(e);
    if (toolCallId) {
      try {
        store.transaction((tx) => {
          tx.run(
            `UPDATE tool_calls SET state = 'failed', finished_at = ?, detail = ?, error_code = ?
             WHERE tool_call_id = ?`,
            nowIso(),
            detail,
            e?.code ?? null,
            toolCallId,
          );
        });
      } catch (e2: any) {
        log('工具调用失败状态写入失败', { run_id: runId, error: e2.message });
      }
    }
    try {
      runs.transition(runId, 'failed', { reason: 'capability_failed', detail });
    } catch (e2: any) {
      log('快速路由终态写入失败', { run_id: runId, error: e2.message });
    }
  }
}

#!/usr/bin/env python3
"""GH-58：`smoke_voice.sh` 的纯断言层（B1–B7）。

这里只读 NDJSON 事件与 stderr，**不启动进程、不碰设备**；采集在
`eval/aec3/smoke_voice.sh` 里。这样同一套判据可以用固定 fixture 离线跑，
不需要 macOS、麦克风或扬声器。

判据（来自 #41）：

- B1：见过 `bridge_ready`
- B2：见过 `tts_started`
- B3：`tts_chunk_finished` 计数 > 0
- B4：见过 `tts_played`，且 `played > 0`（非 dry-run）
- B5：见过 `tts_finished`，`stop_reason == "done"`，未被取消
- B6：stderr 无 `Terminating app`
- B7：播报窗口内 `speech_state` / 采集电平（`aec_echo_probe`）持续更新

另有 C0（构建身份）：`bridge_ready` 默认不得回报 `test_harness: true`（生产构建）；
AEC 对照实验（`aec_ab2.sh` / `collect_pair.sh`）反过来要求它**是** JSON `true`
（`require_harness=True`）。C0b（AEC 模式）在指定 `expected_aec_mode` 时要求
`bridge_ready.aec_mode` 精确相等——`--aec3` 被桥静默忽略时必须变红。

所有判据都读**解析后的 JSON 字段**，不做文本匹配：桥输出的是紧凑 JSON
（`"test_harness":true`），用带空格的 grep 字面量匹配会把成功的实验误判成作废
（GH-65）。

退出码：0 = PASS；1 = FAIL；2 = 参数或输入错误（不是判定结果）。
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass
from pathlib import Path

# B7：播报窗口内至少要有 3 次电平/语音状态更新，且首尾跨度覆盖窗口的 50%。
# 生产桥在播报期间按 100ms 节奏发 `aec_echo_probe`，一段 3 秒播报约 30 次。
MIN_LEVEL_EVENTS = 3
MIN_LEVEL_COVERAGE = 0.5
LEVEL_EVENT_TYPES = ("aec_echo_probe", "speech_state")
CRASH_MARKER = "Terminating app"


class InputError(Exception):
    """输入文件不合法（fail closed，不猜）。"""


@dataclass(frozen=True)
class Check:
    key: str
    ok: bool
    detail: str


@dataclass
class Report:
    checks: list[Check]
    counts: dict[str, object]

    @property
    def ok(self) -> bool:
        return all(check.ok for check in self.checks)


def load_events(path: Path) -> list[dict]:
    """读 NDJSON；空行跳过，坏行直接判输入错误（不静默丢事件）。"""
    events: list[dict] = []
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise InputError(f"读不到事件文件 {path}: {exc}") from exc
    for lineno, line in enumerate(text.splitlines(), start=1):
        stripped = line.strip()
        if not stripped:
            continue
        try:
            obj = json.loads(stripped)
        except json.JSONDecodeError as exc:
            raise InputError(f"{path}:{lineno} 不是合法 JSON: {exc.msg}") from exc
        if not isinstance(obj, dict):
            raise InputError(f"{path}:{lineno} 不是 JSON 对象")
        events.append(obj)
    return events


def _t_ms(event: dict) -> int | None:
    value = event.get("t_ms")
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value


def _wire(events: list[dict], response_id: str | None) -> list[dict]:
    if response_id is None:
        return events
    return [event for event in events if event.get("response_id") == response_id]


def bridge_ready(events: list[dict]) -> dict | None:
    """第一条 `bridge_ready`；没有就返回 None。

    调用方据此判断「桥到底是不是测试构建、进的是不是请求的 AEC 模式」，
    **一律读解析后的字段**，不做文本匹配。
    """
    for event in events:
        if event.get("ev") == "bridge_ready":
            return event
    return None


def carries_flag(value: object) -> bool:
    """JSON 布尔 `true` 才算；字符串 `"true"` 不算（防手写 fixture 写成字符串）。"""
    return value is True


def check_harness_or_production(bridge: dict | None, require_harness: bool) -> Check:
    """C0（要求 harness）与 C0p（要求生产构建）是同一个开关的两面。"""
    value = bridge.get("test_harness") if bridge else None
    if require_harness:
        ok = carries_flag(value)
        return Check(
            "C0",
            ok,
            (
                "bridge_ready 回报 test_harness=true（测试构建）"
                if ok
                else f"bridge_ready.test_harness={value!r}，不是 JSON true；"
                "AudioBridge 未用 WALLY_AUDIO_TEST_HARNESS=1 构建，实验作废"
            ),
        )
    ok = not carries_flag(value)
    return Check(
        "C0",
        ok,
        "bridge_ready 未回报 test_harness（默认生产构建）"
        if ok
        else "bridge_ready 回报了 test_harness=true，测试构建不能冒充生产指标",
    )


def check_aec_mode(bridge: dict | None, expected: str | None) -> Check:
    """ABAB / collect_pair 的证伪锚点：桥必须真的进了请求的 AEC 模式。

    `expected is None` 表示调用方没有要求（`smoke_voice.sh` 就是这种），判为跳过。
    """
    if expected is None:
        return Check("C0b", True, "未指定 aec_mode，跳过")
    actual = bridge.get("aec_mode") if bridge else None
    return Check(
        "C0b",
        actual == expected,
        f"aec_mode={expected}"
        if actual == expected
        else f"bridge_ready.aec_mode={actual!r}，要求 {expected!r}（--aec3 被忽略会让 VPIO 数据冒充 AEC3）",
    )


def analyze(
    events: list[dict],
    stderr_text: str,
    response_id: str | None = None,
    *,
    require_harness: bool = False,
    expected_aec_mode: str | None = None,
) -> Report:
    """对事件与 stderr 做 B1–B7 + C0/C0b 判定。纯函数，不读文件。

    两个新参数只在显式传入时才改变判据，默认值保持 `smoke_voice.sh` 的原有语义。
    """
    bridge_events = [event for event in events if event.get("ev") == "bridge_ready"]
    bridge = bridge_ready(events)
    tts_started = _wire([event for event in events if event.get("ev") == "tts_started"], response_id)
    chunk_finished = _wire(
        [event for event in events if event.get("ev") == "tts_chunk_finished"], response_id
    )
    tts_played = _wire([event for event in events if event.get("ev") == "tts_played"], response_id)
    tts_finished = _wire([event for event in events if event.get("ev") == "tts_finished"], response_id)
    tts_cancelled = _wire([event for event in events if event.get("ev") == "tts_cancelled"], response_id)
    played_values = [
        event["played"]
        for event in tts_played
        if isinstance(event.get("played"), int) and not isinstance(event.get("played"), bool)
    ]
    max_played = max(played_values, default=0)
    dry_run = any(event.get("dry_run") is True for event in tts_started)

    starts = [t for t in (_t_ms(event) for event in tts_started) if t is not None]
    ends = [t for t in (_t_ms(event) for event in tts_finished) if t is not None]
    window = (min(starts), max(ends)) if starts and ends else None

    level_total = {"aec_echo_probe": 0, "speech_state": 0}
    level_in_window: list[tuple[int, str]] = []
    level_missing_t_ms = 0
    for event in events:
        ev = event.get("ev")
        if ev not in LEVEL_EVENT_TYPES:
            continue
        level_total[ev] += 1
        when = _t_ms(event)
        if when is None:
            level_missing_t_ms += 1
            continue
        if window is not None and window[0] <= when <= window[1]:
            level_in_window.append((when, ev))

    window_ms = (window[1] - window[0]) if window is not None else 0
    level_span = 0
    if level_in_window:
        times = [when for when, _ in level_in_window]
        level_span = max(times) - min(times)

    b7_reasons: list[str] = []
    if window is None:
        b7_reasons.append("无法确定播报窗口（缺 tts_started 或 tts_finished 的 t_ms）")
    else:
        if len(level_in_window) < MIN_LEVEL_EVENTS:
            b7_reasons.append(
                f"播报窗口内采集电平/speech_state 只有 {len(level_in_window)} 次（需要 ≥ {MIN_LEVEL_EVENTS}）"
            )
        if window_ms > 0 and level_span < window_ms * MIN_LEVEL_COVERAGE:
            b7_reasons.append(
                f"电平更新只覆盖窗口 {level_span}/{window_ms}ms（需要 ≥ {int(MIN_LEVEL_COVERAGE * 100)}%）"
            )
    if level_missing_t_ms:
        b7_reasons.append(f"{level_missing_t_ms} 条电平事件缺 t_ms，无法证明发生在播报窗口内")

    finished = tts_finished[0] if tts_finished else None
    stop_reason = finished.get("stop_reason") if finished else None

    checks = [
        check_harness_or_production(bridge, require_harness),
        # 只断言调用方明确要求的东西：smoke_voice.sh 不传 expected_aec_mode，
        # 于是它的 B1–B7 输出与退出码语义一字不变。
        *([check_aec_mode(bridge, expected_aec_mode)] if expected_aec_mode is not None else []),
        Check(
            "B1",
            bool(bridge_events),
            f"bridge_ready 次数 = {len(bridge_events)}"
            + (f"，engine_started = {bridge.get('engine_started')}" if bridge else ""),
        ),
        Check(
            "B2",
            bool(tts_started),
            f"tts_started 次数 = {len(tts_started)}"
            + (f"，chunks = {tts_started[0].get('chunks')}" if tts_started else ""),
        ),
        Check("B3", bool(chunk_finished), f"tts_chunk_finished 次数 = {len(chunk_finished)}"),
        Check(
            "B4",
            bool(tts_played) and max_played > 0 and not dry_run,
            (
                f"tts_played 事件 = {len(tts_played)}，played 最大值 = {max_played}"
                if tts_played
                else "缺 tts_played：只合成、没有播出的证据"
            )
            + ("；tts_started 是 dry_run，不能证明出声" if dry_run else ""),
        ),
        Check(
            "B5",
            bool(tts_finished) and stop_reason == "done" and not tts_cancelled,
            (
                f"tts_finished 次数 = {len(tts_finished)}，stop_reason = {stop_reason}"
                if tts_finished
                else "缺 tts_finished：播报没有正常收尾"
            )
            + (f"；另有 tts_cancelled {len(tts_cancelled)} 条" if tts_cancelled else ""),
        ),
        Check(
            "B6",
            CRASH_MARKER not in stderr_text,
            (
                f"stderr 无 {CRASH_MARKER!r}"
                if CRASH_MARKER not in stderr_text
                else f"stderr 含 {CRASH_MARKER!r}：桥进程崩溃"
            ),
        ),
        Check("B7", not b7_reasons, "；".join(b7_reasons) if b7_reasons else "播报窗口内电平持续更新"),
    ]

    counts: dict[str, object] = {
        "bridge_ready": len(bridge_events),
        "tts_started": len(tts_started),
        "tts_chunk_finished": len(chunk_finished),
        "tts_played": len(tts_played),
        "played_values": played_values,
        "tts_finished": len(tts_finished),
        "stop_reason": stop_reason,
        "tts_cancelled": len(tts_cancelled),
        "aec_echo_probe": level_total["aec_echo_probe"],
        "speech_state": level_total["speech_state"],
        "level_in_window": len(level_in_window),
        "window_ms": window_ms,
        "level_span_ms": level_span,
        "window": window,
    }
    return Report(checks=checks, counts=counts)


def render(report: Report) -> str:
    counts = report.counts
    window = counts["window"]
    played = ",".join(str(value) for value in counts["played_values"]) or "-"
    lines = [
        "== smoke_voice 事件计数 ==",
        f"bridge_ready            {counts['bridge_ready']}",
        f"tts_started             {counts['tts_started']}",
        f"tts_chunk_finished      {counts['tts_chunk_finished']}",
        f"tts_played              {counts['tts_played']} (played: {played}；最大值 "
        f"{max(counts['played_values'], default=0)})",
        f"tts_finished            {counts['tts_finished']} (stop_reason: {counts['stop_reason']})",
        f"tts_cancelled           {counts['tts_cancelled']}",
        f"aec_echo_probe          总量 {counts['aec_echo_probe']}，播报窗口内 "
        f"{counts['level_in_window']}（speech_state 总量 {counts['speech_state']}）",
        (
            f"播报窗口                t_ms {window[0]}..{window[1]}（{counts['window_ms']}ms），"
            f"电平跨度 {counts['level_span_ms']}ms"
            if window is not None
            else "播报窗口                无法确定"
        ),
        "== B1–B7 断言 ==",
    ]
    for check in report.checks:
        lines.append(f"{'PASS' if check.ok else 'FAIL'} {check.key} {check.detail}")
    lines.append("PASS" if report.ok else "FAIL")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="smoke_voice.sh 的 B1–B7 断言（只读 fixture 或已采集的事件文件）"
    )
    parser.add_argument("--events", required=True, help="桥的 NDJSON 事件文件")
    parser.add_argument("--stderr", dest="stderr_path", required=True, help="桥的 stderr 文件")
    parser.add_argument("--response-id", default=None, help="只统计该 response_id 的 TTS 事件")
    args = parser.parse_args(argv)

    try:
        events = load_events(Path(args.events))
        stderr_text = Path(args.stderr_path).read_text(encoding="utf-8", errors="replace")
    except (InputError, OSError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2

    report = analyze(events, stderr_text, response_id=args.response_id)
    print(render(report))
    return 0 if report.ok else 1


if __name__ == "__main__":
    sys.exit(main())

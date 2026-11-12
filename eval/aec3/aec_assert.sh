#!/bin/sh
# GH-65：AEC 对照实验（ABAB / collect_pair）的**共用断言层**。
#
# 为什么要有这一层（而不是在 shell 里 grep）：真机事故是 Swift 桥输出紧凑 JSON
#   （`"test_harness":true`），旧脚本用 `grep -q '"test_harness": true'`（冒号后有
#   空格）去匹配，于是一个**已经跑成功**的 harness 实验被判成「未用测试构建」，
#   白跑一轮；同一处写法也出现在 `"aec_mode": "aec3"` 上。
#
#   字面量匹配对 JSON 只有一个结果：要么永远匹配不上（误判），要么哪天桥换了排版
#   就静默失配。所以判据改成**解析 JSON 后读字段**，与 `voice_smoke.py` 的 C0 用
#   同一套判据（那里已经用 `analyze()` 做过，这里直接复用，不再抄一遍）。
#
# 用法：
#   sh eval/aec3/aec_assert.sh bridge <ndjson> [--require-harness] [--expect-aec-mode <mode>]
#   sh eval/aec3/aec_assert.sh play   <ndjson>
#
# 退出码：0 = 断言通过；1 = 断言失败；2 = 输入/参数错误（不是判定结果）。
# 输出：每个判据一行 PASS/FAIL，最后一行是总结论（与 voice_smoke.py 同形）。
set -u

PYTHON=${PYTHON:-python3}
HERE=$(cd "$(dirname "$0")" && pwd)

usage() {
    sed -n '/^# 用法：/,/^# 输出/p' "$0" | sed 's/^# \{0,1\}//'
}

[ $# -ge 1 ] || { usage >&2; exit 2; }
case "$1" in
  -h|--help) usage; exit 0 ;;
esac
CMD=$1
shift
[ $# -ge 1 ] || { printf 'ERROR: 缺少事件文件\n' >&2; exit 2; }
FILE=$1
shift

case "$CMD" in
  bridge|play) ;;
  *) printf 'ERROR: 未知子命令 %s（只支持 bridge|play）\n' "$CMD" >&2; exit 2 ;;
esac

[ -f "$FILE" ] || { printf 'ERROR: 找不到事件文件 %s\n' "$FILE" >&2; exit 2; }

exec "$PYTHON" - "$HERE" "$CMD" "$FILE" "$@" <<'PY'
"""按子命令解析 NDJSON 并断言；桥的判据全部复用 voice_smoke.py。"""

import sys
from pathlib import Path

here = Path(sys.argv[1])
sys.path.insert(0, str(here))

from voice_smoke import (  # noqa: E402
    Check,
    InputError,
    bridge_ready,
    check_aec_mode,
    check_harness_or_production,
    load_events,
)

cmd = sys.argv[2]
path = Path(sys.argv[3])
rest = sys.argv[4:]

require_harness = False
expected = None
index = 0
while index < len(rest):
    arg = rest[index]
    if arg == "--require-harness":
        require_harness = True
        index += 1
    elif arg == "--expect-aec-mode":
        if index + 1 >= len(rest):
            print("ERROR: --expect-aec-mode 需要一个模式名", file=sys.stderr)
            raise SystemExit(2)
        expected = rest[index + 1]
        index += 2
    else:
        print(f"ERROR: 未知参数 {arg}", file=sys.stderr)
        raise SystemExit(2)

if cmd == "play" and (require_harness or expected is not None):
    print("ERROR: play 子命令不接受 bridge 的开关", file=sys.stderr)
    raise SystemExit(2)

try:
    events = load_events(path)
except InputError as exc:
    print(f"FAIL {exc}")
    raise SystemExit(1)

bridge = bridge_ready(events)
checks: list[Check]
if cmd == "bridge":
    checks = [check_harness_or_production(bridge, require_harness)]
    if expected is not None:
        checks.append(check_aec_mode(bridge, expected))
else:
    # play：只判「这一轮真的播完了」。构建身份由调用方在开播前单独证伪。
    finished = [event for event in events if event.get("ev") == "play_finished"]
    checks = [Check("P1", bool(finished), f"play_finished 次数 = {len(finished)}")]

for check in checks:
    print(f"{'PASS' if check.ok else 'FAIL'} {check.key} {check.detail}")
ok = all(check.ok for check in checks)
print("PASS" if ok else "FAIL")
raise SystemExit(0 if ok else 1)
PY

#!/bin/sh
# 正式播报链路冒烟（GH-58）：默认生产桥 + 正式 `speak` 命令，按 #41 的 B1–B7 判定。
#
# 用法（在仓库任意目录都能跑）：
#   sh eval/aec3/smoke_voice.sh                 # 正式跑法（需要 Mac 的麦克风 + 扬声器）
#   SMOKE_VOICE_TEXT="" sh eval/aec3/smoke_voice.sh   # 故意失败：空文本，B2/B3/B4/B5/B7 必须变红
#   sh eval/aec3/smoke_voice.sh --assert-only eval/aec3/fixtures/smoke_voice_pass.ndjson \
#       eval/aec3/fixtures/smoke_voice_pass.stderr    # 离线：只跑断言，不启动桥
#
# 前置：默认生产构建，**不要**加测试 harness 开关：
#   sh scripts/build_audio_bridge.sh
#
# 产出（可用 SMOKE_VOICE_OUT 改目录）：
#   work/verify/smoke_voice/events.ndjson   完整 NDJSON 事件
#   work/verify/smoke_voice/stderr.log      完整 stderr
#
# 退出码：0 = PASS；1 = FAIL；2 = 参数/前置错误；77 = SKIP（非 Darwin 或缺音频设备，
# **SKIP 不是 PASS**，真实设备缺失不会被写成绿）。
set -u

HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
cd "$ROOT" || exit 2

PYTHON=${PYTHON:-python3}
APP="$ROOT/work/bin/AudioBridge.app"
OUT=${SMOKE_VOICE_OUT:-$ROOT/work/verify/smoke_voice}
RESPONSE_ID=${SMOKE_VOICE_RESPONSE_ID:-smoke-voice}
TEXT=${SMOKE_VOICE_TEXT-你好，我是瓦力。这是一次 AEC 冒烟播报测试。}
SPEAK_TIMEOUT=${SMOKE_VOICE_TIMEOUT:-30}

usage() {
    sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'
}

skip() {
    printf 'SKIP: %s\n' "$1"
    printf 'SKIP 不是 PASS：没有拿到正式播报链路的证据。\n'
    exit 77
}

fail() {
    printf 'FAIL: %s\n' "$1" >&2
    exit "${2:-1}"
}

case "${1:-}" in
    -h|--help)
        usage
        exit 0
        ;;
    --assert-only)
        [ $# -eq 3 ] || {
            usage >&2
            fail "--assert-only 需要两个参数：<events.ndjson> <stderr.log>" 2
        }
        command -v "$PYTHON" >/dev/null 2>&1 || fail "找不到 $PYTHON（断言层只用标准库）" 2
        if [ -n "${SMOKE_VOICE_RESPONSE_ID:-}" ]; then
            exec "$PYTHON" "$HERE/voice_smoke.py" \
                --events "$2" --stderr "$3" --response-id "$SMOKE_VOICE_RESPONSE_ID"
        fi
        exec "$PYTHON" "$HERE/voice_smoke.py" --events "$2" --stderr "$3"
        ;;
    "") ;;
    *)
        usage >&2
        fail "未知参数：$1" 2
        ;;
esac

if [ "$(uname -s)" != "Darwin" ]; then
    skip "当前系统是 $(uname -s)，正式播报冒烟需要 macOS（站在 macOS 上用默认生产桥跑）"
fi
command -v "$PYTHON" >/dev/null 2>&1 || fail "找不到 $PYTHON（断言层只用标准库，需要 Python 3.9+）" 2

[ -x "$APP/Contents/MacOS/AudioBridge" ] || fail \
    "缺桥：先 sh scripts/build_audio_bridge.sh（默认生产构建，不要开测试 harness）" 2

mkdir -p "$OUT" || fail "建不了输出目录 $OUT" 2
EVENTS="$OUT/events.ndjson"
STDERR_LOG="$OUT/stderr.log"
IN="$OUT/.cmd.fifo"
rm -f "$EVENTS" "$STDERR_LOG" "$IN"
mkfifo "$IN" || fail "建不了 FIFO $IN" 2

INPUT_HOLDER=""
cleanup() {
    if [ -n "$INPUT_HOLDER" ]; then
        kill "$INPUT_HOLDER" 2>/dev/null || true
    fi
    # 没有匹配进程时 pkill 返回 1；这里不能让它影响退出码。
    pkill -f "AudioBridge serve" 2>/dev/null || true
}
on_signal() {
    cleanup
    exit 130
}
trap cleanup EXIT
trap on_signal INT TERM

printf '==> 启动默认生产桥：%s\n' "$APP"
printf '==> 事件：%s\n' "$EVENTS"
sleep 120 > "$IN" &
INPUT_HOLDER=$!
open -n -a "$APP" --stdin "$IN" --stdout "$EVENTS" --stderr "$STDERR_LOG" \
    --args serve --locale zh_CN ||
    fail "open 没能启动桥（见 $STDERR_LOG）" 1

wait_for() {
    pattern="$1"
    limit="$2"
    i=0
    while [ "$i" -lt "$limit" ]; do
        grep -Eq "$pattern" "$EVENTS" 2>/dev/null && return 0
        sleep 0.5
        i=$((i + 1))
    done
    return 1
}

# B1 的前置：桥必须真的起来。没有 bridge_ready 时先区分「缺设备/权限」与真失败。
if ! wait_for '"ev"[[:space:]]*:[[:space:]]*"bridge_ready"' 40; then
    if grep -Eq 'E_MIC_PERM' "$EVENTS" "$STDERR_LOG" 2>/dev/null; then
        skip "麦克风未授权（TCC）：先在系统设置 → 隐私与安全性 → 麦克风里允许 AudioBridge"
    fi
    fail "20s 内没有 bridge_ready（见 $EVENTS / $STDERR_LOG；不把环境问题算 PASS）" 1
fi

if grep -Eq '"engine_started"[[:space:]]*:[[:space:]]*false' "$EVENTS" 2>/dev/null; then
    skip "引擎没有启动（engine_started=false）：没有可用的音频设备"
fi
if grep -Eq 'E_MIC_OPEN' "$EVENTS" "$STDERR_LOG" 2>/dev/null; then
    skip "打不开麦克风（E_MIC_OPEN）：没有音频输入设备或被其他进程占用"
fi

printf '==> 等 VAD 校准（最多 20s）\n'
if ! wait_for '"ev"[[:space:]]*:[[:space:]]*"vad_calibrated"' 40; then
    if grep -Eq 'E_MIC_OPEN' "$EVENTS" "$STDERR_LOG" 2>/dev/null; then
        skip "打不开麦克风（E_MIC_OPEN）：没有音频输入设备或被其他进程占用"
    fi
    fail "20s 内没有 vad_calibrated（见 $EVENTS / $STDERR_LOG）" 1
fi

printf '==> 发送正式 speak 命令（response_id=%s，文本 %s 字）\n' "$RESPONSE_ID" "${#TEXT}"
printf '%s' "$TEXT" | "$PYTHON" -c \
    'import json, sys; print(json.dumps({"cmd": "speak", "response_id": sys.argv[1], "text": sys.stdin.read()}, ensure_ascii=False))' \
    "$RESPONSE_ID" > "$IN" || fail "写不了 speak 命令（FIFO 已关闭？）" 2

printf '==> 等播报结束（最多 %ss）\n' "$SPEAK_TIMEOUT"
# 出错（如空文本的 E_TTS_EMPTY）也立即进入断言，不必干等满超时。
wait_for '"ev"[[:space:]]*:[[:space:]]*"(tts_finished|tts_cancelled)"|"code"[[:space:]]*:[[:space:]]*"E_TTS_' \
    $((SPEAK_TIMEOUT * 2)) ||
    printf 'WARN: %ss 内没等到 tts_finished/tts_cancelled，仍按已采集事件判定\n' "$SPEAK_TIMEOUT"

printf '%s\n' '{"cmd":"quit"}' > "$IN" 2>/dev/null || true
sleep 1
kill "$INPUT_HOLDER" 2>/dev/null || true
INPUT_HOLDER=""
pkill -f "AudioBridge serve" 2>/dev/null || true
sleep 1

printf '\n'
"$PYTHON" "$HERE/voice_smoke.py" --events "$EVENTS" --stderr "$STDERR_LOG" \
    --response-id "$RESPONSE_ID"
status=$?

printf '\n证据文件：\n  %s\n  %s\n' "$EVENTS" "$STDERR_LOG"
if [ "$status" -eq 0 ]; then
    printf 'PASS（正式播报链路；真机验收证据请贴回 #41）\n'
else
    printf 'FAIL（判据见上面的 B1–B7）\n'
fi
exit "$status"

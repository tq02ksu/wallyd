#!/bin/sh
# AEC 严格对照实验（ABAB 交替 + 每轮实时本底 + 固定测试音 + 100ms 采样）
#
# 为什么这样设计（对比旧版 work/verify/aec_ab.sh 的缺陷）：
#   1. 旧版 AA BB 顺序：环境漂移会单向污染两组。改成 ABAB，漂移被平分。
#   2. 旧版本底一次静态校准：环境变了就失真。改每轮播报前后各测一次。
#   3. 旧版用 TTS：合成结果不一定逐字节相同，且走系统另一套音频图。
#      改用固定 WAV（work/verify/aec_probe.wav），经同一 playerNode 播放。
#   4. 旧版 500ms 采样：一轮只有 17 点。改 100ms，约 50 点/轮。
#
# 用法：sh eval/aec3/aec_ab2.sh [轮数，默认 3] [vpio|aec3]
#
# 前置（GH-55）：桥必须用测试专用 harness 构建，play/record 已从正式命令面删除：
#   WALLY_AUDIO_TEST_HARNESS=1 sh scripts/build_audio_bridge.sh
# 脚本先证伪 `test_harness=true`；默认构建不认识 harness_play_wav，实验作废。
#
#   vpio（默认）：--aec（VPIO）对 --no-aec
#   aec3：--aec3（软件分叉参考）对 --no-aec；桥必须在 bridge_ready 里确认
#         报告了 aec_mode=aec3，否则实验作废（忽略未知 flag 会把 VPIO 数据伪装成 AEC3）
#
# 桥的构建身份与 AEC 模式由 `aec_assert.sh` 判（解析 JSON 读字段，不 grep 字面量，
# 见 GH-65）。**退出码汇总**：任一组失败 → 非零退出；六组全过才打印 OK。
#
# 环境变量（一般不用改；测试与换路径时用）：AEC_AB2_APP / AEC_AB2_WAV / AEC_AB2_OUT
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE/../.." || exit 1
APP=${AEC_AB2_APP:-"$(pwd)/work/bin/AudioBridge.app"}
WAV=${AEC_AB2_WAV:-"$(pwd)/work/verify/aec_probe.wav"}
ROUNDS="${1:-3}"
MODE="${2:-vpio}"
OUT=${AEC_AB2_OUT:-work/verify/ab2}
ASSERT="$HERE/aec_assert.sh"

# 输出目录统一成绝对路径：下面 --stdout/--stderr 直接透传给桥，相对路径会
# 让桥把事件写到 `open` 的工作目录而不是仓库根。
case "$OUT" in
  /*) ;;
  *) OUT="$(pwd)/$OUT" ;;
esac

case "$ROUNDS" in
  ''|*[!0-9]*) echo "轮数必须是正整数：$ROUNDS" >&2; exit 2 ;;
esac
[ "$ROUNDS" -ge 1 ] || { echo "轮数必须 ≥ 1：$ROUNDS" >&2; exit 2; }

case "$MODE" in
  vpio) AEC_TAG=aec;  AEC_FLAGS="--aec" ;;
  aec3) AEC_TAG=aec3; AEC_FLAGS="--aec3" ;;
  *)
    echo "未知模式 '$MODE'（只支持 vpio|aec3）" >&2
    exit 2
    ;;
esac

[ -d "$APP" ] || { echo "缺桥：先 WALLY_AUDIO_TEST_HARNESS=1 sh scripts/build_audio_bridge.sh"; exit 1; }
[ -f "$WAV" ] || { echo "缺测试音：先跑 python3 work/verify/make_probe.py"; exit 1; }
mkdir -p "$OUT"

stop_bridge() {
  kill "$1" 2>/dev/null || true
  pkill -f "AudioBridge serve" 2>/dev/null || true
}

run_one() {
  tag="$1"
  round="$2"
  shift 2            # 剩下的是给桥的参数（--aec / --no-aec）
  base="$OUT/$round-$tag"
  rm -f "$base.in" "$base.out" "$base.err"
  mkfifo "$base.in"
  sleep 90 > "$base.in" &
  holder=$!

  open -n -a "$APP" --stdin "$base.in" --stdout "$base.out" \
      --stderr "$base.err" --args serve --locale zh_CN "$@"

  i=0
  while [ $i -lt 80 ]; do grep -q vad_calibrated "$base.out" 2>/dev/null && break; sleep 0.5; i=$((i+1)); done
  grep -q vad_calibrated "$base.out" || { echo "[$round-$tag] 校准超时"; stop_bridge "$holder"; return 1; }

  # 证伪：桥必须真的进入请求的 AEC 模式，而不是静默忽略未知 flag。
  if [ "$tag" = "aec3" ]; then
    if ! report=$("$ASSERT" bridge "$base.out" --require-harness --expect-aec-mode aec3 2>&1); then
      echo "[$round-$tag] FAIL 桥未确认 aec_mode=aec3（--aec3 未实现或被忽略）"
      printf '%s\n' "$report" | sed 's/^/    /'
      stop_bridge "$holder"
      return 1
    fi
  fi

  # 证伪（GH-55）：harness 命令只存在于测试专用构建；bridge_ready 没回报就作废。
  # 默认构建会回 E_CMD_UNKNOWN，这时绝不能把「没有播完」当成环境问题继续跑。
  if ! report=$("$ASSERT" bridge "$base.out" --require-harness 2>&1); then
    echo "[$round-$tag] FAIL 桥未回报 test_harness=true（AudioBridge 未用 WALLY_AUDIO_TEST_HARNESS=1 构建）"
    printf '%s\n' "$report" | sed 's/^/    /'
    stop_bridge "$holder"
    return 1
  fi

  sleep 1
  # --- 播报前本底：3 秒静默采样 ---
  sleep 3
  echo "{\"cmd\":\"harness_play_wav\",\"path\":\"$WAV\"}" > "$base.in"
  # 测试音 5.0s，多等 3s 让残余回声也采到
  sleep 8
  # --- 播报后本底：再 2 秒 ---
  sleep 2
  echo '{"cmd":"quit"}' > "$base.in"
  sleep 2
  kill $holder 2>/dev/null || true
  pkill -f "AudioBridge serve" 2>/dev/null || true
  sleep 1
  # **断言**：静默崩溃是这套实验最大的坑（六组全部崩了却"看起来跑完"）。
  if grep -q "Terminating app" "$base.err" 2>/dev/null; then
    echo "[$round-$tag] FAIL 进程崩溃：$(head -1 "$base.err")"
    return 1
  fi
  if ! report=$("$ASSERT" play "$base.out" 2>&1); then
    echo "[$round-$tag] FAIL 没有播完（缺 play_finished）"
    printf '%s\n' "$report" | sed 's/^/    /'
    return 1
  fi
}

FAILED=0
TOTAL=0
r=1
while [ "$r" -le "$ROUNDS" ]; do
  echo "=== 第 $r 轮 ==="
  if run_one "$AEC_TAG" "$r" $AEC_FLAGS; then :; else FAILED=$((FAILED + 1)); fi
  TOTAL=$((TOTAL + 1))
  if run_one noaec "$r" --no-aec; then :; else FAILED=$((FAILED + 1)); fi
  TOTAL=$((TOTAL + 1))
  r=$((r + 1))
done

# GH-65：以前这里是无条件 `echo OK`，所以六组全崩也打印 OK。现在成败由退出码说话。
if [ "$FAILED" -ne 0 ]; then
  echo "FAIL：$FAILED/$TOTAL 组未通过，实验作废（这些数据不能当 AEC 证据）" >&2
  exit 1
fi
echo "OK $TOTAL 组全部通过"

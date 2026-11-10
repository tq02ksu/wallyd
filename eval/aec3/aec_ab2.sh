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
# 脚本先证伪 `"test_harness": true`；默认构建不认识 harness_play_wav，实验作废。
#
#   vpio（默认）：--aec（VPIO）对 --no-aec
#   aec3：--aec3（软件分叉参考）对 --no-aec；桥必须在 bridge_ready 里确认
#         `"aec_mode": "aec3"`，否则实验作废（忽略未知 flag 会把 VPIO 数据伪装成 AEC3）
cd "$(dirname "$0")/../.." || exit 1
APP="$(pwd)/work/bin/AudioBridge.app"
WAV="$(pwd)/work/verify/aec_probe.wav"
ROUNDS="${1:-3}"
MODE="${2:-vpio}"
OUT="work/verify/ab2"

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

run_one() {
  tag="$1"
  round="$2"
  shift 2            # 剩下的是给桥的参数（--aec / --no-aec）
  base="$OUT/$round-$tag"
  rm -f "$base.in" "$base.out" "$base.err"
  mkfifo "$base.in"
  sleep 90 > "$base.in" &
  holder=$!

  open -n -a "$APP" --stdin "$base.in" --stdout "$(pwd)/$base.out" \
      --stderr "$(pwd)/$base.err" --args serve --locale zh_CN "$@"

  i=0
  while [ $i -lt 80 ]; do grep -q vad_calibrated "$base.out" 2>/dev/null && break; sleep 0.5; i=$((i+1)); done
  grep -q vad_calibrated "$base.out" || { echo "[$round-$tag] 校准超时"; kill $holder 2>/dev/null; pkill -f "AudioBridge serve"; return 1; }

  # 证伪：桥必须真的进入请求的 AEC 模式，而不是静默忽略未知 flag。
  if [ "$tag" = "aec3" ] && ! grep -q '"aec_mode": "aec3"' "$base.out" 2>/dev/null; then
    echo "[$round-$tag] FAIL 桥未确认 aec_mode=aec3（--aec3 未实现或被忽略）"
    kill $holder 2>/dev/null || true
    pkill -f "AudioBridge serve" 2>/dev/null || true
    return 1
  fi

  # 证伪（GH-55）：harness 命令只存在于测试专用构建；bridge_ready 没回报就作废。
  # 默认构建会回 E_CMD_UNKNOWN，这时绝不能把「没有播完」当成环境问题继续跑。
  if ! grep -q '"test_harness": true' "$base.out" 2>/dev/null; then
    echo "[$round-$tag] FAIL 桥未回报 test_harness=true（AudioBridge 未用 WALLY_AUDIO_TEST_HARNESS=1 构建）"
    kill $holder 2>/dev/null || true
    pkill -f "AudioBridge serve" 2>/dev/null || true
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
  if ! grep -q play_finished "$base.out" 2>/dev/null; then
    echo "[$round-$tag] FAIL 没有播完（缺 play_finished）"
    return 1
  fi
}

for r in 1 2 3; do
  [ "$r" -gt "$ROUNDS" ] && break
  echo "=== 第 $r 轮 ==="
  run_one "$AEC_TAG" "$r" $AEC_FLAGS
  run_one noaec "$r" --no-aec
done
echo "OK"

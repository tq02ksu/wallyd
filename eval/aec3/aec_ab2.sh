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
# 用法：sh work/verify/aec_ab2.sh [轮数，默认 3]
cd "$(dirname "$0")/../.." || exit 1
APP="$(pwd)/work/bin/AudioBridge.app"
WAV="$(pwd)/work/verify/aec_probe.wav"
ROUNDS="${1:-3}"
OUT="work/verify/ab2"

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

  sleep 1
  # --- 播报前本底：3 秒静默采样 ---
  sleep 3
  echo "{\"cmd\":\"play\",\"path\":\"$WAV\"}" > "$base.in"
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
  run_one aec "$r" --aec
  run_one noaec "$r" --no-aec
done
echo "OK"

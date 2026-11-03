#!/bin/sh
# 采集 AEC3 对照实验用的真实录音：对着同一个测试音，录一对「参考信号 + 麦克风信号」。
#
# 为什么必须用真实录音：AEC 的效果取决于真实房间声学（混响、传播延迟、扬声器与麦克风的
# 非线性）。合成一个线性回声去测 AEC，只会得到一个漂亮但无法迁移的结论。
#
# 用法：sh work/verify/collect_pair.sh [输出目录，默认 work/verify/pairs/r1]
#       可选环境变量 AEC=1 让桥开 VPIO（此时 mic.wav 已是 VPIO 处理后的信号）
set -eu
cd "$(dirname "$0")/../.." || exit 1
APP="$(pwd)/work/bin/AudioBridge.app"
WAV="$(pwd)/work/verify/aec_probe.wav"
DIR=$(cd "$(dirname "$0")/../.." && pwd)/${1:-work/verify/pairs/r1}
mkdir -p "$DIR"
rm -f "$DIR/ref.wav" "$DIR/mic.wav"

[ -f "$WAV" ] || { echo "缺测试音：先跑 python3 work/verify/make_probe.py"; exit 1; }

IN="$DIR/.in"
rm -f "$IN"
mkfifo "$IN"
sleep 60 > "$IN" &
holder=$!
MODE="${AEC:-0}"
if [ "$MODE" = "1" ]; then ARG=--aec; else ARG=--no-aec; fi

open -n -a "$APP" --stdin "$IN" --stdout "$DIR/bridge.out" --stderr "$DIR/bridge.err" \
    --args serve --locale zh_CN "$ARG"

i=0
while [ $i -lt 60 ]; do grep -q vad_calibrated "$DIR/bridge.out" 2>/dev/null && break; sleep 0.5; i=$((i+1)); done
grep -q vad_calibrated "$DIR/bridge.out" || { echo "FAIL 校准超时"; kill $holder 2>/dev/null; pkill -f "AudioBridge serve"; exit 1; }

sleep 2
echo "{\"cmd\":\"record\",\"dir\":\"$DIR\",\"path\":\"$WAV\"}" > "$IN"
# 测试音 5s + 收尾 1.5s
sleep 12
echo '{"cmd":"quit"}' > "$IN" 2>/dev/null || true
sleep 2
kill $holder 2>/dev/null || true
# `pkill` 在「没有匹配进程」时返回 1，配合 `set -e` 会让脚本静默退出，
# 把已经成功的采集伪装成失败（实测踩过）。所以一律 `|| true`。
pkill -f "AudioBridge serve" 2>/dev/null || true
sleep 1

if grep -q "Terminating app" "$DIR/bridge.err" 2>/dev/null; then
    echo "FAIL 桥崩溃：$(head -1 "$DIR/bridge.err")"; exit 1
fi
for f in ref.wav mic.wav; do
    [ -f "$DIR/$f" ] || { echo "FAIL 没有产出 $f"; exit 1; }
done
echo "OK 已采集：$DIR/{ref,mic}.wav"
ls -lh "$DIR/ref.wav" "$DIR/mic.wav" | awk '{print "  ", $9, $5}'

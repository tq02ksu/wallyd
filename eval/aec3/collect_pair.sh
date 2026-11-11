#!/bin/sh
# 采集 AEC3 对照实验用的真实录音：对着同一个测试音，录一对「参考信号 + 麦克风信号」。
#
# 为什么必须用真实录音：AEC 的效果取决于真实房间声学（混响、传播延迟、扬声器与麦克风的
# 非线性）。合成一个线性回声去测 AEC，只会得到一个漂亮但无法迁移的结论。
#
# 用法：sh eval/aec3/collect_pair.sh [输出目录，默认 work/verify/pairs/r1]
#       可选环境变量 AEC=1 让桥开 VPIO（此时 mic.wav 已是 VPIO 处理后的信号）
#
# 前置（GH-55）：`WALLY_AUDIO_TEST_HARNESS=1 sh scripts/build_audio_bridge.sh`。
# `record` 已从正式命令面删除，这里走测试专用 `harness_record_pair`；桥没在
# bridge_ready 回报 `"test_harness": true` 时实验作废（不作「有文件就算成功」）。
set -eu
cd "$(dirname "$0")/../.." || exit 1
APP="$(pwd)/work/bin/AudioBridge.app"
WAV="$(pwd)/work/verify/aec_probe.wav"
DIR=$(cd "$(dirname "$0")/../.." && pwd)/${1:-work/verify/pairs/r1}
mkdir -p "$DIR"
rm -f "$DIR/ref.wav" "$DIR/mic.wav"

[ -d "$APP" ] || { echo "缺桥：先 WALLY_AUDIO_TEST_HARNESS=1 sh scripts/build_audio_bridge.sh"; exit 1; }
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

# 证伪（GH-55）：只有测试专用构建才认识 harness_record_pair。
if ! grep -q '"test_harness": true' "$DIR/bridge.out" 2>/dev/null; then
    echo "FAIL 桥未回报 test_harness=true（AudioBridge 未用 WALLY_AUDIO_TEST_HARNESS=1 构建）"
    kill $holder 2>/dev/null || true
    pkill -f "AudioBridge serve" 2>/dev/null || true
    exit 1
fi

sleep 2
echo "{\"cmd\":\"harness_record_pair\",\"dir\":\"$DIR\",\"path\":\"$WAV\"}" > "$IN"
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
    # 非空文件才算产出：空 WAV（只有表头/0 字节）是假实验。
    [ -s "$DIR/$f" ] || { echo "FAIL 没有产出非空 $f"; exit 1; }
done
echo "OK 已采集：$DIR/{ref,mic}.wav"
ls -lh "$DIR/ref.wav" "$DIR/mic.wav" | awk '{print "  ", $9, $5}'

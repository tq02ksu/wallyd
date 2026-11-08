#!/bin/sh
# WALLY 语音回归基线（GH-14）——一条命令量 6 项 §11 指标。
#
# 用法：
#   sh eval/voice/run_baseline.sh                    # 需要夹具就自动合成，连跑两次看波动
#   sh eval/voice/run_baseline.sh --repeat 1         # 只跑一次
#   sh eval/voice/run_baseline.sh --seed-baseline    # 首次播种 eval/voice/baseline.json
#   sh eval/voice/run_baseline.sh --no-playback      # 不出声（TTS 首包标 SKIP）
#   sh eval/voice/run_baseline.sh --with-long-run    # 额外跑 30 分钟麦克风采集
#
# 无麦克风权限 / 无喇叭 / 非 macOS 的机器上不会 PASS：缺的那几项会明确标
# `SKIP: <原因>`，退出码 3（不完整），其余能测的项照常测。
#
# 全部逻辑在 voice_baseline.py（标准库，无第三方依赖）；这里只做一层薄壳，
# 保证 `sh eval/voice/run_baseline.sh` 在任意工作目录下都能跑。
set -u

HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)

PYTHON=${PYTHON:-python3}
if ! command -v "$PYTHON" >/dev/null 2>&1; then
    echo "ERROR: 找不到 $PYTHON（基线脚本只用标准库，需要 Python 3.9+）" >&2
    exit 2
fi

cd "$ROOT" || exit 2
exec "$PYTHON" "$HERE/voice_baseline.py" "$@"

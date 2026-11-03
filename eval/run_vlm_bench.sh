#!/bin/sh
# 起一个本地 MiniCPM-V（MLX）服务，对给定图片跑单帧延迟，跑完关掉自己起的那个服务。
#
# 用法：
#   sh eval/run_vlm_bench.sh [图片...]                    # 不给图片则用本项目 work/eval/*.jpg
# 环境变量：
#   MINICPM_MODEL（默认 $BOT/models/MiniCPM-V-4.6-4bit）、MINICPM_HOST / MINICPM_PORT、
#   BENCH_REPS（默认 2）、BENCH_MAX_TOKENS（默认 32）、BENCH_PROMPT
#
# 两个实测踩过的坑（详见同目录 vision-latency.md §5）：
#   1) MLX 需要 Metal —— **必须在沙箱外跑**，受限沙箱会报 No Metal device available；
#   2) 系统 HTTP 代理会劫持 127.0.0.1 的请求（curl 正常、python urllib 会拿到 502），
#      vlm_bench.py 里已显式 ProxyHandler({}) 绕过。
set -u

HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/.." && pwd)                       # 项目根：<wallyd-root>/
BOT=${BOT:-/Users/tq02ksu/workspace/bot}           # MLX 环境与权重（见 model-selection）
MODEL=${MINICPM_MODEL:-$BOT/models/MiniCPM-V-4.6-4bit}
HOST=${MINICPM_HOST:-127.0.0.1}
PORT=${MINICPM_PORT:-8080}
BASE="http://$HOST:$PORT"
STARTED=no

health() { curl -s -m 3 -o /dev/null -w '%{http_code}' "$BASE/health" 2>/dev/null || true; }

echo "health_before=$(health)"
if [ "$(health)" != "200" ]; then
  export HF_ENDPOINT=${HF_ENDPOINT:-https://hf-mirror.com}
  export HF_HOME=${HF_HOME:-$BOT/.cache/huggingface}
  T0=$(date +%s.%N)
  nohup "$BOT/.venv/bin/mlx_vlm.server" --model "$MODEL" --host "$HOST" --port "$PORT" \
    > /tmp/vlm-server.log 2>&1 &
  SRV=$!
  STARTED=yes
  i=0
  while [ $i -lt 180 ]; do
    [ "$(health)" = "200" ] && break
    i=$((i + 1))
    sleep 1
  done
  echo "server_load_seconds=$(echo "$(date +%s.%N) - $T0" | bc) health=$(health) pid=$SRV"
else
  echo "server: 复用已有服务（$BASE）"
fi

if [ $# -gt 0 ]; then IMGS="$*"; else IMGS="$ROOT"/work/eval/*.jpg; fi

MINICPM_MODEL="$MODEL" MINICPM_BASE_URL="$BASE/v1" \
  BENCH_REPS="${BENCH_REPS:-2}" BENCH_MAX_TOKENS="${BENCH_MAX_TOKENS:-32}" \
  /usr/bin/python3 "$HERE/vlm_bench.py" $IMGS

if [ "$STARTED" = "yes" ]; then
  kill "$SRV" 2>/dev/null
  sleep 1
  echo "server_stopped pid=$SRV"
fi

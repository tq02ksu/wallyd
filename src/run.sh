#!/bin/sh
# 一键起服务：模型服务（可选）+ robotd（身体，Python）。
#
# 用法：sh src/run.sh [串口设备] [robotd http 端口]
#   例：sh src/run.sh                          # 默认串口，robotd :8787
#       sh src/run.sh /dev/cu.usbserial-XXX 8787
#
# 说明：
# - **robotd 是 Python 进程**（robotd/src/robotd），不是旧的 TS POC。
# - agentd（大脑，:8791）不在本脚本范围内，单独起：npm run agentd
# - 环境变量：
#     POC_MODEL=stub   用 modeld.py 的 stub 后端（:8790，只验链路）
#     POC_MODEL=none    不起任何模型服务
#     BOT=<MLX 环境根>（默认 /Users/tq02ksu/workspace/bot）
#     MINICPM_MODEL=<权重目录>
#     POC_MODEL_PORT=<模型端口，默认 8080>
#     ROBOTD_SIM=1      仿真模式（无硬件）
PORT=${1:-/dev/cu.usbserial-A5069RR4}
HTTP=${2:-8787}
BOT=${BOT:-/Users/tq02ksu/workspace/bot}
MODEL=${MINICPM_MODEL:-$BOT/models/MiniCPM-V-4.6-4bit}
MODEL_PORT=${POC_MODEL_PORT:-8080}
cd "$(dirname "$0")/.." || exit 1          # 项目根：<wallyd-root>/

ROBOTD_PY=robotd/.venv/bin/python
[ -x "$ROBOTD_PY" ] || { echo "找不到 $ROBOTD_PY；先在 robotd/ 建 venv" >&2; exit 1; }

pkill -f mlx_vlm.server 2>/dev/null
pkill -f modeld.py 2>/dev/null
sleep 1

MODELD_URL=""
MODEL_ID=""

if [ "${POC_MODEL:-minicpm}" = "none" ]; then
  echo "模型 → 不起（POC_MODEL=none）"
elif [ "${POC_MODEL:-minicpm}" = "stub" ]; then
  /usr/bin/python3 src/modeld.py --port 8790 > /tmp/modeld.log 2>&1 &
  MODELD_URL=http://127.0.0.1:8790
  MODEL_ID=poc
  echo "模型 → stub（modeld.py :8790，日志 /tmp/modeld.log）"
else
  # MLX 要 Metal：必须在非沙箱进程里跑（受限沙箱报 No Metal device available）
  HF_HOME=${HF_HOME:-$BOT/.cache/huggingface}
  HF_HUB_OFFLINE=1
  export HF_HOME HF_HUB_OFFLINE
  # 模型名：mlx_vlm.server 把 /v1/models 的 id 直接取成 `--model` 的原字符串，且请求侧按
  # **字符串精确匹配**——所以想让它报一个干净名字，就得「以权重目录为 cwd + 只传目录名」。
  MODELS_DIR=$(dirname "$MODEL")
  MODEL_ID=${POC_MODEL_NAME:-$(basename "$MODEL")}
  if [ "$MODEL_ID" != "$(basename "$MODEL")" ]; then
    [ -e "$MODELS_DIR/$MODEL_ID" ] || ln -s "$MODEL" "$MODELS_DIR/$MODEL_ID" 2>/dev/null
    [ -e "$MODELS_DIR/$MODEL_ID" ] || { echo "建不了模型名软链：$MODELS_DIR/$MODEL_ID" >&2; exit 1; }
  fi
  ( cd "$MODELS_DIR" && exec "$BOT/.venv/bin/mlx_vlm.server" \
      --model "$MODEL_ID" --host 127.0.0.1 --port "$MODEL_PORT" ) \
    > /tmp/vlm-server.log 2>&1 &
  MODELD_URL=http://127.0.0.1:$MODEL_PORT
  echo "模型 → $MODEL_ID（MLX :$MODEL_PORT，日志 /tmp/vlm-server.log）"
  i=0
  while [ $i -lt 60 ]; do
    # --noproxy：系统 HTTP 代理会劫持 127.0.0.1，健康检查必须绕开
    [ "$(curl -s -m 2 --noproxy '*' -o /dev/null -w '%{http_code}' "$MODELD_URL/health" 2>/dev/null)" = "200" ] && break
    i=$((i + 1))
    sleep 1
  done
  echo "模型就绪耗时约 ${i}s（$MODELD_URL/health）"
fi

# robotd 在前台：串口/板侧日志直接可见（Ctrl-C 停）
SET_ARGS=""
[ "${ROBOTD_SIM:-0}" = "1" ] && SET_ARGS="--sim"
[ -n "$MODELD_URL" ] && SET_ARGS="$SET_ARGS --modeld $MODELD_URL --model $MODEL_ID"

echo "robotd → http://127.0.0.1:$HTTP/  （UI 由 agentd 托管：npm run agentd → http://127.0.0.1:8791/）"
# shellcheck disable=SC2086
exec env PYTHONPATH=robotd/src "$ROBOTD_PY" -m robotd \
  --port "$PORT" --http "$HTTP" $SET_ARGS serve

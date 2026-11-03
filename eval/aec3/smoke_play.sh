#!/bin/sh
# 单次播放验证：确认桥真的把 WAV 播出来、tap 真的在采集、进程不崩。
#
# 为什么需要这个脚本：ab2 实验里六组全部在 play_started 之后崩溃
# （'required condition is false: _outputFormat.channelCount == buffer.format.channelCount'），
# 但脚本只看「有没有产出文件」，于是把崩溃误判成「实验完成」。
# 所以这里**显式断言**：必须看到 play_finished、必须有 >=10 个 aec_echo_probe、进程必须正常退出。
#
# 用法：sh work/verify/smoke_play.sh [--aec|--no-aec]
cd "$(dirname "$0")/../.." || exit 1
APP="$(pwd)/work/bin/AudioBridge.app"
WAV="$(pwd)/work/verify/aec_probe.wav"
MODE="${1:---aec}"
BASE="work/verify/smoke-$(echo "$MODE" | tr -d '-')"
rm -f "$BASE.in" "$BASE.out" "$BASE.err"
mkfifo "$BASE.in"
sleep 60 > "$BASE.in" &
holder=$!

open -n -a "$APP" --stdin "$BASE.in" --stdout "$(pwd)/$BASE.out" \
    --stderr "$(pwd)/$BASE.err" --args serve --locale zh_CN "$MODE"

i=0
while [ $i -lt 60 ]; do grep -q vad_calibrated "$BASE.out" 2>/dev/null && break; sleep 0.5; i=$((i+1)); done
grep -q vad_calibrated "$BASE.out" || { echo "FAIL 校准超时"; kill $holder 2>/dev/null; pkill -f "AudioBridge serve"; exit 1; }

sleep 2
echo "{\"cmd\":\"play\",\"path\":\"$WAV\"}" > "$BASE.in"
sleep 8
echo '{"cmd":"quit"}' > "$BASE.in"
sleep 2
kill $holder 2>/dev/null || true
pkill -f "AudioBridge serve" 2>/dev/null || true
sleep 1

python3 - "$BASE.out" "$BASE.err" <<'PY'
import json, sys
out, err = sys.argv[1], sys.argv[2]
evs, probes = {}, []
for ln in open(out):
    try: e = json.loads(ln)
    except: continue
    evs[e.get("ev")] = evs.get(e.get("ev"), 0) + 1
    if e.get("ev") == "aec_echo_probe": probes.append(e)
errtext = open(err).read()
crash = "Terminating app" in errtext
print("事件统计:", evs)
print(f"探针数量: {len(probes)}")
ok = True
if not evs.get("play_started"):
    print("FAIL 没有 play_started"); ok = False
if not evs.get("play_finished"):
    print("FAIL 没有 play_finished（播放没走完）"); ok = False
if len(probes) < 10:
    print(f"FAIL 探针只有 {len(probes)} 个（应 >=10，播放 5s @100ms 约 50 个）"); ok = False
if crash:
    print("FAIL 进程崩溃:", errtext.splitlines()[0][:160]); ok = False
if probes:
    db = [p["db"] for p in probes]
    print(f"播放期间电平: min={min(db):.1f} max={max(db):.1f}")
print("PASS" if ok else "FAIL")
sys.exit(0 if ok else 1)
PY

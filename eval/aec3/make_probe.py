#!/usr/bin/env python3
"""生成 AEC 对照用的固定测试音（纯标准库，无第三方依赖）。

为什么不用 TTS：
  1. AVSpeechSynthesizer 每次合成可能有细微差异，无法逐字节对照。
  2. 它走系统另一套音频图，输出电平无法精确控制。
  用固定 WAV 才能做 ABAB 交替、两次实验输入完全相同。

信号设计（模仿语音，而不是纯正弦）：
  - 用带通噪声（300–3400 Hz，语音主频段）。AEC 的自适应滤波器对平稳单频信号
    行为与真实语音差别很大，单频会给出过于乐观的结果。
  - 叠加 ~4 Hz 幅度包络（音节节奏），让滤波器要持续跟踪。
  - 前后各留 0.5s 静音，便于识别回声起止。

输出：work/verify/aec_probe.wav（16-bit PCM, 48kHz, 单声道）
"""
import math
import random
import struct
import wave

SR = 48000
DUR = 4.0
LEAD, TAIL = 0.5, 0.5
random.seed(20261025)          # 固定种子 → 每次生成完全相同的信号

n = int(SR * DUR)

# --- 4 阶切比雪夫式级联带通（两个二阶节），中心 ~1200Hz，带宽 300–3400Hz ---
# 手算双线性变换系数：低通 3400Hz 与高通 300Hz 级联，简化为一对一阶+一对二阶。
# 这里用更稳妥的做法：两级一阶滤波串联，Q 低但足够塑形，关键是**可复现**。
def biquad_bandpass(f0, q, sr):
    """RBJ cookbook bandpass（constant skirt gain）。"""
    w0 = 2 * math.pi * f0 / sr
    alpha = math.sin(w0) / (2 * q)
    b0 = alpha
    b1 = 0.0
    b2 = -alpha
    a0 = 1 + alpha
    a1 = -2 * math.cos(w0)
    a2 = 1 - alpha
    return (b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0)

# 两级带通串起来：宽一点（Q 低）覆盖整个语音段
f1 = biquad_bandpass(800.0, 0.7, SR)
f2 = biquad_bandpass(2000.0, 0.9, SR)

def apply_biquad(x, c):
    b0, b1, b2, a1, a2 = c
    y = [0.0] * len(x)
    x1 = x2 = y1 = y2 = 0.0
    for i, v in enumerate(x):
        o = b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
        x2, x1 = x1, v
        y2, y1 = y1, o
        y[i] = o
    return y

white = [random.uniform(-1, 1) for _ in range(n)]
band = apply_biquad(apply_biquad(white, f2), f1)

# --- 音节包络：4Hz 起伏 + 慢抖动 ---
for i in range(n):
    t = i / SR
    band[i] *= (0.55 + 0.45 * math.sin(2 * math.pi * 4.0 * t + 0.7)) \
               * (1.0 + 0.15 * math.sin(2 * math.pi * 0.7 * t))

peak = max(abs(v) for v in band) or 1.0
band = [v / peak * 0.85 for v in band]

full = [0.0] * int(SR * LEAD) + band + [0.0] * int(SR * TAIL)
pcm = b"".join(struct.pack("<h", int(v * 32767)) for v in full)

out = "work/verify/aec_probe.wav"
with wave.open(out, "wb") as w:
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes(pcm)

rms = math.sqrt(sum(v * v for v in full) / len(full))
print(f"wrote {out}: {len(full)/SR:.2f}s peak={max(abs(v) for v in full):.3f} rms={rms:.4f}")

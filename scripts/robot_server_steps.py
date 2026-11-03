"""
ESP32-S3 MicroPython 指令服务器 —— TB6600 步进电机版 (M1)
通过 USB 串口接收高层指令，用 bitstream 在 STEP 引脚输出脉冲驱动 TB6600 → 42BYGH47。
保留 led 指令用于指示/测试，move/rotate 改为真实驱动。

接线（共阳接法，见 stepper-wiring.md）：
  TB6600 PUL+/DIR+/ENA+  -> +5V（共阳）
  TB6600 PUL-  -> 左电机 STEP GPIO (下左)
  TB6600 DIR-  -> 左电机 DIR  GPIO
  TB6600 VCC/GND -> 12V 电机动力电源
  两台 TB6600 各独立一组 STEP/DIR，电机线 A+/A-/B+/B- 接 42BYGH47 两组线圈

引脚（可按实际改）：
  左电机: STEP=4, DIR=5
  右电机: STEP=6, DIR=7
"""
from machine import Pin, bitstream
import neopixel
import time
import sys

# ---- 引脚配置（可按实际接线修改）----
STEP_L = 4
DIR_L = 5
STEP_R = 6
DIR_R = 7
pin_step_l = Pin(STEP_L, Pin.OUT)
pin_dir_l = Pin(DIR_L, Pin.OUT)
pin_step_r = Pin(STEP_R, Pin.OUT)
pin_dir_r = Pin(DIR_R, Pin.OUT)

# ---- 步进参数 ----
MICROSTEPS = 8          # TB6600 细分 (1/8)
STEPS_PER_REV = 200 * MICROSTEPS   # 42BYGH47 200 整步/圈 → 1600 步/圈
PULSE_NS = 5000         # 脉冲半周期 5us -> 占空比 50%, 频率 100kHz. 实际按带宽限 * 建议 >1.2us

# ---- 轮子几何（装车后按实际填；空转测试用默认 0 跳过换算）----
WHEEL_DIAM_MM = 0.0     # 轮子直径 mm, 0 = 不换算, move 直接用步数
WHEEL_BASE_MM = 0.0     # 两轮中心距 mm, 0 = 不换算, rotate 用估算

# ---- 板载 RGB 灯(WS2812, GPIO48) ----
np = neopixel.NeoPixel(Pin(48), 1)
def set_color(r, g, b):
    np[0] = (r, g, b)
    np.write()

def set_dir(pin, direction):
    """direction: 1 正, 0 反"""
    pin.value(1 if direction else 0)
    time.sleep_us(10)   # 方向信号先于脉冲 >5us (TB6600 手册)

def step_pulses(pin, count, period_us=1000):
    """用 bitstream 在 STEP 引脚发 count 个脉冲。
    每个脉冲 = 一个 high-low 周期。period_us 为周期(us), 半周期=period_us/2。
    返回实际发出的脉冲数。
    """
    if count <= 0:
        return 0
    high_ns = int(period_us * 1000 / 2)
    low_ns = int(period_us * 1000 / 2)
    # 每个 bit 一个脉冲, data 用 0xAA (10101010)交替
    nbytes = (count + 7) // 8
    data = bytes([0b10101010]) * nbytes
    bitstream(pin, 0, (high_ns, low_ns, high_ns, low_ns), data)
    return count

def drive_steps(left_dir, right_dir, left_steps, right_steps, speed_pps=500):
    """同时驱动左右电机发脉冲。speed_pps = 每秒脉冲数(步/秒)。"""
    set_dir(pin_dir_l, left_dir)
    set_dir(pin_dir_r, right_dir)
    period_us = int(1000000 / speed_pps)  # 每步周期 us
    # 各自发脉冲（简单起见顺序发；后续可优化为交替）
    step_pulses(pin_step_l, left_steps, period_us)
    step_pulses(pin_step_r, right_steps, period_us)
    return left_steps, right_steps

# ---- 指令处理 ----
def handle(cmd):
    parts = cmd.strip().split()
    if not parts:
        return "ERR: empty"
    op = parts[0].lower()

    if op == "hello":
        return "OK: hello from ESP32"

    elif op == "led":
        try:
            r, g, b = int(parts[1]), int(parts[2]), int(parts[3])
            set_color(r, g, b)
            return f"OK: led set ({r},{g},{b})"
        except Exception:
            return "ERR: usage 'led <r> <g> <b>'"

    elif op == "ledoff":
        set_color(0, 0, 0)
        return "OK: led off"

    elif op == "move":
        # move <steps>  双电机同向前进/后退指定步数
        try:
            steps = int(parts[1])
            direction = 1
            if len(parts) > 2 and parts[2].lower() in ('back', 'backward', 'rev'):
                direction = 0
            drive_steps(direction, direction, abs(steps), abs(steps))
            set_color(0, 255, 0)
            return f"OK: move {steps} steps (dir={direction})"
        except Exception as e:
            return f"ERR: move <steps> [back]: {e}"

    elif op == "rotate":
        # rotate <deg>  差速转向。正=顺时针(右转), 负/left=逆时针
        try:
            deg = int(parts[1])
            # 差速: 左转/右转 各走相反方向
            direction = 0 if deg >= 0 else 1
            # 角度->步数估算(需轴距); 未填轴距时用退化近似
            steps = 0
            if WHEEL_BASE_MM > 0 and WHEEL_DIAM_MM > 0:
                arc_mm = abs(deg) * 3.1416 * WHEEL_BASE_MM / 360
                steps = int(arc_mm / (3.1416 * WHEEL_DIAM_MM / STEPS_PER_REV))
            else:
                steps = abs(deg) * (STEPS_PER_REV // 360)  # 1度≈4.4步 近似
            drive_steps(direction, 1 - direction, steps, steps)
            set_color(255, 165, 0)
            return f"OK: rotate {deg} deg (dir={direction}, steps={steps})"
        except Exception as e:
            return f"ERR: rotate <deg>: {e}"

    elif op == "stop":
        set_color(255, 0, 0)
        return "OK: stop (LED red)"

    elif op == "status":
        return f"OK: status idle microsteps={MICROSTEPS}"

    else:
        return f"ERR: unknown command '{op}'"

# ---- 主循环 ----
print("Robot Server (TB6600) ready on ESP32. Waiting for commands...")
set_color(0, 0, 0)
while True:
    try:
        line = sys.stdin.readline()
        if line:
            res = handle(line)
            print(res)
    except KeyboardInterrupt:
        break
    except Exception as e:
        print(f"ERR: {e}")

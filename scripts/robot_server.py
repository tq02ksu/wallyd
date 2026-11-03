"""
ESP32-S3 MicroPython 指令服务器
通过 USB 串口接收高层指令并执行。
当前阶段：用板载 RGB 灯(WS2812, GPIO48)模拟动作，验证 USB 控制链路。
后续：把动作替换为 TB6600 步进电机脉冲输出。
"""
from machine import Pin
import neopixel
import time
import sys

# ---- 硬件配置 ----
LED_PIN = 48
np = neopixel.NeoPixel(Pin(LED_PIN), 1)

def set_color(r, g, b):
    np[0] = (r, g, b)
    np.write()

# ---- 指令处理 ----
def handle(cmd):
    parts = cmd.strip().split()
    if not parts:
        return "ERR: empty"
    op = parts[0].lower()

    if op == "hello":
        return "OK: hello from ESP32"

    elif op == "led":
        # led <r> <g> <b>  设置 RGB 颜色
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
        # move <steps>  模拟前进（步数换算成单车测试, 此处用灯闪烁表示）
        try:
            steps = int(parts[1])
            set_color(0, 255, 0)  # 绿=前进
            return f"OK: move {steps} steps (LED green)"
        except Exception:
            return "ERR: usage 'move <steps>'"

    elif op == "rotate":
        # rotate <deg>  模拟转向
        try:
            deg = int(parts[1])
            set_color(255, 165, 0)  # 橙=转向
            return f"OK: rotate {deg} deg (LED orange)"
        except Exception:
            return "ERR: usage 'rotate <deg>'"

    elif op == "stop":
        set_color(255, 0, 0)  # 红=停止
        return "OK: stop (LED red)"

    elif op == "status":
        return "OK: status idle"

    else:
        return f"ERR: unknown command '{op}'"

# ---- 主循环 ----
print("Robot Server ready on ESP32. Waiting for commands...")
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

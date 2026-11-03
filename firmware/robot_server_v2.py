"""ESP32-S3 机器人指令服务器 v2（POC）

相对 v1（板上原 main.py）的三处关键改动 —— 正是 POC 要验证的点：
  1. **非阻塞运动**：v1 的 move/rotate 用 bitstream 一次发完所有脉冲，期间读不到串口，
     因此既无法中途 stop、也无法实现心跳看门狗。v2 把运动拆成主循环里每 20ms 推进一小片。
  2. **协议 v2**：换行分隔 JSON，命令带 id、应答回填 id、事件无 id；错误带错误码。
  3. **心跳看门狗**：运动中 300ms 收不到 velocity/keepalive 就自主停机（安全兜底）。

脱机 ENA（2026-10-05 起：**ENA 必接**）：
  每台驱动器 3 脚，固件按状态机管 ENA —— 使能 → 等 `ENA_SETTLE_MS` → 发脉冲 →
  发完留 `ENA_HOLD_MS` → 脱机；心跳看门狗急停后按 `RELEASE_ON_WATCHDOG` 决定是否脱机。
  静置省电的账：四台 TB6600 静止保持电流合计约 16–38W，脱机后降到近零。
  极性与电平：`ENA_ENGAGED_LEVEL` / `ENA_RELEASED_LEVEL`（本批共阳「悬空 = 常使能」，
  故拉低预期 = 脱机；**实测反了就把两个常量对调**）。

安全默认：DRIVE_MOTORS = False —— 只点灯 + 走状态机，不动电机。
确认电机悬空/安全后再改 True，恢复 bitstream 真实脉冲（逻辑沿用 v1）。

接线（2026-10-05 定案，见 docs/electrical-architecture.md §5.2）：
  底盘左驱 PUL/DIR/ENA = 9/10/11 ｜ 底盘右驱 = 12/13/14
  `DRIVERS_PRESENT = ("L", "R")`：2026-10-09 起左右两驱都在管（右驱接上前是 ("L",)）。
  ⚠ **不在这个元组里的驱动器，固件从不配置它的 ENA 引脚**——引脚留高阻=悬空=使能，
  于是它永久保持电流、不会自动脱机。加驱动器时这里忘了改，表现就是这个。
"""
import sys
import time
import json

try:
    import uselect as select
except ImportError:
    import select

from machine import Pin
import neopixel

PROTO = 2
FW = "poc-2.1"

DRIVE_MOTORS = True           # 2026-10-05：左驱已接、开始单电机台面测试（右驱未到货）
# ⚠️ 本批 TB6600 的输入光耦：**只有"高阻（悬空）"才是可靠的"关"**，拉到 3.3V 仍部分导通。
# 所以 PUL/DIR 只允许两态：拉低 = 有效，高阻 = 无效（永不打高）。
MICROSTEPS = 8
STEPS_PER_REV = 200 * MICROSTEPS
# ---- 标定值（归属见 ADR-0002：**权威在 robotd**，改参数不刷固件）----
# 这三个是**运行时可变的默认值**：板子以 `CALIB_*` 为出厂默认，host 通过 `calib` 命令覆盖。
# 覆盖只作用于本次通电（掉电回到默认）；要掉电保留，host 传 `persist: true`（写 /calib.json）。
# 路径以固件内已有约定为准：MicroPython 可直接 open('/calib.json','w')。
CALIB_DEFAULT_STEPS_PER_M = 8000.0   # 占位值：装车后按实际标定（轮径 × 细分）
CALIB_DEFAULT_WHEEL_BASE_MM = 120.0
STEPS_PER_M = CALIB_DEFAULT_STEPS_PER_M
WHEEL_BASE_MM = CALIB_DEFAULT_WHEEL_BASE_MM
CALIB_SOURCE = "default"             # default | board(掉电读回) | host(本次覆盖)
MAX_RATE = 1500.0             # 软件方波（sleep_us 循环）能稳的上限；再高要换 RMT/MCPWM
CHUNK_MS = 250                # 单次脉冲块的目标时长。要点：块要**够长**——每轮固定开销 ÷ 块长
                              # 就是掉速比例（实测 53ms 块掉 14%）。落速不受影响，因为串口检查
                              # 塞在脉冲循环里（见 POLL_EVERY_STEPS）。
POLL_EVERY_STEPS = 24         # 发脉冲时每 24 步查一次串口：USB-CDC 上每次 poll 约 1ms，
                              # 每 8 步查一次会吃掉一整轮 20% 的时间（实测 1.22× 偏慢）。
                              # 24 步 ≈ 20ms@1200pps → stop 最坏延迟 20ms，远好于 300ms 看门狗
DIR_INVERT = True             # 实测转向与"前进"约定相反 → 统一在此翻转（改一处，不散落取反）
DT_CAP_MS = 500               # 累加器计时的单次上限。**必须 ≥ 脉冲块时长**：早先写死 100ms，
                              # 而块长 CHUNK_MS=250ms → 每轮少算 150ms → 状态机路径掉速 21%（实测）

HEARTBEAT_TIMEOUT_MS = 300
TICK_MS = 20
PROGRESS_EVERY_MS = 200

# ---- 引脚（v1 原样）----
# 2026-10-05 新引脚定案（每台驱动器 3 脚，位置连＋序号连；见 docs/electrical-architecture.md §5.2）：
#   底盘左驱 PUL/DIR/ENA = 9/10/11 ｜ 底盘右驱 = 12/13/14 ｜ 步进3 = 4/5/6 ｜ 步进4 = 15/16/17
# 物理状态（2026-10-09）：左右两驱都已接上。
PIN_L = (9, 10, 11)      # PUL, DIR, ENA
PIN_R = (12, 13, 14)

# ---- 脱机 ENA（2026-10-05 起：ENA 必接）----
USE_ENA = True            # ENA 线接上就 True；不想脱机就设 False
# ⚠️ 2026-10-05 实测（三档都试过）：
#   ENA− 悬空        → **使能**（有保持电流、手拧有阻力）
#   ENA− 拉低到 GND  → **禁用**（光耦导通 = 关输出）
#   ENA− 拉到 3.3V   → **也禁用**（光耦两端仍有 ~1.7V，部分导通）
# ⇒ 这块板是「光耦导通 = 关输出」，只有真悬空才使能。所以：
#   使能 = 引脚**高阻输入**（不驱动）；脱机 = 输出低电平（光耦完全导通，最确定的关断）。
#   顺带：上电/reset 时引脚默认高阻 = 使能 = 保持力矩（失效安全方向正确）。
ENA_ENGAGED_IS_FLOAT = True   # 使能时把引脚置高阻（= 悬空）
ENA_ENGAGED_LEVEL = 0         # 仅当 ENA_ENGAGED_IS_FLOAT=False 时用
ENA_RELEASED_LEVEL = 0        # 脱机 = 输出低电平（拉低到 GND = 光耦导通 = 关输出）
ENA_SETTLE_MS = 20        # 使能后等多久再发第一个脉冲（光耦 + 驱动器建立）
ENA_HOLD_MS = 200         # 脉冲发完后再保持多久才脱机（立刻脱机会顿挫/丢步）
RELEASE_ON_WATCHDOG = True  # 看门狗急停后是否脱机：平地 True（省电不发热）；坡道保位改 False
DRIVERS_PRESENT = ("L", "R")  # 2026-10-09：右驱 TB6600 已接上，两驱都进 ENA 状态机
                              # ⚠ 这个元组是 ENA 的唯一开关：不在里面的驱动器，固件**从不碰**它的
                              # ENA 引脚 → 引脚停在上电默认的**高阻/悬空**，而本批板实测「悬空 = 使能」
                              # → 该驱动器**永久保持电流、等不到自动脱机**（右驱接上后正是这个症状）。
ENAGED_MAX_MS = 30000     # **使能上限**：idle 状态下，使能持续超过这么久就自动脱机（0 = 不自动）
                          # 判据是"使能已持续多久"，不是"多久没指令"——后者会被任何串口流量重置
                          # （心跳/状态查询都算），实测永远等不到。兜的场景：调试旁路钉住、复位后默认使能

if DRIVE_MOTORS:
    # 脉冲用软件方波：POC 台面速度（≤2kHz）足够，且语义透明、不依赖 bitstream 的 4 元组写法。
    # 量产/多轴同时动再换 RMT/MCPWM（见 docs/electrical-architecture.md §5.4）。
    pin_step_l = Pin(PIN_L[0], Pin.IN)      # 空闲 = 高阻（悬空）= 可靠的"关"
    pin_dir_l = Pin(PIN_L[1], Pin.IN)
    if "R" in DRIVERS_PRESENT:
        pin_step_r = Pin(PIN_R[0], Pin.IN)
        pin_dir_r = Pin(PIN_R[1], Pin.IN)
if USE_ENA:
    if "L" in DRIVERS_PRESENT:
        # 上电即"使能"：高阻 = 悬空（见 ENA_* 注释）；绝不能在启动时把它拉低/拉高
        pin_ena_l = Pin(PIN_L[2], Pin.IN) if ENA_ENGAGED_IS_FLOAT else Pin(PIN_L[2], Pin.OUT, value=ENA_ENGAGED_LEVEL)
    if "R" in DRIVERS_PRESENT:
        pin_ena_r = Pin(PIN_R[2], Pin.IN) if ENA_ENGAGED_IS_FLOAT else Pin(PIN_R[2], Pin.OUT, value=ENA_ENGAGED_LEVEL)

# 上电即处于「使能/保持」——与「ENA 悬空 = 常使能」一致，且复位/挂死时车不会自由滑行
_ena_state = "engaged"
_release_at = None
_ena_since = time.ticks_ms()
_last_activity = time.ticks_ms()

np = neopixel.NeoPixel(Pin(48), 1)
_led_color = None

def led(r, g, b):
    """写 WS2812（去重：颜色没变就不写，避免无谓的时序占用）。"""
    global _led_color
    if _led_color == (r, g, b):
        return
    _led_color = (r, g, b)
    np[0] = (r, g, b)
    np.write()

# ---- 状态灯：收到指令闪一下；运动中绿/橙；空闲且使能暗蓝；脱机灭；错误红闪 ----
LED_BOOT = (0, 0, 80)
LED_IDLE_ENGAGED = (0, 0, 25)
LED_IDLE_RELEASED = (0, 0, 0)
LED_MOVE = (0, 90, 0)
LED_TURN = (90, 60, 0)
LED_ERR = (90, 0, 0)
LED_CMD = (35, 35, 35)
_flash_until = 0

def led_flash(color=LED_CMD, ms=60):
    global _flash_until
    led(*color)
    _flash_until = time.ticks_add(time.ticks_ms(), ms)

def led_tick():
    """由主循环每 20ms 调一次：闪灯优先，过后回到「按状态」的底色。"""
    global _flash_until
    if _flash_until and time.ticks_diff(time.ticks_ms(), _flash_until) >= 0:
        _flash_until = 0
    if _flash_until:
        return
    if motion.mode == "moving":
        led(*(LED_MOVE if motion.dir_l == motion.dir_r else LED_TURN))
    elif _ena_state == "engaged":
        led(*LED_IDLE_ENGAGED)
    else:
        led(*LED_IDLE_RELEASED)

def send(obj):
    print(json.dumps(obj))

def ok(mid, data=None):
    if mid is not None:
        send({"id": mid, "ok": True, "data": data or {}})

def err(mid, code, msg):
    if mid is not None:
        send({"id": mid, "ok": False, "err": {"code": code, "msg": msg}})

def event(ev, **kw):
    d = {"ev": ev}
    d.update(kw)
    send(d)

def ena_set(engage, why=""):
    """使能（保持力矩）或脱机（省电）。见文件头 ENA_* 常量。"""
    global _ena_state, _release_at, _ena_since
    if not USE_ENA:
        return
    for name in DRIVERS_PRESENT:
        pin = pin_ena_l if name == "L" else pin_ena_r
        if engage and ENA_ENGAGED_IS_FLOAT:
            pin.init(Pin.IN)                     # 高阻 = 悬空 = 使能
        else:
            pin.init(Pin.OUT, value=ENA_ENGAGED_LEVEL if engage else ENA_RELEASED_LEVEL)
    _ena_state = "engaged" if engage else "released"
    if engage:
        _ena_since = time.ticks_ms()
    _release_at = None
    event("ena.changed", state=_ena_state, why=why)

def step_pulses(pin, count, period_us, off_mode="float", check=None):
    """在 STEP 引脚发 count 个脉冲。**两态制（2026-10-05 实测）**：
      有效（脉冲）= 输出拉低（光耦完全导通）
      无效（间隔）= 高阻/悬空（光耦完全关闭）
    ⚠️ 不能用"拉高到 3.3V"当无效：本批 TB6600 的输入光耦在 3.3V 时仍有 ~1.7V，
       会**部分导通**→ 输入一直停在"有效"态 → 看不到边沿 → 电机完全不走（实测踩到）。
    check：每 POLL_EVERY_STEPS 步调用一次（在发脉冲间隙读串口）。"""
    if count <= 0:
        return 0
    half = max(3, int(period_us // 2))
    for i in range(count):
        pin.init(Pin.OUT, value=0)          # 有效：拉低
        time.sleep_us(half)
        if off_mode == "float":
            pin.init(Pin.IN)                # 无效：高阻 = 悬空（唯一可靠的"关"）
        else:
            pin.init(Pin.OUT, value=1)      # 拉到 3.3V（实测不可靠，保留用于对照）
        time.sleep_us(half)
        if check is not None and (i % POLL_EVERY_STEPS) == 0:
            check()
    return count

def set_dir(pin, direction, off_mode="float"):
    """方向：0 = 拉低（光耦导通）；1 = 高阻（悬空）。同样是"高电平不可用"的两态制。"""
    if DIR_INVERT:                     # 实测（2026-10-05）：按上面的约定，车"前进"是反的 → 这里统一翻转
        direction = 0 if direction else 1
    if direction:
        pin.init(Pin.IN) if off_mode == "float" else pin.init(Pin.OUT, value=1)
    else:
        pin.init(Pin.OUT, value=0)

def ena_release_after(ms, why=""):
    """延迟脱机：让电机停稳再断保持电流（立刻脱机会顿挫）。"""
    global _release_at
    if not USE_ENA:
        return
    _release_at = time.ticks_add(time.ticks_ms(), ms)
    if why:
        event("ena.release_scheduled", in_ms=ms, why=why)

def ena_tick():
    global _release_at
    if _release_at is not None and time.ticks_diff(time.ticks_ms(), _release_at) >= 0:
        ena_set(False, why="hold elapsed")
    # 使能上限兜底：idle 下使能持续超时 → 自动脱机（防止"钉住使能忘了放"一直耗电）
    if (ENAGED_MAX_MS and _ena_state == "engaged" and motion.mode != "moving"
            and ena_engaged_ms() > ENAGED_MAX_MS):
        ena_set(False, why="engaged timeout")

def ena_engaged_ms():
    return time.ticks_diff(time.ticks_ms(), _ena_since) if _ena_state == "engaged" else 0

# ---- 运动状态机 ----
class Motion:
    def __init__(self):
        self.mode = "idle"
        self.dir_l = self.dir_r = 1
        self.left_remaining = 0
        self.right_remaining = 0
        self.total = 0
        self.rate = 3000.0        # steps/s
        self.owed = 0.0           # 相位累加器：按时间攒"欠下的步数"，每 tick 最多补 MAX_CHUNK_STEPS 步
        self.chunk = 64           # 每次最多发几步（按 rate 换算成 CHUNK_MS）
        self.last_tick = time.ticks_ms()
        self.last_hb = time.ticks_ms()
        self.last_progress = time.ticks_ms()

    def start(self, left, right, rate):
        ena_set(True, "motion start")
        time.sleep_ms(ENA_SETTLE_MS)      # 使能 → 等建立 → 再发第一个脉冲
        self.mode = "moving"
        self.dir_l = 1 if left >= 0 else 0
        self.dir_r = 1 if right >= 0 else 0
        self.left_remaining = abs(left)
        self.right_remaining = abs(right)
        self.total = max(abs(left), abs(right)) or 1
        self.rate = max(50.0, min(rate, MAX_RATE))
        self.chunk = max(32, int(self.rate * CHUNK_MS / 1000.0))
        self.owed = 0.0
        now = time.ticks_ms()
        self.last_tick = now
        self.last_hb = now
        self.last_progress = now

    def stop(self):
        self.mode = "idle"
        self.left_remaining = 0
        self.right_remaining = 0
        ena_release_after(ENA_HOLD_MS, "motion stop")   # 停稳后再断保持电流
        led(0, 0, 0)

    def hb_age(self):
        return time.ticks_diff(time.ticks_ms(), self.last_hb)

    def tick(self):
        ena_tick()
        now = time.ticks_ms()
        dt = time.ticks_diff(now, self.last_tick)
        if dt < 5:
            return
        self.last_tick = now
        if self.mode != "moving":
            return

        if self.hb_age() > HEARTBEAT_TIMEOUT_MS:
            self.stop()
            event("motion.aborted", reason="watchdog", hb_age_ms=HEARTBEAT_TIMEOUT_MS)
            if RELEASE_ON_WATCHDOG:
                ena_set(False, "watchdog")          # 平地：失联即脱机，省电不发热
            return

        # 相位累加 + 限幅：按真实时间攒步数（平均速率准），每次只补一小片（不阻塞串口）。
        # 早先两版（实测 dt 预算 / 固定预算）都会因"poll 与发脉冲串行"而掉速（实测 1.76× 偏慢）。
        self.owed += self.rate * min(dt, DT_CAP_MS) / 1000.0
        n = int(self.owed)
        if n > self.chunk:
            n = self.chunk
        self.owed -= n
        n_l = min(self.left_remaining, n)
        n_r = min(self.right_remaining, n)

        if DRIVE_MOTORS and (n_l or n_r):
            period_us = int(1000000 / self.rate)
            if n_l and "L" in DRIVERS_PRESENT:
                set_dir(pin_dir_l, self.dir_l)     # DIR 先于脉冲，同样用「拉低/高阻」两态
                time.sleep_us(20)
                step_pulses(pin_step_l, n_l, period_us, check=poll_input_if_any)
            if n_r and "R" in DRIVERS_PRESENT:
                set_dir(pin_dir_r, self.dir_r)
                time.sleep_us(20)
                step_pulses(pin_step_r, n_r, period_us, check=poll_input_if_any)
        # LED 由 led_tick() 按运动/使能状态统一驱动（见上）

        self.left_remaining -= n_l
        self.right_remaining -= n_r

        if self.left_remaining <= 0 and self.right_remaining <= 0:
            done = self.total
            self.stop()
            event("motion.done", steps=done)
            return

        if time.ticks_diff(now, self.last_progress) >= PROGRESS_EVERY_MS:
            self.last_progress = now
            progressed = 1.0 - (max(self.left_remaining, self.right_remaining) / self.total)
            event("motion.progress", p=round(progressed, 3))

motion = Motion()
pump_state = "off"

# ---- 指令处理 ----
def handle_json(msg):
    # global 声明必须在函数内任何使用之前，否则 MicroPython 直接语法错误（POC 已两次踩到）
    global pump_state, _ena_state, STEPS_PER_M, WHEEL_BASE_MM, CALIB_SOURCE
    mid = msg.get("id")
    op = msg.get("op")
    args = msg.get("args") or {}

    if op == "hello":
        if args.get("proto") != PROTO:
            return err(mid, "E_FW", "proto mismatch: board=%d host=%s" % (PROTO, args.get("proto")))
        return ok(mid, {"fw": FW, "proto": PROTO, "microsteps": MICROSTEPS,
                        "steps_per_m": STEPS_PER_M, "wheelbase_mm": WHEEL_BASE_MM,
                        "calib_source": CALIB_SOURCE,
                        "drive_motors": DRIVE_MOTORS,
                        "drivers": list(DRIVERS_PRESENT), "ena": _ena_state,
                        "caps": ["move", "rotate", "velocity", "stop", "status", "ena",
                                 "pump", "calib"]})

    if op == "calib":                        # 标定下发（归属见 ADR-0002：权威在 robotd）
        # 只改运行时变量 → 不刷固件。persist=true 才写盘（掉电保留）。
        changed = {}
        if "steps_per_m" in args:
            v = float(args["steps_per_m"])
            if v <= 0:
                return err(mid, "E_RANGE", "steps_per_m must be > 0")
            STEPS_PER_M = v
            changed["steps_per_m"] = v
        if "wheelbase_mm" in args:
            v = float(args["wheelbase_mm"])
            if v <= 0:
                return err(mid, "E_RANGE", "wheelbase_mm must be > 0")
            WHEEL_BASE_MM = v
            changed["wheelbase_mm"] = v
        if not changed:
            return err(mid, "E_ARGS", "calib: no recognized field")
        CALIB_SOURCE = "host"
        persisted = False
        if args.get("persist"):
            try:
                with open("/calib.json", "w") as f:
                    json.dump({"steps_per_m": STEPS_PER_M,
                               "wheelbase_mm": WHEEL_BASE_MM}, f)
                persisted = True
            except OSError:
                # 写盘失败不改运行时结果，如实回报（host 自行决定是否重试）
                persisted = False
        return ok(mid, {"steps_per_m": STEPS_PER_M, "wheelbase_mm": WHEEL_BASE_MM,
                        "calib_source": CALIB_SOURCE, "persisted": persisted})

    if op in ("move", "rotate"):
        if motion.mode == "moving":
            return err(mid, "E_BUSY", "motion in progress")
        if op == "move":
            left = int(args.get("left", 0))
            right = int(args.get("right", 0))
            speed = float(args.get("speed", 0.15))
        else:
            steps = int(args.get("steps", 0))
            sign = 1 if steps >= 0 else -1
            left, right = sign * abs(steps), -sign * abs(steps)
            speed = 0.15
        if max(abs(left), abs(right)) > 200000:
            return err(mid, "E_RANGE", "steps out of range")
        rate = max(200.0, abs(speed) * STEPS_PER_M)
        motion.start(left, right, rate)
        return ok(mid, {"steps": max(abs(left), abs(right)),
                        "eta_ms": int(max(abs(left), abs(right)) / motion.rate * 1000)})

    if op == "velocity":                     # 心跳兼连续控制
        motion.last_hb = time.ticks_ms()
        return ok(mid, {"hb_age_ms": motion.hb_age()})

    if op == "stop":                         # 幂等、可抢占、无 id 也执行
        motion.stop()
        event("motion.aborted", reason="stop")
        return ok(mid, {"stopped": True})

    if op == "status":
        return ok(mid, {"mode": motion.mode, "pump": pump_state,
                        "microsteps": MICROSTEPS, "drive_motors": DRIVE_MOTORS,
                        "drivers": list(DRIVERS_PRESENT), "ena": _ena_state,
                        "ena_ms": ena_engaged_ms(),
                        "remaining": max(motion.left_remaining, motion.right_remaining),
                        "hb_age_ms": motion.hb_age()})

    if op == "ena":                      # 手动使能/脱机：接线后用它核对极性、量静置电流差
        ena_set(bool(args.get("on", True)), "host command")
        return ok(mid, {"ena": _ena_state})

    if op == "pulse":                    # 调试旁路：直接发一串脉冲，用于台面判定接线/极性
        if "L" not in DRIVERS_PRESENT:
            return err(mid, "E_NO_DRIVER", "left driver not present")
        count = int(args.get("count", 200))
        period_us = int(args.get("period_us", 800))
        off_mode = args.get("off", "float")          # float=高阻作"关"（默认，实测唯一可靠）；high=拉高对照
        direction = int(args.get("dir", 1))
        set_dir(pin_dir_l, direction, off_mode)
        time.sleep_us(20)
        t0 = time.ticks_us()
        step_pulses(pin_step_l, count, period_us, off_mode)
        elapsed_us = time.ticks_diff(time.ticks_us(), t0)
        return ok(mid, {"count": count, "period_us": period_us, "off": off_mode, "dir": direction,
                        "elapsed_us": elapsed_us,
                        "actual_period_us": (elapsed_us // count) if count else 0,
                        "actual_steps_per_s": int(count * 1000000 / elapsed_us) if elapsed_us else 0})

    if op == "pins":                     # 调试旁路：把左驱三根线钉在指定电平，供万用表静态测量
        if "L" not in DRIVERS_PRESENT:
            return err(mid, "E_NO_DRIVER", "left driver not present")
        if "step" in args:
            # step=1 → 高阻（悬空）；step=0 → 拉低
            pin_step_l.init(Pin.IN) if int(args["step"]) else pin_step_l.init(Pin.OUT, value=0)
        if "dir" in args:
            int(args["dir"]) and pin_dir_l.init(Pin.IN) or pin_dir_l.init(Pin.OUT, value=0)
        if "ena" in args:
            ena_set(bool(int(args["ena"])), "pins op")     # 1 = 使能（高阻/悬空），0 = 脱机（拉低到 GND）
        return ok(mid, {"step": pin_step_l.value(), "dir": pin_dir_l.value(),
                        "ena": _ena_state, "pins": {"step": PIN_L[0], "dir": PIN_L[1], "ena": PIN_L[2]}})

    if op == "pump":
        # 这里必须能写全局量（见函数开头的 global）；否则赋值会让它变局部变量，
        # 上面 status 分支读同名全局量就 UnboundLocalError（POC 实测踩到）。
        pump_state = "on" if args.get("state") == "on" else "off"
        return ok(mid, {"pump": pump_state})

    if op == "led":                      # 调试旁路：直接点灯，用来验证 WS2812 与"收到指令"
        r = int(args.get("r", 0)); g = int(args.get("g", 0)); b = int(args.get("b", 0))
        led(r, g, b)
        return ok(mid, {"led": [r, g, b]})

    return err(mid, "E_CMD", "unknown op %s" % op)

def handle_text(line):
    """保留 v1 文本指令做救急通道（串口终端敲 status 仍然有用）。"""
    parts = line.split()
    op = parts[0].lower()
    if op == "hello":
        return "OK: hello from ESP32 (v2, text-mode)"
    if op == "status":
        return "OK: status %s microsteps=%d drive_motors=%s" % (motion.mode, MICROSTEPS, DRIVE_MOTORS)
    if op == "stop":
        motion.stop()
        return "OK: stop (LED off)"
    if op == "led" and len(parts) == 4:
        led(int(parts[1]), int(parts[2]), int(parts[3]))
        return "OK: led set"
    return "ERR: use JSON {\"op\":...} or text: hello/status/stop/led r g b"

def handle_line(line):
    global _last_activity
    _last_activity = time.ticks_ms()      # 任何指令都算"人还在"，空闲脱机计时据此重置
    line = line.strip()
    if not line:
        return
    led_flash()                       # 任何指令都闪一下 = "ESP32 收到了"（肉眼可见）
    if line.startswith("{"):
        try:
            handle_json(json.loads(line))
        except Exception as e:
            led_flash(LED_ERR, 250)
            send({"ok": False, "err": {"code": "E_PARSE", "msg": str(e)}})
    else:
        print(handle_text(line))

# ---- 主循环 ----
poller = select.poll()
poller.register(sys.stdin, select.POLLIN)

def poll_input_if_any():
    """非阻塞读一条指令（发脉冲的间隙里调，保证 stop/心跳 不被脉冲阻塞）。"""
    if poller.poll(0):
        line = sys.stdin.readline()
        if line:
            handle_line(line)

def load_calib_from_flash():
    """开机读回 host 持久化的标定（ADR-0002：host 权威、板侧只做持久化便利）。
    没有文件/坏文件就保持出厂默认，不报错（首次上电本就没有）。"""
    global STEPS_PER_M, WHEEL_BASE_MM, CALIB_SOURCE
    try:
        with open("/calib.json") as f:
            d = json.load(f)
        spm = float(d.get("steps_per_m", STEPS_PER_M))
        wb = float(d.get("wheelbase_mm", WHEEL_BASE_MM))
        if spm > 0 and wb > 0:
            STEPS_PER_M, WHEEL_BASE_MM = spm, wb
            CALIB_SOURCE = "board"
    except (OSError, ValueError):
        pass

load_calib_from_flash()

print("Robot Server v2 (POC) ready. drive_motors=%s proto=%d" % (DRIVE_MOTORS, PROTO))
led(*LED_BOOT)
event("boot", fw=FW, drive_motors=DRIVE_MOTORS,
      steps_per_m=STEPS_PER_M, wheelbase_mm=WHEEL_BASE_MM, calib_source=CALIB_SOURCE)

while True:
    try:
        # 空闲时阻塞 20ms 省电；运动时由 step_pulses 内部每 8 步查一次串口（见上），
        # 这样"轮询"不再和"发脉冲"串行（早先串行导致任务耗时 1.2–1.8×，ETA 失真）。
        if motion.mode != "moving" and poller.poll(TICK_MS):
            line = sys.stdin.readline()
            if line:
                handle_line(line)
        motion.tick()
        led_tick()
    except KeyboardInterrupt:
        motion.stop()
        break
    except Exception as e:
        led_flash(LED_ERR, 300)
        send({"ok": False, "err": {"code": "E_INTERNAL", "msg": str(e)}})

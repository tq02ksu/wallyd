"""
ESP32 机器人控制脚本（电脑端）
通过 USB 串口连上板子的 MicroPython 指令服务器，发送高层指令、接收响应。
用法:
  python robot_cli.py                    # 交互模式, 输入指令
  python robot_cli.py "led 255 0 0"      # 执行单条指令
  python robot_cli.py "move 1000"
"""
import serial, time, sys

PORT = '/dev/cu.usbserial-A5069RR4'
BAUD = 115200

def connect():
    ser = serial.Serial(PORT, BAUD, timeout=0.5)
    time.sleep(0.3)
    return ser

def send_cmd(ser, cmd, wait=0.8):
    ser.reset_input_buffer()
    ser.write((cmd + '\n').encode())
    time.sleep(wait)
    out = ser.read(4000)
    return out.decode(errors='replace').strip()

def main():
    try:
        ser = connect()
    except Exception as e:
        print(f"无法连接 {PORT}: {e}")
        sys.exit(1)
    print(f"已连接 {PORT}")

    # 如果给了一条指令, 直接执行
    if len(sys.argv) > 1:
        cmd = ' '.join(sys.argv[1:])
        resp = send_cmd(ser, cmd)
        print(f"> {cmd}")
        print(f"< {resp}")
        ser.close()
        return

    # 否则进入交互模式
    print("交互模式: 输入指令, 如 led 255 0 0 / move 1000 / rotate 90 / stop / status / hello / ledoff")
    print("输入 quit 退出")
    while True:
        try:
            cmd = input("> ").strip()
        except (EOFError, KeyboardInterrupt):
            break
        if not cmd:
            continue
        if cmd.lower() in ('quit', 'exit', 'q'):
            break
        resp = send_cmd(ser, cmd)
        print(f"< {resp}")
    ser.close()

if __name__ == '__main__':
    main()

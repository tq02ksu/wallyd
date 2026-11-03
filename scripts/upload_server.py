import serial, time, sys

port = '/dev/cu.usbserial-A5069RR4'
ser = serial.Serial(port, 115200, timeout=2)
time.sleep(0.8)
ser.reset_input_buffer()

def paste_exec(code, wait=1.5):
    ser.write(b'\x01')
    time.sleep(0.15)
    ser.write(code.encode())
    ser.write(b'\x04')
    time.sleep(wait)
    out = ser.read(8000)
    return out.decode(errors='replace')

# Ctrl+B 确保在 REPL, Ctrl+C 中断可能循环
ser.write(b'\x02'); time.sleep(0.2)
ser.write(b'\x03'); time.sleep(0.3)
ser.write(b'\r\n'); time.sleep(0.3); ser.read(3000)

# 读取 robot_server.py 内容并逐行写入板子 main.py
with open('robot_server.py', 'r') as f:
    content = f.read()

# 构造 MicroPython 写入命令：把内容拆成一行行 write
# 用 repr 逐行写，避免缩进/引号问题
lines = content.split('\n')
code = "f=open('main.py','w')\n"
for ln in lines:
    esc = ln.replace('\\', '\\\\').replace("'", "\\'")
    code += f"f.write('{esc}\\n')\n"
code += "f.close()\nprint('main.py uploaded')\n"

r = paste_exec(code, wait=2.5)
print("UPLOAD:", r[-300:])

# 验证
r2 = paste_exec("f=open('main.py')\nprint('LEN', len(f.read()))\nf.close()\n")
print("CHECK:", r2[-200:])
ser.close()

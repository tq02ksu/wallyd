import serial, time, sys
port = '/dev/cu.usbserial-A5069RR4'
ser = serial.Serial(port, 115200, timeout=2)
time.sleep(0.8)
ser.reset_input_buffer()
def paste_exec(code, wait=2.5):
    ser.write(b'\x01'); time.sleep(0.15)
    ser.write(code.encode()); ser.write(b'\x04')
    time.sleep(wait)
    return ser.read(8000).decode(errors='replace')
# 先 Ctrl+C 确保回到 REPL
ser.write(b'\x03'); time.sleep(0.3)
ser.write(b'\x02'); ser.write(b'\r\n'); time.sleep(0.3); ser.read(3000)
# 读取驱动内容逐行写入板子 main.py
with open('robot_server_steps.py','r') as f:
    content = f.read()
lines = content.split('\n')
code = "f=open('main.py','w')\n"
for ln in lines:
    esc = ln.replace('\\','\\\\').replace("'", "\\'")
    code += f"f.write('{esc}\\n')\n"
code += "f.close()\nprint('main.py (TB6600) uploaded')\n"
r = paste_exec(code, wait=3.0)
print("UPLOAD:", r[-300:])
# 验证长度
r2 = paste_exec("f=open('main.py')\nprint('LEN', len(f.read()))\nf.close()\n")
print("CHECK:", r2[-200:])
ser.close()

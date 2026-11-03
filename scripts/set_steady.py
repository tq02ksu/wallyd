import serial, time

port = '/dev/cu.usbserial-A5069RR4'
ser = serial.Serial(port, 115200, timeout=2)
time.sleep(0.5)
ser.reset_input_buffer()

def paste_exec(code, wait=1.5):
    ser.write(b'\x01')
    time.sleep(0.1)
    ser.write(code.encode())
    ser.write(b'\x04')
    time.sleep(wait)
    out = ser.read(8000)
    return out.decode(errors='replace')

# 先 Ctrl+B 退出任何粘贴，回到 REPL；若板子在跑 while True 会阻塞，需先 Ctrl+C 中断
ser.write(b'\x02')
time.sleep(0.2)
ser.write(b'\x03')  # Ctrl+C 中断可能正在跑的循环
time.sleep(0.3)
ser.write(b'\r\n'); time.sleep(0.3); ser.read(3000)

# 把 main.py 改成"常亮绿色单色"（不闪烁）
main_code = (
    "f=open('main.py','w')\n"
    "f.write('from machine import Pin\\n')\n"
    "f.write('import neopixel\\n')\n"
    "f.write('np = neopixel.NeoPixel(Pin(48), 1)\\n')\n"
    "f.write('np[0] = (0, 255, 0)  # 常亮绿色\\n')\n"
    "f.write('np.write()\\n')\n"
    "f.close()\n"
    "print('main.py steady-written')\n"
)
r = paste_exec(main_code)
print("WRITE:", r[-200:])

# 直接执行一次点亮绿色，让当前立即生效
r2 = paste_exec("from machine import Pin\nimport neopixel\nnp = neopixel.NeoPixel(Pin(48), 1)\nnp[0] = (0, 255, 0)\nnp.write()\nprint('green on')\n")
print("EXEC:", r2[-200:])
ser.close()

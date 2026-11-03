import serial, time, sys

port = '/dev/cu.usbserial-A5069RR4'
ser = serial.Serial(port, 115200, timeout=1)
time.sleep(0.5)

# 触发硬复位 (DTR+RTS 抖动), MicroPython 会重新跑 boot.py -> main.py
ser.setDTR(False)
ser.setRTS(True)
time.sleep(0.1)
ser.setRTS(False)
time.sleep(0.1)
ser.setDTR(True)   # 进入 bootloader? 不, 这里仅做复位
time.sleep(2.5)    # 等板子启动 main.py

# 读启动输出
boot = ser.read(4000)
print("BOOT OUTPUT:", boot.decode(errors='replace')[:500])

# 发出 hello 测试指令
ser.reset_input_buffer()
ser.write(b'hello\n')
time.sleep(1.0)
resp = ser.read(4000)
print("HELLO RESP:", repr(resp.decode(errors='replace')))

# 发 led 指令
ser.reset_input_buffer()
ser.write(b'led 255 0 0\n')   # 红
time.sleep(0.8)
resp = ser.read(4000)
print("LED RESP:", repr(resp.decode(errors='replace')))

ser.close()

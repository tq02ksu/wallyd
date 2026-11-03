import serial, time
port = '/dev/cu.usbserial-A5069RR4'
ser = serial.Serial(port, 115200, timeout=2)
time.sleep(0.8)
ser.reset_input_buffer()
def paste_exec(code, wait=2.5):
    ser.write(b'\x01'); time.sleep(0.15)
    ser.write(code.encode()); ser.write(b'\x04')
    time.sleep(wait)
    return ser.read(8000).decode(errors='replace')
ser.write(b'\x02'); ser.write(b'\r\n'); time.sleep(0.3); ser.read(3000)
# 测试 bitstream: 在 GPIO4 输出一串脉冲 (2000 ns 高 + 2000 ns 低 = 250kHz), 100 个 step
code = """from machine import Pin, bitstream
import time
p = Pin(4, Pin.OUT)
# bitstream(pin, 0, (time_high_ns, time_low_ns), bits)
# 假设一次驱动位序列: 先高后低 100 次
bits = []
for _ in range(100):
    bits.append(1)  # high
    bits.append(0)  # low
bitstream(p, 0, (2000, 2000), bits)
print('bitstream ok, 100 pulses on GPIO4')
"""
r = paste_exec(code)
print(r[-400:])
ser.close()

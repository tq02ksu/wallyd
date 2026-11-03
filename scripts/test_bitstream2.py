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
# 构造 bytes: 每步 高+低 = 2 bits. 发 32 步 = 64 bits = 8 bytes
# 0b10101010... 交替. 用 bytes 构造
code = """from machine import Pin, bitstream
p = Pin(4, Pin.OUT)
# 100 步 = 200 bits = 25 bytes, 每字节 0b10101010
nbytes = 25
data = bytes([0b10101010]) * nbytes
bitstream(p, 0, (2000, 2000), data)
print('bitstream ok, ~100 pulses on GPIO4')
"""
r = paste_exec(code)
print(r[-400:])
ser.close()

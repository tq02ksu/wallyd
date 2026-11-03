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
# bitstream 四元组 timing. 每 bit 高/低 各 2000ns = 250kHz.
# data: 0xAA = 10101010, 交替高低. 25 bytes = 200 bits -> ~100 脉冲(2bit/步)
code = """from machine import Pin, bitstream
p = Pin(4, Pin.OUT)
data = bytes([0b10101010]) * 25   # 200 bits
bitstream(p, 0, (2000, 2000, 2000, 2000), data)
print('bitstream4 ok, 200 bits on GPIO4')
"""
r = paste_exec(code)
print(r[-300:])
ser.close()

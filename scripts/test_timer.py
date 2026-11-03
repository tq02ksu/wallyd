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
# 探测 Timer 用法
code = """import machine
print('Timer', machine.Timer)
# 列出 Timer 支持的频率范围估算: 看 init 签名 (简单探测)
t = machine.Timer(0)
print('timer created')
"""
r = paste_exec(code)
print(r[-400:])
ser.close()

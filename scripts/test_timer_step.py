import serial, time
port = '/dev/cu.usbserial-A5069RR4'
ser = serial.Serial(port, 115200, timeout=2)
time.sleep(0.8)
ser.reset_input_buffer()
def paste_exec(code, wait=3.0):
    ser.write(b'\x01'); time.sleep(0.15)
    ser.write(code.encode()); ser.write(b'\x04')
    time.sleep(wait)
    return ser.read(8000).decode(errors='replace')
ser.write(b'\x02'); ser.write(b'\r\n'); time.sleep(0.3); ser.read(3000)
code = """from machine import Pin, Timer
import time
p = Pin(4, Pin.OUT)
p.value(0)
state = {'count':0, 'target':400}  # 400 次翻转 = 200 步
def cb(t):
    p.value(1 if state['count']%2==0 else 0)
    state['count'] += 1
    if state['count'] >= state['target']:
        t.deinit()
        print('DONE steps(falling edges):', state['count']//2)
tmr = Timer(0)
tmr.init(period=3000, mode=Timer.PERIODIC, callback=cb)  # 3ms 周期 ~333Hz
print('timer started')
"""
r = paste_exec(code)
print(r[-400:])
ser.close()

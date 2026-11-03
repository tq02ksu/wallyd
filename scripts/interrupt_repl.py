import serial, time
port = '/dev/cu.usbserial-A5069RR4'
ser = serial.Serial(port, 115200, timeout=1)
time.sleep(0.5)
ser.reset_input_buffer()
# 发 Ctrl+C 中断当前 main.py 循环
ser.write(b'\x03')
time.sleep(0.5)
out = ser.read(3000)
print("AFTER CTRL+C:", repr(out.decode(errors='replace')[-400:]))
# 发空行测试是否回到 REPL
ser.write(b'\r\n')
time.sleep(0.5)
out2 = ser.read(3000)
print("AFTER ENTER:", repr(out2.decode(errors='replace')[-400:]))
ser.close()

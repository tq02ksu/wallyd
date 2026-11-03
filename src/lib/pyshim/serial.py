"""pyserial minimal shim (stdlib termios only).

Local machine has no pyserial, but <wallyd-root>/scripts/*.py all `import serial`.
Put this directory on PYTHONPATH and those scripts run unchanged, no network needed.

Covers: Serial(port, baudrate, timeout) / read / write / reset_input_buffer /
reset_output_buffer / setDTR / setRTS / in_waiting / close / flush / get_lines.
Temporary work script under work/, not part of the knowledge base.
"""

import fcntl
import os
import select
import struct
import termios
import time

VERSION = 'shim-0.1'
__version__ = VERSION


class SerialException(OSError):
    pass


class Serial:
    def __init__(self, port, baudrate=9600, bytesize=8, parity='N', stopbits=1,
                 timeout=None, write_timeout=None, xonxoff=False, rtscts=False,
                 dsrdtr=False, exclusive=False, **kwargs):
        self.port = port
        self.baudrate = baudrate
        self.timeout = timeout
        self.write_timeout = write_timeout
        self.is_open = False
        self.fd = None
        self._dtr = None
        self._rts = None
        self._open()

    def _open(self):
        self.fd = os.open(self.port, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
        self._configure()
        self.is_open = True
        # 实测（2026-10-03）：这块 ESP32-S3 板的 DTR/RTS 经三极管接到 EN/IO0，
        # DTR=1 或 RTS=1 都会把芯片按在复位/下载态（表现为读不到任何输出）。
        # pyserial 默认两者都拉高，在本板上必然连不上，所以这里默认拉低。
        self.setRTS(False)
        self.setDTR(False)

    def _configure(self):
        b = getattr(termios, 'B%d' % int(self.baudrate))
        _i, _o, _c, _l, _is, _os, cc = termios.tcgetattr(self.fd)
        iflag = 0
        oflag = 0
        lflag = 0
        cflag = termios.CS8 | termios.CREAD | termios.CLOCAL
        cc[termios.VMIN] = 0
        cc[termios.VTIME] = 0
        termios.tcsetattr(self.fd, termios.TCSANOW,
                          [iflag, oflag, cflag, lflag, b, b, cc])
        termios.tcflush(self.fd, termios.TCIOFLUSH)

    def _set_line(self, mask, value):
        req = termios.TIOCMBIS if value else termios.TIOCMBIC
        fcntl.ioctl(self.fd, req, struct.pack('I', mask))

    def get_lines(self):
        buf = bytearray(4)
        fcntl.ioctl(self.fd, termios.TIOCMGET, buf, True)
        v = struct.unpack('I', bytes(buf))[0]
        return {'dtr': bool(v & termios.TIOCM_DTR),
                'rts': bool(v & termios.TIOCM_RTS),
                'cts': bool(v & termios.TIOCM_CTS),
                'dsr': bool(v & termios.TIOCM_DSR),
                'car': bool(v & termios.TIOCM_CAR)}

    def setDTR(self, value):
        self._set_line(termios.TIOCM_DTR, value)
        self._dtr = value

    def setRTS(self, value):
        self._set_line(termios.TIOCM_RTS, value)
        self._rts = value

    @property
    def in_waiting(self):
        r, _, _ = select.select([self.fd], [], [], 0)
        return 1 if r else 0

    def read(self, size=1):
        if not self.is_open:
            raise SerialException('port is closed')
        buf = b''
        deadline = None if self.timeout is None else time.time() + self.timeout
        while len(buf) < size:
            if deadline is None:
                wait = 0.05
            else:
                remain = deadline - time.time()
                if remain <= 0:
                    break
                wait = min(remain, 0.05)
            r, _, _ = select.select([self.fd], [], [], wait)
            if r:
                chunk = os.read(self.fd, size - len(buf))
                if chunk:
                    buf += chunk
                    if self.timeout is not None:
                        deadline = time.time() + self.timeout
        return buf

    def write(self, data):
        if not self.is_open:
            raise SerialException('port is closed')
        return os.write(self.fd, data)

    def flush(self):
        termios.tcflush(self.fd, termios.TCOFLUSH)

    def reset_input_buffer(self):
        termios.tcflush(self.fd, termios.TCIFLUSH)

    def reset_output_buffer(self):
        termios.tcflush(self.fd, termios.TCOFLUSH)

    def close(self):
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None
        self.is_open = False

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()

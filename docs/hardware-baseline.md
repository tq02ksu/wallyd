# Hardware and Electrical Baseline

This is the WALLY procurement and wiring baseline inherited from the reference
Mac mini robot. Detailed source documents are authoritative:

- [hardware selection](../doc/hardware-selection.md)
- [electrical architecture](../doc/electrical-architecture.md)
- [power architecture](../doc/power-architecture.md)
- [connector plan](../doc/wiring-connectors.md)
- [stepper wiring](../doc/stepper-wiring.md)
- [risk assessment](../doc/risk-assessment.md)

## Selected bill of materials

| Subsystem | Selected hardware | Status / rationale |
| --- | --- | --- |
| Compute | Mac mini M4, 24 GB target | Reference platform; local models stay on-device |
| Motion MCU | ESP32-S3-N16R8 DevKit | Native USB; firmware owns pulse timing and watchdog |
| Wheels | 2 x 42BYGH47 NEMA-17, 0.55 N*m | Purchased and connected in reference build |
| Drivers | 2 x TB6600 | Purchased; isolated STEP/DIR/ENA inputs |
| Chassis | Differential 2WD + one caster | Printed or fabricated chassis |
| Vision | UVC 1080p USB camera | Must expose UVC interface class 0x0E |
| Gimbal | 2 x MG996R | Dedicated 5/6 V supply required |
| Logic power | Isolated 12 V -> 5 V converter | Shared ground, separate motor supply rail |
| Main power | 12 V bus, >=30 A with full expansion load | Exact buck/current strategy remains unverified |
| Battery | Factory tool battery preferred; 3S LiPo fallback | Avoid uncertified low-cost packs |
| AC power | 200 W pure sine inverter for Mac mini | No modified sine wave; surge risk remains open |
| Charging | Magnetic/pogo contacts + IR guidance | Docking mechanics remain a staged risk |

The reference cost target is approximately RMB 400 excluding the Mac mini, but
current prices were not live-validated. Recheck the BOM before purchase.

## Motion wiring baseline

| Function | GPIO | TB6600 signal |
| --- | --- | --- |
| Left drive STEP / DIR / ENA | 9 / 10 / 11 | PUL- / DIR- / ENA- |
| Right drive STEP / DIR / ENA | 12 / 13 / 14 | PUL- / DIR- / ENA- |
| Expansion stepper 3 | 4 / 5 / 6 | PUL / DIR / ENA |
| Expansion stepper 4 | 15 / 16 / 17 | PUL / DIR / ENA |
| Pump group | 1 / 2 / 42 | level sensor / two relay channels |
| Gimbal | 41 / 40 | pan / tilt PWM |
| I2C | 39 / 38 | SDA / SCL |

TB6600 logic is common-anode/low-active. Its PUL, DIR, and ENA inputs on the
adopted board revision must only be driven low or left high-impedance; driving
them to 3.3 V can partially turn on the optocoupler and prevent movement.

## Power and safety redlines

- Use physically different connectors for power and logic signals.
- Use one star ground point; connect ESP32 ground to power ground even while the
  board is USB-powered.
- Never disconnect motor phases while the TB6600 is powered.
- Do not power servos from the ESP32 regulator.
- Include a fused 12 V bus, motor-driver bulk capacitance, pump flyback/snubber,
  and inverter soft-start or precharge.
- Software `stop` is not a hardware emergency stop. A hardware energy-cut path
  remains required before real-world operation.
- Power architecture, surge current, BMS behavior, wheel torque, motor accuracy,
  and docking are unverified until measured on hardware.

## Phase-one boundary

Procurement and wiring may be documented and simulated. Automation must not
flash firmware, energize drivers, move motors, or operate the camera on real
hardware until a human explicitly authorizes a hardware test.


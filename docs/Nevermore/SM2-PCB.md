---
hide:
  - footer
---

# Nevermore Stealthmax PCB 2

<img src="https://raw.githubusercontent.com/xbst/Nevermore-PCB/refs/heads/master/Images/SM2.jpg" width="600"/>

Controller PCB for the [Nevermore Stealthmax](https://github.com/nevermore3d/StealthMax) air filter.

## Printed Parts

Download and print the necessary files from the PCB's repo. You'll need to at least print the "Spacer" for your printer size. You can use the stock latch with the Raspberry Pi logo, or download the version from this repo with the Isik's Tech logo.

| Filter | Spacer | Latch |
|---|---|---|
| Stealthmax | [Spacer](https://github.com/xbst/Nevermore-PCB/Mounts/Stealthmax/Spacer.stl) | [Latch](https://github.com/xbst/Nevermore-PCB/Mounts/Stealthmax/Latch.stl) |
| Stealthmax S | [Spacer](https://github.com/xbst/Nevermore-PCB/Mounts/Stealthmax-S/Spacer.stl) | [Latch](https://github.com/xbst/Nevermore-PCB/Mounts/Stealthmax-S/Latch.stl) |

## Mount

1. Place the spacer over the screw holes of the electronics chamber of your filter. The top side of the mount (printing orientation) faces down. Align the outer screw holes with the holes on the spacer.
2. Attach the heatsink to the PCB, behind the corner with the buck converters. Align its edges with the edges of the PCB. This is where it fits with the spacer:

[![Heatsink](https://github.com/xbst/docs/raw/master/docs/assets/nevermore/SM2-Heatsink.jpg)](https://github.com/xbst/docs/raw/master/docs/assets/nevermore/SM2-Heatsink.jpg)

## Wiring

All internal connectors except peltier are JST-PH, peltier is MX3.0. The CAN/VIN connector is XT30(2+2). Use the diagram below to wire your fan, sensors, LEDs, thermistor, and peltier.

[![Pinout](https://github.com/xbst/docs/raw/master/docs/assets/nevermore/SM2-Pinout.png)](https://github.com/xbst/docs/raw/master/docs/assets/nevermore/SM2-Pinout.png)

!!! warning "Do not hot-plug VIN on your PCB. Always turn your printer off before plugging/unplugging the VIN cable."

## Next Steps

Proceed to [Firmware & Software Setup](Firmware-Setup.md) for flashing instructions, SGP40 plugin installation, and Klipper config.

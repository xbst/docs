---
hide:
  - footer
---

# Nevermore Max 2 PCB

<img src="https://raw.githubusercontent.com/xbst/Nevermore-PCB/refs/heads/master/Images/Max.jpg" width="600"/>

Controller PCB for the [Nevermore Max](https://github.com/nevermore3d/Nevermore_Max) air filter.

!!! warning "This PCB does not support CAN bus communication. Use [USB Serial Communication](Firmware-Setup.md#firmware-flashing) when flashing firmware."

## Mount

1. Print the ~~bottle opener~~ [Nevermore Max PCB tray](https://github.com/xbst/Nevermore-PCB/Mounts/Max/PCB-Tray.stl) using the standard Voron print settings.
2. Remove the built-in supports.
3. Superglue 2 magnets. Pay attention to the polarities.
4. Mount the PCB. The plastic latches will keep the PCB in place, no screws needed. The USB/power side should be seated first.

[![Instructions](https://github.com/xbst/docs/raw/master/docs/assets/nevermore/PCB-Tray.png)](https://github.com/xbst/docs/raw/master/docs/assets/nevermore/PCB-Tray.png)

## Wiring

All connectors except USB are JST-XH. Use the diagram below to wire your fans, sensors, LEDs, and power.

[![Pinout](https://github.com/xbst/docs/raw/master/docs/assets/nevermore/Max-Pinout.png)](https://github.com/xbst/docs/raw/master/docs/assets/nevermore/Max-Pinout.png)

!!! warning "Do not hot-plug VIN on your PCB. Always turn your printer off before plugging/unplugging the VIN cable."

## Next Steps

Proceed to [Firmware & Software Setup](Firmware-Setup.md) for flashing instructions, SGP40 plugin installation, and Klipper config.

---
hide:
  - footer
---

# Nevermore Stealthmax PCB 3

<img src="https://raw.githubusercontent.com/xbst/Stealthmax-PCB-3/refs/heads/master/Images/PCB.jpg" width="600"/>

Controller PCB for the [Nevermore Stealthmax v2](https://github.com/nevermore3d/Stealthmax_V2) air filter.

## Printed Parts

Below are all the printed parts you can print for your Nevermore Stealthmax PCB 3 setup. You need to print the spacer file, the rest are optional and dependent on your setup.


| Type         | Single-Color | Multi-Color |
| ------------ | ------------ | ----------- |
| Spacer (Mount) | [Download](https://raw.githubusercontent.com/xbst/Stealthmax-PCB-3/refs/heads/master/CAD/Printed-Parts/Mount/SM-PCB3-Mount.stl) | N/A |
| Latch | [Download](https://raw.githubusercontent.com/xbst/Stealthmax-PCB-3/refs/heads/master/CAD/Printed-Parts/Latch/IT-Latch.stl) | [Download](https://raw.githubusercontent.com/xbst/Stealthmax-PCB-3/refs/heads/master/CAD/Printed-Parts/Latch/Latches-Color.step) |
| XT30(2+2) Port Cover | [Download](https://raw.githubusercontent.com/xbst/Stealthmax-PCB-3/refs/heads/master/CAD/Printed-Parts/Port-Covers/XT30(2+2)-Port-Cover.stl) | N/A |
| MX3.0 Port Cover | [Download](https://raw.githubusercontent.com/xbst/Stealthmax-PCB-3/refs/heads/master/CAD/Printed-Parts/Port-Covers/MX3.0-Port-Cover.stl) | N/A |

## Port Cover (Optional)

1. Print and insert the plastic cover into the port.
2. Mount the port cover PCB using M3 screws.
3. Connect the internal MX3.0 cable to the Stealthmax PCB 3 before mounting it.

## Mount

1. If using a port cover, mount that first following the above steps.
2. Stealthmax PCB 3s ship with the heatsink placed on the board. Make sure this heatsink is on your PCB, and is seated down fully (parallel to the PCB).
3. There are 2 mounting screws included with your PCB; one is 10mm long, the other is 8mm. 10mm is used for the heatsink side, and 8mm is used on the other side. Using these screws, mount the PCB in place with the spacer between the Stealthmax and the PCB.
    ![Mount](https://github.com/xbst/docs/raw/master/docs/assets/nevermore/SM3-Mount.PNG)

## Wiring

All internal connectors except peltier are JST-PH, peltier is MX3.0. The CAN/VIN connector is also MX3.0.

### PH Connectors

![Pinout](https://github.com/xbst/docs/raw/master/docs/assets/nevermore/SM3-PH-Pinout.png)

### Other Connectors

![Pinout](https://github.com/xbst/docs/raw/master/docs/assets/nevermore/SM3-MX-Pinout.png)

There's a slide switch on the bottom side. Slide it left (toward the CAN+VIN connector) to terminate the CAN bus (120 Ohm resistor).

## Next Steps

Proceed to [Firmware & Software Setup](Firmware-Setup.md) for flashing instructions, SGP40 plugin installation, and Klipper config.

---
title: Ouroboros Wiring & Mount
hide:
  - footer
---

# Ouroboros Wiring & Mount

## Ouroboros Mounts
- [Voron DIN Rail Mount by hartk](./Ouroboros_Mount_hartk.zip)

## Ouroboros Wiring

![Pinout](../pinouts/ouroboros/ouroboros.pinout.html){ type=application/pinout style="min-height:70vh;width:100%" }

### MCU_PWR

Make sure the `MCU_PWR` switch is set to `BUCK`. This switch is meant to be set to `BUCK` during normal operation. The `USB` setting is for firmware flashing without power connected to VIN. You won't need this setting when following this documentation.

### Motor Power & Encoder Wires

<img align="right" width="300" height="300" src="/../assets/ouroboros/stepper-coils.PNG">
Refer to your motor's datasheet to find its wire colors for each coil. It will look similar to the image on the right. 

|         | Black | Green | Red  | Blue |
| ------- | ----- | ----- | ---- | ---- |
| Pinout  | A     | C     | B    | D    |
| Stepper | A1    | A2    | B1   | B2   |
| BLDC    | U     | V     | W    | -    |

!!! warning "Wire Colors"
    There's no standard for motor wire colors, so your motor wire colors may differ. Make sure to refer to the pinout below to make sure your motors are wired correctly.

!!! note "Encoders"
    Recommended encoder type is AB or ABZ optical encoder. Hall effect encoders are known to not work as well.

### Expansion Connector

This connector is designed for adding more features to Ouroboros. It has some power pins, and many pins connectors connected to the STM32 MCU, including CAN bus, UART, and other GPIO pins. It's a standard 1.27mm pitch female header, which can be mated with a standard 1.27mm pin header on an expansion board, or with male jumper wires using the same size connector.

Currently there are no official expansion boards available.

<style type="text/css">
.tg  {border-collapse:collapse;border-spacing:0;}
.tg td{border-color:amber;border-style:solid;border-width:2px;overflow:hidden;padding:6px 6px;word-break:normal;}
.tg th{border-color:amber;border-style:solid;border-width:2px;overflow:hidden;padding:6px 6px;word-break:normal;}
.tg .tg-0pky{border-color:inherit;text-align:center;vertical-align:center}
.tg .tg-0lax{text-align:center;vertical-align:center}
</style>
<table class="tg"><thead>
  <tr>
    <th class="tg-0pky">12V</th>
    <th class="tg-0pky">12V</th>
    <th class="tg-0pky">12V</th>
    <th class="tg-0pky">MISO</th>
    <th class="tg-0pky">MOSI</th>
    <th class="tg-0pky">SCK</th>
    <th class="tg-0pky">PE3</th>
    <th class="tg-0pky">PB2</th>
    <th class="tg-0pky">PB1</th>
    <th class="tg-0pky">PB10</th>
    <th class="tg-0pky">PE9</th>
    <th class="tg-0pky">GND</th>
    <th class="tg-0pky">GND</th>
    <th class="tg-0pky">GND</th>
    <th class="tg-0pky">PB0</th>
    <th class="tg-0pky">GND</th>
    <th class="tg-0pky">3.3V</th>
    <th class="tg-0pky">3.3V</th>
    <th class="tg-0pky">5V</th>
    <th class="tg-0pky">5V</th>
  </tr></thead>
<tbody>
  <tr>
    <td class="tg-0pky">GND</td>
    <td class="tg-0pky">GND</td>
    <td class="tg-0pky">PA4</td>
    <td class="tg-0pky">PA5</td>
    <td class="tg-0pky">PA6</td>
    <td class="tg-0pky">PA7</td>
    <td class="tg-0pky">PE14</td>
    <td class="tg-0pky">PE15</td>
    <td class="tg-0pky">GND</td>
    <td class="tg-0pky">PB6</td >
    <td class="tg-0pky">PB5</td>
    <td class="tg-0pky">GND</td>
    <td class="tg-0pky">PE8</td>
    <td class="tg-0pky">PE7</td>
    <td class="tg-0pky">GND</td>
    <td class="tg-0pky">PE1</td>
    <td class="tg-0pky">PE0</td>
    <td class="tg-0pky">GND</td>
    <td class="tg-0pky">PB9</td>
    <td class="tg-0pky">PB8</td>
  </tr>
</tbody></table>
^ Marker on the PCB
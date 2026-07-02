---
hide:
  - footer
---

# Firmware & Software Setup

These instructions apply to all Nevermore PCBs (Max 2, Mini & Stealthmax, Stealthmax PCB 2, and Stealthmax PCB 3).

## Firmware Flashing

!!! warning "Do not hot-plug VIN on your PCB. Always turn your printer off before plugging/unplugging the VIN cable."

!!! info "If you sourced your PCB from an unofficial source, ensure nBOOT_SEL is set to enable BOOT0 before firmware flashing. Official Isik's Tech boards will already have this setting set so you can skip this step."

1. SSH into your Klipper SBC (Raspberry Pi).
2. Connect your PCB with a USB cable.
3. Hold down the `BOOT` button on your PCB. While holding it down, press `RESET`, then release `BOOT`. Alternatively, you can unplug the PCB then plug it in again while holding down the `BOOT` button. Use `lsusb` again to make sure you can see the device in DFU mode.
4. Go to the Klipper directory.
```
cd klipper
```
5. Clean remaining files from previous build.
```
make clean
```
6. Choose the options for the build.
```
make menuconfig
```
Use the following options:

    ??? info "USB Serial Communication"
        ```
        [*] Enable extra low-level configuration options
            Micro-controller Architecture (STMicroelectronics STM32)  --->
            Processor model (STM32G0B1)  --->
            Bootloader offset (No bootloader)  --->
            Clock Reference (8 MHz crystal)  --->
            Communication interface (USB (on PA11/PA12))  --->
            USB ids  --->
        ()  GPIO pins to set at micro-controller startup
        ```
    
    ??? info "CAN Bus Communication (with Katapult)"
        !!! warning "CAN bus is not available for the Nevermore Max 2 PCB."
    
        ```
        [*] Enable extra low-level configuration options
            Micro-controller Architecture (STMicroelectronics STM32)  --->
            Processor model (STM32G0B1)  --->
            Bootloader offset (8KiB Bootloader)  --->
            Clock Reference (8 MHz crystal)  --->
            Communication interface (CAN bus (on PB0/PB1))  --->
        (1000000) CAN bus speed
        ()  GPIO pins to set at micro-controller startup
        ```
    
    Press `Q` then `Y` to save and quit the menu.

7. Build.
```
make
```
8. Flash firmware:

    ??? info "USB Serial Communication"
        1. Flash Klipper.
        ```
        make flash FLASH_DEVICE=0483:df11
        ```
        2. When finished, press the `RESET` button on your PCB.
        3. Use `ls /dev/serial/by-id/*` to find the path starting with `/dev/serial/by-id/usb-Klipper_stm32g0b1`. This is the serial path of your Nevermore PCB.

    ??? info "CAN Bus Communication (with Katapult)"
        1. Go home.
        ```
        cd ~
        ```
        2. Install [Katapult](https://github.com/Arksine/katapult).
        ```
        git clone https://github.com/Arksine/katapult
        ```
        3. Go to the Katapult directory.
        ```
        cd katapult
        ```
        4. Choose the options for the build.
        ```
        make menuconfig
        ```
        Use the following options:
        ```
            Micro-controller Architecture (STMicroelectronics STM32)  --->
            Processor model (STM32G0B1)  --->
            Build Katapult deployment application (Do not build)  --->
            Clock Reference (8 MHz crystal)  --->
            Communication interface (CAN bus (on PB0/PB1))  --->
            Application start offset (8KiB offset)  --->
        (1000000) CAN bus speed
        ()  GPIO pins to set on bootloader entry
        [*] Support bootloader entry on rapid double click of reset button
        [ ] Enable bootloader entry on button (or gpio) state
        [*] Enable Status LED
        (PA13)  Status LED GPIO Pin
        ```
        5. Build.
        ```
        make
        ```
        6. Flash Katapult.
        ```
        sudo dfu-util -a 0 -d 0483:df11 --dfuse-address 0x08000000:leave -D out/canboot.bin
        ```
        7. Power down your system (DO NOT HOT PLUG), connect your VIN and CAN cable, disconnect USB, power your system on and SSH into your SBC.
        8. Find the CAN bus UUID of your PCB. Make sure your CAN wires are connected.
        ```
        ~/klippy-env/bin/python ~/klipper/scripts/canbus_query.py can0
        ```
        9. Flash Klipper. Replace `<UUID>` with your PCB's UUID.
        ```
        cd ~/katapult/scripts && python3 flashtool.py -i can0 -f ~/klipper/out/klipper.bin -u <UUID>
        ```
        10. When finished, press the `RESET` button on your PCB.

## SGP40 Plugin Installation

!!! info "Klipper I2C Changes"
    Klipper devs are currently frequently making changes to the I2C code, and Kalico is merging these changes shortly after. These changes occasionally break compatibility with the SGP40 plugin until its dev updates the plugin. It's recommended to NOT update Klipper/Kalico until Klipper I2C changes are finalized. Updated April 2026.

1. SSH into your Klipper SBC (Raspberry Pi) and run these commands:
```
cd ~
git clone https://github.com/thetic/klipper-sgp40.git
cd klipper-sgp40
./install.sh
```

2. Add the following to your `moonraker.conf` to enable automatic updates:
```
[update_manager klipper-sgp40]
type: git_repo
path: ~/klipper-sgp40
origin: https://github.com/thetic/klipper-sgp40.git
primary_branch: main
managed_services: klipper
```

## Klipper Config

1. Download the Klipper config for your PCB and upload it to your printer.
2. Open the file and edit according to your setup.
3. Add `[include <name>.cfg]` in your `printer.cfg` (replace `<name>` with the name of the file).

| PCB | Config File |
|---|---|
| Nevermore Max 2 PCB | [Download Config](https://raw.githubusercontent.com/xbst/Nevermore-PCB/refs/heads/master/Firmware/Max.cfg) |
| Nevermore Mini & Stealthmax PCB | [Download Config](https://raw.githubusercontent.com/xbst/Nevermore-PCB/refs/heads/master/Firmware/Max.cfg) |
| Nevermore Stealthmax PCB 2 | [Download Config](https://raw.githubusercontent.com/xbst/Nevermore-PCB/refs/heads/master/Firmware/SM2.cfg) |
| Nevermore Stealthmax PCB 3 | TBD |

## SGP40 Calibration

!!! info "The printer cannot be used during calibration."

    Calibration establishes a baseline corresponding to "clean air", where "clean air" means as clean as the air in the room. This will take at least 8 hours and ideally 24 hours.

!!! info "Panel off gassing may affect calibration"
    Wash your printer if there is _any_ smell prior to calibration. There is no point calibrating a baseline if it is dirty and off gassing. Use hot water & soap to scrub the panels, enclosures, print sheets, beds, etc.
    
    A dirty printer will result in VOC readings that start around 100, but then rise to 400+. The air is steadily getting dirtier from whatever is off-gassing. The air will keep getting worse until it reaches saturation. If you were to plot the raw response, you’d see it steadily degrade over time.
    
    The initial plateau at 100 VOC Index is because the system will assume the initial conditions are nominal before adjusting the expected range; this is when the VOC Index will begin to increase.

1. Cool down the printer
2. Turn off any air filter fans.
3. Open the printer enclosure
4. (_Optional_) Remove any filter material (e.g. carbon).
   This helps ensure all sensors are exposed to the same air and reach similar calibrations.
5. Let some fresh air into the room for a minute or two.
   Open a window for a few minutes, flap a hand towel in the doorway, whatever.
   The objective is to get clean air into the enclosure.
   **This air will serve as reference for the baseline.**
   If you’re not happy breathing it, it isn't clean air.
6. Close the printer enclosure.
7. Run the `RESET_SGP40`command for each configured sensor.
8. Leave the printer alone for at least 8 hours, and up to 24 hours if possible.
9. Run the `CALIBRATE_SGP40` command for each configured sensor.
10. Run the `SAVE_CONFIG` command.
    This will add the baseline values to `printer.cfg`.
11. Reinstall any filter media removed in step 4.

The system should now have a good baseline for the sensors.

!!! info "Sensor readings may drift over time requiring recalibration."

SGP40 calibration info is based on [SGP40 plugin repo](https://github.com/thetic/klipper-sgp40), licensed under GPLv3.
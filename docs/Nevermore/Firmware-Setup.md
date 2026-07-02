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

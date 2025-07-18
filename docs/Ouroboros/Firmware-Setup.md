---
title: Ouroboros Klipper Firmware Setup
hide:
  - footer
---

# Ouroboros Klipper Firmware Setup

This guide covers installing the TMC4671 plugin on your Klipper 3D printer, and firmware flashing of Ouroboros.



1. Turn on your 3D printer and SSH into it.
2. Install [andrewmcgr's TMC4671 Klipper Plugin](https://github.com/andrewmcgr/tmc-4671) using:
   ```
   wget -O - https://raw.githubusercontent.com/andrewmcgr/tmc-4671/main/install.sh | bash
   ```

3. Do not close your SSH terminal yet, open your web browser and go to your 3D printer's interface (like Mainsail).

4. Edit your `moonraker.conf` file. Add this: 
   ```ini
   [update_manager tmc-4671]
   type: git_repo
   channel: dev
   path: ~/tmc-4671
   origin: https://github.com/andrewmcgr/tmc-4671.git
   managed_services: klipper
   primary_branch: main
   install_script: install.sh
   ```

5. On your SSH terminal, go to the Klipper directory (`cd ~/Klipper`), clean previous build files (`make clean`), and configure Klipper for Ouroboros (`make menuconfig`). Use these settings:
   ``````
   [*] Enable extra low-level configuration options
       Micro-controller Architecture (STMicroelectronics STM32)  --->
       Processor model (STM32H723)  --->
       Bootloader offset (No bootloader)  --->
       Clock Reference (25 MHz crystal)  --->
       Communication interface (USB (on PA11/PA12))  --->
       USB ids  --->
   [ ] Optimize stepper code for 'step on both edges'
   ()  GPIO pins to set at micro-controller startup
   ``````

6. Press `Q`. If prompted to save, press `Y`.

7. On your Ouroboros, press and hold the `BOOT` button. While holding it down, press and release the `RESET` button, then release the `BOOT` button.

8. Flash firmware to your Ouroboros using `make flash FLASH_DEVICE=0483:df11`.

9. To find the serial address of your Ouroboros using `ls /dev/serial/by-id/*`. It'll show up as a STM32H723 device. If you don't see it, press and release the `RESET` button on your Ouroboros and try again.
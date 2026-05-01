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

10. Open your `printer.cfg` file. In it: 
    1. Add: 
       ``````ini
       [mcu ouroboros]
       serial: 
       ``````

        Make sure to add your Ouroboros's serial address to above.

    2. Find your existing `[tmc2209]`, `[tmc2660]`, `[tmc2240]` or similar sections for `stepper_x` and `stepper_y`, and delete or comment them.

    3. Find your existing `[stepper_x]` and `[stepper_y]` sections. Edit them with:
	    1. Edit your `full_steps_per_rotation` and `microsteps` values. Both must be powers of two, and their product must be less than 65536. 4096 steps and 2 microsteps are good starting values.

	    2. Edit the `step_pin`, `dir_pin`, `enable_pin` values. Use these:

	        | Motor | Step           | Dir            | Enable        | Endstop*       |
	        | ----- | -------------- | -------------- | ------------- | -------------- |
	        | X     | ouroboros:PD4  | ouroboros:PD3  | ouroboros:PD6 | ^ouroboros:PD7 |
	        | Y     | ouroboros:PC12 | ouroboros:PC11 | ouroboros:PD1 | ^ouroboros:PB3 |

	        !!! note "Using Existing Physical Endstop Setup"
	            You only need to edit your `endstop_pin` setting if you are using the endstop connector on your Ouroboros. You don't need to edit your existing `endstop_pin` setting if you were already using physical endstop switches wired to boards you're not planning to remove. For example, if your X endstop switch is connected to your toolhead board, you can keep it connected there and use your existing setting for that pin.

	    3. Keep your existing `rotation_distance`, `homing_speed`, `homing_retract_dist`, `position_min`, `position_max`, `position_endstop` and any other parameters not covered here as-is.

    4. Add these lines to enable OTP (over temperature protection):
        ``````ini
        [temperature_sensor Ouroboros_MCU_Temp]
        sensor_type: temperature_mcu
        sensor_mcu: ouroboros
        min_temp: 0
        max_temp: 80
        
        [temperature_sensor Ouroboros_TMC1_MOS_Temp]
        sensor_type: Generic 3950
        sensor_pin: ouroboros:PC4
        pullup_resistor: 4700
        min_temp: 0
        max_temp: 100
        
        [temperature_sensor Ouroboros_TMC2_MOS_Temp]
        sensor_type: Generic 3950
        sensor_pin: ouroboros:PC5
        pullup_resistor: 4700
        min_temp: 0
        max_temp: 100
        ``````
        
    5. Add these lines to enable `FORCE_MOVE`:
       ``````ini
       [force_move]
       enable_force_move: True
       ``````

12. Move on to your motor type's (stepper/BLDC) setup document. 

    (BLDC docs are coming soon)
---
title: Ouroboros Encoder Stepper Setup
hide:
  - footer
---

# Ouroboros Encoder Stepper Setup

This guide covers upgrading X and Y motors of a Klipper 3D printer with closed loop FOC using Ouroboros and stepper motors with built-in encoders.

---
## Klipper Config

1. Find the serial address of your Ouroboros using `ls /dev/serial/by-id/*`. It'll show up as a STM32H723 device. 

2. Open your `printer.cfg` file. In it: 

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

    3. Keep your existing `rotation_distance`, `homing_speed`, `hoimng_retract_dist`, `position_min`, `position_max`, `position_endstop` and any other parameters not covered here as-is.

    4. Add `[tmc4671]` sections for both motors:
       ``````ini
       [tmc4671 stepper_x]
       # SPI
       cs_pin: ouroboros:PD0
       spi_bus: spi2
       spi_speed: 2000000
       
       # Current Sense
       current_scale_ma_lsb: 1.272
       
       # Currents
       run_current: 3.5
       flux_current: 0.02
       
       # Motor Info
       foc_motor_type: 2
       foc_n_pole_pairs: 50
       
       # TMC4671 Settings
       foc_pwm_sv: 0
       foc_adc_i_ux_select: 0
       foc_adc_i_v_select: 2
       foc_adc_i_wy_select: 1
       foc_phi_e_selection: 3
       foc_position_selection: 9
       foc_velocity_selection: 9
       
       # Encoder
       foc_abn_decoder_ppr: 4000
       foc_abn_direction: 1
       
       # PID
       foc_pid_flux_p: 17.1
       foc_pid_flux_i: 0.067
       foc_pid_torque_p: 17.1
       foc_pid_torque_i: 0.067
       foc_pid_velocity_p: 1.07063
       foc_pid_velocity_i: 0.00498
       foc_pid_position_p: 1.27522
       foc_pid_position_i: 0.00125
       
       # Biquad Filter
       biquad_flux_frequency: 0
       biquad_torque_frequency: 0
       biquad_velocity_frequency: 0
       biquad_position_frequency: 0
       
       [tmc4671 stepper_y]
       # SPI
       cs_pin: ouroboros:PD2
       spi_bus: spi2
       spi_speed: 2000000
       
       # Current Sense
       current_scale_ma_lsb: 1.272
       
       # Currents
       run_current: 3.5
       flux_current: 0.02
       
       # Motor Info
       foc_motor_type: 2
       foc_n_pole_pairs: 50
       
       # TMC4671 Settings
       foc_pwm_sv: 0
       foc_adc_i_ux_select: 0
       foc_adc_i_v_select: 2
       foc_adc_i_wy_select: 1
       foc_phi_e_selection: 3
       foc_position_selection: 9
       foc_velocity_selection: 9
       
       # Encoder
       foc_abn_decoder_ppr: 4000
       foc_abn_direction: 1
       
       # PID
       foc_pid_flux_p: 17.1
       foc_pid_flux_i: 0.067
       foc_pid_torque_p: 17.1
       foc_pid_torque_i: 0.067
       foc_pid_velocity_p: 1.07063
       foc_pid_velocity_i: 0.00498
       foc_pid_position_p: 1.27522
       foc_pid_position_i: 0.00125
       
       # Biquad Filter
       biquad_flux_frequency: 0
       biquad_torque_frequency: 0
       biquad_velocity_frequency: 0
       biquad_position_frequency: 0
       ``````

    5. Edit these parameters:
        1. `run_current`:  For stepper motors, recommended starting value is 1.4 times the rated current of the stepper motor, as specified on its datasheet. For example, if the rated current of the stepper motor is 2.5A on its datasheet, a good starting value for run_current is **3.5A**.
        2. `foc_abn_decoder_ppr`: For stepper motors with 1000 PPR AB encoders, the correct value is **4000**.

    6. Add these lines to see your board temperatures on your interface:
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

    7. Add these lines to enable `FORCE_MOVE`:
       ``````ini
       [force_move]
       enable_force_move: True
       ``````

3. Save and close. `FIRMWARE_RESTART` your 3D printer.

---
## Calibration
Make sure to follow the calibration docs next for your stepper motors.

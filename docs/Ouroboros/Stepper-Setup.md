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
       foc_abn_direction: 0
       
       # PID
       foc_pid_flux_i: 0.485
       foc_pid_flux_p: 9.66
       foc_pid_torque_i: 0.485
       foc_pid_torque_p: 9.66
       foc_pid_velocity_i: 0.00826
       foc_pid_velocity_p: 1.408
       foc_pid_position_i: 0.00277
       foc_pid_position_p: 2.82
       
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
       foc_abn_direction: 0
       
       # PID
       foc_pid_flux_p: 9.66
       foc_pid_flux_i: 0.485
       foc_pid_torque_p: 9.66
       foc_pid_torque_i: 0.485
       foc_pid_velocity_p: 1.0
       foc_pid_velocity_i: 0
       foc_pid_position_p: 1.0
       foc_pid_position_i: 0
       
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
       sensor_type: ouroboros:temperature_mcu
       
       [temperature_sensor Ouroboros_TMC1_MOS_Temp]
       sensor_type: Generic 3950
       sensor_pin: ouroboros:PC4
       pullup_resistor: 4700
       
       [temperature_sensor Ouroboros_TMC2_MOS_Temp]
       sensor_type: Generic 3950
       sensor_pin: ouroboros:PC5
       pullup_resistor: 4700
       ``````

    7. Add these lines to enable `FORCE_MOVE`:
       ``````ini
       [force_move]
       enable_force_move: True
       ``````

3. Save and close. `FIRMWARE_RESTART` your 3D printer.

---
## Calibration
This section covers both the initial calibration and fine tuning of your TMC4671 setup.

Field oriented control works works very differently than the typical stepper driver setup we're more used to on Klipper 3D printers, so the terminology here may be confusing. Basically we're using PID control loops for driving the stepper instead of fully powering it on at a time. When tuned well, this can help improve print quality by reducing resonances, allowing you to print high quality prints at higher speeds. Unfortunately this tuning takes more effort than a typical stepper driver, so expect this to take some time, with some trial and error.
!!! warning "Don't install motors on your gantry yet! We need to make sure the motors can move and stop fine before installing them."
Follow the next steps in order:

### PID Tuning Flux & Torque
1. Start by autotuning the X stepper:
   ``````
   SET_STEPPER_ENABLE STEPPER=stepper_x
   TMC_TUNE_PID STEPPER=stepper_x
   M84
   ``````
   This will output a line like `PID stepper_x parameters: Kc=9.66 Ki=0.485`. It will also prompt you to save these values using `SAVE_CONFIG`. **Don't do this yet.**
   <br><br>Repeat the above steps for your Y motor:
   ``````
   SET_STEPPER_ENABLE STEPPER=stepper_y
   TMC_TUNE_PID STEPPER=stepper_y
   M84
   ``````
   This will output a line like `PID stepper_y parameters: Kc=9.76 Ki=0.481`. 
   <br><br>IIf your printer is a CoreXY system, make sure the values for X and Y are similar. **Pick the values for one motor and use them for both in the config.**
   <br><br>
2. Edit your config with these new values.   
   `Kc` is used for `foc_pid_flux_p` and `foc_pid_torque_p`. 
   `Kp` is used for `foc_pid_flux_p` and `foc_pid_torque_p`. 
   So if the line says ``PID stepper_x parameters: Kc=9.66 Ki=0.485`, these are the values to use in the config: 
   ``````ini
   foc_pid_flux_p: 9.66
   foc_pid_flux_i: 0.485
   foc_pid_torque_p: 9.66
   foc_pid_torque_i: 0.485
   ``````
   Edit both `[tmc4671]` sections with the correct PID values, save and `FIRMWARE_RESTART`.

---
### PID Tuning Velocity & Position
1. Check the datasheet of your encoder stepper motor to find its `Holding Torque` and `Rated Current` values. Different manufacturers use different units for `Holding Torque`, if the unit on your datasheet isn't `Nm`, you'll need to convert it to `Nm`.
   <br><br>Use this command to calculate PI values for velocity and position. Use the `Rated Current` in A as `HOLDING_CURRENT`.
   ``````
   TMC_TUNE_MOTION_PID LAMBDA_V=100 LAMBDA_P=400 HOLDING_CURRENT=2.5 HOLDING_TORQUE=0.055 STEPPER=stepper_x
   ``````
   `LAMBDA_V` and `LAMBDA_P` are measures of how aggressive the tuning will be. The default values are `LAMBDA_V`=100 and `LAMBDA_P`=400. We will try different values later. The command will also suggest filter frequencies, **ignore these for now.**
   <br><br>If your setup isn't CoreXY, repeat above instructions for `stepper_y`. For CoreXY, you should use the same values for both motors.
   <br><br>
   2. Edit your config with the values suggested by the algorithm, save and `FIRMWARE_RESTART`. 


    !!! warning "Make sure the motors aren't installed on your gantry yet. This is to avoid damage to your printer until everything is confirmed working."

3. Use this command to move your X motor to confirm it's moving fine:
   ``````
   FORCE_MOVE STEPPER=stepper_x DISTANCE=100 VELOCITY=50
   ``````
   Make sure:
      - It's moving.
      - It's moving smoothly.
      - It's not loud enough to suggest something isn't right. If it's loud but otherwise sounding "healthy", it's good. We will tune noise later.
      - The motor stops spinning in a few seconds.
      - Motor doesn't get really hot really fast.
   <br> 

    !!! success "Looks Good"
        If everything looks good, disable the motor using `M84`, then repeat the above for `stepper_y`. If that's good to, you can move on to the next step.
    !!! question "Motor moves fine, but doesn't stop after a few seconds"
        If everything seems good, except your stepper doesn't stop spinning after a few seconds, your `foc_abn_direction` value is wrong. If it's set to `0`, set it to `1`, or vice versa, then `FIRMWARE_RESTART` and try again.
    !!! failure "Fail"
        If the motor isn't moving, isn't moving smoothly, getting too hot really fast or sounding unhealthy, your velocity and position PID values are wrong. We need to try different lambda values and rerun `TMC_TUNE_MOTION_PID`. Make sure to use the correct `Holding Torque` and `Rated Current` values.
        ??? quote "Instructions"
            As stated earlier, lambda values are measures of how aggressive the tuning will be. The default values are usually ok for this step, but sometimes you may need to try different values.  
            <br>`LAMBDA_V` can go from 45 up, and `LAMBDA_P` should be at least twice `LAMBDA_V`, but can be much higher than that.
            Try different lambda values this time. Make sure to use the correct `HOLDING_CURRENT` and `HOLDING_TORQUE`values like before.
            ``````
            TMC_TUNE_MOTION_PID LAMBDA_V=100 LAMBDA_P=400 HOLDING_CURRENT=2.5 HOLDING_TORQUE=0.055 STEPPER=stepper_x
            ``````
            If your setup isn't CoreXY, repeat above for `stepper_y`. For CoreXY, you should use the same values for both motors. 
            <br><br>Edit your config with the values suggested by the algorithm, save and `FIRMWARE_RESTART`, then try `FORCE_MOVE STEPPER=stepper_x DISTANCE=100 VELOCITY=50` again. Try different lambda values until both your motors move healthily.

4. Once your motors are moving healthily, it's time to install them on your gantry. Power your printer off, mount your motors, do the belt tensioning, and power your printer back on. **Move both axis to roughly the middle by hand to avoid crashes if something goes wrong.**

5. Verify both endstops are working as expected, then try to home your X and Y axis. **Be ready to emergency stop** if something goes wrong. 

6. Once you verify that your printer can home and motors are moving in the correct direction, it's time to fine tune the velocity and position PI values.
   <br><br>
   As stated earlier, lambda values are measures of how aggressive the tuning will be. The default values are usually ok for this step, but sometimes you may need to try different values.  
   <br>`LAMBDA_V` can go from 45 up, and `LAMBDA_P` should be at least twice `LAMBDA_V`, but can be much higher than that.
   <br><br>Using the same command, try different lambda values until you're satisfied with the smoothness of the motion.  Make sure to use the correct `HOLDING_CURRENT` and `HOLDING_TORQUE`values like before. If the motors make noise at rest, increase the lambda values. If not, consider decreasing them; the minimum value that remains quiet at rest is likely also the optimal value.
   ``````
   TMC_TUNE_MOTION_PID LAMBDA_V=100 LAMBDA_P=400 HOLDING_CURRENT=2.5 HOLDING_TORQUE=0.055 STEPPER=stepper_x
   ``````
   <br>
   Once you're happy with your settings, we can move on to tuning the biquad filter.

---
### Biquad Filter Tuning
Biquad filter mostly helps with lowering the audible noise of your printer. So far, we had all 4 biquad filter frequencies set to `0`, which is off.  If you're happy with the noise level of your printer, you may skip this step.


1. The `TMC_TUNE_MOTION_PID` command we ran earlier would've suggested `biquad_velocity_frequency` and `biquad_torque_frequency` values. You can rerun the same command if yo don't remember the suggested values.<br><br>
   There's currently no way of autotuning `biquad_flux_frequency` or `biquad_position_frequency`. A good starting value for `biquad_flux_frequency` is about 400. You can leave `biquad_position_frequency` at 0.<br><br>
   Open your config file and edit your biquad filter values according to above. Remember to use the same values for both X and Y motors on a CoreXY setup. Save, then `FIRMWARE_RESTART`.<br><br>
2. Move your motors to see how they perform. **Be ready to emergency stop** if something goes wrong. Wrong biquad filter values can cause issues, which is why we left it off until now.<br><br>
   If frequencies are too high, the motor will make hissing noises while moving, if the frequencies are too low it will tend to make noise while stationary, and to round off corners when printing fast. Flux frequencies can be a lot lower than torque and velocity frequencies, as the flux current does not need to change as dynamically.<br><br>
3. Change these values until you're happy with the results.

---
### Print Speed & Acceleration Tuning
Unlike traditional stepper drivers, TMC4671 drivers won't skip steps if the motors can't do the motion you requested. Because they have encoders on the back, they can know exactly where the motor is, and they can compensate for skipped steps.

This is of course a very nice feature to have to avoid crashes, and failed prints. But this will come at the cost of print quality. What'll happen is, the motor will take a "shortcut" when printing a corner to catch up, resulting in lower print quality. Because of this, it's not a good idea to use a speed test macro like Ellis3D's macro to figure out your maximum print speeds. You will need to actually print with it to figure out IRL practical speeds and accelerations.

The FOC system used on Ouroboros, when tuned well, should reduce resonances originating on the stepper motor. This will help with print quality, just remember to recalibrate your `input_shaper`. It's also a good idea to recalibrate your `pressure_advance`.

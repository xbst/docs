---
title: Ouroboros Isik's Tech Encoder Stepper Setup
hide:
  - footer
---

# Ouroboros Isik's Tech Encoder Stepper Setup

This guide covers both the initial calibration and tuning of your TMC4671 setup, using values we use on our test setup to save you calibration time. If these values don't work for your setup, or if you want to further fine-tune them, check out the manual calibration document on this website.

**[Motor Datasheet](../Ouroboros-Stepper.pdf)**



### Config Values

!!! warning "Don't install motors on your gantry yet! We need to make sure the motors can move and stop fine before installing them."

Add the `[tmc4671]` sections to your config, then `FIRMWARE_RESTART`:

``````ini
[tmc4671 stepper_x]
# Ouroboros-specific Config
cs_pin: ouroboros:PD0
spi_bus: spi2
spi_speed: 2000000
current_scale_ma_lsb: 1.272

# TMC4671 Settings - Leave As-Is or Refer to Config Reference Page for More Info 
foc_pwm_sv: 0
foc_adc_i_ux_select: 0
foc_adc_i_v_select: 2
foc_adc_i_wy_select: 1
foc_phi_e_selection: 3
foc_position_selection: 9
foc_velocity_selection: 9

# Motor Info
foc_motor_type: 2
foc_n_pole_pairs: 50
run_current: 3.5
flux_current: 0.02
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
biquad_flux_frequency: 300
biquad_torque_frequency: 1200
biquad_velocity_frequency: 0
biquad_position_frequency: 0

[tmc4671 stepper_y]
# Ouroboros-specific Config
cs_pin: ouroboros:PD2
spi_bus: spi2
spi_speed: 2000000
current_scale_ma_lsb: 1.272

# TMC4671 Settings - Leave As-Is or Refer to Config Reference Page for More Info 
foc_pwm_sv: 0
foc_adc_i_ux_select: 0
foc_adc_i_v_select: 2
foc_adc_i_wy_select: 1
foc_phi_e_selection: 3
foc_position_selection: 9
foc_velocity_selection: 9

# Motor Info
foc_motor_type: 2
foc_n_pole_pairs: 50
run_current: 3.5
flux_current: 0.02
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
biquad_flux_frequency: 300
biquad_torque_frequency: 1200
biquad_velocity_frequency: 0
biquad_position_frequency: 0
``````

After restarting, use this command to move your X motor to confirm it's moving fine:

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
        If the motor isn't moving, isn't moving smoothly, getting too hot really fast or sounding unhealthy, your velocity and position PID values might be wrong. Try following the manual tuning document on this website (from the beginning). 


Once your motors are moving healthily, it's time to install them on your gantry. Power your printer off, mount your motors, do the belt tensioning, and power your printer back on. **Move both axis to roughly the middle by hand to avoid crashes if something goes wrong.**

Verify both endstops are working as expected, then try to home your X and Y axis. **Be ready to emergency stop** if something goes wrong. If it works well, you can move on to speed and acceleration tuning. If not, try following the manual tuning document on this website (from the beginning).



## Fine Tuning

Calibrate your input shaper and pressure advance.

Time to finally print!

Print some files at moderate speeds, accelerations and SCV, and gradually increase them until you hit your printer's limits. Currently this is the best way to determine maximum speeds, accelerations and SCV, as TMC4671 drivers won't skip steps if the motors can't do the motion you requested unlike traditional stepper drivers. They have encoders on the back, they know exactly where the motor is, and they compensate for skipped steps. This is of course a very nice feature to have to avoid crashes and failed prints, but this will come at the cost of print quality. What'll happen is, the motor will take a "shortcut" when printing a corner to catch up, resulting in lower print quality.

Based on your prints, you may want to do adjustments to your config values. Refer to the manual tuning document for info about how to edit these values.

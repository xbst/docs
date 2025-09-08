---
title: Ouroboros Isik's Tech Encoder Stepper Setup
hide:
  - footer
---

# Ouroboros Isik's Tech Encoder Stepper Setup

This guide covers both the initial calibration and tuning of your TMC4671 setup, using values we use on our test setup to save you calibration time. If these values don't work for your setup, or if you want to further fine-tune them, check out the manual calibration document on this website.

### PID & Biquad Filter values

!!! warning "Don't install motors on your gantry yet! We need to make sure the motors can move and stop fine before installing them."

Use these values for **both** motors, then save and `FIRMWARE_RESTART`:

``````ini
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

---
### Print Speed & Acceleration Tuning
Unlike traditional stepper drivers, TMC4671 drivers won't skip steps if the motors can't do the motion you requested. Because they have encoders on the back, they can know exactly where the motor is, and they can compensate for skipped steps.

This is of course a very nice feature to have to avoid crashes, and failed prints. But this will come at the cost of print quality. What'll happen is, the motor will take a "shortcut" when printing a corner to catch up, resulting in lower print quality. Because of this, it's not a good idea to use a speed test macro like Ellis3D's macro to figure out your maximum print speeds. You will need to actually print with it to figure out IRL practical speeds and accelerations.

The FOC system used on Ouroboros, when tuned well, should reduce resonances originating on the stepper motor. This will help with print quality, just remember to recalibrate your `input_shaper`. It's also a good idea to recalibrate your `pressure_advance`.

---

If you'd like to further tune your setup, manually tuning your PID values can help improve vibrations, noise, heat, speeds, accelerations and more. Check out the manual calibration document on this website for more info.

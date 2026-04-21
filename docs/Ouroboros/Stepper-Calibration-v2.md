---
title: Ouroboros Encoder Stepper Calibration
hide:
  - footer
---

# Ouroboros Encoder Stepper Manual Calibration

!!! info "This is a beta of a better manual tuning document (v2). Please let us know if you see any errors, or if you have any suggestions for improving it."

## FOC & PI Values

This guide covers calibrating PI values of X and Y motors of a Klipper 3D printer with closed loop FOC using Ouroboros and stepper motors with built-in encoders.

Field oriented control works works very differently than the typical stepper driver setup we're more used to on Klipper 3D printers, so the terminology here may be confusing. Basically we're using PI control loops for driving the stepper instead of fully powering it on at a time. When tuned well, this can help improve print quality by reducing resonances, allowing you to print high quality prints at higher speeds. Unfortunately this tuning takes more effort than a typical stepper driver, so expect this to take some time, with some trial and error.

Field oriented control (FOC) on TMC4671s use 4 separate PI loops to control your stepper motor:

- **Torque**: This is the PI loop and current that drives the motor by affecting how much torque it produces. This is what's making your motor move.
- **Flux**: Flux current is the current that's going into the motor that's not being used for creating torque. This PI loop tries to eliminate this wasted energy if flux current is set to zero.
- **Velocity**: This is the PI loop that determines how much torque to apply to make the motor move at the desired speed. 
- **Position**: This loop is used for position error correction (encoder position vs desired position). PI values determine how aggressively the error is corrected.

Each PI loop has these 2 variables:

- **Proportional**: This is the value that's making the biggest change in the output of the loop. Bigger number, faster response to error (current vs desired value), but if you go high, it will overshoot, over-correct in the other direction and oscillate until stable. P (proportional) reacts to the current error (offset), and cannot compensate for errors continuously being added to the control loop.
- **Integral**: Integral (I) keeps track of previous errors, and this way compensates for these continuous errors.

A good analogy for PI is, imagine a captain steering a ship. Captain first checks how far off course he is. If he's too far to the left, he'll steer to the right. This is what P does, and bigger number means he turns faster. Now imagine there's something continuously pushing the ship to the left, like cross-current. The captain needs to compensate for this, so he'll turn the wheel a bit further to the right. This is what I does.

<!--- Above is a simplified description FOC and PI parameters. For more information you can check out this (-----insert resource link-----) -->

!!! warning "Please read this document to the end and before attempting tuning, otherwise you may waste many frustrating hours."

### Torque (Quadrature Current)

This is the PI loop and current that drives the motor by affecting how much torque it produces. This is what's making your motor move, higher PI numbers will make your moves more "aggressive", great for high speed/acceleration printing. But it is possible to go too high.

#### Torque Current (`run_current`)

This should be set to 1.4 times your stepper motor's RMS current. This peak current will only be used briefly to make the motor move if/when needed when PI is tuned right.

#### PI Loop
| Value                  | Too High                                                     | Too Low                                                      |
| ---------------------- | ------------------------------------------------------------ | ------------------------------------------------------------ |
| P (`foc_pid_torque_p`) | If this value is too high, it can introduce a high-pitched whine and oscillations. You might see vibration marks on perimeters. In these cases you should try decreasing this value. | If this value is too low you might see overshoots on fast movements, or skipped steps. Increasing this value will make torque response faster. This should help with sharp corners, reducing overshoots. |
| I (`foc_pid_torque_i`) | If this value is too high it may introduce buzzing sounds and instability when steady. | If this value is too low, you may see your motor slowly lose position when steady when under load. The closed loop system (position loop) will then compensate for this, so you'll see it lose position, then do error correction. |

### Flux (Direct Current)

Flux control regulates the magnetic field alignment. Flux current is essentially the current that's going into the motor that's not being used for creating torque from misalignment of magnetic fields. Because of this, the goal is to keep the flux current at or near zero. PI control tries to achieve this. 

Poor flux tuning primarily causes excess heat in the motor and driver. You'll notice the motor running warm/hot even at low loads.

#### Flux Current (`flux_current`)

This should be set very low, ideally zero. The reason you may not want to set this at exactly zero is, while zero is the ideal value, and you're intentionally introducing some inefficiency when not set to zero, a small non-zero value provides a stabilizing preload, at the cost of slightly more heat. Try to aim for zero if you're able to.

#### PI Loop

| Value                | Too High                                                     | Too Low                                                      |
| -------------------- | ------------------------------------------------------------ | ------------------------------------------------------------ |
| P (`foc_pid_flux_p`) | If this value is too high, you might notice audible noise and heat. Remember that this is the current that's NOT being used to make the motor move, and energy does not simply disappear, it'll turn into heat and vibrations (noise). You should try to decrease this value if that is the case. | If you notice you're hitting a speed cap, or getting reduced torque output, increasing this value might help. |
| I (`foc_pid_flux_i`) | Too high I values will overshoot and oscillate, which can also cause overheating until flux current stabilizes. | If this value is too low, it'll slow the offset elimination (what I does in PI) of flux current. It'll waste power as heat with no torque benefit. If I is too slow, you're more likely to see increased heat when PI needs to act faster, like when doing rapid movements. |

### Velocity

This loop governs how smoothly and responsively the motor tracks speed changes.

#### PI Loop

| Value                    | Too High                                                     | Too Low                                                      |
| ------------------------ | ------------------------------------------------------------ | ------------------------------------------------------------ |
| P (`foc_pid_velocity_p`) | Speed will oscillate at target speed. You'll see ringing-like print artifacts when printing. | You may see jagged lines in your input shaper graphs. Motor may lag behind the target speed, resulting in rounded corners and other print defects. |
| I (`foc_pid_velocity_i`) | Speed oscillations may happen.                               | Motor may run slightly slower than commanded under load. This may be especially visible on long fast print segments. |

### Position

This loop takes position error and commands a velocity setpoint. This is what ultimately determines dimensional accuracy.

#### PI Loop

| Value                    | Too High                                                     | Too Low                                                      |
| ------------------------ | ------------------------------------------------------------ | ------------------------------------------------------------ |
| P (`foc_pid_position_p`) | Overshoots may happen, and may oscillate when stopping. You may hear a loud buzzing sound as well. | Large errors vs commanded position may occur, potentially resulting in rounded corners. Your print's dimensional accuracy will be off, you'll likely get smaller prints. |
| I (`foc_pid_position_i`) | You may want to keep this value at zero. If the I value is too high, you may get integral windup. This means the toolhead will overshoot a corner, realize it went too far, and hook backward to fix it, ruining your sharp edges. | You might get accumulated drift during prints, resulting in layers being slightly offset to one side. |

## FOC Tuning
FOC control loops are cascaded, so we need top tune them in a specific order. For example, if you tune Position P aggressively before the torque loop is stable, the instability compounds and you get violent oscillation.

Biquad filters (helps reduce audible noise) can influence motion, so they need to be tuned last, after figuring out all the PI values we need to figure out.

```
Position P/I  →  Velocity setpoint
                    ↓
              Velocity P/I  →  Torque setpoint
                                   ↓
                             Torque P/I  →  Iq (motor current)
                             Flux P/I    →  Id (= ~0 target)
```

We'll start by tuning flux and torque.

### Tuning Flux & Torque

!!! warning "Don't install motors on your gantry yet! We need to make sure the motors can move and stop fine before installing them."

1. Start by setting all your P values to `1`, all your I values to `0`, and turning your biquad filters off. Do this for both motors.
   ``````
   foc_pid_flux_p: 1
   foc_pid_flux_i: 0
   foc_pid_torque_p: 1
   foc_pid_torque_i: 0
   foc_pid_velocity_p: 1
   foc_pid_velocity_i: 0
   foc_pid_position_p: 1
   foc_pid_position_i: 0
   
   biquad_flux_frequency: 0
   biquad_torque_frequency: 0
   biquad_velocity_frequency: 0
   biquad_position_frequency: 0
   ``````

2. Power on your printer with motors not mounted on your gantry. Start by autotuning the X stepper:
   ``````
   SET_STEPPER_ENABLE STEPPER=stepper_x
   TMC_TUNE_PID STEPPER=stepper_x
   M84
   ``````
   This will output a line like `PID stepper_x parameters: Kc=9.66 Ki=0.485`. It will also prompt you to save these values using `SAVE_CONFIG`. **Don't do this yet.**

3. Repeat the above steps for your Y motor:
   ``````
   SET_STEPPER_ENABLE STEPPER=stepper_y
   TMC_TUNE_PID STEPPER=stepper_y
   M84
   ``````
   This will output a line like `PID stepper_y parameters: Kc=9.76 Ki=0.481`.  If your printer is a CoreXY system, make sure the values for X and Y are similar. **Pick the values for one motor and use them for both in the config.**

4. Edit your config with these new values.

   `Kc` is used for `foc_pid_flux_p` and `foc_pid_torque_p`. 

   `Ki` is used for `foc_pid_flux_i` and `foc_pid_torque_i`. 

   So if the line says ``PID stepper_x parameters: Kc=9.66 Ki=0.485`, these are the values to use in the config: 
   ``````ini
   foc_pid_flux_p: 9.66
   foc_pid_flux_i: 0.485
   foc_pid_torque_p: 9.66
   foc_pid_torque_i: 0.485
   ``````
   Edit both `[tmc4671]` sections with the correct PID values, save and `FIRMWARE_RESTART`.

5. Use this command to move your X motor to confirm it's moving fine:
   ``````
   FORCE_MOVE STEPPER=stepper_x DISTANCE=100 VELOCITY=50
   ``````
    Make sure:

    - It's moving.
    - It's moving smoothly.
    - It's not loud enough to suggest something isn't right. If it's loud but otherwise sounding "healthy", it's good. We will tune noise later.
    - The motor stops spinning in a few seconds.
    - Motor doesn't get really hot really fast.

    !!! success "Looks Good"
        If everything looks good, disable the motor using `M84`, then repeat the above for `stepper_y`. If that's good too, you can move on to the next step.
    !!! failure "Fail"
        If the motor isn't moving, isn't moving smoothly, getting too hot really fast or sounding unhealthy, either your torque and flux PI values are wrong, or your `foc_abn_direction` value is wrong. 
        

        Try reversing `foc_abn_direction` (if `1`, set to `0`, if `0`, set to `1`) first. `FIRMWARE_RESTART`, then repeat steps 2-5.
        
        If reversing `foc_abn_direction` didn't help, you may need to try different torque and flux PI values.

6. Turn off your printer, mount the motors on your gantry, with your toolhead toughly in the middle, and power back on.

7. Home X and Y. **Be ready to emergency stop** if something goes wrong.

    !!! failure "If your printer fails to home safely, you need to try different PI values for velocity PI before moving to the next step."

8. Move your toolhead to near, but not touching, a corner of your gantry. For example: `50, 50`

9. Determine a safe distance for your toolhead to travel. You should try to make sure you have sufficient buffer space in case it overshoots. For example, on a 350mm gantry, you might want to make it move 250mm. 50mm initial distance, plus 250mm movement, leaves 50mm in case of a overshoot. Figure this out for X and Y.

10. Mark this location on your gantry with a permanent marker on the linear rail, or some other location, for both X and Y.

11. Start slow, make your motors move this distance linearly (no corners yet), and see if there's any overshoot.

12. Gradually increase the speed until you reach the maximum speed you'll make the gantry move at. You can use your phone's slow motion camera when checking faster speeds.

13. Figure out if you need to adjust your torque and flux PI values. If there was overshoot, you likely need to. It is better to solve it now, before tuning velocity and position.

    ??? info "Needs Tuning"
        If you're currently using autotuned values, this is not uncommon. Unfortunately the autotuned values the TMC4671 Klipper plugin provides can be far from ideal. You will need to try different values if this is the case.
        
        Refer to the PI tuning information from earlier in this document for flux and torque. You will likely need to increase `foc_pid_torque_p`, but feel free to change the other 3 variables as well based on how your gantry performed. Usually you can safely double/halve the values without anything going wrong (other than performance possibly getting worse). Just keep an eye on your gantry and be ready to emergency stop just in case.
        
        Repeat steps 7-13 until you're satisfied with flux and torque values.

### Tuning Velocity & Position

1. Start by calculating these values using the default lambda values. Check the datasheet of your encoder stepper motor to find its `Holding Torque` and `Rated Current` values. Different manufacturers use different units for `Holding Torque`, if the unit on your datasheet isn't `Nm`, you'll need to convert it to `Nm`.

    Use this command to calculate PI values for velocity and position. Use the `Rated Current` in A as `HOLDING_CURRENT`.

      ``````
      TMC_TUNE_MOTION_PID LAMBDA_V=100 LAMBDA_P=400 HOLDING_CURRENT=2.5 HOLDING_TORQUE=0.055 STEPPER=stepper_x
      ``````
      `LAMBDA_V` and `LAMBDA_P` are measures of how aggressive the tuning will be. The default values are `LAMBDA_V`=100 and `LAMBDA_P`=400. We will try different values later. The command will also suggest filter frequencies, **ignore these for now.**
      <br><br>If your setup isn't CoreXY, repeat above instructions for `stepper_y`. For CoreXY, you should use the same values for both motors.
      <br>

2. Edit your config with the values suggested by the algorithm, save and `FIRMWARE_RESTART`. 
3. Home X and Y. **Be ready to emergency stop** if something goes wrong.

4. Move your toolhead to near, but not touching, a corner of your gantry. Use the same location as before. We'll do the same test to start.
5. Start slow, make your motors move this distance linearly (no corners yet), and see if there's any overshoot.
6. Gradually increase the speed until you reach the maximum speed you'll make the gantry move at. You can use your phone's slow motion camera when checking faster speeds.
7. Run an input shaper test. Check the graph to see if the lines are smooth. If not, you may need to increase `velocity_p`.

    ??? info "Needs Tuning"
        You need to change velocity and position PI values. Start by optimizing velocity values, position should be tuned last. You can refer to the PI tuning information from earlier in this document for velocity and position to see what you may need to change.
        
    
        You can manually change these values, or use the algorithm we used earlier and change the lambda values to try to get a change in the right direction. Lambda values are measures of how aggressive the tuning will be. The default values didn't work well for you, so now you can try different values.
        
        `LAMBDA_V` can go from 45 up, and `LAMBDA_P` should be at least twice `LAMBDA_V` (typically 3-5x), but can be much higher than that.
        
        Try different lambda values this time. Make sure to use the correct `HOLDING_CURRENT` and `HOLDING_TORQUE`values like before.
        ``````
        TMC_TUNE_MOTION_PID LAMBDA_V=100 LAMBDA_P=400 HOLDING_CURRENT=2.5 HOLDING_TORQUE=0.055 STEPPER=stepper_x
        ``````
        If your setup isn't CoreXY, repeat above for `stepper_y`. For CoreXY, you should use the same values for both motors. Again, ignore the biquad filter values for now.
        
        Edit your config with the values suggested by the algorithm, save and `FIRMWARE_RESTART`, then try again.

### Tuning Biquad Filter

Your printer is pretty loud currently, right? Time to fix that.

You can either manually tune `biquad_torque_frequency` and `biquad_flux_frequency`, or use the calculated values if you used the `TMC_TUNE_MOTION_PID` method for calculating velocity and position PI values. It's recommended to leave `biquad_velocity_frequency` and `biquad_position_frequency` at `0`, as they can introduce problems.

If you're manually tuning, this paragraph from the [TMC4671 Klipper plugin repo](https://github.com/andrewmcgr/tmc-4671) may be helpful:

For tuning `biquad_torque_frequency` and `biquad_flux_frequency` adjust the digital filters for current measurement. Reasonable values range from about 40 Hz to about 5000 Hz, with most NEMA 17 motors liking values near 1600 Hz for torque and 800 Hz for flux. If the frequency is too high, the motor will make hissing noises while moving, if the frequency is too low it will tend to make noise while stationary, and to round off corners when printing fast. Flux frequencies can be a lot lower than torque frequencies, as the flux current does not need to change as dynamically.

Change your biquad filter values, save then `FIRMWARE_RESTART`. Test if your printer still moves well, and if it's quiet now. If not, you may need to adjust these values.

### Fine Tuning

Calibrate your input shaper and pressure advance.

Time to finally print!

Print some files at moderate speeds, accelerations and SCV, and gradually increase them until you hit your printer's limits. Currently this is the best way to determine maximum speeds, accelerations and SCV, as TMC4671 drivers won't skip steps if the motors can't do the motion you requested unlike traditional stepper drivers. They have encoders on the back, they know exactly where the motor is, and they compensate for skipped steps. This is of course a very nice feature to have to avoid crashes and failed prints, but this will come at the cost of print quality. What'll happen is, the motor will take a "shortcut" when printing a corner to catch up, resulting in lower print quality.

Based on your prints, you may want to do minor adjustments to your PI values. Refer to the earlier PI tuning information in this document to see how you should change these values. If you end up having to do a major adjustment to your torque and flux PI values, you should redo your velocity and position PI value and biquad filter tuning. If you do a major adjustment to your velocity and position PI values, you should redo your biquad filter tuning.

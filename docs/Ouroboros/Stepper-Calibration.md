---
title: Ouroboros Encoder Stepper Calibration
hide:
  - footer
---

# Ouroboros Encoder Stepper Calibration

!!! info "Beta Document"
    This is a beta of an improved manual tuning document using many of the recent (as of 27 JUN 2026) additions to the TMC4671 Klipper plugin. The plugin is updated frequently, so this page may lag behind the plugin's code. If something here doesn't work, the [plugin README](https://github.com/andrewmcgr/tmc-4671) may help.
    
    Previous docs are still available, but keep in mind they are outdated and will be removed soon:
    
    - [Manual Stepper Calibration](./Beta1-Stepper-Calibration.md)
    - [Isik's Tech Stepper Presets](./IT.md)

This guide covers setting up and tuning Ouroboros with closed-loop FOC stepper motors using the plugin's built-in board and motor profiles, and the plugin's automatic startup tuning.

If you have BLDC motors, follow the BLDC document instead. (coming soon)

## Before You Start

You need:

- Ouroboros installed in your printer and wired up. See the [Mount & Wiring](../wiring/) page.
- The TMC4671 plugin installed. See the [Firmware Setup](../Firmware-Setup/) page.
- Encoder steppers physically connected to Ouroboros (phase wires + encoder cable), but **not mounted on your gantry yet**. We'll mount them after the first round of tuning.

This guide defaults to **Ouroboros Steppers**. If you have a different motor, you can find more info about using other steppers in the [Other Motors](#other-motors) section at the bottom of this page. Just replace `Ouroboros_Stepper` with your motor in the config.

**[Ouroboros Stepper Datasheet](../Ouroboros-Stepper.pdf)**

## What the Tuning Is Doing

Field-Oriented Control (FOC) uses four cascaded PI control loops to drive the motor:

```
Position P/I  →  Velocity setpoint
                    ↓
              Velocity P/I  →  Torque setpoint
                                   ↓
                             Torque P/I  →  Iq (motor current that produces motion)
                             Flux P/I    →  Id (motor current target = 0)
```

Tuning means finding the right Proportional (P) and Integral (I) gains for each loop. Wrong gains mean the motor either responds too slowly (sluggish, lags behind your moves) or too aggressively (overshoots, oscillates, makes noise). Good news: the plugin can compute these gains for you automatically.

??? info "More about PI loops (optional reading)"
    Each PI loop has two parameters:

    - **Proportional (P)** is the value that's making the biggest change in the output. Bigger number = faster response to error, but if it's too high it will overshoot, over-correct in the other direction, and oscillate until stable.
    - **Integral (I)** keeps track of accumulated past error, so it can compensate for a steady-state offset (e.g. constant load) that P alone can't fix.
    
    Analogy: a captain steers a ship. If it's drifting left, he steers right to compensate — this is P. If a steady crosswind keeps pushing the ship left, he holds the wheel slightly right of center indefinitely — this is I.
    
    The four loops in order of nesting:
    
    - **Torque** (Iq): the current that actually produces motion. Tuning affects how snappy your accelerations are.
    - **Flux** (Id): current that *doesn't* produce motion, wasted as heat. Target is zero. Tuning affects how well the loop suppresses unwanted flux current.
    - **Velocity**: how the motor tracks speed changes. Tuning affects smoothness and corner behavior.
    - **Position**: how the motor corrects position error. Tuning affects dimensional accuracy.
    
    The loops are cascaded: position outputs a velocity target, velocity outputs a torque target, torque outputs a current. If an inner loop is unstable, all the outer ones will be too. That's why tuning order matters — and why the plugin does them in that order automatically.

## Step 1: Config

Add the following to your `printer.cfg`. The `board_profile: Ouroboros` and `motor_profile: Ouroboros_Stepper` lines pull in all the hardware-specific defaults so you don't have to enter them manually. You can find a list of these hardware-specific parameters in the `TMC4671 Plugin Reference`.

```ini
[tmc4671 stepper_x]
cs_pin: ouroboros:PD0
spi_bus: spi2
spi_speed: 2000000
board_profile: Ouroboros
motor_profile: Ouroboros_Stepper
tune_current_pid: True
tune_motion_pid: True

[tmc4671 stepper_y]
cs_pin: ouroboros:PD2
spi_bus: spi2
spi_speed: 2000000
board_profile: Ouroboros
motor_profile: Ouroboros_Stepper
tune_current_pid: True
tune_motion_pid: True
```

The two `tune_*_pid: True` options tell the plugin to automatically run its tuning routines every time Klipper starts. The first time it runs, the staged values will be empty in your config; after `SAVE_CONFIG` they're saved and re-applied on every boot. You can turn these off later if you want fully stable values (see [Disabling Autotune](#disabling-autotune)).

Save your config and `FIRMWARE_RESTART`.

## Step 2: Let the Plugin Tune

When Klipper restarts:

1. The plugin measures motor resistance and inductance by injecting brief test currents into the windings. The motor will buzz quietly for a second or two — this is normal.
2. The plugin computes flux/torque PI gains analytically from the measured electrical properties (this is `tune_current_pid` doing its thing).
3. The plugin computes velocity/position PI gains from the motor profile's physics parameters (this is `tune_motion_pid`).
4. All four sets of PI gains, plus the matching biquad filter cutoff frequencies, are written directly to the TMC4671, so motors are now running with the autotuned values. The same values are also queued for `SAVE_CONFIG`, which is how they get persisted across the next restart (see Step 4).

You'll see a notice in the web interface that there are pending config updates. **Don't save yet.**

## Step 3: Verify the Motors Move

With motors still **not mounted on the gantry**, test each one in turn:

```
SET_STEPPER_ENABLE STEPPER=stepper_x
FORCE_MOVE STEPPER=stepper_x DISTANCE=100 VELOCITY=50
M84
```

Check:

- It's moving.
- It's moving smoothly.
- It stops when commanded (the motor shaft holds position after the move completes, until `M84`).
- It's not getting hot quickly.
- It's not making a really loud or grinding noise. Some hiss or whine is normal at this stage — we'll quiet it down by the end.

!!! success "Looks Good"
    Repeat for `stepper_y`. If both motors are happy, continue.

!!! failure "Motor doesn't move, runs rough, or overheats"
    The most common cause is that your encoder's direction doesn't match the motor's direction. The `Ouroboros_Stepper` profile sets `foc_abn_direction: 1`. If your motor isn't behaving, try overriding it:

    ```ini
    [tmc4671 stepper_x]
    # ... your existing config ...
    foc_abn_direction: 0
    ```
    
    `FIRMWARE_RESTART` and test again. If that also doesn't work, double-check your encoder cable wiring against the [Mount & Wiring](../wiring/) page — an A↔B swap or polarity inversion will produce these symptoms.

## Step 4: Save & Mount

Run `SAVE_CONFIG`. Klipper will write the autotuned values into your `printer.cfg` and restart. With `tune_current_pid: True` still set, the plugin will autotune again on this restart. You can disable this later, as covered in the [Disabling Autotune](#disabling-autotune) section below.

Power off, mount the motors on your gantry with belts, then power back on.

## Step 5: Home and Test Moves

1. Home X and Y. **Be ready to emergency stop** in case the gantry doesn't behave.

2. Move your toolhead to near, but not touching, a corner of your gantry. For example: `50, 50`
3. Determine a safe distance for your toolhead to travel. You should try to make sure you have sufficient buffer space in case it overshoots. For example, on a 350mm gantry, you might want to make it move 250mm. 50mm initial distance, plus 250mm movement, leaves 50mm in case of an overshoot. Figure this out for X and Y.
4. Mark this location on your gantry with a permanentStart slow, make your motors move this distance linearly (no corners yet), and see if there's any overshoot.
5. Gradually increase the speed until you reach the maximum speed you'll make the gantry move at. You can use your phone's slow motion camera when checking faster speeds. marker on the linear rail, or some other location, for both X and Y.

Look for:

- Smooth motion at all speeds.
- No overshoot at end-of-move.
- No buzzing, screeching, or grinding.

If everything looks good, you're done with basic tuning. Move on to the next section.

!!! failure "Overshoots, oscillation, or loud noise"
    The autotuned values may need to be adjusted. Jump to [Manual Adjustment](#manual-pi-adjustment) below.

## Disabling Autotune

Keeping `tune_current_pid` and `tune_motion_pid` enabled means the plugin re-tunes every Klipper restart, using whatever the motor measures look like that day. There will be slight variance to these measurements. 

There's no harm to keeping this enabled, it can even help compensate for drifting values or act as a warning if something goes wrong (if you see very different values, or sounds different at startup). However this also means your PI values and therefore your system's performance will slightly vary from restart to restart, and you'll see a prompt to `SAVE_CONFIG` every time.

To disable autotune: change both options to `False` in both `TMC4671` sections:

```ini
tune_current_pid: False
tune_motion_pid: False
```

`FIRMWARE_RESTART`. The plugin will keep using your saved PI values without re-tuning.

## Fine Tuning

Most users get good enough results from the autotune output that no further work is needed. If you want to push performance further:

### Input shaper & Pressure Advance

You should recalibrate input shaper and pressure advance. Ignore the maximum accelerations shown with the input shaper graphs, these values assume a regular stepper driver, you will need to print with your printer to figure out the actual maximum accelerations and speeds.

### Finding Maximum Speeds & Accelerations

Print some files at moderate speeds, accelerations and SCV, and gradually increase them until you hit your printer's limits. Currently this is the best way to determine maximum speeds, accelerations and SCV, as TMC4671 drivers won't skip steps if the motors can't do the requested motion unlike traditional stepper drivers. They have encoders on the back, they know exactly where the motor is, and they compensate for skipped steps. This is of course a very nice feature to have to avoid crashes and failed prints, but this will come at the cost of print quality. They'll "cheat" by taking shortcuts on corners or letting the toolhead lag, and this will be visible on prints.

## Manual PI Adjustment

If autotuning doesn't give you good behavior, here's the lookup table for tweaking each PI value. **Tune in this order: torque → flux → velocity → position.** Changing an inner loop usually requires re-tuning the outer loops on top of it.

### Torque (driving current)

This is what produces motion. Higher gains = more aggressive moves.

| Value                  | Too High                                           | Too Low                                                      |
| ---------------------- | -------------------------------------------------- | ------------------------------------------------------------ |
| P (`foc_pid_torque_p`) | High-pitched whine, vibration marks on perimeters. | Overshoots on fast moves. Increasing helps with sharp corners. |
| I (`foc_pid_torque_i`) | Buzzing when stationary, instability.              | Motor slowly loses position under static load (the position loop will correct it, but you'll see the wobble). |

### Flux (wasted current)

Flux current should ideally be zero. PI here tries to keep it there.

| Value                | Too High                                                     | Too Low                                                      |
| -------------------- | ------------------------------------------------------------ | ------------------------------------------------------------ |
| P (`foc_pid_flux_p`) | Audible noise, motor running hot for no reason.              | Reduced top speed or torque output.                          |
| I (`foc_pid_flux_i`) | Overshoots and oscillates, causes heat during stabilization. | Slow elimination of flux error, more heat during rapid moves. |

### Velocity

Tracks commanded speed.

| Value                    | Too High                                                     | Too Low                                                      |
| ------------------------ | ------------------------------------------------------------ | ------------------------------------------------------------ |
| P (`foc_pid_velocity_p`) | Speed oscillates at target. Ringing-like print artifacts.    | Jagged input shaper graphs. Lags behind target speed → rounded corners. |
| I (`foc_pid_velocity_i`) | Speed oscillations.                                          | Slightly slower than commanded under load — visible on long, fast print segments. |

### Position

Final position accuracy.

| Value                    | Too High                                                     | Too Low                                                      |
| ------------------------ | ------------------------------------------------------------ | ------------------------------------------------------------ |
| P (`foc_pid_position_p`) | Overshoots, oscillates on stops. Loud buzzing.               | Large position error → rounded corners, smaller prints than commanded. |
| I (`foc_pid_position_i`) | Integral windup: overshoots corners then hooks back to fix them, ruining sharp edges. Best left at 0. | Accumulated drift during prints → slightly offset layers.    |

### Workflow

1. Disable startup autotuning (`tune_current_pid: False`, `tune_motion_pid: False`) so your edits aren't overwritten.
2. Change one or two PI values at a time.
3. `FIRMWARE_RESTART`.
4. Test moves and listen / watch for the symptoms in the tables.
5. Adjust again.

You can also use the plugin's tuning commands by hand — see the [Plugin Reference](../gibberish/) page for `TMC_TUNE_PID`, `TMC_TUNE_MOTION_PID`, and the per-loop `BANDWIDTH` parameters.

### Live biquad tuning

Biquad filter frequencies smooth out the measured currents and velocity. The autotune sets them to reasonable values, but you can experiment live (no restart required) with `SET_TMC_BIQUAD_FILTER`. See the [Plugin Reference](../gibberish/) for details. Rough guidance:

- `biquad_flux_frequency`: around 800 Hz for typical NEMA-17.
- `biquad_torque_frequency`: around 1600 Hz.
- `biquad_velocity_frequency`: matches the velocity loop bandwidth (around 450 Hz default).
- `biquad_position_frequency`: leave at 0.

Too high → hissing noises during motion. Too low → noise at rest and rounded corners at speed.

## Other Motors

### LDO motors

If you have LDO 2504b-EN1000 steppers instead, just change the motor profile:

```ini
motor_profile: LDO_2504b-EN1000
```

Everything else in the config above stays the same.

### Custom motors

If you have a stepper that doesn't match either built-in profile, define your own profile from your motor's datasheet:

```ini
[foc_motor my_stepper]
motor_type: 2                 # 2 means this is a stepper motor
n_pole_pairs: 50              # 50 for any standard 1.8° NEMA stepper
rated_current: 2.0            # A RMS, from datasheet
holding_current: 2.0          # A, usually same as rated_current
holding_torque: 0.0555        # Nm, from datasheet (convert from N·cm or kg·cm if needed)
jmotor: 8.2e-6                # Rotor inertia, from datasheet (example value is 82g·cm2 in datasheet)
abn_decoder_ppr: 4000         # 4 × encoder CPR (e.g. 1000 line quadrature optical encoder = 4000)
abn_direction: 0              # try 0 first; if motor misbehaves, change to 1

[tmc4671 stepper_x]
...
motor_profile: my_stepper
...
```

The motor profile sets defaults for the matching `[tmc4671]` fields, so the rest of the setup follows the same flow as the rest of this page.

---
title: Ouroboros Sensorless Homing
hide:
  - footer
---

# Ouroboros Sensorless Homing

!!! info "Plugin getting frequent updates"
    The TMC4671 Klipper plugin is updated frequently. This page may lag behind the plugin's code. If something here doesn't work, the [plugin README](https://github.com/andrewmcgr/tmc-4671) may help. Updated 23 JUN 2026

!!! warning "Untested as of 23 JUN 2026"
    At the moment the information here is untested. We will test and improve this document as soon as we're able to. 

## How it works

When the TMC4671 detects that the motor's velocity PI loop is demanding more current than the configured `homing_current` allows — i.e. the motor has hit something — it raises its `STATUS` output pin. On Ouroboros, the `STATUS` outputs of both TMC4671 chips are wired to MCU GPIOs (PE2 for X, PA2 for Y), so Klipper can use them as virtual endstops.

Detection happens within ~40 µs of contact (a few PWM cycles), which is fast enough to stop the homing move before any meaningful mechanical force builds up.

## Hardware

On Ouroboros, the `STATUS` pins from both TMC4671 chips are already wired to the MCU:

| Motor | STATUS pin |
| ----- | ---------- |
| X     | PE2        |
| Y     | PA2        |

No additional wiring is needed.

## Config

In your `[tmc4671 stepper_x]` and `[tmc4671 stepper_y]` sections, add the `diag_pin` and `homing_current`:

```
[tmc4671 stepper_x]
# ... your existing config ...
diag_pin: ^ouroboros:PE2
homing_current: 0.5

[tmc4671 stepper_y]
# ... your existing config ...
diag_pin: ^ouroboros:PA2
homing_current: 0.5
```

In your `[stepper_x]` and `[stepper_y]` sections, change the `endstop_pin` to the virtual endstop and make sure `homing_retract_dist` is **not zero**:

```
[stepper_x]
# ... your existing config ...
endstop_pin: tmc4671_stepper_x:virtual_endstop
homing_retract_dist: 5

[stepper_y]
# ... your existing config ...
endstop_pin: tmc4671_stepper_y:virtual_endstop
homing_retract_dist: 5
```

!!! warning "`homing_retract_dist` must not be 0"
    With sensorless homing, the `STATUS` pin stays high after contact because the stall flags are still latched from the previous bump. If `homing_retract_dist` is 0, the carriage stays at the hard stop and the next G28 sees no rising edge to trigger on — the homing move won't stop on contact and you'll crash. Set `homing_retract_dist` to at least 3–5 mm.

`FIRMWARE_RESTART` after editing.

## Tuning `homing_current`

During homing, the TMC4671's torque/flux current limit is temporarily reduced from `run_current` to `homing_current`. The velocity PI loop tries to maintain the commanded homing speed. As long as the carriage is moving freely, the demanded current is only what's needed to overcome friction and inertia, which is well below `homing_current`. When the carriage hits the hard stop, the velocity error spikes, the PI loop demands maximum current immediately — and the moment that demand exceeds `homing_current`, the `STATUS` pin fires.

The right value is **just above the peak current the motor needs during a normal free homing move.**

### Starting point

Start with `homing_current: 0.5`.

- If homing triggers **before** the carriage reaches the hard stop (false trigger during free motion): increase in 0.1–0.25 A steps until false triggers stop.
- If homing doesn't trigger reliably on contact, or pushes hard into the hard stop before stopping: that's normally a sign of homing_current set too high. Decrease it.
- **Do not set it to `run_current`.** At full rated current the motor pushes hard into the hard stop before stopping, stressing the frame and the mechanical endstop unnecessarily.

A typical working range for NEMA-17 steppers at homing speeds up to 100 mm/s is **0.5–1.5 A.** Heavier carriages or faster homing speeds need more.

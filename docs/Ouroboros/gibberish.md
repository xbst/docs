---
title: TMC4671 Plugin Reference
hide:
  - footer
---

# TMC4671 Plugin Reference

## G-Code Commands
### Tuning Commands

Please refer to the tuning docs for more info about how to use these.

!!! info "Manual tuning docs aren't yet updated for the S-IMC change to `TMC_TUNE_PID`"

#### `TMC_TUNE_PID`

Autotunes the flux and torque PI gains. Two methods are available:

```
TMC_TUNE_PID STEPPER=stepper_x [CURRENT_BANDWIDTH=<hz>] [SIMC=<0|1>] [CHECK=<0|1>] [DERATE=<factor>]
```

| Parameter           | Default | Description                                                  |
| ------------------- | ------- | ------------------------------------------------------------ |
| `CURRENT_BANDWIDTH` | 1800.0  | Target closed-loop current bandwidth in Hz. Higher values give faster response but more noise. Used by the default (bandwidth) method. |
| `SIMC`              | 0       | When `1`, uses the S-IMC setpoint-change experiment to fit a first-order-plus-dead-time model. Slower but can be more accurate. Requires the motor to be active. |
| `CHECK`             | 0       | When `SIMC=1`, tests the *existing* gains in your config instead of computing from scratch. |
| `DERATE`            | 1.6     | When `SIMC=1`, initial gain derate factor for the experiment. |

The default (bandwidth) method derives P and I analytically from the auto-measured R and L. Results are queued for `SAVE_CONFIG`.

Output example: `PID stepper_x parameters: Kc=9.66 Ki=0.485`

#### `TMC_TUNE_MOTION_PID`

Autotunes velocity and position PI gains using S-IMC. Results are queued for `SAVE_CONFIG`.

```
TMC_TUNE_MOTION_PID STEPPER=stepper_x KT=<nm/a> [LAMBDA_V=<val>] [LAMBDA_P=<val>]
TMC_TUNE_MOTION_PID STEPPER=stepper_x HOLDING_CURRENT=<a> HOLDING_TORQUE=<nm> [LAMBDA_V=<val>] [LAMBDA_P=<val>]
```

| Parameter         | Default | Description                                                  |
| ----------------- | ------- | ------------------------------------------------------------ |
| `KT`              | —       | Motor torque constant in Nm/A.                               |
| `HOLDING_CURRENT` | —       | Rated holding current in A (alternative to `KT`).            |
| `HOLDING_TORQUE`  | —       | Rated holding torque in Nm (alternative to `KT`).            |
| `LAMBDA_V`        | 100.0   | Velocity loop closed-loop time constant. Smaller = faster and noisier. |
| `LAMBDA_P`        | 400.0   | Position loop closed-loop time constant. Should be at least 2× `LAMBDA_V`. |

Also suggests biquad filter frequencies but does not apply them.

#### `INIT_TMC`

Re-initialize all TMC4671 registers from the config and re-run ADC offset calibration. Useful after a power glitch without doing a full Klipper restart.

```
INIT_TMC STEPPER=stepper_x
```

#### `SET_TMC_CURRENT`

Get or set the run current limit.

```
SET_TMC_CURRENT STEPPER=stepper_x [CURRENT=<amps>]
```

Without `CURRENT`, reports the currently active limit. With `CURRENT`, updates the `PID_TORQUE_FLUX_LIMITS` register immediately. The change is **not** persisted — restore by editing your config and `SAVE_CONFIG`.

#### `SET_TMC_BIQUAD_FILTER`

Configure a biquad filter on the fly, without a restart. Useful for finding good biquad frequencies during manual tuning.

```
SET_TMC_BIQUAD_FILTER STEPPER=stepper_x FILTER=<target> [FREQUENCY=<hz>] [TYPE=<type>] [SLOPE=<q>]
```

| Parameter   | Values                                   | Description                                     |
| ----------- | ---------------------------------------- | ----------------------------------------------- |
| `FILTER`    | `flux`, `torque`, `velocity`, `position` | Which signal path to filter.                    |
| `FREQUENCY` | 0 – 100000000                            | Cutoff frequency in Hz. 0 disables the filter.  |
| `TYPE`      | `lpf`, `notch`, `apf`                    | Filter topology. Default: `lpf`.                |
| `SLOPE`     | any positive float                       | Q factor / slope. Default: 0.707 (Butterworth). |

#### `SET_TMC_FIELD`

Read or write any TMC4671 register field by name. For advanced users who know what they're doing.

```
SET_TMC_FIELD STEPPER=stepper_x FIELD=<name> [VALUE=<int>|FVAL=<float>]
```

Without `VALUE` or `FVAL`, reads and prints the current value of the field. `FVAL` uses the field's configured floating-point converter (e.g. for PID coefficients).

### Debug & Inspection Commands

#### `TMC_DEBUG_MOTOR`

Reports the motor resistance and inductance measured during the last startup alignment. If the driver has not yet aligned (e.g. immediately after `FIRMWARE_RESTART`, before `ready`), the command says so.

```
TMC_DEBUG_MOTOR STEPPER=stepper_x
```

#### `TMC_DEBUG_VOLTAGE`

Reports the motor supply voltage (VM) and the FOC d/q axis voltages, in both raw counts and volts.

```
TMC_DEBUG_VOLTAGE STEPPER=stepper_x
```

#### `TMC_DEBUG_CURRENT`

Reports phase currents, FOC target and actual d/q axis currents, and the active current limit.

```
TMC_DEBUG_CURRENT STEPPER=stepper_x
```

#### `TMC_DEBUG_TUNING`

Reports what the PID tuning helpers *would* compute given the current motor parameters, without writing anything to the controller. Compares the computed values against the currently active register values.

```
TMC_DEBUG_TUNING STEPPER=stepper_x [CURRENT_BANDWIDTH=<hz>] [LAMBDA_V=<val>] [LAMBDA_P=<val>] [KT=<nm/a>] [R=<ohm>] [L=<henry>]
TMC_DEBUG_TUNING STEPPER=stepper_x HOLDING_CURRENT=<a> HOLDING_TORQUE=<nm> [...]
```

| Parameter                            | Default | Description                                                  |
| ------------------------------------ | ------- | ------------------------------------------------------------ |
| `CURRENT_BANDWIDTH`                  | 1800.0  | Bandwidth in Hz for the current PID calculation.             |
| `LAMBDA_V`                           | 100.0   | Velocity loop time constant for the motion PID calculation.  |
| `LAMBDA_P`                           | 400.0   | Position loop time constant for the motion PID calculation.  |
| `KT`                                 | —       | Motor torque constant in Nm/A (required for motion PID section). |
| `HOLDING_CURRENT` + `HOLDING_TORQUE` | —       | Alternative way to supply Kt.                                |
| `R`                                  | —       | Override motor winding resistance in Ω. Defaults to the auto-measured value. |
| `L`                                  | —       | Override motor winding inductance in H. Defaults to the auto-measured value. |

If R and L haven't been measured yet, the current PID section says so instead of computing. Providing `R` or `L` overrides the measured value for the computation without changing what's stored — useful for "what-if" exploration.

#### `TMC_DEBUG_MOVE`

Runs a raw motion test in a chosen mode. The motor must be free to move. Results are logged to the Klipper log.

```
TMC_DEBUG_MOVE STEPPER=stepper_x <VELOCITY=<int>|TORQUE=<int>|POSITION=<int>|OPENVEL=<int>>
```

| Parameter  | Description                                             |
| ---------- | ------------------------------------------------------- |
| `VELOCITY` | Target in velocity-mode raw units.                      |
| `TORQUE`   | Target in torque-mode raw units.                        |
| `POSITION` | Target in position-mode raw units.                      |
| `OPENVEL`  | Open-loop velocity in raw units (no position feedback). |

#### `DUMP_TMC`

Read and display TMC4671 registers, grouped by function.

```
DUMP_TMC STEPPER=stepper_x [GROUP=<name>|REGISTER=<name>|FIELD=<name>]
```

Available groups: `default`, `hall`, `abn`, `adc`, `aenc`, `pwm`, `pidconf`, `pid`, `step`, `filters`. Without arguments, dumps the `default` group.


## Config Reference

| Parameter                                                    | Description                                                  | Note                                                         |
| ------------------------------------------------------------ | ------------------------------------------------------------ | ------------------------------------------------------------ |
| cs_pin                                                       | The pin number for the SPI chip select pin.                  | The correct value for Ouroboros is provided on the motor setup guides. |
| spi_bus                                                      | The name of the SPI bus TMC4671 is connected to on the MCU.  | The correct value is spi2 for Ouroboros.                     |
| spi_speed                                                    | The speed of the SPI bus.                                    | Should not be edited.                                        |
| current_scale_ma_lsb                                         | TMC4671 relies on external (not built-into the TMC4671 chip) current sense sensors. This setting is for setting how much sense voltage varies, based on the current sense setup used on the PCB. | The correct value is 1.272 for Ouroboros.                    |
| run_current                                                  | This is the peak current used by the TMC4671 driver to make the motor move. <br/> Unlike common Klipper stepper drivers, this isn't RMS current, it's peak current, so higher values are needed here. | For stepper motors, recommended starting value is 1.4 times the rated current of the stepper motor, as specified on its datasheet. For example, if the rated current of the stepper motor is 2.5A on its datasheet, a good starting value for run_current is **3.5A**. For BLDC, calculate this from the peak power dissipation, if no rated current is given, then multiply by 2.8. |
| flux_current                                                 |                                                              |                                                              |
| foc_motor_type                                               | This is used to let TMC4671 know what type of motor is connected to it. | 1: Single-Phase DC<br />2: Two-Phase Stepper<br />3: Three-Phase BLDC |
| foc_n_pole_pairs                                             | This is the number of pole pairs the motor connected to TMC4671 has. | For 1.8° stepper motors, the correct value is 50.            |
| foc_pwm_sv                                                   | Setting this to 1 enables space vector PWM.                  | Leave at 0 (off).                                            |
| foc_adc_i_ux_select<br />foc_adc_i_v_select<br />foc_adc_i_wy_select | Refer to the TMC4671 datasheet for more information.         |                                                              |
| phi_e_selection                                              | This is used to select an angle signal for FOC transformation as electrical angle of the motor. You'll need to change this if you're using a different type of encoder. | 1: External<br />2: Open loop <br />3: AB / ABN <br />5: Hall effect<br />There are more options. Refer to the TMC4671 datasheet for more information. |
| foc_position_selection                                       | This is used to select an angle signal for the position calculation and control loop. | 1: External<br />2: Open loop <br />3: AB / ABN - Electrical Angle<br />5: Hall effect - Electrical Angle<br />9: AB / ABN - Mechanical Angle<br />12: Hall effect - Mechanical Angle<br />There are more options. Refer to the TMC4671 datasheet for more information. |
| foc_velocity_selection                                       | This is used to select an angle signal for the velocity control loop and velocity calculation. This selects the velocity source for velocity measurement. | 1: External<br />2: Open loop <br />3: AB / ABN - Electrical Angle<br />5: Hall effect - Electrical Angle<br />9: AB / ABN - Mechanical Angle<br />12: Hall effect - Mechanical Angle<br />There are more options. Refer to the TMC4671 datasheet for more information. |
| foc_abn_decoder_ppr                                          | This is based on your motor's encoder's PPR.                 | For a stepper motor with a 1000 PPR AB encoder, the correct value is 4000. |
| foc_abn_direction                                            | This is the direction the encoder moves relative to the direction the motor moves. | Start with 0. If the motor doesn't stop in time when you tell it to move, it means this setting is incorrect. Setting this to 1 will fix this. |
| foc_pid_flux_i<br/>foc_pid_flux_p<br/>foc_pid_torque_i<br/>foc_pid_torque_p<br/>foc_pid_velocity_i<br/>foc_pid_velocity_p<br/>foc_pid_position_i<br/>foc_pid_position_p | These are the PI settings for the FOC system.                | Refer to the motor setup guides here to calibrate these values. |
| biquad_flux_frequency<br/>biquad_torque_frequency<br/>biquad_velocity_frequency<br/>biquad_position_frequency | These are the frequencies for the biquad filter. This helps lower the audible noise coming from the stepper motors. | Refer to the motor setup guides here to calibrate these values. |

~~[More info](https://www.youtube.com/watch?v=RXJKdh1KZ0w)~~

A lot of info on this page are based on the TMC4671 plugin repo, licensed under GPLv3: https://github.com/andrewmcgr/tmc-4671
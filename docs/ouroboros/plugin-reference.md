---
title: TMC4671 Plugin Reference
hide:
  - footer
---

# TMC4671 Plugin Reference

!!! info "Plugin getting frequent updates"
    The TMC4671 Klipper plugin is updated frequently. This page may lag behind the plugin's code. If something here doesn't work, the [plugin README](https://github.com/andrewmcgr/tmc-4671) may help. Updated 11 JUL 2026

## G-Code Commands

### Tuning Commands

Please refer to the tuning docs for more info about how to use these.

#### `TMC_TUNE_PID`

Autotunes the flux and torque current-loop PI gains separately, using the motor resistance and the distinct Ld/Lq inductances measured during startup alignment. With the bandwidth method (default), the flux and torque biquad LPFs are also automatically configured to the respective tuned bandwidth, and their settings are staged for `SAVE_CONFIG` alongside the PI gains.

```
TMC_TUNE_PID STEPPER=stepper_x [FLUX_BANDWIDTH=<hz>] [TORQUE_BANDWIDTH=<hz>] [CURRENT_BANDWIDTH=<hz>] [SIMC=<0|1>] [CHECK=<0|1>] [DERATE=<factor>]
```

| Parameter           | Default             | Description                                                  |
| ------------------- | ------------------- | ------------------------------------------------------------ |
| `FLUX_BANDWIDTH`    | `CURRENT_BANDWIDTH` | Target closed-loop bandwidth in Hz for the flux (d-axis) current loop. |
| `TORQUE_BANDWIDTH`  | `CURRENT_BANDWIDTH` | Target closed-loop bandwidth in Hz for the torque (q-axis) current loop. |
| `CURRENT_BANDWIDTH` | 1200.0              | Fallback bandwidth when `FLUX_BANDWIDTH` or `TORQUE_BANDWIDTH` are not given. 1200 Hz is a safe default; higher values give faster response but more noise. |
| `SIMC`              | 0                   | When `1`, uses an S-IMC setpoint-change experiment per loop instead of the bandwidth method. Slower but can be more accurate. Requires the motor to be active. |
| `CHECK`             | 0                   | When `SIMC=1`, tests the *existing* gains in your config instead of computing from scratch. |
| `DERATE`            | 1.6                 | When `SIMC=1`, initial gain derate factor for the experiment. |

The bandwidth method derives P and I analytically from the measured R, Ld, and Lq. Results are queued for `SAVE_CONFIG`.

Output example:

```
PID stepper_x parameters:
  Flux biquad LPF: 1200 Hz
  Torque biquad LPF: 1200 Hz
  Flux:   Kc=9.6600 Ki=0.4850
  Torque: Kc=9.6600 Ki=0.4850
```

#### `TMC_TUNE_MOTION_PID`

Autotunes velocity and position PI gains and stages the results for `SAVE_CONFIG`. The velocity biquad LPF is also configured automatically and staged.

Two paths are available:

- **Bandwidth path** (default): computes gains from the motor physics config variables (`jmotor`, `jload`, `motor_kt`, `velocity_alpha`). No extra command parameters needed.
- **SIMC/lambda path**: uses a Kt value and lambda time constants. Activated by supplying `KT` (or `HOLDING_CURRENT` + `HOLDING_TORQUE`).

```
TMC_TUNE_MOTION_PID STEPPER=stepper_x [VELOCITY_BANDWIDTH=<hz>] [POSITION_BANDWIDTH=<hz>]
TMC_TUNE_MOTION_PID STEPPER=stepper_x KT=<nm/a> [LAMBDA_V=<val>] [LAMBDA_P=<val>]
TMC_TUNE_MOTION_PID STEPPER=stepper_x HOLDING_CURRENT=<a> HOLDING_TORQUE=<nm> [LAMBDA_V=<val>] [LAMBDA_P=<val>]
```

| Parameter            | Default | Description                                                  |
| -------------------- | ------- | ------------------------------------------------------------ |
| `VELOCITY_BANDWIDTH` | 450.0   | Velocity loop bandwidth in Hz (bandwidth path).              |
| `POSITION_BANDWIDTH` | 100.0   | Position loop bandwidth in Hz (bandwidth path).              |
| `KT`                 | —       | Motor torque constant in Nm/A. Selects the SIMC/lambda path. |
| `HOLDING_CURRENT`    | —       | Rated holding current in A (alternative to `KT`).            |
| `HOLDING_TORQUE`     | —       | Rated holding torque in Nm (alternative to `KT`).            |
| `LAMBDA_V`           | 100.0   | Velocity loop closed-loop time constant (SIMC path). Smaller = faster and noisier. |
| `LAMBDA_P`           | 400.0   | Position loop closed-loop time constant (SIMC path). Should be at least 2× `LAMBDA_V`. |

The velocity biquad LPF cutoff is set to the velocity bandwidth (bandwidth path) or `3 × pwm_freq / LAMBDA_V` (SIMC path) and queued for `SAVE_CONFIG` alongside the PI gains.

#### `INIT_TMC`

Re-initializes all TMC4671 registers from the config and re-runs ADC offset calibration. Useful after a power glitch without doing a full Klipper restart.

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

Reports the motor parameters measured during the last startup alignment (or manual `TMC_MEASURE_IMPEDANCE` run): motor resistance, average inductance, estimated Ld, estimated Lq, and the spatial saliency ratio. If the driver has not yet aligned (e.g. immediately after `FIRMWARE_RESTART`, before `ready`), the command says so.

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

Reports what the PID tuning helpers *would* compute given the current motor parameters, without writing anything to the controller. Compares the computed values against the currently active register values. Always shows the bandwidth-method section; shows the SIMC/lambda motion PID section only when `KT` is supplied.

```
TMC_DEBUG_TUNING STEPPER=stepper_x [CURRENT_BANDWIDTH=<hz>] [VELOCITY_BANDWIDTH=<hz>] [POSITION_BANDWIDTH=<hz>] [LAMBDA_V=<val>] [LAMBDA_P=<val>] [KT=<nm/a>] [R=<ohm>] [L=<henry>]
TMC_DEBUG_TUNING STEPPER=stepper_x HOLDING_CURRENT=<a> HOLDING_TORQUE=<nm> [...]
```

| Parameter                            | Default | Description                                                  |
| ------------------------------------ | ------- | ------------------------------------------------------------ |
| `CURRENT_BANDWIDTH`                  | 1200.0  | Bandwidth in Hz for the current PID section.                 |
| `VELOCITY_BANDWIDTH`                 | 450.0   | Velocity loop bandwidth in Hz for the bandwidth motion PID section. |
| `POSITION_BANDWIDTH`                 | 100.0   | Position loop bandwidth in Hz for the bandwidth motion PID section. |
| `LAMBDA_V`                           | 100.0   | Velocity loop time constant for the SIMC motion PID section. |
| `LAMBDA_P`                           | 400.0   | Position loop time constant for the SIMC motion PID section. |
| `KT`                                 | —       | Motor torque constant in Nm/A (required to show SIMC motion PID section). |
| `HOLDING_CURRENT` + `HOLDING_TORQUE` | —       | Alternative way to supply Kt.                                |
| `R`                                  | —       | Override motor winding resistance in Ω. Defaults to the measured value. |
| `L`                                  | —       | Override motor winding inductance in H. Defaults to the measured value. |

If R and L haven't been measured yet, the current PID section says so instead of computing. Providing `R` or `L` overrides the measured value for the computation without changing what's stored — useful for "what-if" exploration.

#### `TMC_MEASURE_IMPEDANCE`

Performs a high-frequency AC injection test with stochastic demodulation to measure the distinct d-axis and q-axis inductances (Ld, Lq) and the motor's saliency ratio. The values are stored on the driver and used by `TMC_TUNE_PID`. This runs automatically during startup alignment, but can be re-run manually if you suspect the measurement was bad.

```
TMC_MEASURE_IMPEDANCE STEPPER=stepper_x [F_INJECT=<hz>] [N_SAMPLES=<int>]
```

| Parameter   | Default | Description                                                  |
| ----------- | ------- | ------------------------------------------------------------ |
| `F_INJECT`  | 2317.0  | Non-integer high-frequency injection frequency in Hz. The non-integer value avoids aliasing with PWM harmonics. |
| `N_SAMPLES` | 500     | Number of stochastic samples to gather.                      |

Requires prior startup alignment (uses the measured motor resistance). Reports Ld, Lq, and the saliency ratio to the Klipper log.

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

### Profiles

Profiles let you reference a named bundle of board or motor parameters instead of setting them individually. Two built-in board profiles (`OpenFFBoard`, `Ouroboros`) and two built-in motor profiles (`LDO_2504b-EN1000`, `Ouroboros_Stepper`) are available without any extra config sections. The Ouroboros encoder stepper setup guide uses these by default — see it for the recommended config.

| Parameter      | Description                                                  | Note                                                         |
| -------------- | ------------------------------------------------------------ | ------------------------------------------------------------ |
| board_profile  | Name of a built-in or user-defined board profile.            | Use `Ouroboros` for Ouroboros. Sets `voltage_scale_ratio`, `current_scale_ma_lsb`, the ADC selects, BBM dead times, and the voltage limit. |
| motor_profile  | Name of a built-in or user-defined motor profile.            | Use `Ouroboros_Stepper` for Isik's Tech encoder steppers, or `LDO_2504b-EN1000` for the LDO equivalent. Sets `motor_type`, `n_pole_pairs`, `motor_kt`, `jmotor`, `abn_decoder_ppr`, `abn_direction`, and `rated_current`. |

For motors that aren't in the built-in list, define your own:

```ini
[foc_motor my_stepper]
n_pole_pairs: 50
holding_current: 2.0
holding_torque: 0.045
rated_current: 2.0
abn_decoder_ppr: 4000
abn_direction: 0

[tmc4671 stepper_x]
motor_profile: my_stepper
# ... rest of config ...
```

Any field set in a profile can be overridden by setting it explicitly in the `[tmc4671]` section. Profile values silently fill in as defaults; instance values always win.

### Startup Autotuning

| Parameter        | Description                                                  | Note              |
| ---------------- | ------------------------------------------------------------ | ----------------- |
| tune_current_pid | When `True`, runs the equivalent of `TMC_TUNE_PID` automatically at every Klipper restart, after motor R/L measurement. Results are staged for `SAVE_CONFIG`. | Default: `False`. |
| tune_motion_pid  | When `True`, runs the equivalent of `TMC_TUNE_MOTION_PID` (bandwidth path) automatically at every Klipper restart. Results are staged for `SAVE_CONFIG`. | Default: `False`. |

When either is enabled and the corresponding biquad cutoff is not explicitly set, it defaults to 0 (off) until the autotune runs and sets it to the tuned bandwidth.

### Core Parameters

| Parameter                                                    | Description                                                  | Note                                                         |
| ------------------------------------------------------------ | ------------------------------------------------------------ | ------------------------------------------------------------ |
| cs_pin                                                       | The pin number for the SPI chip select pin.                  | The correct value for Ouroboros is provided on the motor setup guides. |
| spi_bus                                                      | The name of the SPI bus TMC4671 is connected to on the MCU.  | The correct value is spi2 for Ouroboros.                     |
| spi_speed                                                    | The speed of the SPI bus.                                    | Should not be edited.                                        |
| current_scale_ma_lsb                                         | TMC4671 relies on external (not built-into the TMC4671 chip) current sense sensors. This setting is for setting how much sense voltage varies, based on the current sense setup used on the PCB. | Set automatically by `board_profile: Ouroboros`. Otherwise the correct value is 1.272 for Ouroboros. |
| voltage_scale_ratio                                          | The VM supply voltage divider ratio used to convert the raw ADC reading to volts. | Set automatically by `board_profile: Ouroboros` to 48.667 (matching the on-board 71.5 kΩ / 1.5 kΩ divider). The plugin's fallback default (40.875) is out of date — set the profile or set this explicitly. To verify: run `TMC_DEBUG_VOLTAGE` and check the reported VM matches your actual supply voltage. If for any reason it doesn't, recalibrate by reading raw `ADC_VM_RAW` via `DUMP_TMC` and calculating `voltage_scale_ratio = VM_actual * 13107 / (ADC_VM_RAW - 32768)`. |
| run_current                                                  | This is the peak current used by the TMC4671 driver to make the motor move. <br/> Unlike common Klipper stepper drivers, this isn't RMS current, it's peak current, so higher values are needed here. | When a motor profile sets `rated_current`, `run_current` defaults to `rated_current × √2` automatically. For example, the `Ouroboros_Stepper` profile (`rated_current: 2.5`) produces a default `run_current` of 3.54 A. For BLDC, calculate this from the peak power dissipation, if no rated current is given, then multiply by 2.8. |
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
| biquad_flux_frequency<br/>biquad_torque_frequency<br/>biquad_velocity_frequency<br/>biquad_position_frequency | Cutoff frequency in Hz for each filter. 0 disables the filter. Float values are accepted. | Refer to the motor setup guides here to calibrate these values. |
| biquad_flux_filter<br/>biquad_torque_filter<br/>biquad_velocity_filter<br/>biquad_position_filter | Filter topology: `lpf` (low-pass), `notch`, or `apf` (all-pass). | Default: `lpf`.                                              |
| biquad_flux_slope<br/>biquad_torque_slope<br/>biquad_velocity_slope<br/>biquad_position_slope | Q factor / slope.                                            | Default: 0.707 (Butterworth).                                |
| jmotor                                                       | Motor rotor moment of inertia in kg·m².                      | Set automatically by motor profiles. Default: 8.45e-6.       |
| jload                                                        | Estimated reflected load inertia in kg·m².                   | 5e-5                                                         |
| motor_kt                                                     | Motor torque constant in Nm/A.                               | Set automatically by motor profiles. Required for `TMC_TUNE_MOTION_PID` and `tune_motion_pid`. |
| velocity_alpha                                               | Velocity loop damping coefficient (dimensionless).           | 0.35                                                         |
| diag_pin                                                     | MCU GPIO connected to the TMC4671 STATUS output for stall detection. | For Ouroboros: `^ouroboros:PE2` (X motor), `^ouroboros:PA2` (Y motor). The `^` enables the input pull-up. |
| homing_current                                               | Current limit in A during homing moves. Stall is detected when the velocity PID demands more than this. | Typical NEMA-17 range: 0.5–1.5 A. Start at 0.5 A and tune up. |
| homing_mask                                                  | Comma-separated list of `STATUS_FLAGS` bits that activate the STATUS pin. | Default is suitable for most installations.                  |

### Bandwidth Parameters

These set the target closed-loop bandwidth for each control loop, in Hz. Used by both the `TMC_TUNE_PID` / `TMC_TUNE_MOTION_PID` commands (when not overridden by command parameters) and the startup autotune (`tune_current_pid` / `tune_motion_pid`). Higher values give faster response but more noise; the defaults are safe starting points.

| Parameter          | Description                                              | Default             |
| ------------------ | -------------------------------------------------------- | ------------------- |
| current_bandwidth  | Fallback bandwidth for the flux and torque current loops. | 1200.0              |
| flux_bandwidth     | Bandwidth for the flux (d-axis) current loop.            | `current_bandwidth` |
| torque_bandwidth   | Bandwidth for the torque (q-axis) current loop.          | `current_bandwidth` |
| velocity_bandwidth | Bandwidth for the velocity loop.                         | 450.0               |
| position_bandwidth | Bandwidth for the position loop.                         | 100.0               |

### Advanced Parameters

Most users should leave these alone.

| Parameter                  | Description                                                  | Default |
| -------------------------- | ------------------------------------------------------------ | ------- |
| impedance_current_fraction | Fraction of `run_current` used as the target current during the impedance (Ld/Lq) measurement at startup. Range: 0–1. | 0.2     |
| bandwidth_filter_ratio     | Ratio between velocity bandwidth and the auto-configured velocity biquad LPF cutoff. Must be > 2.0. | 3.0     |
| current_filter_ratio       | Ratio between the PWM frequency and the auto-configured flux/torque biquad LPF cutoff. Must be > 0 and ≤ 0.5. | 0.4     |
| brake_enable               | Enable the TMC4671's brake chopper output.                   | False   |

~~[More info](https://www.youtube.com/watch?v=RXJKdh1KZ0w)~~

A lot of info on this page is based on the TMC4671 plugin repo, licensed under GPLv3: https://github.com/andrewmcgr/tmc-4671

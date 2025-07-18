---
title: TMC4671 Config Reference
hide:
  - footer
---

# TMC4671 Config Reference

Parameters you may need to edit for a encoder stepper setup are highlighed in bold. **This table is WIP!**

| Parameter                                                    | Description                                                  |
| ------------------------------------------------------------ | ------------------------------------------------------------ |
| cs_pin                                                       | **Leave as-is.** The pin number for the SPI chip select pin. |
| spi_bus                                                      | **Leave as-is.** The name of the SPI bus TMC4671 is connected to on the MCU. |
| spi_speed                                                    | **Leave as-is.** The speed of the SPI bus.                   |
| current_scale_ma_lsb                                         | **Leave as-is.** TMC4671 relies on external (not built-into the TMC4671 chip) current sense sensors. This setting is for setting how much sense voltage varies, based on the current sense setup used on the PCB. For Ouroboros, 1.272 is the correct value. |
| __run_current__                                              | **Edit.** This is the peak current used by the TMC4671 driver to drive the motor. Unlike other stepper drivers, this isn't RMS current, it's peak current, so higher values are needed here.<br />For stepper motors, recommended starting value is 1.4 times the rated current of the stepper motor, as specified on its datasheet. For example, if the rated current of the stepper motor is 2.5A on its datasheet, a good starting value for run_current is **3.5A**. |
| flux_current                                                 | **Leave as-is.**                                             |
| foc_motor_type                                               | **Leave as-is** for stepper motors. This is used to let TMC4671 know what type of motor is connected to it.<br />1: Single-Phase DC<br />2: Two-Phase Stepper<br />3: Three-Phase BLDC |
| foc_n_pole_pairs                                             | **Leave as-is** for 1.8 degree step steppers. This is the number of pole pairs the motor connected to TMC4671 has. |
| foc_pwm_sv                                                   | **Leave as-is.** Setting this to 1 enables space vector PWM. |
| foc_adc_i_ux_select<br />foc_adc_i_v_select<br />foc_adc_i_wy_select | **Leave as-is.** Refer to the TMC4671 datasheet for more information. |
| phi_e_selection                                              | **Leave as-is.** This is used to select an angle signal for FOC transformation as electrical angle of the motor. Refer to the TMC4671 datasheet for more information. |
| foc_position_selection                                       | **Leave as-is.** This is used to select an angle signal for the position calculation and control loop. Refer to the TMC4671 datasheet for more information. |
| foc_velocity_selection                                       | **Leave as-is.** This is used to select an angle signal for the velocity control loop and velocity calculation. This selects the velocity source for velocity measurement. Refer to the TMC4671 datasheet for more information.<br />9 is a good value for this. 3 can be easier to configure at the cost of print quality. You will need to recalibrate your TMC4671 if you change this. Do not try other values for this unless you checked the TMC4671 datasheet, and understand what this setting does. |
| __foc_abn_decoder_ppr__                                      | **Edit.** This is based on your motor's encoder's PPR. For a stepper motor with a 1000 PPR AB encoder (motors linked in this document), the correct value is 4000. |
| __foc_abn_direction__                                        | **Edit.** This is the direction the encoder moves relative to the direction the motor moves. <br />You may start with 0. If the motor doesn't stop in time when you tell it to move, it means this setting is incorrect. Setting this to 1 will fix this. |
| __foc_pid_flux_i<br/>foc_pid_flux_p<br/>foc_pid_torque_i<br/>foc_pid_torque_p<br/>foc_pid_velocity_i<br/>foc_pid_velocity_p<br/>foc_pid_position_i<br/>foc_pid_position_p__ | **Edit.** These are the PI settings for the FOC system. You may start with the suggested values first. Later, we will use the autotune feature to calibrate these values. |
| __biquad_flux_frequency<br/>biquad_torque_frequency<br/>biquad_velocity_frequency<br/>biquad_position_frequency__ | **Edit.** These are the frequencies for the biquad filter. This helps lower the audible noise coming from the stepper motors.<br />Until the rest of the parameters are calibrated, keep these at 0. If you are following this guide, only edit these values when they are mentioned at a later step.<br />Good starting values are 1600 Hz for torque and 800 Hz for flux for NEMA 17 steppers. Velocity and position can be kept at 0. |

~~[More info](https://www.youtube.com/watch?v=RXJKdh1KZ0w)~~
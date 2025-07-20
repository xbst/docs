---
title: TMC4671 Config Reference
hide:
  - footer
---

# TMC4671 Config Reference

!!! warning "Advanced"
    A lot of these settings should not be changed for a typical application. Refer to the setup guides here for setting up your Ouroboros.

| Parameter                                                    | Description                                                  | Note                                                         |
| ------------------------------------------------------------ | ------------------------------------------------------------ | ------------------------------------------------------------ |
| cs_pin                                                       | The pin number for the SPI chip select pin.                  | The correct value for Ouroboros is provided on the motor setup guides. |
| spi_bus                                                      | The name of the SPI bus TMC4671 is connected to on the MCU.  | The correct value is spi2 for Ouroboros.                     |
| spi_speed                                                    | The speed of the SPI bus.                                    | Should not be edited.                                        |
| current_scale_ma_lsb                                         | TMC4671 relies on external (not built-into the TMC4671 chip) current sense sensors. This setting is for setting how much sense voltage varies, based on the current sense setup used on the PCB. | The correct value is 1.272 for Ouroboros.                    |
| run_current                                                  | This is the peak current used by the TMC4671 driver to drive the motor. <br/> Unlike common Klipper stepper drivers, this isn't RMS current, it's peak current, so higher values are needed here. | For stepper motors, recommended starting value is 1.4 times the rated current of the stepper motor, as specified on its datasheet. For example, if the rated current of the stepper motor is 2.5A on its datasheet, a good starting value for run_current is **3.5A**. For BLDC, calculate this from the peak power dissipation, if no rated current is given, then multiply by 2.8. |
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
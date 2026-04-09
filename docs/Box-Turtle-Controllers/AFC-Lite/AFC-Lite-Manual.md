---
hide:
  - footer
---

# AFC-Lite Manual

![AFC-Lite Manual](../../assets/AFC-Lite_Manual.pdf){ type=application/pdf style="min-height:70vh;width:100%" }

??? warning "Do not put Cartographer v3 probes on the same CAN data lines as AFC-Lite. Using one of them in USB mode, or putting them on separate CAN networks is safe. This issue does not affect Cartographer v4 probes, just v3."
    Cartographer v3s have the CAN data lines connected to MUX chips, so they can use the same pins for USB and CAN. These MUX (switch) chips aren't built to the same standards as CAN transceivers, they're not rated for transient voltage spikes, and Cartographer v3s don't have any additional protection for their MUX chips. This is why Cartographer v3s can die when exposed to transient voltage spikes on the CAN data lines. Cartographer team addressed this issue and added TVS (transient voltage suppression) diodes to protect the MUX chips on Cartographer v4s, so this issue doesn't affect v4s.

    But why does a transient spike happen? The exact cause is unknown. I (Isik) tried to replicate this issue many times, but was not able to. I reached out to people with many more years of experience with electronics, trying to see if they can identify what's causing this, but they also weren't able to find out why this is happening. I think the most likely explanantion is the high inrush current on the long CAN cable is causing this. In our 3D printers, typically at the end of a long CAN bus cable, we have a toolhead board with some capacitors. Toolhead boards are designed to drive 1 small stepper, and have very small voltage rails. AFC-Lite drives 4 steppers, and has a much bigger buck converter. It probably has about 4 times the capacitance than a typical toolhead board. Capacitors are the main thing drawing inrush current, so we're talking about a significantly higher draw. Of course there are many 3D printer boards with support for many more motors than that, but they typically don't end up at the end of a long cable carrying the power right next to the CAN bus data lines. The high inrush current flowing on the power part on the cable may be inducing more on the CAN data lines (which are acting like antennas) than the lower inrush current of toolhead boards do.

    Regardless of what the exact cause is, this is within CAN specifications, and CAN transceivers are designed to handle transient voltages. So, any device with the CAN lines directly connected to its CAN transceiver shouldn't be affected. Going forward Cartographers won't be affected as well, as they added protection to protect the MUX chips they use on Cartographer v4s. Any other board with MUXs on CAN lines instead of transceiver should also have TVS diode protection or more if they're designed well, so they should not be affected as well.

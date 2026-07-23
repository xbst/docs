---
title: KUSBA Manual
hide:
  - footer
---

# Klipper USB Accelerometer
<img src="https://store.isiks.tech/cdn/shop/files/FullSizeRender_506acff9-d0a4-4275-adc5-140f3d2246ca.jpg?v=1697927717&width=600">

A PCB designed to make [Klipper's](https://github.com/KevinOConnor/klipper) [input shaping](https://github.com/Klipper3d/klipper/blob/master/docs/Resonance_Compensation.md) much easier by simplifying the wiring and config for [measuring resonances](https://github.com/KevinOConnor/klipper/blob/master/docs/Measuring_Resonances.md). You just need this PCB and a USB C cable.

## Purchasing a KUSBA
### United States
- [Amazon - Prime Shipping](https://www.amazon.com/Isiks-Tech-KUSBA-Klipper-Accelerometer/dp/B0C734JL4Z?maas=maas_adg_AABAE123B3C6951B3F1F9BDBBF2BA8C6_afap_abs&ref_=aa_maas&tag=maas)
- [Isik's Tech Store](https://store.isiks.tech/products/kusba-klipper-usb-accelerometer)
- [West3D](https://west3d.com/products/kusba-klipper-usb-accelerometer-by-isikstech)
### Canada
- [Amazon](https://www.amazon.ca/dp/B0C734JL4Z)
### United Kingdom
- [Printy Please](https://www.printyplease.uk/KUSBA)
### Australia
- [DREMC](https://store.dremc.com.au/products/kusba-usb-adxl345-accelerometer-for-klipper)

## Instructions
### Klipper Prep
Based on [Klipper docs](https://www.klipper3d.org/Measuring_Resonances.html#software-installation).

1. Install the necessary dependencies:
    ```bash
    sudo apt update
    sudo apt install python3-numpy python3-matplotlib libatlas-base-dev libopenblas-dev
    ```
2. Install `numpy` in the Klipper environment:
    ```bash
    ~/klippy-env/bin/pip install -v "numpy<1.26"
    ```

### Firmware Flashing
!!! info "Official Isik's Tech KUSBA boards come with the firmware already flashed, so can skip this step."

??? info "White blob?"
    On the front side of your KUSBA, next to the logo, there's a big 8-pin chip. This is the flash chip. If the top side of the chip is covered in a white blob (very obvious visually), you have a "white blob" board. If not, use the non-"white blob" firmware.
    
    Unoffical board links to the non-"white blob" firmware assuming they didn't substitute the chip, YMMV.
    
    **Why the 2 variants?**
    
    You've probably heard of the recent (written in 07/2026) RAM shortages. Unfortunately flash chips used to store the firmware on PCBs are also a type of memory, and are also affected by the shortages. Due to the shortages, the flash chip typically used on KUSBAs (Winbond W25Q16JVSNIQ) can't always be sourced, so some batches were made with another chip (ISSI IS25LP016D) instead. These chips are identical in terms of specs, but they need different BOOT2 codes for the firmware on RP2040 boards. We marked the ISSI chips with a white blob to make them obvious.

??? info "Seeing "MCU Protocol Error?"
    Klipper devs did some major changes to the ADXL code in 2024, and as a result older Rampon is not compatible with newer Klipper versions, and vice-versa.

    If your Klipper version is older than v0.12.0-85, use [this](https://github.com/rogerlz/rampon_anchor/releases/download/v0.3.0/rampon_anchor_kusba.uf2) firmware.

1. Download the firmware:

    | Board | Firmware |
    | --- | --- |
    | - Official board<br>- White blob | [Download](https://github.com/rogerlz/rampon_anchor/raw/refs/heads/main/release/rampon_anchor_kusba_is25lp.uf2) |
    | - Official board<br>- No white blob | [Download](https://github.com/rogerlz/rampon_anchor/raw/refs/heads/main/release/rampon_anchor_kusba.uf2) |
    | Unofficial board | [Download](https://github.com/rogerlz/rampon_anchor/raw/refs/heads/main/release/rampon_anchor_kusba.uf2) |

2. Connect the KUSBA to your PC while holding down the button on the KUSBA. A new drive will be connected, open if it isn't opened automatically.
3. Drag & drop the downloaded .UF2 file. KUSBA will disconnect and the window will close on its own. Your KUSBA is ready.

### Klipper Config
1. Download the [adxlmcu.cfg](https://raw.githubusercontent.com/xbst/KUSBA/refs/heads/main/Firmware/v2-Rampon/adxlmcu.cfg) file from the KUSBA repo and add it to your Klipper config directory.
2. Edit the adxlmcu.cfg file. Change the the probe points.
3. Add the following to your printer.cfg:
```ini
[include adxlmcu.cfg]
```
4. Do your testing. When done comment the include line to disable the KUSBA. (If you don't do this and unplug the KUSBA, Klipper won't work.)
```ini
# [include adxlmcu.cfg]
```

??? info "Legacy Instructions"
    Ignore unless you know you need these instructions.
    
    [KUSBA v2 Non-Rampon Klipper Instructions](https://github.com/xbst/KUSBA/edit/main/Docs/v2-Firmware.md)
    
    [KUSBA v1 Instructions](https://github.com/xbst/KUSBA/edit/main/Docs/v1-Firmware.md)
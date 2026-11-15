# R69-EMCP V2.0 — evidence profile

| Field | Value | Evidence class |
|---|---|---|
| Board | SHUNJUEY R69-EMCP V2.0 | User-reported board marking |
| SoC | Allwinner H3 | Prior firmware/device analysis; live FEL SoC ID not yet read |
| Expected sunxi-tools SoC ID | `0x1680` | Reference expectation; not currently measured on the box |
| USB VID:PID | `1F3A:EFE8` | Previously observed USB identity; not proof of FEL handshake |
| Board config | `dolphin-p1` | Firmware declaration |
| eMCP | SanDisk `SD9DS28K-8G` | User-supplied package marking |
| Memory package | 8GB eMMC + 8Gbit LPDDR3 (1GB) | Package listing interpretation; not live capacity read |
| DRAM config | LPDDR3, type 7, 336 MHz | `sys_config.fex` firmware declaration |
| Android | Android 10, QP1A.190711.020, userdebug/test-keys | Firmware build properties |
| Firmware container | IMAGEWTY v0x300, 37 entries, about 1.36 GiB | Prior file inspection |
| Boot package | TOC1, five named components | Prior `file`/strings inspection |

## Known limits
- Blue LED and HDMI no-signal do not identify the failing boot stage.
- Compiled strings in Boot0/U-Boot do not prove those routines ran.
- A firmware partition sum does not prove physical eMMC capacity.
- `dram_zq` from FEX is a config value; do not treat it as an invitation to patch a binary structure.
- The current web app cannot identify the exact board wiring, PMIC/power integrity, or eMMC health.

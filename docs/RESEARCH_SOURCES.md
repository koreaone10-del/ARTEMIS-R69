# Technical references

These references underpin the design. Vendor-specific details remain marked as uncertain unless matched to the actual R69 firmware bytes.

1. Allwinner H3 product brief (H.265/HEVC, memory and interface capabilities): https://www.allwinnertech.com/uploads/pdf/201608011519593c.pdf
2. linux-sunxi `sunxi-tools` source and SoC identification table (H3 SoC ID `0x1680`): https://github.com/linux-sunxi/sunxi-tools/blob/master/soc_info.c
3. linux-sunxi `sunxi-tools` repository (FEL, bootinfo and image utilities): https://github.com/linux-sunxi/sunxi-tools
4. `mksunxiboot.c` reference implementation for eGON checksum handling: https://git.openwrt.org/project/bcm63xx/u-boot/tree/tools/mksunxiboot.c
5. U-Boot Allwinner/Sunxi documentation: https://docs.u-boot.org/en/latest/board/allwinner/sunxi.html
6. IMAGEWTY v3 reverse-engineering notes (candidate file-header fields): https://www.gloomyghost.com/posts/openixcli-firmware-module/
7. `sunxi-fw` Allwinner firmware decoding project: https://github.com/apritzel/sunxi-fw
8. SanDisk SD9DS28K-8G product listing (eMCP 8+8 LPDDR3): https://www.mouser.cn/ProductDetail/SanDisk/SD9DS28K-8G
9. WebUSB API reference and browser compatibility cautions: https://developer.mozilla.org/en-US/docs/Web/API/USB

## Confidence policy
A public SoC data sheet is not proof that a specific board routes every peripheral. Reverse-engineered container offsets are candidate formats, not vendor guarantees. The application must show unknowns instead of silently substituting assumptions.

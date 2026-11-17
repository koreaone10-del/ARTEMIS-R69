/*
 * fel_version.c -- minimal read-only Allwinner FEL_VERSION client
 * (ARTEMIS Termux bridge v2; transport shared via fel_common.c)
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 * Copyright (C) 2026 ARTEMIS R69 project contributors
 *
 * Wire format reference (protocol facts, not copied code):
 *   sunxi-tools, fel.c (Icenowy/sunxi-tools master, also Debian dgit),
 *   Copyright (C) 2012 Henrik Nordstrom and contributors, GPL-2.0.
 *   See bridge/docs/SOURCES.md for the exact fields that were verified
 *   against that source.
 *
 * This program sends one FEL_VERSION request (0x001) only. It never
 * sends FEL_WRITE (0x101), FEL_EXEC (0x102) or FEL_READ (0x103);
 * those live in fel_common.h and are used by fel_write.c /
 * fel_exec.c / fel_read.c, not here.
 *
 * Usage (Termux, no root):
 *   termux-usb -r -e ./fel_version /dev/bus/usb/001/002
 *   # or, on newer termux-usb with -E:
 *   TERMUX_USB_FD=<fd> ./fel_version
 *
 * The program takes a USB file descriptor (argv[1], or the
 * TERMUX_USB_FD environment variable), wraps it with
 * libusb_wrap_sys_device() -- the same pattern as usb_probe.c --
 * checks VID:PID 1F3A:EFE8, discovers the bulk endpoints at runtime
 * from the active configuration, claims interface 0, sends one
 * FEL_VERSION request, and prints exactly one JSON object to stdout.
 *
 * verified_on_device: this field is true exactly when the device
 * answered with the AWUSBFEX signature and a decoded SoC ID --
 * that answer IS the verification. (v1 printed a hard-coded
 * false here; that was a bug, fixed in v2.)
 *
 * LIVE RESULT (2026-11-17, user's phone): FEL_VERSION answered
 * AWUSBFEX, soc_id 5760 / 0x1680, soc_name H3, protocol 1,
 * scratchpad 0x7e00, bulk endpoints 1 out / 130 in, device
 * /dev/bus/usb/001/004. The handshake is proven; the remaining
 * v2 commands (FEL_READ / FEL_WRITE / FEL_EXEC) are still
 * UNVERIFIED on a real device.
 */

#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "fel_common.h"

int main(int argc, char **argv)
{
    int fd = -1;
    char *params[1];
    const char *flags[4];
    fel_device dev;
    char err[256];
    unsigned char ver[32];
    uint16_t soc_id;
    uint32_t unknown_0a, scratchpad;
    uint16_t protocol;

    if (fel_resolve_fd_and_params(argc, argv, 0, params, flags, 4,
                                  NULL, &fd) != 0) {
        fel_print_error("fel_version",
                        "usb file descriptor required: argv[1] or "
                        "TERMUX_USB_FD");
        return 2;
    }

    if (fel_open(fd, &dev, err, sizeof(err)) != 0) {
        printf("{\"ok\":false,\"tool\":\"fel_version\",\"error\":\"%s\"}\n",
               err);
        return 1;
    }

    /* One FEL request, 16 bytes: request / address / length / pad,
     * all LE32. FEL_VERSION = 0x001, address 0, length 0.
     * Exchange order follows upstream aw_fel_get_version():
     * send the FEL request, read the 32-byte version reply, then
     * read the 8-byte FEL status. */
    if (fel_send_request(&dev, AW_FEL_VERSION, 0, 0) != 0) {
        fel_print_error("fel_version", "fel version request failed");
        fel_close(&dev);
        return 1;
    }

    /* aw_fel_version, 32 bytes:
     *   0..7  signature "AWUSBFEX"
     *   8..11 soc_id (raw LE32; decoded id = (raw >> 8) & 0xffff)
     *   12..15 unknown_0a (LE32)
     *   16..17 protocol (LE16)
     *   18 unknown_12, 19 unknown_13
     *   20..23 scratchpad (LE32; upstream reads it as LE16, which
     *          gives the same low half on a little-endian host)
     *   24..31 pad
     */
    if (fel_read_version_reply(&dev, ver) != 0) {
        fel_print_error("fel_version", "fel version reply failed");
        fel_close(&dev);
        return 1;
    }
    if (memcmp(ver, "AWUSBFEX", 8) != 0) {
        fel_print_error("fel_version", "bad fel version signature");
        fel_close(&dev);
        return 1;
    }

    soc_id = (uint16_t)((fel_get_le32(ver + 8) >> 8) & 0xffff);
    unknown_0a = fel_get_le32(ver + 12);
    protocol = fel_get_le16(ver + 16);
    scratchpad = fel_get_le32(ver + 20);

    printf("{\"ok\":true,\"tool\":\"fel_version\",\"version\":1,"
           "\"signature\":\"AWUSBFEX\","
           "\"soc_id\":%u,\"soc_id_hex\":\"0x%04x\",\"soc_name\":\"%s\","
           "\"unknown_0a\":%u,\"protocol\":%u,"
           "\"unknown_12\":%u,\"unknown_13\":%u,"
           "\"scratchpad\":%u,\"scratchpad_hex\":\"0x%04x\","
           "\"pad\":[%u,%u],"
           "\"bulk_ep_out\":%d,\"bulk_ep_in\":%d,"
           "\"vid\":\"0x%04x\",\"pid\":\"0x%04x\","
           "\"verified_on_device\":true}\n",
           soc_id, soc_id, fel_soc_name(soc_id),
           unknown_0a, protocol,
           ver[18], ver[19],
           scratchpad, scratchpad,
           fel_get_le32(ver + 24), fel_get_le32(ver + 28),
           dev.bulk_ep_out, dev.bulk_ep_in,
           dev.vid, dev.pid);

    fel_close(&dev);
    return 0;
}

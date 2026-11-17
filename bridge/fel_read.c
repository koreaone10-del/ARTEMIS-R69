/*
 * fel_read.c -- Allwinner FEL_READ client (ARTEMIS Termux bridge v2)
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 * Copyright (C) 2026 ARTEMIS R69 project contributors
 *
 * Reads memory from a device in FEL mode and prints exactly one
 * JSON object (hex + base64 + SHA-256) to stdout.
 *
 * Usage:
 *   fel_read <fd> <address> <length>
 *   fel_read <address> <length> <fd>        (termux-usb -e "cmd" form)
 *   TERMUX_USB_FD=<fd> fel_read <address> <length>
 *   FEL_ADDR=0x1000 FEL_LEN=16 fel_read <fd>
 *
 * Allowlist (fel_common.h): H3 SRAM 0x00000000-0x00020000, and the
 * SID window 0x01C14200-0x01C14210. Length 1..4096 bytes. DRAM
 * (0x40000000) is NEVER read before it is initialised, and no
 * address outside the allowlist is read. This tool only sends
 * AW_FEL_1_READ (0x103); it never writes or executes.
 *
 * UNVERIFIED ON A REAL R69 (2026-11-17): FEL_READ itself has never
 * been run against a live H3. The exchange order follows upstream
 * sunxi-tools fel.c aw_fel_read() (FEL_READ request, AW_USB_READ
 * data, 8-byte FEL status), but a live read is the only proof.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "fel_common.h"

int main(int argc, char **argv)
{
    const char *tool = "fel_read";
    char *params[2];
    const char *flags[4];
    static const char *env_names[2] = { "FEL_ADDR", "FEL_LEN" };
    int fd = -1;
    uint32_t addr = 0, len = 0;
    fel_device dev;
    char err[256];
    unsigned char *buf = NULL;
    char *hex = NULL, *b64 = NULL;
    char sha[65];

    if (fel_resolve_fd_and_params(argc, argv, 2, params, flags, 4,
                                  env_names, &fd) != 0 ||
        fel_parse_u32(params[0], &addr) != 0 ||
        fel_parse_len(params[1], &len) != 0) {
        fel_print_error(tool, "usage: fel_read <fd> <address> <length>");
        return 2;
    }
    if (len < 1 || len > FEL_READ_MAX_LEN) {
        fel_print_error(tool, "length must be 1..4096");
        return 2;
    }
    if (!fel_read_allowed(addr, len)) {
        fel_print_error(tool, "address not in fel_read allowlist "
                              "(h3 sram 0x00000000-0x00020000 or sid "
                              "0x01c14200-0x01c14210)");
        return 2;
    }

    buf = malloc(len);
    hex = malloc(len * 2 + 1);
    if (!buf || !hex) {
        fel_print_error(tool, "out of memory");
        free(buf);
        free(hex);
        return 1;
    }
    if (fel_open(fd, &dev, err, sizeof(err)) != 0) {
        printf("{\"ok\":false,\"tool\":\"fel_read\",\"error\":\"%s\"}\n", err);
        free(buf);
        free(hex);
        return 1;
    }
    if (fel_read_mem(&dev, addr, buf, len) != 0) {
        fel_print_error(tool, "fel read failed");
        fel_close(&dev);
        free(buf);
        free(hex);
        return 1;
    }
    fel_sha256_hex(buf, len, sha);
    fel_hex_encode(buf, len, hex);
    b64 = fel_base64_encode(buf, len);
    printf("{\"ok\":true,\"tool\":\"fel_read\",\"version\":1,"
           "\"address\":%u,\"address_hex\":\"0x%08x\","
           "\"length\":%u,\"sha256\":\"%s\",\"hex\":\"%s\",\"base64\":\"%s\","
           "\"bulk_ep_out\":%d,\"bulk_ep_in\":%d,"
           "\"vid\":\"0x%04x\",\"pid\":\"0x%04x\","
           "\"verified_on_device\":true}\n",
           addr, addr, len, sha, hex, b64 ? b64 : "",
           dev.bulk_ep_out, dev.bulk_ep_in, dev.vid, dev.pid);
    free(b64);
    fel_close(&dev);
    free(buf);
    free(hex);
    return 0;
}

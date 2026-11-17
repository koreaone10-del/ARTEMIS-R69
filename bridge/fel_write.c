/*
 * fel_write.c -- Allwinner FEL_WRITE client (ARTEMIS Termux bridge v2)
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 * Copyright (C) 2026 ARTEMIS R69 project contributors
 *
 * Writes a file to H3 SRAM on a device in FEL mode and prints
 * exactly one JSON object to stdout. SRAM ONLY. This tool can
 * never write eMMC, NAND, DRAM or any flash address: the address
 * must be inside 0x00000000-0x00020000, the size at most 128 KiB,
 * and generic writes that overlap the protected BROM regions
 * (IRQ stack 0x1C00-0x1FFF, stack 0x5C00-0x6FFF, the important
 * 0x7C00-0x7FFF region holding the FEL_VERSION scratchpad 0x7E00,
 * MMU table / thunk 0x8000-0xBFFF) are refused.
 *
 * The one exception is a write starting exactly at the SPL load
 * address 0x00000000 with the --spl flag. Upstream sunxi-fel loads
 * the SPL there, but only after swapping the protected regions to
 * backup SRAM and running a thunk to restore them
 * (aw_fel_write_and_execute_spl, fel.c). v2 does NOT implement
 * that swap/thunk, so an SPL write in v2 is UNVERIFIED and may
 * kill FEL mid-transfer. --spl makes that risk explicit.
 *
 * Usage:
 *   fel_write <fd> <address> <file|-> [--spl]
 *   fel_write <address> <file> <fd> [--spl]
 *   TERMUX_USB_FD=<fd> fel_write <address> <file>
 *   FEL_ADDR=0x1000 FEL_FILE=/path/file fel_write <fd>
 * ("-" reads the bytes from stdin.)
 *
 * UNVERIFIED ON A REAL R69 (2026-11-17): FEL_WRITE has never been
 * run against a live H3. The exchange order follows upstream
 * fel.c aw_fel_write() (FEL_WRITE request, AW_USB_WRITE data,
 * 8-byte FEL status). A live write + read-back is the only proof.
 * This tool does NOT verify by reading back; the bridge server /
 * UI runs fel_read afterwards and compares SHA-256.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "fel_common.h"

static unsigned char *read_all(FILE *in, size_t *out_len)
{
    size_t cap = 8192, len = 0;
    unsigned char *buf = malloc(cap);
    if (!buf)
        return NULL;
    for (;;) {
        size_t want = cap - len;
        size_t n;
        if (want == 0) {
            unsigned char *nb;
            cap *= 2;
            nb = realloc(buf, cap);
            if (!nb) {
                free(buf);
                return NULL;
            }
            buf = nb;
            want = cap - len;
        }
        n = fread(buf + len, 1, want, in);
        len += n;
        if (n < want)
            break;
    }
    *out_len = len;
    return buf;
}

int main(int argc, char **argv)
{
    const char *tool = "fel_write";
    char *params[2];
    const char *flags[4];
    static const char *env_names[2] = { "FEL_ADDR", "FEL_FILE" };
    int fd = -1, spl_flag = 0, i;
    uint32_t addr = 0;
    FILE *in = NULL;
    unsigned char *data = NULL;
    size_t data_len = 0;
    fel_device dev;
    char err[256];
    char sha[65];

    if (fel_resolve_fd_and_params(argc, argv, 2, params, flags, 4,
                                  env_names, &fd) != 0 ||
        fel_parse_u32(params[0], &addr) != 0) {
        fel_print_error(tool,
                        "usage: fel_write <fd> <address> <file|-> [--spl]");
        return 2;
    }
    for (i = 0; flags[i]; i++) {
        if (strcmp(flags[i], "--spl") == 0)
            spl_flag = 1;
    }
    if (strcmp(params[1], "-") == 0) {
        in = stdin;
    } else {
        in = fopen(params[1], "rb");
        if (!in) {
            fel_print_error(tool, "cannot open input file");
            return 2;
        }
    }
    data = read_all(in, &data_len);
    if (in != stdin)
        fclose(in);
    if (!data) {
        fel_print_error(tool, "cannot read input");
        return 1;
    }
    if (data_len < 1 || data_len > FEL_WRITE_MAX_LEN) {
        fel_print_error(tool, "size must be 1..131072 bytes");
        free(data);
        return 2;
    }
    if (!fel_write_allowed(addr, (uint32_t)data_len, spl_flag)) {
        fel_print_error(tool, "address not allowed for fel_write "
                              "(sram only, protected brom regions "
                              "refused; spl writes need --spl at 0x0)");
        free(data);
        return 2;
    }

    fel_sha256_hex(data, data_len, sha);
    if (fel_open(fd, &dev, err, sizeof(err)) != 0) {
        printf("{\"ok\":false,\"tool\":\"fel_write\",\"error\":\"%s\"}\n", err);
        free(data);
        return 1;
    }
    if (fel_write_mem(&dev, addr, data, data_len) != 0) {
        fel_print_error(tool, "fel write failed");
        fel_close(&dev);
        free(data);
        return 1;
    }
    printf("{\"ok\":true,\"tool\":\"fel_write\",\"version\":1,"
           "\"address\":%u,\"address_hex\":\"0x%08x\","
           "\"bytes_written\":%u,\"length\":%u,\"sha256\":\"%s\","
           "\"spl\":%s,"
           "\"bulk_ep_out\":%d,\"bulk_ep_in\":%d,"
           "\"vid\":\"0x%04x\",\"pid\":\"0x%04x\","
           "\"verified_on_device\":true,"
           "\"note\":\"sram only; read back with fel_read to verify\"}\n",
           addr, addr, (unsigned)data_len, (unsigned)data_len, sha,
           spl_flag ? "true" : "false",
           dev.bulk_ep_out, dev.bulk_ep_in, dev.vid, dev.pid);
    fel_close(&dev);
    free(data);
    return 0;
}

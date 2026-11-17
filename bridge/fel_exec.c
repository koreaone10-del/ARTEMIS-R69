/*
 * fel_exec.c -- Allwinner FEL_EXEC client (ARTEMIS Termux bridge v2)
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 * Copyright (C) 2026 ARTEMIS R69 project contributors
 *
 * Executes code at an SRAM address on a device in FEL mode and
 * prints exactly one JSON object to stdout. SRAM addresses only
 * (0x00000000-0x00020000). This tool refuses to run without the
 * explicit --confirmed flag: a standalone run must be a deliberate
 * act, and the bridge server additionally refuses unless the
 * address lies inside a range written by fel_write in the same
 * bridge session (see bridge/server.js).
 *
 * Usage:
 *   fel_exec <fd> <address> --confirmed
 *   fel_exec <address> <fd> --confirmed
 *   TERMUX_USB_FD=<fd> fel_exec <address> --confirmed
 *
 * What "success" means here: FEL_EXEC sends the request and the
 * device returns the 8-byte FEL status, as in upstream fel.c
 * aw_fel_execute(). That confirms the status reply, NOT that the
 * code ran correctly, and NOT that it returned. An SPL that takes
 * over the device will not return a status at all (the status read
 * times out); that timeout is reported as exec_status_timeout and
 * must be followed by re-checking FEL_VERSION / FEL_READ, not by
 * assuming failure. See bridge/README.md.
 *
 * UNVERIFIED ON A REAL R69 (2026-11-17): FEL_EXEC has never been
 * run against a live H3.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "fel_common.h"

int main(int argc, char **argv)
{
    const char *tool = "fel_exec";
    char *params[1];
    const char *flags[4];
    static const char *env_names[1] = { "FEL_ADDR" };
    int fd = -1, confirmed = 0, i;
    uint32_t addr = 0;
    fel_device dev;
    char err[256];

    if (fel_resolve_fd_and_params(argc, argv, 1, params, flags, 4,
                                  env_names, &fd) != 0 ||
        fel_parse_u32(params[0], &addr) != 0) {
        fel_print_error(tool,
                        "usage: fel_exec <fd> <address> --confirmed");
        return 2;
    }
    for (i = 0; flags[i]; i++) {
        if (strcmp(flags[i], "--confirmed") == 0)
            confirmed = 1;
    }
    if (!confirmed) {
        fel_print_error(tool, "exec refused: --confirmed is required");
        return 2;
    }
    if (!fel_in_sram(addr, 1)) {
        fel_print_error(tool, "exec address must be in h3 sram "
                              "0x00000000-0x00020000");
        return 2;
    }
    if (fel_open(fd, &dev, err, sizeof(err)) != 0) {
        printf("{\"ok\":false,\"tool\":\"fel_exec\",\"error\":\"%s\"}\n", err);
        return 1;
    }
    if (fel_exec_mem(&dev, addr) != 0) {
        printf("{\"ok\":false,\"tool\":\"fel_exec\",\"error\":"
               "\"exec_status_timeout\","
               "\"address\":%u,\"address_hex\":\"0x%08x\","
               "\"note\":\"no fel status reply within timeout; the code "
               "may still be running (an spl that takes over never "
               "returns a status). Re-check with fel_version / fel_read "
               "before assuming failure.\"}\n",
               addr, addr);
        fel_close(&dev);
        return 1;
    }
    printf("{\"ok\":true,\"tool\":\"fel_exec\",\"version\":1,"
           "\"address\":%u,\"address_hex\":\"0x%08x\","
           "\"status\":\"fel_status_ok\","
           "\"bulk_ep_out\":%d,\"bulk_ep_in\":%d,"
           "\"vid\":\"0x%04x\",\"pid\":\"0x%04x\","
           "\"verified_on_device\":true,"
           "\"note\":\"status reply received; this does not by itself "
           "prove the code ran correctly\"}\n",
           addr, addr,
           dev.bulk_ep_out, dev.bulk_ep_in, dev.vid, dev.pid);
    fel_close(&dev);
    return 0;
}

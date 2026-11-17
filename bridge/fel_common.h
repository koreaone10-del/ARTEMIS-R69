/*
 * fel_common.h -- shared Allwinner FEL transport for the ARTEMIS
 * Termux bridge v2 (fel_version, fel_read, fel_write, fel_exec).
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 * Copyright (C) 2026 ARTEMIS R69 project contributors
 *
 * Wire format reference (protocol facts, not copied code):
 *   sunxi-tools, fel.c (Icenowy/sunxi-tools master),
 *   Copyright (C) 2012 Henrik Nordstrom and contributors, GPL-2.0.
 *   See bridge/docs/SOURCES.md for the exact fields verified
 *   against that source (FEL codes, 16-byte request layout,
 *   AWUC/AWUS exchange, H3 SRAM map).
 *
 * This header also holds the v2 safety allowlist. It is enforced
 * here AND in bridge/server.js; neither layer trusts the other.
 *
 * H3 SRAM map (verified, fel.c soc_sram_info_table, H3 entry):
 *   SPL load address (spl_addr, field unset => 0)  0x00000000
 *   scratch_addr (safe place for small code)       0x00001000
 *   mmu_tt_addr                                     0x00008000
 *   thunk_addr / thunk_size                         0x0000A200 / 0x200
 *   sid_addr (SID_KEY[0-3] base)                    0x01C14200
 *   DRAM base (NEVER read/written before DRAM init) 0x40000000
 *
 * Protected SRAM sub-ranges (fel.c comments / swap_buffers):
 *   0x1C00-0x1FFF  BROM IRQ stack
 *   0x5C00-0x6FFF  BROM stack
 *   0x7C00-0x7FFF  "something important (overwriting them kills FEL)";
 *                  the FEL_VERSION scratchpad 0x7E00 lives here.
 * A generic fel_write that overlaps any of these is refused.
 * The single exception is a write that starts exactly at the SPL
 * load address 0x00000000 with the --spl flag: upstream sunxi-fel
 * loads the SPL there, but only after swapping the three regions
 * above to backup SRAM and running a thunk to restore them
 * (aw_fel_write_and_execute_spl). v2 does NOT implement that
 * swap/thunk, so an SPL write+exec in v2 is UNVERIFIED and may
 * kill FEL mid-transfer. The --spl flag exists so the risk is
 * explicit and auditable, not silent.
 */

#ifndef FEL_COMMON_H
#define FEL_COMMON_H

#include <stddef.h>
#include <stdint.h>
#include <libusb-1.0/libusb.h>

#ifdef __cplusplus
extern "C" {
#endif

/* --- Wire constants (verified, fel.c) --- */
#define FEL_VID 0x1F3A
#define FEL_PID 0xEFE8
#define AW_USB_READ 0x11
#define AW_USB_WRITE 0x12
#define AW_FEL_VERSION 0x001
#define AW_FEL_1_WRITE 0x101
#define AW_FEL_1_EXEC 0x102
#define AW_FEL_1_READ 0x103
/* Upstream uses 60000 ms; v2 keeps the v1 5000 ms fail-fast
 * deviation for single small exchanges (see SOURCES.md). */
#define FEL_TIMEOUT_MS 5000

/* --- H3 addresses (verified, fel.c) --- */
#define H3_SRAM_BASE 0x00000000u
#define H3_SRAM_END 0x00020000u /* exclusive; 128 KiB window used by v2 */
#define H3_SPL_ADDR 0x00000000u
#define H3_SPL_LEN_LIMIT 0x8000u /* 32 KiB, fel.c SPL_LEN_LIMIT */
#define H3_SCRATCH_ADDR 0x00001000u
#define H3_MMU_TT_ADDR 0x00008000u
#define H3_THUNK_ADDR 0x0000A200u
#define H3_THUNK_SIZE 0x200u
#define H3_SID_ADDR 0x01C14200u
#define H3_SID_LEN 16u /* SID_KEY[0-3] */
#define H3_DRAM_BASE 0x40000000u

/* --- v2 limits --- */
#define FEL_READ_MAX_LEN 4096u
#define FEL_WRITE_MAX_LEN 131072u /* 128 KiB */

/* --- Little-endian helpers --- */
void fel_put_le16(unsigned char *p, uint16_t v);
void fel_put_le32(unsigned char *p, uint32_t v);
uint16_t fel_get_le16(const unsigned char *p);
uint32_t fel_get_le32(const unsigned char *p);

/* Parse "0x..." or decimal into a uint32. Returns 0 on success. */
int fel_parse_u32(const char *s, uint32_t *out);
/* Parse a plain decimal length. Returns 0 on success. */
int fel_parse_len(const char *s, uint32_t *out);

/* --- Address allowlist --- */
/* True if [addr, addr+len) lies entirely inside H3 SRAM. */
int fel_in_sram(uint32_t addr, uint32_t len);
/* True if [addr, addr+len) lies entirely inside the SID window. */
int fel_in_sid(uint32_t addr, uint32_t len);
/* True if the range may be FEL_READ (SRAM, or the SID window). */
int fel_read_allowed(uint32_t addr, uint32_t len);
/* True if [addr, addr+len) overlaps a protected BROM region. */
int fel_overlaps_protected(uint32_t addr, uint32_t len);
/* True if the range may be FEL_WRITE (SRAM, no protected overlap,
 * unless spl_flag is set and addr == H3_SPL_ADDR). */
int fel_write_allowed(uint32_t addr, uint32_t len, int spl_flag);

/* --- Crypto / encoding (no external deps; Termux has no libcrypto dev) --- */
void fel_sha256(const unsigned char *data, size_t len,
                unsigned char out[32]);
void fel_sha256_hex(const unsigned char *data, size_t len, char out[65]);
void fel_hex_encode(const unsigned char *data, size_t len, char *out);
char *fel_base64_encode(const unsigned char *data, size_t len);

/* --- Device handling (libusb) --- */
typedef struct {
    libusb_context *ctx;
    libusb_device_handle *handle;
    int bulk_ep_out;
    int bulk_ep_in;
    uint16_t vid;
    uint16_t pid;
} fel_device;

/*
 * Open the device from a termux-usb file descriptor.
 * fd: the USB fd (argv, or $TERMUX_USB_FD). On failure returns -1
 * and writes a short message into err (err_len bytes).
 */
int fel_open(int fd, fel_device *dev, char *err, size_t err_len);
void fel_close(fel_device *dev);

/* --- FEL primitives (each does its own AWUS / status exchange) --- */
int fel_send_request(fel_device *dev, uint32_t type, uint32_t addr,
                     uint32_t len);
int fel_read_status(fel_device *dev);
/* Version reply: 32-byte AW_USB_READ + 8-byte FEL status, after a
 * FEL_VERSION request has already been sent. Used by fel_version.c;
 * the other tools use fel_read_mem / fel_write_mem / fel_exec_mem. */
int fel_read_version_reply(fel_device *dev, unsigned char ver[32]);
int fel_read_mem(fel_device *dev, uint32_t addr, unsigned char *buf,
                 size_t len);
int fel_write_mem(fel_device *dev, uint32_t addr,
                  const unsigned char *buf, size_t len);
int fel_exec_mem(fel_device *dev, uint32_t addr);

/*
 * Resolve the USB fd and the tool's parameters from the command
 * line, accepting the three ways termux-usb can hand a device over:
 *   1. $TERMUX_USB_FD is set (-E form): params are argv[1..] in order.
 *   2. fd is argv[1] (v1 form, proven live on the phone for
 *      fel_version): params are argv[2..] in order.
 *   3. fd is the LAST argv token (termux-usb -e "cmd args" form,
 *      where the fd is appended after the command string):
 *      params are argv[1..n-1] in order.
 * Flags (tokens starting with "--") are collected separately into
 * flags_out (up to max_flags, NULL-terminated).
 * Environment fallbacks (env_names[i] for parameter i, e.g.
 * {"FEL_ADDR", "FEL_LEN"}) are used for any parameter still
 * missing after argv parsing.
 * Returns 0 on success, -1 on failure (usage error).
 */
int fel_resolve_fd_and_params(int argc, char **argv, int nparams,
                              char **params_out, const char **flags_out,
                              int max_flags, const char **env_names,
                              int *fd_out);

/* Print exactly one JSON error object to stdout (v1 convention). */
void fel_print_error(const char *tool, const char *message);

const char *fel_soc_name(uint16_t soc_id);

#ifdef __cplusplus
}
#endif

#endif /* FEL_COMMON_H */

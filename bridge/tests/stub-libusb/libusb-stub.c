/* Minimal libusb-1.0 stub for VM tests of the bridge C tools.
 *
 * It emulates an Allwinner H3 in FEL mode at the bulk-transfer
 * level, well enough for the tools' whole flows:
 *   - VID/PID 0x1F3A/0xEFE8, bulk endpoints 0x01 out / 0x82 in.
 *   - AWUC + FEL request parsing (AW_FEL_VERSION / READ / WRITE
 *     / EXEC), a 128 KiB SRAM store, DRAM writes accepted and
 *     discarded.
 *   - ARM scratch-code effects that the tools depend on, decoded
 *     from the code words written to scratch (0x1000) at EXEC
 *     time: mrc (read_cp_reg) returns canned CP values
 *     (SCTLR 0x00C52878 — the real value from the 2026-11-17
 *     phone run — DACR/TTBCR/TTBR0 tracked from mcr writes),
 *     the stackinfo snippet returns sp_irq 0x2000 / sp 0x5e08
 *     (also the real 2026-11-17 values), and an EXEC at the
 *     thunk address (0xA200) patches the SPL header at 0x4 to
 *     "eGON.FEL", exactly what the real thunk does.
 *   - FEL_VERSION reply: "AWUSBFEX", soc_id 0x1680, scratchpad
 *     0x7e00.
 *
 * Failure injection (env STUB_LIBUSB_FAIL_RECV):
 *   "first" — the first bulk recv in the (shared) run fails with
 *     LIBUSB_ERROR_TIMEOUT, all later recvs succeed. With
 *     STUB_LIBUSB_STATE=<file> the "already dropped" flag is
 *     shared across processes (one drop per fel-auto run);
 *     without it, the flag is per-process.
 *   "all"   — every bulk recv fails (FEL truly dead).
 * This is what the v3.3.1 step-4 retry tests use: "first" must
 * still succeed (attempt 2 of 3), "all" must fail after
 * 3 attempts.
 *
 * This stub is test infrastructure only. It must never be
 * shipped to the phone or linked into a production binary. */

#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "libusb-1.0/libusb.h"

#define AW_USB_READ 0x11
#define AW_USB_WRITE 0x12
#define AW_FEL_VERSION 0x001
#define AW_FEL_1_WRITE 0x101
#define AW_FEL_1_EXEC 0x102
#define AW_FEL_1_READ 0x103

#define H3_SRAM_SIZE 0x20000u
#define H3_SCRATCH_ADDR 0x1000u
#define H3_THUNK_ADDR 0xA200u

static unsigned char sram[H3_SRAM_SIZE];
static uint32_t cp_sctlr = 0x00C52878u;
static uint32_t cp_dacr = 0x55555555u;
static uint32_t cp_ttbcr = 0;
static uint32_t cp_ttbr0 = 0;
static int thunk_executed = 0;

/* Result of the last scratch-code EXEC, for the following READ. */
static int cp_result_valid = 0;
static uint32_t cp_result = 0;
static int si_valid = 0;
static uint32_t si_irq = 0x2000u, si_sp = 0x5e08u;

/* AWUC / FEL request tracking. */
static int awuc_type = 0;          /* last AWUC header type */
static int data_recv_pending = 0;  /* next recv is a data phase */
static int fel_pending = 0;        /* a FEL request was received */
static uint32_t fel_type = 0, fel_addr = 0, fel_len = 0;

/* Failure injection. */
static int recv_count = 0;
static int dropped = 0;
static int fail_mode = 0; /* 0 off, 1 first, 2 all */
static char state_path[512] = "";
static char sram_path[512] = "";

static void load_sram_file(void)
{
    static int loaded = 0;
    const char *sp;
    FILE *f;
    if (loaded) return;
    loaded = 1;
    sp = getenv("STUB_LIBUSB_SRAM_FILE");
    if (!sp || !sp[0]) return;
    if (strlen(sp) >= sizeof(sram_path)) return;
    memcpy(sram_path, sp, strlen(sp) + 1);
    f = fopen(sram_path, "rb");
    if (f) {
        size_t n = fread(sram, 1, sizeof(sram), f);
        (void)n;
        fclose(f);
    }
}

static void save_sram_file(void)
{
    FILE *f;
    if (!sram_path[0]) return;
    f = fopen(sram_path, "wb");
    if (f) {
        size_t n = fwrite(sram, 1, sizeof(sram), f);
        (void)n;
        fclose(f);
    }
}

static uint32_t get_le32(const unsigned char *p)
{
    return ((uint32_t)p[0]) | ((uint32_t)p[1] << 8) |
           ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}
static void put_le32(unsigned char *p, uint32_t v)
{
    p[0] = (unsigned char)(v & 0xff);
    p[1] = (unsigned char)((v >> 8) & 0xff);
    p[2] = (unsigned char)((v >> 16) & 0xff);
    p[3] = (unsigned char)((v >> 24) & 0xff);
}

static void load_fail_state(void)
{
    static int loaded = 0;
    const char *mode, *sp;
    if (loaded) return;
    loaded = 1;
    mode = getenv("STUB_LIBUSB_FAIL_RECV");
    if (mode && strcmp(mode, "first") == 0) fail_mode = 1;
    else if (mode && strcmp(mode, "all") == 0) fail_mode = 2;
    sp = getenv("STUB_LIBUSB_STATE");
    if (sp && sp[0]) {
        size_t n = strlen(sp);
        if (n < sizeof(state_path)) memcpy(state_path, sp, n + 1);
        FILE *f = fopen(state_path, "r");
        if (f) {
            char buf[64];
            if (fgets(buf, sizeof(buf), f) && strstr(buf, "dropped=1"))
                dropped = 1;
            fclose(f);
        }
    }
}

static void save_fail_state(void)
{
    if (!state_path[0]) return;
    FILE *f = fopen(state_path, "w");
    if (f) { fputs("dropped=1\n", f); fclose(f); }
}

/* Decode an mrc/mcr opcode word (fel.c scratch-code helpers).
 * Returns 1 and sets *kind (0 SCTLR, 1 DACR, 2 TTBCR, 3 TTBR0)
 * when the word is a CP15 register access, else 0. */
static int decode_cp_opcode(uint32_t w, int *kind)
{
    unsigned coproc, opc1, crn, crm, opc2;
    if ((w & 0xFF000000u) != 0xEE000000u) return 0;
    if (!((w >> 4) & 1u)) return 0; /* bit 4 must be set (mrc/mcr) */
    coproc = (w >> 8) & 15u;
    opc1 = (w >> 21) & 7u;
    crn = (w >> 16) & 15u;
    crm = w & 15u;
    opc2 = (w >> 5) & 7u;
    if (coproc != 15 || opc1 != 0) return 0;
    if (crn == 1 && crm == 0 && opc2 == 0) { *kind = 0; return 1; }
    if (crn == 3 && crm == 0 && opc2 == 0) { *kind = 1; return 1; }
    if (crn == 2 && crm == 0 && opc2 == 2) { *kind = 2; return 1; }
    if (crn == 2 && crm == 0 && opc2 == 0) { *kind = 3; return 1; }
    return 0;
}

/* Apply the side effect of executing code at `addr`. */
static void exec_side_effect(uint32_t addr)
{
    uint32_t w0, w1;
    int kind;
    if (addr == H3_THUNK_ADDR) {
        /* The real thunk patches eGON.BT0 -> eGON.FEL at 0x4.
         * STUB_LIBUSB_EGON_FAIL=1 disables the patch, so the
         * flow fails at the eGON.FEL check — used by the
         * fel-auto end-to-end run to force a first-candidate
         * failure and exercise diagnostics + the next candidate. */
        const char *nofail = getenv("STUB_LIBUSB_EGON_FAIL");
        thunk_executed = 1;
        if (!nofail || strcmp(nofail, "1") != 0)
            memcpy(sram + 4, "eGON.FEL", 8);
        return;
    }
    if (addr != H3_SCRATCH_ADDR) return;
    w0 = get_le32(sram + H3_SCRATCH_ADDR);
    w1 = get_le32(sram + H3_SCRATCH_ADDR + 4);
    if (w0 == 0xe10f0000u) {
        /* get_stackinfo: mrs r0, CPSR ... str sp, [pc,#4]. */
        si_valid = 1;
        return;
    }
    if (w0 == 0xe59f000cu && decode_cp_opcode(w1, &kind)) {
        /* write_cp_reg: ldr r0,[pc,#12]; mcr ...; value at +20. */
        uint32_t v = get_le32(sram + H3_SCRATCH_ADDR + 20);
        if (kind == 1) cp_dacr = v;
        else if (kind == 2) cp_ttbcr = v;
        else if (kind == 3) cp_ttbr0 = v;
        return;
    }
    if (decode_cp_opcode(w0, &kind)) {
        /* read_cp_reg: mrc ...; str r0,[pc]; result at +12. */
        if (kind == 0) cp_result = cp_sctlr;
        else if (kind == 1) cp_result = cp_dacr;
        else if (kind == 2) cp_result = cp_ttbcr;
        else cp_result = cp_ttbr0;
        cp_result_valid = 1;
        return;
    }
}

/* --- libusb API --- */

int libusb_init(libusb_context **ctx)
{
    load_sram_file();
    if (ctx) *ctx = (libusb_context *)0x1;
    return 0;
}

void libusb_exit(libusb_context *ctx) { (void)ctx; }

int libusb_set_option(libusb_context *ctx, enum libusb_option option, ...)
{
    (void)ctx; (void)option;
    return 0;
}

int libusb_wrap_sys_device(libusb_context *ctx, intptr_t sys_dev,
                           libusb_device_handle **dev_handle)
{
    (void)ctx; (void)sys_dev;
    if (dev_handle) *dev_handle = (libusb_device_handle *)0x2;
    return 0;
}

libusb_device *libusb_get_device(libusb_device_handle *dev_handle)
{
    (void)dev_handle;
    return (libusb_device *)0x3;
}

int libusb_get_device_descriptor(libusb_device *dev, libusb_device_descriptor *desc)
{
    (void)dev;
    if (!desc) return -1;
    memset(desc, 0, sizeof(*desc));
    desc->bLength = 18;
    desc->bDescriptorType = 1;
    desc->idVendor = 0x1F3A;
    desc->idProduct = 0xEFE8;
    desc->bNumConfigurations = 1;
    return 0;
}

int libusb_claim_interface(libusb_device_handle *dev_handle, int interface_number)
{
    (void)dev_handle; (void)interface_number;
    return 0;
}

int libusb_release_interface(libusb_device_handle *dev_handle, int interface_number)
{
    (void)dev_handle; (void)interface_number;
    return 0;
}

static libusb_endpoint_descriptor stub_eps[2] = {
    { 7, 5, 0x01, 0x02, 64, 0, 0, 0, NULL, 0 },
    { 7, 5, 0x82, 0x02, 64, 0, 0, 0, NULL, 0 },
};
static libusb_interface_descriptor stub_alt = {
    9, 4, 0, 0, 2, 0xFF, 0xFF, 0xFF, 0, stub_eps, NULL, 0,
};
static libusb_interface stub_iface = { &stub_alt, 1 };
static libusb_config_descriptor stub_cfg = {
    9, 2, 0, 1, 1, 0, 0x80, 250, &stub_iface, NULL, 0,
};

int libusb_get_active_config_descriptor(libusb_device *dev, libusb_config_descriptor **config)
{
    (void)dev;
    if (!config) return -1;
    *config = &stub_cfg;
    return 0;
}

int libusb_get_config_descriptor(libusb_device *dev, uint8_t config_index, libusb_config_descriptor **config)
{
    (void)config_index;
    return libusb_get_active_config_descriptor(dev, config);
}

void libusb_free_config_descriptor(libusb_config_descriptor *config)
{
    (void)config;
}

int libusb_bulk_transfer(libusb_device_handle *dev_handle, unsigned char endpoint,
                         unsigned char *data, int length, int *actual_length,
                         unsigned int timeout)
{
    (void)dev_handle; (void)timeout;
    load_fail_state();
    if (endpoint & 0x80) {
        /* IN: a recv. */
        recv_count++;
        if (fail_mode == 2 || (fail_mode == 1 && !dropped)) {
            dropped = 1;
            save_fail_state();
            /* The in-flight exchange is aborted; the tool
             * retries from scratch. */
            data_recv_pending = 0;
            fel_pending = 0;
            if (actual_length) *actual_length = 0;
            return LIBUSB_ERROR_TIMEOUT;
        }
        {
            /* STUB_LIBUSB_EGON_READ_FAIL=1: reads of the SPL
             * header at 0x4 always time out, so the eGON.FEL
             * read-back fails after 3 attempts — the exact
             * 336/300 MHz live shape. Used by the fel-auto
             * end-to-end run to force a first-candidate failure. */
            const char *erf = getenv("STUB_LIBUSB_EGON_READ_FAIL");
            if (erf && strcmp(erf, "1") == 0 && data_recv_pending &&
                fel_pending && fel_type == AW_FEL_1_READ &&
                fel_addr == 4 && fel_len == 8) {
                data_recv_pending = 0;
                fel_pending = 0;
                if (actual_length) *actual_length = 0;
                return LIBUSB_ERROR_TIMEOUT;
            }
        }
        if (data_recv_pending) {
            data_recv_pending = 0;
            if (fel_pending && fel_type == AW_FEL_1_READ) {
                /* Data phase of a FEL READ. */
                if (fel_addr == H3_SCRATCH_ADDR + 12 && cp_result_valid && (uint32_t)length >= 4) {
                    put_le32(data, cp_result);
                    if (length > 4) memset(data + 4, 0, (size_t)(length - 4));
                    cp_result_valid = 0;
                } else if (fel_addr == H3_SCRATCH_ADDR + 0x24 && si_valid && (uint32_t)length >= 8) {
                    put_le32(data, si_irq);
                    put_le32(data + 4, si_sp);
                    if (length > 8) memset(data + 8, 0, (size_t)(length - 8));
                    si_valid = 0;
                } else if (fel_addr < H3_SRAM_SIZE) {
                    size_t n = (size_t)length;
                    if (fel_addr + n > H3_SRAM_SIZE) n = H3_SRAM_SIZE - fel_addr;
                    memcpy(data, sram + fel_addr, n);
                    if ((size_t)length > n) memset(data + n, 0, (size_t)length - n);
                } else {
                    memset(data, 0, (size_t)length);
                }
                fel_pending = 0;
            } else if (!fel_pending && length == 32) {
                /* FEL_VERSION reply (raw USB read, no FEL req). */
                memset(data, 0, (size_t)length);
                memcpy(data, "AWUSBFEX", 8);
                put_le32(data + 8, 0x00168000u);
                put_le32(data + 20, 0x00007e00u);
            } else {
                /* FEL status / anything else: zeros. */
                memset(data, 0, (size_t)length);
            }
        } else {
            /* AWUS status reply (13 bytes). A VERSION or EXEC FEL
             * request is complete once its status reply arrives;
             * a WRITE request stays pending until its data phase
             * and a READ request until its data phase. */
            if (fel_pending && (fel_type == AW_FEL_VERSION || fel_type == AW_FEL_1_EXEC))
                fel_pending = 0;
            memset(data, 0, (size_t)length);
            if (length >= 4) memcpy(data, "AWUS", 4);
        }
        if (actual_length) *actual_length = length;
        return 0;
    }
    /* OUT: a send. */
    if (length == 32 && memcmp(data, "AWUC", 4) == 0) {
        awuc_type = (int)((unsigned)data[16] | ((unsigned)data[17] << 8));
        if (awuc_type == AW_USB_READ) data_recv_pending = 1;
        if (actual_length) *actual_length = length;
        return 0;
    }
    if (awuc_type == AW_USB_WRITE && length == 16 && !fel_pending) {
        /* A 16-byte FEL request. */
        fel_type = get_le32(data);
        fel_addr = get_le32(data + 4);
        fel_len = get_le32(data + 8);
        fel_pending = 1;
        if (fel_type == AW_FEL_1_EXEC) exec_side_effect(fel_addr);
        if (actual_length) *actual_length = length;
        return 0;
    }
    if (awuc_type == AW_USB_WRITE && fel_pending && fel_type == AW_FEL_1_WRITE) {
        /* Data phase of a FEL WRITE: store into SRAM. */
        if (fel_addr < H3_SRAM_SIZE) {
            size_t n = (size_t)length;
            if (fel_addr + n > H3_SRAM_SIZE) n = H3_SRAM_SIZE - fel_addr;
            memcpy(sram + fel_addr, data, n);
            save_sram_file();
        }
        fel_pending = 0;
        if (actual_length) *actual_length = length;
        return 0;
    }
    if (actual_length) *actual_length = length;
    return 0;
}

void libusb_close(libusb_device_handle *dev_handle)
{
    (void)dev_handle;
}

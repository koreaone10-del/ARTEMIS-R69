/*
 * fel_common.c -- shared Allwinner FEL transport for the ARTEMIS
 * Termux bridge v2. See fel_common.h for the verified sources and
 * the safety allowlist. SPDX-License-Identifier: GPL-2.0-or-later.
 */

#include "fel_common.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <libusb-1.0/libusb.h>

/* ---------- little-endian helpers ---------- */

void fel_put_le16(unsigned char *p, uint16_t v)
{
    p[0] = (unsigned char)(v & 0xff);
    p[1] = (unsigned char)((v >> 8) & 0xff);
}

void fel_put_le32(unsigned char *p, uint32_t v)
{
    p[0] = (unsigned char)(v & 0xff);
    p[1] = (unsigned char)((v >> 8) & 0xff);
    p[2] = (unsigned char)((v >> 16) & 0xff);
    p[3] = (unsigned char)((v >> 24) & 0xff);
}

uint16_t fel_get_le16(const unsigned char *p)
{
    return (uint16_t)(p[0] | (p[1] << 8));
}

uint32_t fel_get_le32(const unsigned char *p)
{
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) |
           ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

int fel_parse_u32(const char *s, uint32_t *out)
{
    char *end = NULL;
    unsigned long v;
    if (!s || !*s || !out)
        return -1;
    v = strtoul(s, &end, 0);
    if (!end || *end != '\0' || v > 0xffffffffUL)
        return -1;
    *out = (uint32_t)v;
    return 0;
}

int fel_parse_len(const char *s, uint32_t *out)
{
    char *end = NULL;
    unsigned long v;
    if (!s || !*s || !out)
        return -1;
    v = strtoul(s, &end, 10);
    if (!end || *end != '\0' || v > 0xffffffffUL)
        return -1;
    *out = (uint32_t)v;
    return 0;
}

/* ---------- address allowlist ---------- */

int fel_in_sram(uint32_t addr, uint32_t len)
{
    if (len == 0)
        return 0;
    if (addr >= H3_SRAM_END)
        return 0;
    if ((uint64_t)addr + len > H3_SRAM_END)
        return 0;
    return 1;
}

int fel_in_sid(uint32_t addr, uint32_t len)
{
    if (len == 0)
        return 0;
    if (addr < H3_SID_ADDR || addr >= H3_SID_ADDR + H3_SID_LEN)
        return 0;
    if ((uint64_t)addr + len > H3_SID_ADDR + H3_SID_LEN)
        return 0;
    return 1;
}

int fel_read_allowed(uint32_t addr, uint32_t len)
{
    return fel_in_sram(addr, len) || fel_in_sid(addr, len);
}

/* Protected BROM regions on H3 (fel.c a10_a13_a20_sram_swap_buffers
 * + the comment at fel.c L895-911). Half-open intervals. */
static const struct { uint32_t start, end; } protected_ranges[] = {
    { 0x1C00, 0x2000 }, /* BROM IRQ stack */
    { 0x5C00, 0x7000 }, /* BROM stack */
    { 0x7C00, 0x8000 }, /* "something important"; FEL_VERSION scratchpad 0x7E00 */
    { 0x8000, 0xC000 }, /* MMU translation table (0x8000) + thunk (0xA200) */
};

int fel_overlaps_protected(uint32_t addr, uint32_t len)
{
    size_t i;
    if (len == 0)
        return 0;
    for (i = 0; i < sizeof(protected_ranges) / sizeof(protected_ranges[0]); i++) {
        if (addr < protected_ranges[i].end &&
            (uint64_t)addr + len > protected_ranges[i].start)
            return 1;
    }
    return 0;
}

int fel_write_allowed(uint32_t addr, uint32_t len, int spl_flag)
{
    if (len == 0 || len > FEL_WRITE_MAX_LEN)
        return 0;
    if (!fel_in_sram(addr, len))
        return 0;
    if (fel_overlaps_protected(addr, len)) {
        /* Only a write starting exactly at the SPL load address,
         * explicitly flagged --spl, is allowed through. See the
         * header comment: v2 does not do upstream's stack
         * swap/thunk, so this is UNVERIFIED and risky. */
        if (spl_flag && addr == H3_SPL_ADDR)
            return 1;
        return 0;
    }
    return 1;
}

/* ---------- SHA-256 (FIPS 180-4, self-contained) ---------- */

typedef struct {
    uint32_t h[8];
    uint64_t len;
    unsigned char buf[64];
    size_t buflen;
} sha256_ctx;

static const uint32_t sha256_k[64] = {
    0x428a2f98u, 0x71374491u, 0xb5c0fbcfu, 0xe9b5dba5u,
    0x3956c25bu, 0x59f111f1u, 0x923f82a4u, 0xab1c5ed5u,
    0xd807aa98u, 0x12835b01u, 0x243185beu, 0x550c7dc3u,
    0x72be5d74u, 0x80deb1feu, 0x9bdc06a7u, 0xc19bf174u,
    0xe49b69c1u, 0xefbe4786u, 0x0fc19dc6u, 0x240ca1ccu,
    0x2de92c6fu, 0x4a7484aau, 0x5cb0a9dcu, 0x76f988dau,
    0x983e5152u, 0xa831c66du, 0xb00327c8u, 0xbf597fc7u,
    0xc6e00bf3u, 0xd5a79147u, 0x06ca6351u, 0x14292967u,
    0x27b70a85u, 0x2e1b2138u, 0x4d2c6dfcu, 0x53380d13u,
    0x650a7354u, 0x766a0abbu, 0x81c2c92eu, 0x92722c85u,
    0xa2bfe8a1u, 0xa81a664bu, 0xc24b8b70u, 0xc76c51a3u,
    0xd192e819u, 0xd6990624u, 0xf40e3585u, 0x106aa070u,
    0x19a4c116u, 0x1e376c08u, 0x2748774cu, 0x34b0bcb5u,
    0x391c0cb3u, 0x4ed8aa4au, 0x5b9cca4fu, 0x682e6ff3u,
    0x748f82eeu, 0x78a5636fu, 0x84c87814u, 0x8cc70208u,
    0x90befffau, 0xa4506cebu, 0xbef9a3f7u, 0xc67178f2u,
};

#define ROR32(x, n) (((x) >> (n)) | ((x) << (32 - (n))))

static void sha256_block(sha256_ctx *c, const unsigned char *p)
{
    uint32_t w[64];
    uint32_t a, b, cc, d, e, f, g, h;
    int i;
    for (i = 0; i < 16; i++)
        w[i] = ((uint32_t)p[i * 4] << 24) | ((uint32_t)p[i * 4 + 1] << 16) |
               ((uint32_t)p[i * 4 + 2] << 8) | (uint32_t)p[i * 4 + 3];
    for (i = 16; i < 64; i++) {
        uint32_t s0 = ROR32(w[i - 15], 7) ^ ROR32(w[i - 15], 18) ^ (w[i - 15] >> 3);
        uint32_t s1 = ROR32(w[i - 2], 17) ^ ROR32(w[i - 2], 19) ^ (w[i - 2] >> 10);
        w[i] = w[i - 16] + s0 + w[i - 7] + s1;
    }
    a = c->h[0]; b = c->h[1]; cc = c->h[2]; d = c->h[3];
    e = c->h[4]; f = c->h[5]; g = c->h[6]; h = c->h[7];
    for (i = 0; i < 64; i++) {
        uint32_t s1 = ROR32(e, 6) ^ ROR32(e, 11) ^ ROR32(e, 25);
        uint32_t ch = (e & f) ^ ((~e) & g);
        uint32_t t1 = h + s1 + ch + sha256_k[i] + w[i];
        uint32_t s0 = ROR32(a, 2) ^ ROR32(a, 13) ^ ROR32(a, 22);
        uint32_t maj = (a & b) ^ (a & cc) ^ (b & cc);
        uint32_t t2 = s0 + maj;
        h = g; g = f; f = e; e = d + t1;
        d = cc; cc = b; b = a; a = t1 + t2;
    }
    c->h[0] += a; c->h[1] += b; c->h[2] += cc; c->h[3] += d;
    c->h[4] += e; c->h[5] += f; c->h[6] += g; c->h[7] += h;
}

static void sha256_init(sha256_ctx *c)
{
    c->h[0] = 0x6a09e667u; c->h[1] = 0xbb67ae85u;
    c->h[2] = 0x3c6ef372u; c->h[3] = 0xa54ff53au;
    c->h[4] = 0x510e527fu; c->h[5] = 0x9b05688cu;
    c->h[6] = 0x1f83d9abu; c->h[7] = 0x5be0cd19u;
    c->len = 0;
    c->buflen = 0;
}

static void sha256_update(sha256_ctx *c, const unsigned char *data, size_t len)
{
    c->len += len;
    while (len > 0) {
        size_t take = 64 - c->buflen;
        if (take > len)
            take = len;
        memcpy(c->buf + c->buflen, data, take);
        c->buflen += take;
        data += take;
        len -= take;
        if (c->buflen == 64) {
            sha256_block(c, c->buf);
            c->buflen = 0;
        }
    }
}

static void sha256_final(sha256_ctx *c, unsigned char out[32])
{
    uint64_t bits = c->len * 8;
    unsigned char pad = 0x80;
    unsigned char zero = 0x00;
    int i;
    sha256_update(c, &pad, 1);
    while (c->buflen != 56)
        sha256_update(c, &zero, 1);
    /* Length in bits, big-endian, appended without counting it. */
    {
        unsigned char lb[8];
        for (i = 0; i < 8; i++)
            lb[i] = (unsigned char)((bits >> (56 - 8 * i)) & 0xff);
        /* Feed directly: buflen is 56, so this completes the block. */
        memcpy(c->buf + c->buflen, lb, 8);
        sha256_block(c, c->buf);
        c->buflen = 0;
    }
    for (i = 0; i < 8; i++) {
        out[i * 4] = (unsigned char)((c->h[i] >> 24) & 0xff);
        out[i * 4 + 1] = (unsigned char)((c->h[i] >> 16) & 0xff);
        out[i * 4 + 2] = (unsigned char)((c->h[i] >> 8) & 0xff);
        out[i * 4 + 3] = (unsigned char)(c->h[i] & 0xff);
    }
}

void fel_sha256(const unsigned char *data, size_t len, unsigned char out[32])
{
    sha256_ctx c;
    sha256_init(&c);
    if (len > 0)
        sha256_update(&c, data, len);
    sha256_final(&c, out);
}

void fel_sha256_hex(const unsigned char *data, size_t len, char out[65])
{
    unsigned char digest[32];
    int i;
    fel_sha256(data, len, digest);
    for (i = 0; i < 32; i++)
        sprintf(out + i * 2, "%02x", digest[i]);
    out[64] = '\0';
}

void fel_hex_encode(const unsigned char *data, size_t len, char *out)
{
    size_t i;
    for (i = 0; i < len; i++)
        sprintf(out + i * 2, "%02x", data[i]);
    out[len * 2] = '\0';
}

char *fel_base64_encode(const unsigned char *data, size_t len)
{
    static const char tbl[] =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    size_t outlen = ((len + 2) / 3) * 4 + 1;
    char *out = malloc(outlen);
    size_t i, o = 0;
    if (!out)
        return NULL;
    for (i = 0; i < len; i += 3) {
        uint32_t n = (uint32_t)data[i] << 16;
        int rem = (int)(len - i);
        if (rem > 1)
            n |= (uint32_t)data[i + 1] << 8;
        if (rem > 2)
            n |= data[i + 2];
        out[o++] = tbl[(n >> 18) & 63];
        out[o++] = tbl[(n >> 12) & 63];
        out[o++] = rem > 1 ? tbl[(n >> 6) & 63] : '=';
        out[o++] = rem > 2 ? tbl[n & 63] : '=';
    }
    out[o] = '\0';
    return out;
}

/* ---------- device handling ---------- */

static int bulk_send(fel_device *dev, int ep, const unsigned char *data,
                     size_t len)
{
    while (len > 0) {
        int sent = 0;
        int rc = libusb_bulk_transfer(dev->handle, ep,
                                      (unsigned char *)data, (int)len,
                                      &sent, FEL_TIMEOUT_MS);
        if (rc != 0 || sent <= 0)
            return -1;
        len -= (size_t)sent;
        data += sent;
    }
    return 0;
}

static int bulk_recv(fel_device *dev, int ep, unsigned char *data, size_t len)
{
    while (len > 0) {
        int got = 0;
        int rc = libusb_bulk_transfer(dev->handle, ep, data, (int)len,
                                      &got, FEL_TIMEOUT_MS);
        if (rc != 0 || got <= 0)
            return -1;
        len -= (size_t)got;
        data += got;
    }
    return 0;
}

static int discover_endpoints(fel_device *dev)
{
    libusb_device *usbdev = libusb_get_device(dev->handle);
    struct libusb_config_descriptor *cfg = NULL;
    int rc = libusb_get_active_config_descriptor(usbdev, &cfg);
    int i, a, e;
    if (rc != 0 || !cfg) {
        rc = libusb_get_config_descriptor(usbdev, 0, &cfg);
        if (rc != 0 || !cfg)
            return -1;
    }
    dev->bulk_ep_out = 0;
    dev->bulk_ep_in = 0;
    for (i = 0; i < cfg->bNumInterfaces; i++) {
        const struct libusb_interface *iface = &cfg->interface[i];
        for (a = 0; a < iface->num_altsetting; a++) {
            const struct libusb_interface_descriptor *alt =
                &iface->altsetting[a];
            for (e = 0; e < alt->bNumEndpoints; e++) {
                const struct libusb_endpoint_descriptor *ep =
                    &alt->endpoint[e];
                if ((ep->bmAttributes & 0x03) != 0x02)
                    continue; /* not bulk */
                if (ep->bEndpointAddress & 0x80)
                    dev->bulk_ep_in = ep->bEndpointAddress;
                else
                    dev->bulk_ep_out = ep->bEndpointAddress;
            }
        }
    }
    libusb_free_config_descriptor(cfg);
    return (dev->bulk_ep_out != 0 && dev->bulk_ep_in != 0) ? 0 : -1;
}

int fel_open(int fd, fel_device *dev, char *err, size_t err_len)
{
    struct libusb_device_descriptor desc;
    memset(dev, 0, sizeof(*dev));
    if (fd < 0) {
        snprintf(err, err_len, "usb file descriptor required");
        return -1;
    }
    libusb_set_option(NULL, LIBUSB_OPTION_NO_DEVICE_DISCOVERY);
    if (libusb_init(&dev->ctx) != 0) {
        snprintf(err, err_len, "libusb_init failed");
        return -1;
    }
    if (libusb_wrap_sys_device(dev->ctx, (intptr_t)fd, &dev->handle) != 0) {
        snprintf(err, err_len, "libusb_wrap_sys_device failed");
        libusb_exit(dev->ctx);
        return -1;
    }
    if (libusb_get_device_descriptor(libusb_get_device(dev->handle),
                                     &desc) != 0) {
        snprintf(err, err_len, "cannot read usb device descriptor");
        libusb_close(dev->handle);
        libusb_exit(dev->ctx);
        return -1;
    }
    dev->vid = desc.idVendor;
    dev->pid = desc.idProduct;
    if (desc.idVendor != FEL_VID || desc.idProduct != FEL_PID) {
        snprintf(err, err_len,
                 "not a fel device (vid 0x%04x pid 0x%04x)",
                 desc.idVendor, desc.idProduct);
        libusb_close(dev->handle);
        libusb_exit(dev->ctx);
        return -1;
    }
    if (libusb_claim_interface(dev->handle, 0) != 0) {
        snprintf(err, err_len, "libusb_claim_interface(0) failed");
        libusb_close(dev->handle);
        libusb_exit(dev->ctx);
        return -1;
    }
    if (discover_endpoints(dev) != 0) {
        snprintf(err, err_len, "no bulk in/out endpoints found");
        libusb_release_interface(dev->handle, 0);
        libusb_close(dev->handle);
        libusb_exit(dev->ctx);
        return -1;
    }
    return 0;
}

void fel_close(fel_device *dev)
{
    if (!dev || !dev->handle)
        return;
    libusb_release_interface(dev->handle, 0);
    libusb_close(dev->handle);
    if (dev->ctx)
        libusb_exit(dev->ctx);
    memset(dev, 0, sizeof(*dev));
}

/* ---------- FEL primitives ---------- */

/* One AWUC USB request: 32 bytes (fel.c aw_usb_request). */
static int send_usb_request(fel_device *dev, int type, uint32_t length)
{
    unsigned char req[32];
    memset(req, 0, sizeof(req));
    memcpy(req, "AWUC", 4);
    fel_put_le32(req + 8, length);
    fel_put_le32(req + 12, 0x0c000000u);
    fel_put_le16(req + 16, (uint16_t)type);
    fel_put_le32(req + 18, length);
    return bulk_send(dev, dev->bulk_ep_out, req, sizeof(req));
}

static int read_usb_response(fel_device *dev)
{
    unsigned char buf[13];
    if (bulk_recv(dev, dev->bulk_ep_in, buf, sizeof(buf)) != 0)
        return -1;
    if (memcmp(buf, "AWUS", 4) != 0)
        return -1;
    return 0;
}

static int fel_usb_write(fel_device *dev, const unsigned char *data,
                         size_t len)
{
    if (send_usb_request(dev, AW_USB_WRITE, (uint32_t)len) != 0)
        return -1;
    if (bulk_send(dev, dev->bulk_ep_out, data, len) != 0)
        return -1;
    return read_usb_response(dev);
}

static int fel_usb_read(fel_device *dev, unsigned char *data, size_t len)
{
    if (send_usb_request(dev, AW_USB_READ, (uint32_t)len) != 0)
        return -1;
    if (bulk_recv(dev, dev->bulk_ep_in, data, len) != 0)
        return -1;
    return read_usb_response(dev);
}

int fel_read_status(fel_device *dev)
{
    unsigned char buf[8];
    return fel_usb_read(dev, buf, sizeof(buf));
}

/* One FEL request, 16 bytes (fel.c aw_fel_request). */
int fel_send_request(fel_device *dev, uint32_t type, uint32_t addr,
                     uint32_t len)
{
    unsigned char req[16];
    memset(req, 0, sizeof(req));
    fel_put_le32(req + 0, type);
    fel_put_le32(req + 4, addr);
    fel_put_le32(req + 8, len);
    fel_put_le32(req + 12, 0);
    return fel_usb_write(dev, req, sizeof(req));
}

int fel_read_version_reply(fel_device *dev, unsigned char ver[32])
{
    if (fel_usb_read(dev, ver, 32) != 0)
        return -1;
    return fel_read_status(dev);
}

int fel_read_mem(fel_device *dev, uint32_t addr, unsigned char *buf,
                 size_t len)
{
    if (fel_send_request(dev, AW_FEL_1_READ, addr, (uint32_t)len) != 0)
        return -1;
    if (fel_usb_read(dev, buf, len) != 0)
        return -1;
    return fel_read_status(dev);
}

int fel_write_mem(fel_device *dev, uint32_t addr,
                  const unsigned char *buf, size_t len)
{
    if (fel_send_request(dev, AW_FEL_1_WRITE, addr, (uint32_t)len) != 0)
        return -1;
    if (fel_usb_write(dev, buf, len) != 0)
        return -1;
    return fel_read_status(dev);
}

int fel_exec_mem(fel_device *dev, uint32_t addr)
{
    if (fel_send_request(dev, AW_FEL_1_EXEC, addr, 0) != 0)
        return -1;
    return fel_read_status(dev);
}

/* ---------- fd / parameter resolution ---------- */

static int token_is_decimal_fd(const char *s, long *out)
{
    char *end = NULL;
    long v;
    if (!s || !*s)
        return 0;
    if (s[0] == '-' || (s[0] == '0' && (s[1] == 'x' || s[1] == 'X')))
        return 0;
    v = strtol(s, &end, 10);
    if (!end || *end != '\0' || v < 0 || v > 0x7fffffffL)
        return 0;
    if (out)
        *out = v;
    return 1;
}

int fel_resolve_fd_and_params(int argc, char **argv, int nparams,
                              char **params_out, const char **flags_out,
                              int max_flags, const char **env_names,
                              int *fd_out)
{
    int fd = -1;
    int fd_index = -1; /* argv index of the fd, -1 = from environment */
    int i, nflags = 0, npar = 0;
    const char *env;
    long v;

    for (i = 0; i < nparams; i++)
        params_out[i] = NULL;
    if (flags_out) {
        for (i = 0; i < max_flags; i++)
            flags_out[i] = NULL;
    }

    env = getenv("TERMUX_USB_FD");
    if (env && env[0] && token_is_decimal_fd(env, &v)) {
        fd = (int)v;
        fd_index = -1;
    } else if (argc >= 2 && token_is_decimal_fd(argv[1], &v)) {
        /* v1 form: fd first. */
        fd = (int)v;
        fd_index = 1;
    } else if (argc >= 2 && token_is_decimal_fd(argv[argc - 1], &v)) {
        /* termux-usb -e "cmd args" form: fd appended last. */
        fd = (int)v;
        fd_index = argc - 1;
    } else {
        /* v3.1: flags may precede the fd (e.g. fel_spl_uboot
         * --validate-only <fd> <file>): skip leading "--" tokens
         * when looking for the fd-first form. */
        for (i = 1; i < argc; i++) {
            if (argv[i][0] == '-' && argv[i][1] == '-')
                continue;
            if (token_is_decimal_fd(argv[i], &v)) {
                fd = (int)v;
                fd_index = i;
            }
            break;
        }
    }
    if (fd < 0)
        return -1;

    /* Collect the non-fd, non-flag tokens in order. */
    for (i = 1; i < argc; i++) {
        if (i == fd_index)
            continue;
        if (argv[i][0] == '-' && argv[i][1] == '-') {
            if (flags_out && nflags < max_flags - 1)
                flags_out[nflags++] = argv[i];
            continue;
        }
        if (npar < nparams)
            params_out[npar++] = argv[i];
        else
            return -1; /* too many parameters */
    }
    if (flags_out && nflags < max_flags)
        flags_out[nflags] = NULL;

    /* Environment fallbacks for parameters not given on argv. */
    if (env_names) {
        for (i = npar; i < nparams; i++) {
            env = getenv(env_names[i]);
            if (env && env[0])
                params_out[i] = (char *)env;
        }
    }
    for (i = 0; i < nparams; i++) {
        if (!params_out[i])
            return -1;
    }
    *fd_out = fd;
    return 0;
}

void fel_print_error(const char *tool, const char *message)
{
    printf("{\"ok\":false,\"tool\":\"%s\",\"error\":\"%s\"}\n",
           tool ? tool : "fel", message ? message : "unknown error");
    fflush(stdout);
}

const char *fel_soc_name(uint16_t soc_id)
{
    switch (soc_id) {
    case 0x1623: return "A10";
    case 0x1625: return "A13";
    case 0x1633: return "A31";
    case 0x1651: return "A20";
    case 0x1650: return "A23";
    case 0x1689: return "A64";
    case 0x1639: return "A80";
    case 0x1667: return "A33";
    case 0x1673: return "A83T";
    case 0x1680: return "H3";
    default: return "unknown";
    }
}

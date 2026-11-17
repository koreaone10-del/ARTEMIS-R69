/*
 * fel_version.c -- minimal read-only Allwinner FEL_VERSION client
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
 * This file is an original minimal implementation of the FEL_VERSION
 * exchange only. It deliberately does NOT implement FEL_WRITE (0x101),
 * FEL_EXEC (0x102) or FEL_READ (0x103): those constants are not defined
 * here, and this program never sends them.
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
 * UNVERIFIED ON A REAL R69 (2026-11-17): this program has never been
 * run against a live H3 in FEL mode. In particular, whether
 * libusb_claim_interface() succeeds on a termux-usb wrapped handle on
 * the user's Samsung phone, and whether the 5 s timeout is enough on
 * that phone, are both untested. A failure is reported as JSON with
 * ok:false; it is never reported as a successful version read.
 */

#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <libusb-1.0/libusb.h>

/* Verified against sunxi-tools fel.c (master). See bridge/docs/SOURCES.md. */
#define AW_USB_VENDOR_ID  0x1F3A
#define AW_USB_PRODUCT_ID 0xEFE8
#define AW_USB_READ       0x11
#define AW_USB_WRITE      0x12
#define AW_FEL_VERSION    0x001
/* Timeout: upstream sunxi-fel uses 60000 ms. This tool uses 5000 ms
 * for a single small version exchange, so a stuck device fails fast
 * instead of hanging the bridge server. Documented deviation. */
#define FEL_TIMEOUT_MS 5000

static int bulk_ep_out = 0;
static int bulk_ep_in = 0;

static void print_error(const char *message)
{
    printf("{\"ok\":false,\"tool\":\"fel_version\",\"error\":\"%s\"}\n",
           message ? message : "unknown error");
    fflush(stdout);
}

/* Little-endian helpers, written out explicitly so the wire format
 * does not depend on host <endian.h> availability in Termux. */
static void put_le16(unsigned char *p, uint16_t v)
{
    p[0] = (unsigned char)(v & 0xff);
    p[1] = (unsigned char)((v >> 8) & 0xff);
}

static void put_le32(unsigned char *p, uint32_t v)
{
    p[0] = (unsigned char)(v & 0xff);
    p[1] = (unsigned char)((v >> 8) & 0xff);
    p[2] = (unsigned char)((v >> 16) & 0xff);
    p[3] = (unsigned char)((v >> 24) & 0xff);
}

static uint16_t get_le16(const unsigned char *p)
{
    return (uint16_t)(p[0] | (p[1] << 8));
}

static uint32_t get_le32(const unsigned char *p)
{
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) |
           ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

static int bulk_send(libusb_device_handle *h, int ep,
                     const unsigned char *data, size_t len)
{
    while (len > 0) {
        int sent = 0;
        int rc = libusb_bulk_transfer(h, ep, (unsigned char *)data,
                                      (int)len, &sent, FEL_TIMEOUT_MS);
        if (rc != 0 || sent <= 0)
            return -1;
        len -= (size_t)sent;
        data += sent;
    }
    return 0;
}

static int bulk_recv(libusb_device_handle *h, int ep,
                     unsigned char *data, size_t len)
{
    while (len > 0) {
        int got = 0;
        int rc = libusb_bulk_transfer(h, ep, data,
                                      (int)len, &got, FEL_TIMEOUT_MS);
        if (rc != 0 || got <= 0)
            return -1;
        len -= (size_t)got;
        data += got;
    }
    return 0;
}

/* One AWUC USB request: 32 bytes, packed, explicit offsets.
 *   0..7   signature "AWUC" (padded with zeros)
 *   8..11  length (LE32)
 *   12..15 unknown1 = 0x0c000000 (LE32)
 *   16..17 request (LE16)
 *   18..21 length2 = length (LE32)
 *   22..31 pad (zeros)
 */
static int send_usb_request(libusb_device_handle *h, int type, uint32_t length)
{
    unsigned char req[32];
    memset(req, 0, sizeof(req));
    memcpy(req, "AWUC", 4);
    put_le32(req + 8, length);
    put_le32(req + 12, 0x0c000000u);
    put_le16(req + 16, (uint16_t)type);
    put_le32(req + 18, length);
    return bulk_send(h, bulk_ep_out, req, sizeof(req));
}

static int read_usb_response(libusb_device_handle *h)
{
    unsigned char buf[13];
    if (bulk_recv(h, bulk_ep_in, buf, sizeof(buf)) != 0)
        return -1;
    if (memcmp(buf, "AWUS", 4) != 0)
        return -1;
    return 0;
}

/* aw_usb_write in sunxi-tools: AWUC WRITE, bulk OUT data, AWUS reply. */
static int fel_usb_write(libusb_device_handle *h,
                         const unsigned char *data, size_t len)
{
    if (send_usb_request(h, AW_USB_WRITE, (uint32_t)len) != 0)
        return -1;
    if (bulk_send(h, bulk_ep_out, data, len) != 0)
        return -1;
    return read_usb_response(h);
}

/* aw_usb_read in sunxi-tools: AWUC READ, bulk IN data, AWUS reply. */
static int fel_usb_read(libusb_device_handle *h,
                        unsigned char *data, size_t len)
{
    if (send_usb_request(h, AW_USB_READ, (uint32_t)len) != 0)
        return -1;
    if (bulk_recv(h, bulk_ep_in, data, len) != 0)
        return -1;
    return read_usb_response(h);
}

static int read_fel_status(libusb_device_handle *h)
{
    unsigned char buf[8];
    return fel_usb_read(h, buf, sizeof(buf));
}

/* Discover bulk endpoints at runtime from the active configuration,
 * exactly as sunxi-tools aw_fel_get_endpoint() does. Endpoints are
 * NOT hardcoded: older sunxi code used OUT 0x01 / IN 0x82, but the
 * current upstream discovers them, and this tool follows current
 * upstream. If the active configuration cannot be read, fall back
 * to configuration 0. */
static int discover_endpoints(libusb_device_handle *h)
{
    libusb_device *dev = libusb_get_device(h);
    struct libusb_config_descriptor *cfg = NULL;
    int rc = libusb_get_active_config_descriptor(dev, &cfg);
    if (rc != 0 || !cfg) {
        rc = libusb_get_config_descriptor(dev, 0, &cfg);
        if (rc != 0 || !cfg)
            return -1;
    }
    bulk_ep_out = 0;
    bulk_ep_in = 0;
    for (int i = 0; i < cfg->bNumInterfaces; i++) {
        const struct libusb_interface *iface = &cfg->interface[i];
        for (int a = 0; a < iface->num_altsetting; a++) {
            const struct libusb_interface_descriptor *alt =
                &iface->altsetting[a];
            for (int e = 0; e < alt->bNumEndpoints; e++) {
                const struct libusb_endpoint_descriptor *ep =
                    &alt->endpoint[e];
                if ((ep->bmAttributes & 0x03) != 0x02)
                    continue; /* not bulk */
                if (ep->bEndpointAddress & 0x80)
                    bulk_ep_in = ep->bEndpointAddress;
                else
                    bulk_ep_out = ep->bEndpointAddress;
            }
        }
    }
    libusb_free_config_descriptor(cfg);
    return (bulk_ep_out != 0 && bulk_ep_in != 0) ? 0 : -1;
}

static const char *soc_name(uint16_t soc_id)
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

int main(int argc, char **argv)
{
    int fd = -1;
    if (argc >= 2 && argv[1][0]) {
        char *end = NULL;
        long v = strtol(argv[1], &end, 10);
        if (end && *end == '\0' && v >= 0)
            fd = (int)v;
    }
    if (fd < 0) {
        const char *env = getenv("TERMUX_USB_FD");
        if (env && env[0]) {
            char *end = NULL;
            long v = strtol(env, &end, 10);
            if (end && *end == '\0' && v >= 0)
                fd = (int)v;
        }
    }
    if (fd < 0) {
        print_error("usb file descriptor required: argv[1] or TERMUX_USB_FD");
        return 2;
    }

    libusb_context *ctx = NULL;
    libusb_device_handle *handle = NULL;
    libusb_set_option(NULL, LIBUSB_OPTION_NO_DEVICE_DISCOVERY);
    if (libusb_init(&ctx) != 0) {
        print_error("libusb_init failed");
        return 1;
    }
    if (libusb_wrap_sys_device(ctx, (intptr_t)fd, &handle) != 0) {
        print_error("libusb_wrap_sys_device failed");
        libusb_exit(ctx);
        return 1;
    }

    struct libusb_device_descriptor desc;
    if (libusb_get_device_descriptor(libusb_get_device(handle), &desc) != 0) {
        print_error("cannot read usb device descriptor");
        libusb_close(handle);
        libusb_exit(ctx);
        return 1;
    }
    if (desc.idVendor != AW_USB_VENDOR_ID ||
        desc.idProduct != AW_USB_PRODUCT_ID) {
        printf("{\"ok\":false,\"tool\":\"fel_version\","
               "\"error\":\"not a fel device\","
               "\"vid\":\"0x%04x\",\"pid\":\"0x%04x\"}\n",
               desc.idVendor, desc.idProduct);
        libusb_close(handle);
        libusb_exit(ctx);
        return 1;
    }

    /* UNVERIFIED on Termux/Android: upstream sunxi-fel claims
     * interface 0 on Linux. Whether a termux-usb wrapped handle
     * allows this claim on the user's phone is untested; a failure
     * here is reported, not silently ignored. */
    if (libusb_claim_interface(handle, 0) != 0) {
        print_error("libusb_claim_interface(0) failed");
        libusb_close(handle);
        libusb_exit(ctx);
        return 1;
    }
    if (discover_endpoints(handle) != 0) {
        print_error("no bulk in/out endpoints found");
        libusb_release_interface(handle, 0);
        libusb_close(handle);
        libusb_exit(ctx);
        return 1;
    }

    /* One FEL request, 16 bytes: request / address / length / pad,
     * all LE32. FEL_VERSION = 0x001, address 0, length 0. */
    unsigned char fel_req[16];
    memset(fel_req, 0, sizeof(fel_req));
    put_le32(fel_req + 0, AW_FEL_VERSION);
    put_le32(fel_req + 4, 0);
    put_le32(fel_req + 8, 0);
    put_le32(fel_req + 12, 0);
    if (fel_usb_write(handle, fel_req, sizeof(fel_req)) != 0) {
        print_error("fel version request failed");
        libusb_release_interface(handle, 0);
        libusb_close(handle);
        libusb_exit(ctx);
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
    unsigned char ver[32];
    if (fel_usb_read(handle, ver, sizeof(ver)) != 0 ||
        read_fel_status(handle) != 0) {
        print_error("fel version reply failed");
        libusb_release_interface(handle, 0);
        libusb_close(handle);
        libusb_exit(ctx);
        return 1;
    }
    if (memcmp(ver, "AWUSBFEX", 8) != 0) {
        print_error("bad fel version signature");
        libusb_release_interface(handle, 0);
        libusb_close(handle);
        libusb_exit(ctx);
        return 1;
    }

    uint16_t soc_id = (uint16_t)((get_le32(ver + 8) >> 8) & 0xffff);
    uint32_t unknown_0a = get_le32(ver + 12);
    uint16_t protocol = get_le16(ver + 16);
    uint32_t scratchpad = get_le32(ver + 20);

    printf("{\"ok\":true,\"tool\":\"fel_version\",\"version\":1,"
           "\"signature\":\"AWUSBFEX\","
           "\"soc_id\":%u,\"soc_id_hex\":\"0x%04x\",\"soc_name\":\"%s\","
           "\"unknown_0a\":%u,\"protocol\":%u,"
           "\"unknown_12\":%u,\"unknown_13\":%u,"
           "\"scratchpad\":%u,\"scratchpad_hex\":\"0x%04x\","
           "\"pad\":[%u,%u],"
           "\"bulk_ep_out\":%d,\"bulk_ep_in\":%d,"
           "\"vid\":\"0x%04x\",\"pid\":\"0x%04x\","
           "\"verified_on_device\":false}\n",
           soc_id, soc_id, soc_name(soc_id),
           unknown_0a, protocol,
           ver[18], ver[19],
           scratchpad, scratchpad,
           get_le32(ver + 24), get_le32(ver + 28),
           bulk_ep_out, bulk_ep_in,
           desc.idVendor, desc.idProduct);

    libusb_release_interface(handle, 0);
    libusb_close(handle);
    libusb_exit(ctx);
    return 0;
}

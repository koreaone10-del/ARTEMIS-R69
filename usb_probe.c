#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
#include <libusb-1.0/libusb.h>

static void print_string(
    libusb_device_handle *h,
    uint8_t index,
    const char *label
) {
    unsigned char buf[256] = {0};

    if (!index) {
        printf("%s: Not provided\n", label);
        return;
    }

    int n = libusb_get_string_descriptor_ascii(
        h, index, buf, sizeof(buf)
    );

    if (n >= 0)
        printf("%s: %s\n", label, buf);
    else
        printf("%s: Unavailable (%d)\n", label, n);
}

int main(int argc, char **argv) {
    if (argc < 2) {
        fprintf(stderr, "USB file descriptor required\n");
        return 2;
    }

    int fd = atoi(argv[1]);
    libusb_context *ctx = NULL;
    libusb_device_handle *handle = NULL;

    int rc = libusb_set_option(
        NULL, LIBUSB_OPTION_NO_DEVICE_DISCOVERY
    );

    if (rc != 0) {
        fprintf(stderr, "USB discovery option: %d\n", rc);
    }

    rc = libusb_init(&ctx);
    if (rc != 0) {
        fprintf(stderr, "libusb_init: %s\n",
                libusb_error_name(rc));
        return 1;
    }

    rc = libusb_wrap_sys_device(
        ctx, (intptr_t)fd, &handle
    );

    if (rc != 0) {
        fprintf(stderr, "USB open failed: %s\n",
                libusb_error_name(rc));
        libusb_exit(ctx);
        return 1;
    }

    libusb_device *dev = libusb_get_device(handle);
    struct libusb_device_descriptor d;

    rc = libusb_get_device_descriptor(dev, &d);

    if (rc != 0) {
        fprintf(stderr, "Descriptor error: %s\n",
                libusb_error_name(rc));
        libusb_close(handle);
        libusb_exit(ctx);
        return 1;
    }

    printf("\n===== ARTEMIS USB INTELLIGENCE =====\n");
    printf("VID:PID       %04X:%04X\n",
           d.idVendor, d.idProduct);
    printf("USB Version   %04X\n", d.bcdUSB);
    printf("Device Class  %02X\n", d.bDeviceClass);
    printf("Device Sub    %02X\n", d.bDeviceSubClass);
    printf("Protocol      %02X\n", d.bDeviceProtocol);
    printf("Configurations %u\n", d.bNumConfigurations);

    print_string(handle, d.iManufacturer, "Manufacturer");
    print_string(handle, d.iProduct, "Product");
    print_string(handle, d.iSerialNumber, "Serial");

    for (int c = 0; c < d.bNumConfigurations; c++) {
        struct libusb_config_descriptor *cfg = NULL;

        rc = libusb_get_config_descriptor(dev, c, &cfg);

        if (rc != 0 || !cfg)
            continue;

        printf("\nCONFIGURATION %d\n", c);
        printf("Interfaces: %u\n", cfg->bNumInterfaces);

        for (int i = 0; i < cfg->bNumInterfaces; i++) {
            const struct libusb_interface *iface =
                &cfg->interface[i];

            for (int a = 0; a < iface->num_altsetting; a++) {
                const struct libusb_interface_descriptor *alt =
                    &iface->altsetting[a];

                printf(" Interface %u Alt %u Class %02X "
                       "SubClass %02X Protocol %02X\n",
                       alt->bInterfaceNumber,
                       alt->bAlternateSetting,
                       alt->bInterfaceClass,
                       alt->bInterfaceSubClass,
                       alt->bInterfaceProtocol);

                for (int e = 0; e < alt->bNumEndpoints; e++) {
                    const struct libusb_endpoint_descriptor *ep =
                        &alt->endpoint[e];

                    printf("  Endpoint %02X Attributes %02X "
                           "MaxPacket %u\n",
                           ep->bEndpointAddress,
                           ep->bmAttributes,
                           ep->wMaxPacketSize);
                }
            }
        }

        libusb_free_config_descriptor(cfg);
    }

    printf("\n===== READ-ONLY INSPECTION COMPLETE =====\n");

    libusb_close(handle);
    libusb_exit(ctx);
    return 0;
}

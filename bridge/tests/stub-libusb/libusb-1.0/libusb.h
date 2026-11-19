/* Minimal libusb-1.0 header for the VM test stub
 * (bridge/tests/stub-libusb/libusb-stub.c). It declares only the
 * libusb surface the bridge C tools use (see fel_common.c), with
 * the real libusb 1.0 public struct layouts, so code compiled
 * against it is ABI-compatible with the real headers the phone
 * build uses. The real libusb headers are not installed in this
 * VM (no libusb-1.0 dev package); the stub implementation is
 * what makes the tests meaningful — it emulates an H3 in FEL
 * mode at the bulk-transfer level. Do NOT use this header for
 * anything but the VM tests. */

#ifndef STUB_LIBUSB_H
#define STUB_LIBUSB_H

#include <stdint.h>
#include <stddef.h>
#include <stdarg.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct libusb_context libusb_context;
typedef struct libusb_device libusb_device;
typedef struct libusb_device_handle libusb_device_handle;

typedef struct libusb_device_descriptor {
    uint8_t  bLength;
    uint8_t  bDescriptorType;
    uint16_t bcdUSB;
    uint8_t  bDeviceClass;
    uint8_t  bDeviceSubClass;
    uint8_t  bDeviceProtocol;
    uint8_t  bMaxPacketSize0;
    uint16_t idVendor;
    uint16_t idProduct;
    uint16_t bcdDevice;
    uint8_t  iManufacturer;
    uint8_t  iProduct;
    uint8_t  iSerialNumber;
    uint8_t  bNumConfigurations;
} libusb_device_descriptor;

typedef struct libusb_endpoint_descriptor {
    uint8_t  bLength;
    uint8_t  bDescriptorType;
    uint8_t  bEndpointAddress;
    uint8_t  bmAttributes;
    uint16_t wMaxPacketSize;
    uint8_t  bInterval;
    uint8_t  bRefresh;
    uint8_t  bSynchAddress;
    const unsigned char *extra;
    int extra_length;
} libusb_endpoint_descriptor;

typedef struct libusb_interface_descriptor {
    uint8_t  bLength;
    uint8_t  bDescriptorType;
    uint8_t  bInterfaceNumber;
    uint8_t  bAlternateSetting;
    uint8_t  bNumEndpoints;
    uint8_t  bInterfaceClass;
    uint8_t  bInterfaceSubClass;
    uint8_t  bInterfaceProtocol;
    uint8_t  iInterface;
    const libusb_endpoint_descriptor *endpoint;
    const unsigned char *extra;
    int extra_length;
} libusb_interface_descriptor;

typedef struct libusb_interface {
    const libusb_interface_descriptor *altsetting;
    int num_altsetting;
} libusb_interface;

typedef struct libusb_config_descriptor {
    uint8_t  bLength;
    uint8_t  bDescriptorType;
    uint16_t wTotalLength;
    uint8_t  bNumInterfaces;
    uint8_t  bConfigurationValue;
    uint8_t  iConfiguration;
    uint8_t  bmAttributes;
    uint8_t  MaxPower;
    const libusb_interface *interface;
    const unsigned char *extra;
    int extra_length;
} libusb_config_descriptor;

#define LIBUSB_SUCCESS 0
#define LIBUSB_ERROR_TIMEOUT -7
#define LIBUSB_ERROR_NO_DEVICE -4

enum libusb_option {
    LIBUSB_OPTION_LOG_LEVEL = 0,
    LIBUSB_OPTION_USE_USBDK = 1,
    LIBUSB_OPTION_NO_DEVICE_DISCOVERY = 2,
};

int libusb_init(libusb_context **ctx);
void libusb_exit(libusb_context *ctx);
int libusb_set_option(libusb_context *ctx, enum libusb_option option, ...);
int libusb_wrap_sys_device(libusb_context *ctx, intptr_t sys_dev, libusb_device_handle **dev_handle);
libusb_device *libusb_get_device(libusb_device_handle *dev_handle);
int libusb_get_device_descriptor(libusb_device *dev, libusb_device_descriptor *desc);
int libusb_claim_interface(libusb_device_handle *dev_handle, int interface_number);
int libusb_release_interface(libusb_device_handle *dev_handle, int interface_number);
int libusb_get_active_config_descriptor(libusb_device *dev, libusb_config_descriptor **config);
int libusb_get_config_descriptor(libusb_device *dev, uint8_t config_index, libusb_config_descriptor **config);
void libusb_free_config_descriptor(libusb_config_descriptor *config);
int libusb_bulk_transfer(libusb_device_handle *dev_handle, unsigned char endpoint,
                         unsigned char *data, int length, int *actual_length,
                         unsigned int timeout);
void libusb_close(libusb_device_handle *dev_handle);

#ifdef __cplusplus
}
#endif

#endif /* STUB_LIBUSB_H */

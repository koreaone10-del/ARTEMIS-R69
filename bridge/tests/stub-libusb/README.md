# Stub libusb for VM tests

`libusb.h` declares only the libusb surface the bridge C tools
use, with the real libusb 1.0 public struct layouts.
`libusb-stub.c` implements it as an H3-in-FEL emulator at the
bulk-transfer level (SRAM store, CP-register scratch-code
effects, thunk patching `eGON.BT0` → `eGON.FEL`, version reply
`AWUSBFEX` / 0x1680).

Failure injection via env:

- `STUB_LIBUSB_FAIL_RECV=first` — the first bulk recv fails
  with `LIBUSB_ERROR_TIMEOUT`, later recvs succeed.
- `STUB_LIBUSB_FAIL_RECV=all` — every bulk recv fails.
- `STUB_LIBUSB_STATE=<file>` — shares the "already dropped"
  flag across processes (one drop per run); without it the
  flag is per-process.
- `STUB_LIBUSB_SRAM_FILE=<file>` — shares the 128 KiB SRAM
  across processes (the file is loaded at init and saved after
  every FEL WRITE), so a pattern written by `fel_write` in one
  process reads back from `fel_read` in another — like the real
  device's SRAM. Without it, SRAM is per-process.

Build a tool against it (VM only, never on the phone):

```sh
gcc -O2 -Wall -Wextra -I bridge/tests/stub-libusb \
  -o /tmp/fel_spl_uboot-test bridge/fel_spl_uboot.c \
  bridge/fel_common.c bridge/tests/stub-libusb/libusb-stub.c
```

Test infrastructure only — never ship to the phone or link
into a production binary.

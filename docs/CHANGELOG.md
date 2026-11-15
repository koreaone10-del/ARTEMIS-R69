# Changelog

## 6.1.0 — 2026-11-15
- Corrected IMAGEWTY v3 serialized entry layout against the public C reference implementation.
- Read `file_header_length` from main-header offset `0x20`; it is not the entry-table offset.
- Decode filename length, per-entry header size, maintype, subtype, filename, stored/original lengths and payload offset at their actual serialized positions.
- Restore local per-file extraction using the validated payload range and `original_length`.
- Added 37-entry synthetic regression coverage, malformed range checks and unsafe-name rejection.
- Kept all hardware interaction read-only; no FEL write/execute, DRAM pattern, Boot0 patching or eMMC writes.

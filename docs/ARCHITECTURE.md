# ARTEMIS R69 v6 — architecture and trust model

## Product scope
A mobile-first web workspace for offline firmware metadata analysis, boot-header inspection, partition arithmetic, USB descriptor inspection, report export and specialist code review. It is not a universal unbricking tool and does not claim to repair hardware.

## Trust labels
- **Observed**: data actually read from the selected file or USB descriptors.
- **Firmware-declared**: values found in FEX/configuration files.
- **Reported**: hardware facts supplied by the operator or prior inspection.
- **Expected**: target profile values, not a live identification.
- **Hypothesis**: interpretation requiring additional evidence.

## Safety boundary
No implementation of FEL_WRITE, FEL_EXEC, eMMC writes, arbitrary RAM writes, DRAM pattern tests, boot0 patching, or recovery-image construction is included. The USB module only requests access and inspects descriptors. It explicitly does not claim that FEL_VERSION has been exchanged. This is deliberate: VID/PID 1F3A:EFE8 is not a successful FEL handshake.

## Components
- `frontend/`: RTL mobile dashboard and browser-local analysis.
- `backend/`: Express static host, health/build endpoints, AI proxy.
- `lib/parsers/`: Node-compatible FEX, partition, eGON, IMAGEWTY candidate and TOC1 header parsers.
- `lib/analyzers/`: target comparison, boot artifact dispatch, report schema.
- `lib/ai/`: offline specialist triage and optional OpenAI-compatible provider proxy.
- `tests/`: Node built-in test runner; synthetic fixtures only.

## IMAGEWTY caution
The candidate v3 profile uses header size 96, table offset 0x400, entry size 1024, count offset 60, and field offsets documented in `imagewty.js`. These values are not treated as a universal vendor specification. The browser checks bounds and labels the result `candidate-v3-profile`. Confirm extracted bytes against independently extracted known files before trusting any offset. Compressed/stored length and original length are kept separate.

## TOC1 caution
The known R69 package was previously identified as TOC1 with five items (`u-boot`, `scp`, `soc-cfg`, `dtb`, `optee`). This implementation intentionally reports the header and expected component names only. It does not invent component-table offsets for a vendor layout that has not been independently validated.

## eGON caution
The inspector reads magic, checksum, declared length and entry point. It validates checksum only when the declared length is in bounds and word aligned. It never patches the image. A valid checksum does not prove board compatibility or successful boot.

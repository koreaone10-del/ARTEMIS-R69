# Boot Code Studio

The workspace supports source-level drafting and review for C, U-Boot configuration, and device-tree snippets. It can export a source text file and send a selected snippet to the configured AI review endpoint.

It intentionally does **not**:
- claim to be a validated R69 board port;
- compile a new Boot0/SPL/U-Boot image;
- patch the vendor boot0 binary;
- load or execute code over FEL;
- write a bootloader to eMMC or SD media.

The exact R69 schematic, PMIC/power sequencing, DRAM wiring, eMMC routing, and vendor boot chain are not established by the supplied firmware alone. A generic H3 bootloader source tree can be a starting point for expert review, not a drop-in replacement. Every board-specific constant must be verified against primary board evidence and built/tested by a qualified embedded developer in a controlled environment.

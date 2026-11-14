# Changelog

## 6.0.0 — ORION (2026-11-14)
- Replaced the legacy active flashing workflow with a read-only forensic architecture.
- Added mobile-first RTL dashboard and browser-local firmware inspection.
- Added candidate IMAGEWTY v3 parser with bounds checks and explicit uncertainty labels.
- Added eGON checksum/header validation and conservative TOC1 header inspection.
- Added FEX DRAM and partition metadata parsers.
- Added USB descriptor inspector; no FEL protocol transfer is sent.
- Added Boot Code Studio for source-only drafting/review.
- Added offline engineering assistant and optional server-side OpenAI-compatible AI proxy.
- Added JSON reports, Termux scripts, Render deployment, Dockerfile, CI and tests.
- Removed old active FEL write/execute/flash UI and unsupported recovery-image claims.

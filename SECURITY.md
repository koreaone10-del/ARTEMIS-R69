# Security policy

- Never commit API keys, device serials, or private firmware.
- Treat all uploaded binary files as untrusted input. Parsers enforce basic bounds but are not a substitute for sandboxing in a multi-user public service.
- Keep analysis local. The app does not upload firmware binaries to the backend.
- No persistent hardware writes or arbitrary code execution are implemented.
- Report parser discrepancies with a minimal synthetic fixture when possible.

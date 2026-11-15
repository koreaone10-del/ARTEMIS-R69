# ARTEMIS AI Assistant

ARTEMIS supports an OpenAI-compatible inference endpoint. For a self-hosted open model that accepts requests without authentication, set:

- `AI_BASE_URL` to the endpoint base URL (ending in `/v1`)
- `AI_MODEL` to the exact model ID served by that endpoint
- leave `AI_API_KEY` empty if the endpoint does not require a key

Example model reference: `Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF` (GGUF). A model server such as llama.cpp can expose an OpenAI-compatible API. The model must run on infrastructure reachable from the ARTEMIS backend. A model running on the Android phone's `127.0.0.1` is not reachable from a Render-hosted backend; conversely, a Render service cannot be assumed to have enough RAM/CPU to host an LLM.

If `AI_BASE_URL` is absent, ARTEMIS uses deterministic offline rules. This fallback is not a generative model. If the endpoint fails, the assistant returns a clearly labeled offline fallback and the provider error.

Never put private credentials in frontend files or GitHub. AI output is advisory and is never executed.

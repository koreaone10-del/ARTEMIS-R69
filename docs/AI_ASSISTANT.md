# AI assistant configuration

Offline mode works without a key and provides conservative domain-specific triage. To enable a connected provider, set these server-side environment variables:

- `AI_BASE_URL` — API base URL, default `https://api.openai.com/v1`.
- `AI_API_KEY` — provider secret. Never commit it to GitHub.
- `AI_MODEL` — model identifier, default `gpt-4o-mini`.

The backend uses a Chat Completions-compatible endpoint. Keep secrets in Render Environment settings or local Termux shell environment. The browser never receives the provider key. The AI is advisory; it does not run shell commands, edit the repository, flash hardware or execute submitted code.

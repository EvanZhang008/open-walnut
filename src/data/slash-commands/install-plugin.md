---
description: Install a Walnut plugin from a share snippet or git repo URL
---
The user wants to install a plugin. The share snippet or git URL follows this command (or is pasted in the same message).

1. **Load your `walnut-plugin-store` skill** — find it in `<available_skills>` and follow it exactly. Everything below is a summary; the skill is the source of truth.
2. **Register the source** — POST the snippet/URL to the plugin-sources API. New plugins activate immediately (soft reload, no restart).
3. **Configure if needed** — if any plugin reports `needs-config`, read its `missing` fields + `uiHints` help text, ask the user for ONLY the required values (quote the help text — it says exactly where to find each one), then save via the config API and verify the plugin flips to `loaded`.
4. **Report back** — which plugins were found, which are active, and anything that still needs attention.

If no snippet/URL was provided, ask for one. Do NOT clone anything manually — the API does all git work.

# Agent System — Quick Reference

**Full implementation details: `.claude/skills/walnut-agent-loop/SKILL.md`** (loop internals,
providers, auth, retry, streaming, caching, tool modules).

## Essentials

- Entry: `runAgentLoop()` in `src/agent/loop.ts`. Always streams (`sendMessageStream()`).
- Providers are config (YAML), protocols are code: registry resolves `config.providers[name]` →
  adapter (`bedrock` | `anthropic-messages`). Legacy config falls back to Bedrock.
- Prompt caching in `src/agent/cache.ts` — cache_control on system/tools/messages; volatile
  content goes in the message tail, never in system (breaks the cache prefix).
- Tools return `string | ToolContentBlock[]` (text + base64 image blocks); display callbacks
  always get a safe string. Tool modules live one-per-file under `src/agent/tools/`.

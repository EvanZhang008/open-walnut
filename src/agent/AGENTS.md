# Agent System — Implementation Details

For architecture overview and tool table, see project `CLAUDE.md`.

## Agent Loop Internals

- **Entry**: `runAgentLoop()` at `src/agent/loop.ts`
- **Model**: Bedrock `global.anthropic.claude-opus-4-6-v1` via `src/agent/model.ts`
- **Auth**: Bearer token from `config.yaml` (`provider.bedrock_bearer_token`), falls back to `AWS_BEARER_TOKEN_BEDROCK` env var, then standard AWS credential chain. Auto-recreates client on 403 (expired credentials) with one retry.
- **Retry**: Aggressive retry on 429 (rate limit), 529 (overloaded), 503 (service unavailable) — up to 10 retries with exponential backoff (1s→60s cap, ±30% jitter), respects `retry-after` header, abort-signal aware. Both `sendMessage()` and `sendMessageStream()` retry transparently.
- **Streaming**: Always uses `sendMessageStream()` — non-streaming calls can timeout on long responses. Supports `onTextDelta` callback for real-time token delivery.
- **Abort**: Accepts an `AbortSignal` via `options.signal`. Checked before each model call and before each tool execution. Aborted tools return `[Aborted by user]`.
- **Continuation**: When `stop_reason === 'max_tokens'`, auto-sends "Continue." up to 3 times to complete truncated responses.
- **Tool round exhaustion**: When all 300 rounds are used and the model is still calling tools, a visible notice is streamed to the user and one final model call is made without tools to produce a closing response.
- **Subagent mode**: When `options` is provided, uses custom system prompt, tools, model config, and max rounds instead of defaults.
- **Caching**: `src/agent/cache.ts` — cache_control markers on system/tools/messages, TTL tracking, context pruning for old turns

## Tool Return Types

Tools return `ToolResultContent = string | ToolContentBlock[]` where `ToolContentBlock` is `ToolTextBlock | ToolImageBlock`. This allows tools to return structured content including base64 images that the vision model can directly perceive. The `onToolResult` callback always receives a display-safe string (image blocks are replaced with `[image]` placeholders for WebSocket broadcast). During compaction, image blocks in tool results are replaced with `[image content]` text placeholders.

## Tool Module Files

Tool modules are split into separate files under `src/agent/tools/`:
- `read-tool.ts`, `write-tool.ts`, `edit-tool.ts` — file operations
- `exec-tool.ts` — shell execution with `exec-policy.ts` for safety
- `apply-patch.ts` — multi-file patch application
- `process-tool.ts` — background process management
- `slack-tool.ts`, `tts-tool.ts`, `image-tool.ts` — integrations
- `web-search-tool.ts`, `web-fetch-tool.ts` — web access
- `agent-crud-tools.ts` — subagent CRUD (WIP)

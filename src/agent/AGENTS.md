# src/agent/ — shims only

Nothing lives here any more. Every file except `session-context.ts` is a one-line re-export of
its new home, kept so an in-flight caller keeps compiling; the directory goes away with them.

- model layer (`sendMessage`, providers, catalog, adapters) → `src/model/` (the shims still here)
- tool types → `src/model/tools.ts`; the micro-agent tool loop → `src/model/micro-agent.ts`
- read-only tools (rendered from the op registry) → `src/core/tools/read-only.ts`;
  plugin-contributed tools → `src/core/plugins/plugin-tools.ts`
- context sources → `src/core/context-sources.ts`; working memory → `src/core/memory/`;
  persona sections → `src/core/sessions/persona-sections.ts`; overview maintainer → `src/core/`

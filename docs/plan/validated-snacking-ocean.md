# Walnut Memory v2 — Wiki-based Knowledge Architecture

---

## Part 1: Research

### Moltbot Memory Architecture

- **Plugin architecture**: `extensions/memory-core/` as standalone extension
- **Storage**: SQLite (`memory.sqlite`) with FTS5 + vector embeddings (`sqlite-vec`)
- **Three memory types**: Long-term (`MEMORY.md` + `memory/YYYY-MM-DD.md`), Session (transcript JSONL), Short-term (in-memory)
- **Writes**: Only during pre-compaction flush. Flush is a full agent turn, write tool is wrapped — can only append to `memory/YYYY-MM-DD.md`, MEMORY.md is read-only at code level
- **Trigger**: Token exceeds threshold (contextWindow - 20K - 4K) or transcript > 2MB. No periodic writes
- **Search**: Hybrid (70% vector + 30% BM25 FTS5), temporal decay (30-day half-life), MMR diversity re-ranking
- **Embedding**: Supports local/OpenAI/Gemini/Voyage/Mistral/Ollama, auto-select
- **Context injection**: Tool-based (`memory_search` + `memory_get`), not system prompt dump. Agent decides when to retrieve
- **Token budget**: maxInjectedChars 4000, maxResults 6, minScore 0.35

### Claude Code Memory Architecture (5 Layers)

1. **Session Memory (`summary.md`)**: Real-time updated structured notes
   - Trigger: 10K tokens initial + 5K growth + 3 tool calls
   - Method: **Edit overwrite** (not append!) — prevents bloat
   - Limit: ≤2000 tokens per section, ≤12000 tokens total
   - Uses main model (reuses prompt cache)
   - **Injection timing**: Not injected normally; replaces traditional summary during compaction; injected on resume
   - **No duplication with chat history**: Because old messages are deleted during compaction, summary replaces them

2. **Context Compaction Summary**: Generated during compaction, focused on task recovery
3. **Dream Consolidation**: Background reflection process
   - Trigger: ≥24h + ≥5 sessions touched
   - Forked agent, read-only bash
   - 4 phases: Orient → Gather → Consolidate → Prune
   - Merges into topic files; only creates new files when necessary
4. **Agent Memory Instructions**: Role-specific domain knowledge
5. **User Memory**: Understanding of the user

### Claude Code Compaction Decision Logic

```
trySessionMemoryCompaction() tries first
  ├─ working-memory.md has content → use it as summary ✅ (saves LLM call)
  └─ empty/missing → return null → fallback to traditional LLM summarizer
```

Session memory **replaces** traditional summary, not stacks on top. They are mutually exclusive.

### Walnut Current Memory Write Paths

1. **Explicit agent writes**: `files_write` → appendDailyLog / appendProjectMemory / appendRepoMemory / updateMemoryFile
2. **Compaction flush**: `MEMORY_FLUSH_MESSAGE` → agent turn → writes daily log (full tool set, no wrapping)
3. **Dual-write**: project memory append automatically cross-writes to daily log
4. **Triage**: Can write memory via tools
5. **No automatic memory write on session end**

### QMD (`@tobilu/qmd`) Technical Analysis

- **npm package**: `@tobilu/qmd` v2.1.0, MIT, Node 22+
- **SDK**: `createStore()` → `search()`, `searchLex()`, `searchVector()`, `get()`, `update()`, `embed()`, `close()`
- **BM25**: SQLite FTS5 (porter stemmer + unicode61)
- **Vector**: `sqlite-vec` extension + `node-llama-cpp`, EmbeddingGemma 300M GGUF (~300MB)
- **Re-ranking**: Qwen3-Reranker-0.6B cross-encoder (~640MB), ~2ms/candidate, non-generative
- **Query expansion**: Custom-trained 1.7B GGUF (~1.1GB), generates lex + vec + hyde variants
- **Total VRAM**: ~2GB, fully local, zero API cost, Apple Silicon Metal acceleration
- **Collections**: Named groups, `includeByDefault` control, filterable per-collection search
- **No file watcher**: Requires explicit `store.update()` + `store.embed()` calls
- **Global search then filter**: No per-collection independent search → requires our per-source wrapper to solve noisy neighbor

### Karpathy's LLM Wiki

- Three layers: Raw Sources → Wiki (LLM-maintained) → Schema
- index.md (content directory) + log.md (append-only time stream)
- Operations: Ingest, Query, Lint
- Core insight: "humans abandon wikis because maintenance burden grows faster than value. LLMs don't get bored."

---

## Part 2: Design

## Context

The current Walnut memory system has several fundamental problems:

1. **No working memory** — No Claude Code `summary.md`-style continuously updated notes
2. **Poor daily log quality** — Biased toward git log (commit hashes, line counts) rather than valuable knowledge
3. **Full injection on read** — All memory truncated and stuffed into system prompt, `memory-index.sqlite` sits idle
4. **Unorganized knowledge** — Daily log is a chronological stream, no wiki-style topic aggregation and cross-referencing
5. **Heavy self-built search maintenance** — Self-built FTS5 + Ollama BGE-M3 + RRF, ~800 lines of code

Reference designs from three systems:
- **Karpathy's LLM Wiki** — Three-layer architecture (Raw Sources → Wiki → Schema), index.md + log.md
- **Claude Code Session Memory** — Forked agent, structured Edit (not append), per-section 2K token limit, replaces traditional LLM summary during compaction
- **QMD (`@tobilu/qmd`)** — Local hybrid search (BM25 FTS5 + vector + LLM re-ranking + query expansion), fully local models, zero API cost

---

## Core Principle: Memory vs Notes

```
Memory (AI's world) = what's in your brain (recall)
  "What did we discuss last week?" "What was that root cause again?"
  ✦ Primarily written by AI, AI has full read/write access
  ✦ Organized by time + topic (wiki/topic)
  ✦ Time-sensitive (working → daily → old)
  ✦ Access pattern: "I remember..."

Notes (User's world) = what's in your filing cabinet (reference)
  "my visa records" "savings account" "investment runbook"
  ✦ Primarily written by user, AI assists occasionally
  ✦ PARA structure (Projects/Areas/Resources/Archive)
  ✦ Mostly permanent, some expire
  ✦ Access pattern: "Let me look that up..."

Interaction rules:
  Memory → Notes:  dream/triage pushes persistent knowledge to Notes (cautiously — user's territory)
  Notes → Memory:  memory_search scope includes Notes (read-only)
  Separate storage, separate QMD instances, unified API
```

---

## Memory Layered Architecture

```
~/.open-walnut/memory/
├── working-memory.md          ← NEW: real-time working memory (Claude Code style)
├── index.md                   ← NEW: wiki directory (Karpathy style)
├── daily/                     ← EXISTING: append-only time stream
├── topics/                    ← NEW: topic wiki pages
├── projects/                  ← EXISTING: task-centric project memory
├── repos/                     ← EXISTING: repository environment knowledge
├── compaction/                ← NEW: compaction artifact archive
└── sessions/                  ← EXISTING: session notes

~/.open-walnut/notes/          ← EXISTING: Obsidian vault (separate QMD instance)
├── Areas/
├── Projects/
├── Resources/
└── Archive/
```

---

## Search Architecture: Replacing Self-Built Search with QMD

### Decision: Replace Walnut Self-Built Search with QMD (`@tobilu/qmd`)

**Gains**:
- Re-ranking (Qwen3 cross-encoder, understands semantics beyond cosine)
- Query expansion (custom-trained 1.7B, search "tax filing" → ["tax filing", "CPA", "W2"])
- HyDE (hypothetical document search, good for fuzzy queries)
- Delete ~800 lines of self-built search code
- Remove Ollama dependency (QMD has its own runtime)
- All 2200 Notes files become searchable

**Losses**:
- Task field-level weights (title 3x, description 2.5x, etc.) → can add task-specific scoring later
- Full control → QMD is a black box, slightly higher debug cost
- Incremental real-time → QMD has no file watcher, we must trigger `store.update()`

**Model configuration**:
- **Embedding**: BGE-M3 GGUF (best for multilingual, replaces QMD default EmbeddingGemma)
  - `QMD_EMBED_MODEL=hf:BAAI/bge-m3-GGUF/bge-m3.gguf`
- **Re-ranking**: Qwen3-Reranker-0.6B (keep QMD default)
- **Query expansion**: QMD custom-trained 1.7B (keep default)

**Resource consumption**: ~3GB VRAM (BGE-M3 ~2GB + Reranker ~640MB + Expansion ~1.1GB), Apple Silicon Metal acceleration, auto-release after 5 min idle

### Ranking Formula: QMD score × source weight × temporal decay

```
finalScore = qmdScore × sourceWeight × temporalDecay

Search flow:
  1. Each source independently calls QMD search (per-collection, over-fetch 50)
  2. QMD internal: BM25 + vector(BGE-M3) + query expansion + re-ranking → qmdScore
  3. Our wrapper:
     a. qmdScore × sourceWeight (source importance)
     b. × temporalDecay (time decay, evergreen=1.0)
     c. Guaranteed slot allocation
     d. Remaining slots filled by finalScore ranking
```

**Temporal decay** (ported from Moltbot `temporal-decay.ts`):
```
decay = exp(-ln(2) / halfLifeDays × ageInDays)

daily:      halfLife=30 days, age parsed from filename YYYY-MM-DD.md
compaction: halfLife=30 days, age parsed from filename YYYY-MM-DD-HHMM.md
session:    halfLife=14 days, age from file mtime
topic/project/repo/global/note_*: no decay (evergreen, decay=1.0)
```

**Over-fetch strategy**:
```
memory sources (small data, ~500 chunks):  over-fetch=50 (near-complete, ~99%+ recall)
notes sources (large data, ~10000 chunks): over-fetch=20
```

### Two QMD Instances (Memory vs Notes Isolation)

```typescript
// Memory instance — AI's memory, default search target
const memoryStore = await createStore({
  dbPath: "~/.open-walnut/memory-search.sqlite",
  config: {
    collections: {
      daily:      { path: "memory/daily",      pattern: "**/*.md" },
      topic:      { path: "memory/topics",     pattern: "**/*.md" },
      project:    { path: "memory/projects",   pattern: "**/*.md" },
      repo:       { path: "memory/repos",      pattern: "**/*.md" },
      compaction: { path: "memory/compaction",  pattern: "**/*.md" },
      global:     { path: "~/.open-walnut",    pattern: "MEMORY.md" },
      session:    { path: "memory/sessions",    pattern: "**/*.md" },
    }
  }
});

// Notes instance — user's knowledge base, only searched when explicitly requested
const notesStore = await createStore({
  dbPath: "~/.open-walnut/notes-search.sqlite",
  config: {
    collections: {
      areas:     { path: "notes/Areas",     pattern: "**/*.md" },
      projects:  { path: "notes/Projects",  pattern: "**/*.md" },
      resources: { path: "notes/Resources", pattern: "**/*.md" },
      archive:   { path: "notes/Archive",   pattern: "**/*.md", includeByDefault: false },
    }
  }
});
```

### Per-Source Search + Weight + Guaranteed Slots

QMD natively doesn't support per-source weights or guaranteed slots. We add a ~40-line wrapper:

```typescript
const SOURCE_CONFIG = {
  // Memory sources
  topic:      { weight: 1.5, minSlots: 2, overFetch: 50, decays: false },
  global:     { weight: 1.5, minSlots: 1, overFetch: 10, decays: false },
  project:    { weight: 1.2, minSlots: 1, overFetch: 50, decays: false },
  daily:      { weight: 1.0, minSlots: 1, overFetch: 50, decays: true, halfLife: 30 },
  repo:       { weight: 1.2, minSlots: 0, overFetch: 20, decays: false },
  compaction: { weight: 0.8, minSlots: 0, overFetch: 30, decays: true, halfLife: 30 },
  session:    { weight: 0.8, minSlots: 0, overFetch: 20, decays: true, halfLife: 14 },
  // Notes sources
  note_areas:     { weight: 1.0, minSlots: 0, overFetch: 20, decays: false },
  note_projects:  { weight: 1.0, minSlots: 0, overFetch: 20, decays: false },
  note_resources: { weight: 1.0, minSlots: 0, overFetch: 20, decays: false },
  note_archive:   { weight: 0.5, minSlots: 0, overFetch: 10, decays: false },
};

async function memoryNotesSearch(query: string, sources?: string[], limit = 8) {
  const activeSources = sources ?? Object.keys(SOURCE_CONFIG).filter(s => !s.startsWith('note_'));

  // Step 1: Search each source independently (per-collection, over-fetch for full candidate pool)
  const perSourceResults = await Promise.all(
    activeSources.map(async (src) => {
      const config = SOURCE_CONFIG[src];
      const store = src.startsWith('note_') ? notesStore : memoryStore;
      const collection = src.startsWith('note_') ? src.replace('note_', '') : src;
      const raw = await store.search({ query, limit: config.overFetch, collection });
      return raw.map(r => ({
        ...r,
        source: src,
        finalScore: r.score
          * config.weight
          * (config.decays ? temporalDecay(r.filepath, config.halfLife) : 1.0),
      }));
    })
  );

  // Step 2: Guaranteed slot reservation — each source with minSlots reserves its top results
  const guaranteed = [];
  const remaining = [];
  for (const results of perSourceResults) {
    const src = results[0]?.source;
    const min = SOURCE_CONFIG[src]?.minSlots ?? 0;
    results.sort((a, b) => b.finalScore - a.finalScore);
    guaranteed.push(...results.slice(0, min));
    remaining.push(...results.slice(min));
  }

  // Step 3: Remaining slots filled by finalScore ranking
  remaining.sort((a, b) => b.finalScore - a.finalScore);
  const final = [...guaranteed, ...remaining.slice(0, limit - guaranteed.length)];
  final.sort((a, b) => b.finalScore - a.finalScore);
  return final;
}
```

Each source independently calls QMD (over-fetch 50) → decay re-ranks in the full candidate pool → guaranteed slots → completely solves the noisy neighbor problem.

### File Watch Trigger

QMD has no file watcher; we keep a simplified watcher:

```typescript
// Full index on startup
await memoryStore.update();
await memoryStore.embed();
await notesStore.update();
await notesStore.embed();

// Incremental update on file changes (reuse current fs.watch logic)
fs.watch(MEMORY_DIR, { recursive: true }, debounce(() => {
  memoryStore.update();
  memoryStore.embed();
}, 2000));

fs.watch(NOTES_DIR, { recursive: true }, debounce(() => {
  notesStore.update();
  notesStore.embed();
}, 5000));  // notes change less frequently, longer debounce
```

---

## Data Flow Architecture

```
Live Conversation
    │
    ├─ Working Memory (background forked agent, Edit overwrite)
    │   Trigger: 5K token growth + 3 tool calls
    │   Content: active focus, user requests, decisions, struggles
    │   Injection: only during compaction/resume/subagent (not normally — avoids duplication with chat history)
    │
    ├─ Daily Log (agent explicitly calls files_write, append)
    │   Content: butler journal style
    │   Injection: today's log goes directly into system prompt
    │
    └─ Compaction Trigger
        │
        ├─ Step 1: Memory flush → daily log (unchanged)
        ├─ Step 2: working-memory.md → replaces traditional LLM summary (saves one LLM call)
        │          If working-memory.md is empty → fallback to traditional summarizer
        ├─ Step 3: working-memory.md snapshot → compaction/*.md (archived, searchable)
        └─ Step 4: Old messages discarded

Periodic Dream (background, ≥24h + ≥5 sessions)
    │
    ├─ Phase 1: Orient — read index.md + existing topic files
    ├─ Phase 2: Gather — scan daily logs, working-memory, compaction/*
    ├─ Phase 3: Consolidate — merge into topics/*.md (don't create new files unless topic is entirely new)
    └─ Phase 4: Prune — update index.md, delete contradicted/outdated entries

Retrieval (agent runtime)
    │
    ├─ memory_notes_search(query)                          → default: search memory (per-source weight + guaranteed slots)
    ├─ memory_notes_search(query, ["note_areas"])           → search notes
    ├─ memory_notes_search(query, ["daily","note_areas"])   → cross memory+notes
    └─ memory_get(path, lines) → point read full content (both memory + notes readable)
```

---

## Team Breakdown

### Team A: QMD Search Integration (Search Infrastructure Replacement)

**Scope**: Replace Walnut self-built search with QMD, including both memory + notes instances

**Tasks**:

1. **Install QMD + create store module**
   - `npm install @tobilu/qmd`
   - New `src/core/qmd-store.ts` — two QMD instance initialization + collections config
   - New `src/core/qmd-watcher.ts` — fs.watch → `store.update()` + `store.embed()` trigger
   - Call `update()` + `embed()` on startup

2. **Create `memory_notes_search` tool (unified entry point)**
   - New `src/agent/tools/memory-notes-search-tool.ts`
   - Single tool, `sources` parameter controls what to search:
     ```typescript
     {
       name: 'memory_notes_search',
       input_schema: {
         query: string,       // natural language search
         limit?: number,      // default 8
         sources?: string[],  // memory sources: daily | topic | project | repo | compaction | global | session
                              // notes:  note_areas | note_projects | note_resources | note_archive
                              // default: memory sources only (excludes notes)
       }
     }
     ```
   - Internal routing: `daily|topic|project|...` → memoryStore, `note_*` → notesStore
   - Per-source search wrapper (weight + guaranteed slots) → only applies to memory sources
   - Notes sources searched independently, not mixed with memory ranking

3. **Create `memory_get` tool**
   - New `src/agent/tools/memory-get-tool.ts`
   - Delegates to `memoryHandler.read()`
   - Can read both memory + notes files

4. **Register tools + streamline system prompt**
   - Modify `src/agent/tools.ts` — register new tools
   - Modify `src/agent/context.ts:buildMemoryContext()` — budget 20K→8K + memory_search hint

5. **Delete old search code**
   - Delete/simplify: `src/core/embedding/client.ts`, `pipeline.ts`, `store.ts`, `cosine.ts`
   - Delete/simplify: `src/core/memory-watcher.ts` (replaced by qmd-watcher.ts)
   - Simplify: `src/core/memory-index.ts` (keep FTS5 for existing API, or delete entirely)
   - Simplify: `src/core/search.ts` (delegate to QMD wrapper)

**Test Strategy**:

```
Test data preparation (before implementation):
  1. Record known content snippets from current memory/ as ground truth
     - From daily/2026-04-03.md take "session empty reply" → search should find it
     - From projects/passion/walnut/MEMORY.md take key paragraphs → search should find them
     - From notes/Areas/Finance/ take "savings" → notes search should find it
  2. Record current search() results for these queries as baseline

Unit tests:
  - qmd-store.ts: store init, update, embed, close lifecycle
  - memory-search-tool.ts: per-source wrapper, weight, guaranteed slots
  - qmd-watcher.ts: debounce triggers update+embed

Integration tests:
  - Start Walnut → QMD index auto-builds
  - memory_search("session empty reply") → returns daily log results
  - memory_search("savings", sources: ["note"]) → returns notes results
  - memory_search("walnut architecture", sources: ["topic"]) → returns topic (create a test topic file)
  - Write new daily log → 2s later search can find it (watcher trigger)
  - Ollama not running → search still works (QMD has its own models, no Ollama dependency)

Regression tests:
  - Compare to baseline: content found before should still be found after QMD switch
  - Web UI search function (if calling search.ts) still works
```

---

### Team B: Working Memory

**Scope**: Creation, updating, and injection of `working-memory.md`

**Dependencies**: None (independent of Team A)

**Reference implementation**: Claude Code `src/services/SessionMemory/sessionMemory.ts` + `prompts.ts`
  - Full prompt: `claude-code-system-prompts/agent-prompt-session-memory-update-instructions.md`
  - Template: `claude-code-system-prompts/data-session-memory-template.md`
  - We use the same pattern, with minor section adjustments for Walnut's butler role

**Tasks**:

1. **Working memory module**
   - New `src/core/working-memory.ts`
     - `getWorkingMemory()`: Read working-memory.md
     - `getWorkingMemoryTemplate()`: Return template (see below, adapted from Claude Code template)
     - `ensureWorkingMemory()`: Create if doesn't exist
     - `isWorkingMemoryEmpty(content)`: Check if only template without actual content
     - `getWorkingMemorySectionSizes()`: Return token count per section (for over-limit warnings)
     - `truncateWorkingMemoryForCompact(content)`: Truncate for compaction, same as Claude Code `truncateSessionMemoryForCompact()`

   **Template** (adapted from Claude Code `data-session-memory-template.md` for Walnut butler):
   ```markdown
   # Active Focus
   _What is the user currently working on? Active tasks, their IDs, and status._

   # User Requests
   _What did the user ask for recently? Their original words, not paraphrased. Include task IDs._

   # Decisions & Rationale
   _Important decisions made and WHY. Trade-offs considered. What alternatives were rejected._

   # Struggles & Breakthroughs
   _What blocked progress? How was it resolved? Root causes discovered. User corrections._

   # Session Status
   _Running sessions: what each is doing, blockers, any issues. Include session IDs._

   # Open Threads
   _Unresolved questions, pending items, things to follow up on._

   # Learnings
   _What worked well? What failed? Patterns noticed. Do not duplicate other sections._
   ```

   Claude Code original sections: Session Title, Current State, Task specification, Files and Functions,
   Workflow, Errors & Corrections, Codebase and System Documentation, Learnings, Key results, Worklog.
   We simplify to 7 sections because Walnut is a coordinator, not a coder (no need for Files/Workflow/Codebase).

2. **Working memory updater (forked agent)**
   - New `src/agent/working-memory-updater.ts`
   - Post-sampling hook (inspired by Claude Code `sessionMemory.ts:272-350`):
     - Initial threshold: 10K tokens of context
     - Update threshold: 5K token growth + 3 tool calls
     - Token-only not enough (prevents chat-only sessions without tool use from never updating)
     - Execution: forked agent turn, only `files_edit` allowed targeting `working-memory.md`
     - Uses main model (reuses prompt cache, same as Claude Code `runForkedAgent()`)
   - Update prompt (inspired by Claude Code `agent-prompt-session-memory-update-instructions.md`):
     - Read current working-memory.md content → inject as `<current_working_memory>` block
     - Instructions: Edit tool to update each section, parallel edits allowed
     - Section structure + italic descriptions must never be changed
   - Bloat prevention (same as Claude Code `prompts.ts`):
     - `MAX_SECTION_LENGTH = 2000` tokens per section
     - `MAX_TOTAL_WORKING_MEMORY_TOKENS = 12000`
     - Over limit: prompt adds "⚠ CRITICAL: section X exceeds 2000 tokens, condense aggressively"
   - State tracking (same as Claude Code):
     - `lastMemoryMessageUuid`: Prevent duplicate extraction
     - `tokensAtLastExtraction`: Record context size at last extraction
     - `extractionStartedAt`: Prevent concurrency (15s timeout, 1min stale)

3. **Compaction integration**
   - Modify `src/core/chat-history.ts:compact()`
     - Read working-memory.md → if has content → use directly as compaction summary (saves summarizer LLM call)
     - If working-memory.md empty/missing → fallback to traditional summarizer
     - Write snapshot to `memory/compaction/YYYY-MM-DD-HHMM.md` (archived)

4. **Injection timing**
   - Modify `src/agent/context.ts:buildSystemPrompt()` — inject working memory as "Earlier context" on resume/new conversation
   - Modify `src/agent/context-sources.ts` — subagent injects `working_memory` source (budget: 4000 tok)

**Test Strategy**:

```
Unit tests:
  - working-memory.ts: ensureWorkingMemory creates template, getWorkingMemory reads
  - isWorkingMemoryEmpty: empty template → true, has content → false
  - compaction: working memory has content → skip summarizer; empty → fallback

Integration tests:
  - Start Walnut → working-memory.md auto-created
  - Have 5+ conversation turns → verify working memory is auto-updated
  - Verify content quality: task names/IDs, user requests, decisions (not commit hashes)
  - Verify file size doesn't exceed ~12K tokens
  - Trigger compaction → verify:
    a. Working memory replaces traditional summary
    b. compaction/ directory has archived file
    c. Refresh page → "Earlier context" comes from working memory
  - Subagent starts → verify working_memory is in context sources
```

---

### Team C: Daily Log Quality + MEMORY_FLUSH_MESSAGE (Minimal Change)

**Scope**: Rewrite flush prompt to improve daily log write quality

**Dependencies**: None (independent of Team A & B)

**Tasks**:

1. **Rewrite `MEMORY_FLUSH_MESSAGE`**
   - Modify `src/core/chat-history.ts:1056`
   - Butler journal style prompt (see below)
   - Max 800 chars per entry

2. **That's the only change.**

```typescript
export const MEMORY_FLUSH_MESSAGE = `Pre-compaction memory flush.

Persist knowledge using the \`memory\` tool. Write as a butler's journal —
record what matters for RECALL, not for git log.

## Daily log — what to write (append, max 800 chars)

- **User requests**: their words, not paraphrased. Task names + IDs, not commits
- **Decisions & why**: important choices and reasoning
- **Struggles**: what blocked, how resolved, root causes, user corrections
- **Events**: personal matters, noteworthy non-task events, new patterns
- **Open threads**: unresolved questions, pending items

DO NOT: commit SHAs, file line counts, bundle sizes, deploy status tables,
implementation details (those → project memory).

Think: "What would I need to recall 2 weeks from now?"

## Project memory — update with technical decisions
## Global memory — update with new user preferences
If nothing new → "Nothing to persist."`;
```

**Test Strategy**:

```
Manual testing:
  - Have a long conversation → trigger compaction → check daily log output
  - Verify: no commit hashes, includes task name/ID, includes user requests
  - Compare: before/after with previous git-log style output
```

---

### Team D: Dream + Topic Files + index.md (Phase 3)

**Scope**: Periodic knowledge consolidation + topic files + index.md

**Dependencies**: Team A (QMD search), Team B (working memory)

**Reference implementation**: Claude Code `src/services/autoDream/autoDream.ts` + Karpathy LLM Wiki

**Tasks**:

1. **Topic Files — Persistent wiki knowledge pages**
   - **Essence**: Long-term memory, persistent knowledge distilled from daily logs + project memory + working memory
   - **Location**: `memory/topics/*.md`
   - **Creation**: Dream agent or agent proactively creates (when a topic recurs frequently)
   - **Updates**: Edit overwrite (same as working memory, not append)
   - **Difference from working memory**:
     - working memory = current state (real-time, gets overwritten)
     - topic files = persistent knowledge (cumulative, not overwritten daily)
     - Example: working memory records "currently doing memory v2 refactor"; topic file records "Walnut architecture design decision history"

   **Topic file format**:
   ```markdown
   ---
   title: Walnut Architecture
   updated: 2026-04-12
   tags: [walnut, architecture, design]
   ---

   ## Overview
   Brief description of the topic.

   ## Key Facts
   - Bullet points of essential knowledge
   - Include dates for time-sensitive facts

   ## Decisions
   - 2026-04-12: Memory v2 — wiki-based, QMD search, working-memory.md
   - 2026-04-03: Session memory flush via MEMORY_FLUSH_MESSAGE

   ## See Also
   - [related-topic](related-topic.md) — one-line description
   ```

2. **index.md — Wiki Directory**
   - **Location**: `memory/index.md`
   - **Format**: Karpathy style — `- [title](path) — one-line hook`, ≤150 chars per line
   - **Limit**: ≤200 lines, ≤25KB
   - **Injection**: Injected into system prompt (condensed version, ~1K tokens), helps agent know what knowledge is searchable
   - **Maintenance**: Updated by Dream agent, or by agent immediately after creating a new topic

   ```markdown
   # Memory Index

   ## Topics
   - [walnut-architecture](topics/walnut-architecture.md) — technical architecture, modules, key decisions
   - [side-project](topics/side-project.md) — Chrome Extension, API integration, accuracy
   - [user-preferences](topics/user-preferences.md) — work habits, preferences, feedback patterns

   ## Active Projects
   - [passion/walnut](projects/passion/walnut/MEMORY.md) — Walnut dev log
   - [work/project-x](projects/work/project-x/MEMORY.md) — Work project notes

   ## Recent Daily Logs
   - [2026-04-12](daily/2026-04-12.md) — Memory v2 design
   - [2026-04-11](daily/2026-04-11.md) — Claude Code analysis
   ```

3. **Dream Process — Periodic knowledge consolidation**
   - New `src/core/dream.ts`
   - **Trigger** (same as Claude Code `autoDream.ts`):
     - ≥24h since last dream + ≥5 sessions touched
     - File lock `.dream-lock` prevents concurrency (mtime = lastConsolidatedAt, PID body, 60min stale guard)
   - **Execution**: Forked agent, read-only bash (ls/grep/cat) + files_edit/write restricted to memory/
   - **4 phases** (same as Claude Code dream prompt):
     ```
     Phase 1 — Orient
       Read memory/index.md, ls memory/topics/, read existing topic headers
       
     Phase 2 — Gather
       Scan daily logs since last dream
       Read working-memory.md
       Read recent compaction/*.md
       
     Phase 3 — Consolidate
       Merge new signals into existing topic files (Edit, don't create new files unless topic is entirely new)
       Relative dates → absolute dates
       Delete contradicted old facts
       Extract cross-project general knowledge from project memory → topic files
       
     Phase 4 — Prune
       Update index.md (≤200 lines)
       Delete outdated pointers
       Flag contradictions needing user confirmation
     ```

**Test Strategy**:

```
Unit tests:
  - dream.ts: lock acquire/release, stale lock detection, trigger condition evaluation
  - Topic file format validation (YAML frontmatter + sections)

Integration tests:
  - Setup: write 3 days of daily logs + 2 project memories as test data
  - Manually trigger dream → verify:
    a. Topic files are created (at least 1)
    b. index.md is created/updated
    c. Topic content comes from daily logs (not fabricated)
    d. Relative dates converted to absolute dates
  - Run dream twice → no duplicate topic files created (merges into existing)
  - memory_notes_search can find topic file content
```

---

## Implementation Order + Team Parallelism

```
Week 1:
  Team A (QMD Search)  ────────────────────────▶  Search available
  Team B (Working Memory)  ────────────────────▶  Working memory available
  Team C (Flush Prompt)  ──▶  Done immediately (1 hour)

Week 2:
  Team A (Cleanup old code)  ──▶  Delete self-built search code
  Team B (Compaction integration)  ──▶  Working memory replaces summary
  Team D (Dream)  ─────────────────────────────▶  Topic files + index.md

Dependency graph:
  C → no dependencies (independent)
  A → no dependencies (independent)
  B → no dependencies (independent)
  D → A + B (requires QMD search + working memory)
```

Teams A, B, C are **fully parallel**, no conflicts. Team D starts after A+B complete.

---

## Complete Test Strategy

### Functional Tests

**Phase 0: Test Data Preparation (must do before implementation)**

Before changing any code, record current state as baseline:

```typescript
// test/memory-v2/baseline.test.ts
// 1. Pick ground truth snippets from real memory files
const GROUND_TRUTH = [
  { query: "session empty reply",    expectedFile: "daily/2026-04-03.md",     expectedSnippet: "session empty reply" },
  { query: "walnut architecture",    expectedFile: "projects/passion/walnut/", expectedSnippet: "..." },
  { query: "API design decision",    expectedFile: "daily/...",                expectedSnippet: "..." },
  { query: "savings account",        expectedFile: "notes/Areas/Finance/",     expectedSnippet: "savings" },
  { query: "visa records",           expectedFile: "notes/Areas/Records/",     expectedSnippet: "visa" },
];

// 2. Run current search() for each query, record results to baseline.json
// 3. After implementation compare: QMD search results ≥ baseline (must not regress)
```

**QMD Search Tests**:
```
test: QMD store init + collections correctly configured
test: memoryStore.update() indexes all memory/*.md files
test: notesStore.update() indexes all notes/*.md files
test: memory_notes_search("session empty reply") → returns daily log results
test: memory_notes_search("savings", sources: ["note_areas"]) → returns notes results
test: memory_notes_search defaults to memory-only (noisy neighbor protection)
test: per-source weight: topic result adjustedScore > daily result with same raw score
test: per-source guaranteed: topic minSlots=2, reserved even if daily scores higher
test: write new memory file → watcher triggers → 2s later search can find it
test: QMD model unavailable → graceful degradation (no crash, returns empty or BM25-only)
test: store.close() correctly releases resources
```

**Working Memory Tests**:
```
test: ensureWorkingMemory() creates template file on startup
test: isWorkingMemoryEmpty(template) → true
test: isWorkingMemoryEmpty(template + content) → false
test: getWorkingMemorySectionSizes() correctly calculates token count per section
test: updater trigger: 5K token growth + 3 tool calls → triggers
test: updater trigger: only token growth without tool calls → does not trigger
test: updater does not trigger during compaction
test: updater output contains task IDs (not commit hashes)
test: updater does not modify section headers or italic descriptions
test: section exceeds 2000 tokens → prompt includes CRITICAL WARNING
test: compaction with working memory content → skips summarizer LLM call
test: compaction with empty working memory → fallback to traditional summarizer
test: compaction artifact written to compaction/ directory
test: resume → "Earlier context" comes from working memory
test: subagent context sources include working_memory
```

**Daily Log Quality Tests**:
```
test: MEMORY_FLUSH_MESSAGE output contains no commit hashes
test: MEMORY_FLUSH_MESSAGE output contains task name/ID
test: MEMORY_FLUSH_MESSAGE output ≤ 800 chars
```

### Performance Tests

```
perf: QMD initial index time (memory ~50 files + notes ~2200 files)
      - Target: memory < 30s, notes < 120s (initial; subsequent incremental <5s)
perf: QMD search latency (single collection)
      - Target: searchLex < 50ms, search (full pipeline) < 500ms
perf: QMD search latency (per-source wrapper, 7 collections in parallel)
      - Target: < 2s total (7 × ~300ms parallel)
perf: Working memory updater latency (forked agent turn)
      - Target: < 3s (main model + prompt cache hit)
perf: Compaction with working memory (vs traditional summarizer)
      - Target: faster (saves summarizer LLM call)
perf: Memory usage (QMD models loaded vs idle)
      - Target: loaded ~2GB, released after 5 min idle
perf: fs.watch debounce prevents update storms
      - Target: 10 consecutive file writes → triggers only 1 update
```

### Regression Tests

```
regression: All GROUND_TRUTH queries still return relevant results under QMD
regression: Web UI search function (if calling search.ts) still works
regression: Existing files_write/files_read memory operations unaffected
regression: Compaction flow uninterrupted (memory flush + summary generation)
regression: Subagent context injection uninterrupted
regression: Triage agent can still write memory
```

### Test Utilities

```typescript
// test/memory-v2/helpers.ts

// Create temporary memory directory + QMD store for testing
async function createTestMemoryStore(fixtures: Record<string, string>) {
  const tmpDir = await mkdtemp('walnut-memory-test-');
  for (const [path, content] of Object.entries(fixtures)) {
    await writeFile(join(tmpDir, path), content);
  }
  const store = await createStore({ dbPath: join(tmpDir, 'test.sqlite'), config: { ... } });
  await store.update();
  await store.embed();
  return { store, tmpDir, cleanup: () => rm(tmpDir, { recursive: true }) };
}

// Assert search results contain expected file
function expectResultContains(results, expectedPath, minScore = 0.3) { ... }

// Assert per-source guaranteed slots
function expectMinSourceSlots(results, source, minCount) { ... }

// Performance timing wrapper
async function timed<T>(label: string, fn: () => Promise<T>): Promise<{ result: T; ms: number }> { ... }
```

---

## Appendix A: Code References — Walnut (Modification Targets)

### Constants (`src/constants.ts`)
```
WALNUT_HOME   = ~/.open-walnut/
MEMORY_DIR    = ~/.open-walnut/memory/
DAILY_DIR     = ~/.open-walnut/memory/daily/
PROJECTS_DIR  = ~/.open-walnut/memory/projects/
REPOS_MEMORY_DIR = ~/.open-walnut/memory/repos/
SESSIONS_DIR  = ~/.open-walnut/memory/sessions/
MEMORY_FILE   = ~/.open-walnut/MEMORY.md
NOTES_DIR     = ~/.open-walnut/notes/
TASKS_FILE    = ~/.open-walnut/tasks/tasks.json
CHAT_HISTORY_FILE = ~/.open-walnut/chat-history.json
```

### System Prompt (`src/agent/context.ts`)
- `buildTaskCategoriesSection()` — task inventory
- `getNotesContext()` — reads `notes/AGENTS.md` for injection
- `buildMemoryContext(budget=20000)` — main memory context builder (MODIFY: reduce budget to ~8K, add memory_notes_search hint, inject index.md summary)
- `buildRoleSection(name)` — role/rules system prompt
- `buildSystemPrompt()` — assembles everything, includes `getCompactionSummary()` as "Earlier conversation context" (MODIFY: use working-memory.md instead when available)

### Chat History + Compaction (`src/core/chat-history.ts`)
- Line 1056: `MEMORY_FLUSH_MESSAGE` — flush prompt (MODIFY: butler journal style)
- Line 1071: `MEMORY_FLUSH_MIN_ENTRIES = 8`
- Line 1151: `compact(summarizer, memoryFlusher)` — main compaction function (MODIFY: working memory replaces summarizer)
- Line 1195: `shouldFlush` — checks min entries before memory flush
- Line 1207: `memoryFlusher(aiMsgs)` — runs memory flush agent turn
- `getCompactionSummary()` — reads stored summary for injection

### Compaction Callbacks (`src/web/routes/chat.ts`)
- Line 56: `createCompactionCallbacks()` — creates summarizer + memoryFlusher
- Line 87: `memoryFlusher` — runs `runAgentLoop(MEMORY_FLUSH_MESSAGE, ...)`
- NOTE: memoryFlusher uses full default tool set (not wrapped like Moltbot) for prompt cache alignment

### Agent Tools (`src/agent/tools.ts`)
- Line 98: `export interface ToolDefinition` — tool definition shape
- Line 191: `export const tools: ToolDefinition[]` — tool array (ADD: memory_notes_search, memory_get)

### Memory Module Files (existing, may need modification or deletion)
- `src/core/memory-index.ts` — SQLite FTS5 + chunk indexing (DELETE/REPLACE: QMD handles this)
  - `getDb()`, `chunkMarkdown()`, `collectMemoryFiles()`, `indexMemoryFiles()`, `searchIndex()`
- `src/core/memory-watcher.ts` — fs.watch → reindex + embed (REPLACE: simplified QMD trigger watcher)
  - `startMemoryWatcher()` — watches MEMORY_DIR + MEMORY_FILE
- `src/core/search.ts` — hybrid search (SIMPLIFY: delegate to QMD wrapper)
  - `search(query, options)`, `normalizedFuse()`, `vectorSearchAll()`, `bm25ScoreMemory()`, `bm25ScoreTasks()`, `recencyBonus()`
- `src/core/embedding/client.ts` — Ollama HTTP client (DELETE: QMD has own embedding)
  - `embed()`, `batchEmbed()`, `isOllamaAvailable()`, `unloadModel()`
- `src/core/embedding/pipeline.ts` — reconciliation pipeline (DELETE: QMD handles)
  - `reconcileTaskEmbeddings()`, `reconcileChunkEmbeddings()`, `reconcileAllEmbeddings()`, `embedSingleTask()`
- `src/core/embedding/store.ts` — embedding SQLite storage (DELETE: QMD handles)
- `src/core/embedding/cosine.ts` — cosine similarity (DELETE: QMD handles)
- `src/core/embedding/types.ts` — SearchMode type

### Memory CRUD (kept unchanged)
- `src/core/daily-log.ts`
  - `appendDailyLog(content, source?, projectPath?, agentId?)` — append entry
  - `getDailyLog(date?)`, `getDailyLogsWithinBudget(tokenBudget)`
  - `compactDailyLog(date, threshold, summarizer)` — LLM summarize
  - `estimateTokens(text)` — chars/4 approximation
- `src/core/memory-file.ts`
  - `getMemoryFile()`, `updateMemoryFile(content, hash?)`, `editMemoryFile(old, new, hash)`
- `src/core/project-memory.ts`
  - `appendProjectMemory(path, content, source?)` — also dual-writes to daily log
  - `getProjectMemory(path)`, `getAllProjectSummaries()`
- `src/core/repo-memory.ts`
  - `appendRepoMemory(slug, content, source?)` — no daily log cross-write
- `src/agent/tools/files/memory-handler.ts` — agent tool handler for memory file ops

### Subagent Context (`src/agent/context-sources.ts`)
- `loadContextSources(agentDef, { taskId, sessionId, cwd, host })` — loads context in parallel
- Auto-inferred: `task_details` (1500 tok), `project_memory` (2000 tok)
- Optional: `global_memory` (2000), `daily_log` (3000), `session_history` (4000), `conversation_log` (1000)
- ADD: `working_memory` (4000 tok)

### Agent Loop (`src/agent/loop.ts`)
- `runAgentLoop(prompt, history, callbacks)` — main agent execution
- Used by memoryFlusher and will be used by working memory updater

---

## Appendix B: Code References — Claude Code (Reference Implementation)

All paths relative to Claude Code source code directory.

### Session Memory
- `src/services/SessionMemory/sessionMemory.ts`
  - Line 272-350: Post-sampling hook trigger logic
    - `initializationThreshold = 10000` tokens
    - `updateThreshold = 5000` tokens growth
    - `toolCallThreshold = 3` tool calls
    - Trigger: `(hasMetTokenThreshold && hasMetToolCallThreshold) OR (hasMetTokenThreshold && !hasToolCallsInLastTurn)`
  - Line 310-320: `buildSessionMemoryUpdatePrompt(currentMemory, memoryPath)`
  - Line 318-323: `runForkedAgent()` — isolated context, only FileEditTool allowed
  - Line 411: Uses `mainLoopModel` from `toolUseContext.options` (prompt cache sharing!)
  - State tracking: `lastMemoryMessageUuid`, `tokensAtLastExtraction`, `extractionStartedAt` (15s timeout, 1min stale)

- `src/services/SessionMemory/prompts.ts`
  - `MAX_SECTION_LENGTH = 2000` tokens per section
  - `MAX_TOTAL_SESSION_MEMORY_TOKENS = 12000`
  - `buildSessionMemoryUpdatePrompt()` — the update instruction prompt
  - `truncateSessionMemoryForCompact(content)` — truncate before use in compaction
  - Section size analysis + CRITICAL WARNING injection when oversized

- `src/services/SessionMemory/sessionMemoryUtils.ts`
  - `getLastSummarizedMessageId()` / `setLastSummarizedMessageId()`
  - `getSessionMemoryContent()` — read from disk
  - `isSessionMemoryEmpty(content)` — check if template-only

### Compaction with Session Memory
- `src/services/compact/autoCompact.ts`
  - Line 287-310: `trySessionMemoryCompaction()` called FIRST
  - If succeeds → skip traditional compaction (saves LLM call)
  - If null → fallback to `compactConversation()`
  - Line 296: `setLastSummarizedMessageId(undefined)` after SM compact

- `src/services/compact/sessionMemoryCompact.ts`
  - Line 514: `trySessionMemoryCompaction(messages, agentId, threshold)`
  - Line 519: `shouldUseSessionMemoryCompaction()` — feature gate
  - Line 530: `getSessionMemoryContent()` — load from disk
  - Line 540: `isSessionMemoryEmpty()` — fall back if empty
  - Line 571: `calculateMessagesToKeepIndex()` — find boundary
  - Line 591: `createCompactionResultFromSessionMemory()` — build result
  - Key: `lastSummarizedMessageId` marks boundary between summarized/unsummarized

### Forked Agent
- `src/utils/forkedAgent.ts`
  - `runForkedAgent(params)` — runs isolated agent turn
  - `createCacheSafeParams(context)` — for prompt cache sharing
  - `createSubagentContext()` — isolated context creation
  - Uses parent's model + system prompt + tools for cache reuse

### Dream Consolidation
- `src/services/autoDream/autoDream.ts`
  - `initAutoDream(context)` — called from `backgroundHousekeeping`
  - `executeAutoDream()` — called from `stopHooks` (post-sampling)
  - Gating order: time gate (≥24h) → session gate (≥5) → lock gate → scan throttle (10min)
  - Feature flag: `tengu_onyx_plover`
  - Forked agent with restricted bash (read-only: ls, find, grep, cat, stat, wc, head, tail)

- `src/services/autoDream/consolidationLock.ts`
  - `.consolidate-lock` file in memory dir
  - Content: PID. mtime = lastConsolidatedAt
  - Stale: 60 minutes
  - `rollbackConsolidationLock(priorMtime)` on failure

- `src/services/autoDream/consolidationPrompt.ts`
  - 4 phases: Orient → Gather → Consolidate → Prune
  - "Skim existing topic files so you improve them rather than creating duplicates"
  - "Converting relative dates to absolute dates"
  - "Deleting contradicted facts"
  - Index: `_memory.md`, ≤25KB, `MAX_ENTRYPOINT_LINES`

### System Prompts (from claude-code-system-prompts repo)
- `agent-prompt-session-memory-update-instructions.md` — THE update prompt (use as template)
  - "Use the Edit tool to update the notes file"
  - "NEVER modify section headers or italic descriptions"
  - "Make all Edit tool calls in parallel in a single message"
  - "Keep each section under ~${MAX_SECTION_TOKENS} tokens"
  - "IMPORTANT: Always update 'Current State'"
- `data-session-memory-template.md` — 10 section template
  - Session Title, Current State, Task specification, Files and Functions, Workflow, Errors & Corrections, Codebase and System Documentation, Learnings, Key results, Worklog
- `agent-prompt-dream-memory-consolidation.md` — dream prompt with 4 phases
- `system-prompt-context-compaction-summary.md` — compaction summary format
- `agent-prompt-conversation-summarization.md` — detailed conversation summary (9 sections)

---

## Appendix C: Code References — Moltbot (Search + Decay Reference)

All paths relative to Moltbot source code directory.

### Temporal Decay
- `extensions/memory-core/src/memory/temporal-decay.ts` — FULL IMPLEMENTATION (port target)
  - `toDecayLambda(halfLifeDays)` → `Math.LN2 / halfLifeDays`
  - `calculateTemporalDecayMultiplier({ ageInDays, halfLifeDays })` → `exp(-lambda * age)`
  - `applyTemporalDecayToScore({ score, ageInDays, halfLifeDays })` → `score * multiplier`
  - `parseMemoryDateFromPath(filePath)` — regex `/memory\/(\d{4})-(\d{2})-(\d{2})\.md$/`
  - `isEvergreenMemoryPath(filePath)` — MEMORY.md + non-dated memory/*.md → no decay
  - `extractTimestamp({ filePath, source, workspaceDir })` — path date → mtime fallback
  - `applyTemporalDecayToHybridResults(results, config)` — apply to search result array

### Memory Flush (Write-Side Reference)
- `src/auto-reply/reply/memory-flush.ts` — trigger logic
  - `shouldRunMemoryFlush()`, `hasAlreadyFlushedForCurrentCompaction()`
- `extensions/memory-core/src/flush-plan.ts` — flush prompt + config
  - `DEFAULT_MEMORY_FLUSH_SOFT_TOKENS = 4000`
  - `DEFAULT_MEMORY_FLUSH_FORCE_TRANSCRIPT_BYTES = 2MB`
  - Safety: "Treat MEMORY.md, SOUL.md as read-only during flush"
  - "APPEND new content only", "canonical YYYY-MM-DD.md filename"

### Hybrid Search
- `extensions/memory-core/src/memory/hybrid.ts` — RRF fusion
  - `vectorWeight=0.7, textWeight=0.3` default
  - `score = vectorWeight * vectorScore + textWeight * textScore`
- `extensions/memory-core/src/memory/mmr.ts` — Maximal Marginal Relevance
  - `lambda=0.7` (relevance vs diversity)

### Memory Config
- `src/agents/memory-search.ts` — resolved config defaults
  - `maxResults: 6`, `minScore: 0.35`
  - `chunking: { tokens: 400, overlap: 80 }`
  - `maxInjectedChars: 4000`

---

## Appendix D: QMD SDK Reference

### Installation
```
npm install @tobilu/qmd   # package: @tobilu/qmd (NOT 'qmd')
```
Requires Node 22+.

### Key API
```typescript
import { createStore } from "@tobilu/qmd";

const store = await createStore({
  dbPath: "/path/to/index.sqlite",
  config: {
    collections: {
      name: { path: "./dir", pattern: "**/*.md", includeByDefault: true }
    }
  }
});

// Index files (no auto-watcher — call explicitly)
await store.update();                    // scan filesystem, hash compare, reindex changed
await store.update({ collections: ["daily"] });  // specific collection
await store.embed();                     // generate embeddings for unembedded chunks
await store.embed({ force: true });      // re-embed everything

// Search
const results = await store.search({ query: "...", limit: 10 });
const results = await store.search({ query: "...", limit: 10, collection: "daily" });
const lexOnly = await store.searchLex("...", { limit: 10 });  // BM25 only, fast

// Point read
const doc = await store.get("path/to/file.md");
const docs = await store.multiGet(["path1.md", "path2.md"]);

// Lifecycle
await store.close();   // release models + DB
```

### Environment Variables
```
QMD_EMBED_MODEL=hf:BAAI/bge-m3-GGUF/bge-m3.gguf   # Override embedding model (BGE-M3 for zh+en)
QMD_RERANK_MODEL=hf:...                               # Override reranker
QMD_GENERATE_MODEL=hf:...                             # Override query expansion
QMD_EMBED_CONTEXT_SIZE=2048                           # Embedding context window
```

### Models (auto-download to ~/.cache/qmd/models/)
| Model | Default | Size | Purpose |
|-------|---------|------|---------|
| Embedding | EmbeddingGemma-300M | ~300MB | We override to BGE-M3 (~2GB) for zh+en |
| Reranker | Qwen3-Reranker-0.6B | ~640MB | Cross-encoder relevance scoring |
| Query expansion | qmd-query-expansion-1.7B | ~1.1GB | Query variant generation |

### Collection Config
```typescript
{
  name: {
    path: string,           // directory path
    pattern: string,        // glob, default "**/*.md"
    ignore?: string[],      // exclusion globs
    context?: ContextMap,   // path-prefix metadata for reranker
    includeByDefault?: boolean  // default true, false = opt-in only
  }
}
```

### Search Result Shape
```typescript
{
  filepath: string,    // e.g. "qmd://daily/2026-04-03.md"
  title: string,
  score: number,       // 0-1 relevance
  snippet: string,     // matched text excerpt
  collection: string,  // collection name
}
```

# Walnut Repository YAML Format

Repository profiles are stored as YAML files in `~/.open-walnut/repositories/{slug}.yaml`.

## Complete Schema

```yaml
# ── Required fields ──
name: Project Name                    # Human-readable name
description: >-                       # 1-3 sentences — what it does, why it matters
  Personal AI that manages tasks, knowledge, and AI sessions.
  TypeScript/React frontend with Node.js backend. Runs every AI turn as
  a Claude Code session bound to a task.
hosts:                                # At least one host required
  local:                              # Host label (any string)
    path: /absolute/path/to/repo      # Absolute filesystem path (required)
    ssh_host: hostname                 # SSH host (optional, for remote hosts)
  cloud-desktop:
    path: /home/user/project
    ssh_host: dev-desktop

# ── Rich context fields (the valuable part) ──

overview: |                           # What / Why / How, read on demand by an agent
  ## What
  Walnut is a Personal AI that manages tasks, knowledge, and
  Claude Code sessions. It provides a React web UI for task management
  and runs every AI turn as a Claude Code session bound to a task.

  ## Why
  Consolidates task tracking, memory management, and AI session
  orchestration into a single self-hosted tool. Replaces scattered
  todo apps and manual Claude Code session management.

  ## How
  Express server with React SPA frontend. Chatting with Walnut is a
  Claude Code session that reaches tasks, memory, and search through
  Walnut's operation registry, mounted as an MCP server. Tasks, memory,
  and session state are stored as JSON/YAML files in ~/.open-walnut/.

architecture: |                       # Components, data flow, key directories
  ## Components
  - **Session Manager** (src/providers/): Claude Code CLI process lifecycle
  - **Task Manager** (src/core/): CRUD, phases, event bus integration
  - **Operation Registry** (src/ops/): the named operations sessions and the CLI call
  - **Model Layer** (src/model/): single model calls, provider adapters, model catalog
  - **Web Server** (src/web/): Express REST API + WebSocket
  - **React SPA** (web/src/): Vite-built frontend with task/session/memory UI
  - **Event Bus** (src/core/event-bus.ts): Pub/sub backbone connecting all subsystems

  ## Data Flow
  User chat → claude session → Walnut ops → Task/Session/Memory managers
    → Event Bus → WebSocket → React UI updates

  ## Key Directories
  src/core/      Task manager, memory, sessions, event bus, cron
  src/ops/       Operation registry (what sessions and the CLI call)
  src/model/     Model calls, provider adapters, model catalog
  src/providers/ Claude Code session runner, daemon, named-agent runner
  src/web/       Express server, REST routes, WebSocket
  web/src/       React SPA (pages, components, hooks, API client)
  tests/         — Vitest E2E and unit tests

tech_stack: [TypeScript, React, Node.js, Express, SQLite, Vite]

common_commands: |                    # Day-one developer commands
  npm run build              # Build server to dist/
  cd web && npx vite build   # Build React SPA
  npm run dev:prod           # Build all + restart server
  npm test                   # Run all tests
  cd web && npx vite         # Frontend hot reload (:5173)
```

## Field Details

### name (required)
Human-readable project name. Used in UI and agent context.

### description (required)
1-3 sentence summary of what the project does. NOT just "A web app": be specific about its purpose and value. This is what repository listings and the Repositories page show.

### hosts (required)
Map of host labels to host configurations. Each host represents where the repo exists on a particular machine.

- **path** (required): Absolute filesystem path to the repo root
- **ssh_host** (optional): SSH hostname for remote hosts

### overview (strongly recommended)
The most important field for AI context. Written in markdown with What/Why/How sections. Nothing injects it into a session for you; it is what an agent reads when it needs to understand a repo it has not worked in. An agent reading this should immediately understand:
- What the project does (not just "it's a web app")
- Why it exists (what problem it solves)
- How it works at a high level (the 30-second architecture explanation)

### architecture (strongly recommended)
Structured breakdown of the codebase. Include:
- **Components**: Major subsystems with 1-line descriptions
- **Data Flow**: How requests/events move through the system
- **Key Directories**: Top-level directory → purpose mapping

### tech_stack (recommended)
Array of technology names. Include frameworks, languages, data stores, and infrastructure tools.

### common_commands (recommended)
The commands a new developer needs on day one. Include build, test, dev, and deploy commands with comments.

## Naming Convention

The YAML filename (slug) should be:
- Lowercase
- Hyphenated (use `-` instead of spaces)
- Short but descriptive

Examples: `walnut.yaml`, `data-pipeline.yaml`, `eks-event-service.yaml`

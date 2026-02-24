# Walnut

**Personal AI butler that manages tasks, runs Claude Code sessions, and accumulates project knowledge — all from a single web UI.**

Walnut is a self-hosted task management system with an embedded AI agent. You talk to it in natural language, and it creates tasks, spawns coding sessions, syncs with Microsoft To-Do, and builds a searchable memory of everything you work on.

## Screenshots

### Chat with the AI agent to create tasks

![Create a task through chat](docs/demo-create-task.png)

Ask Walnut to create tasks, set priorities, assign due dates — it handles the category/project hierarchy automatically.

### Start Claude Code sessions directly from tasks

![Start a coding session](docs/demo-start-session.png)

Walnut can spawn Claude Code sessions attached to any task. Sessions run in plan or bypass mode, and their output is tracked alongside the task.

## Features

- **AI Chat Agent** — Talk to Walnut in natural language. It has 30+ tools to manage your tasks, memory, sessions, and integrations.
- **Task Management** — 4-layer hierarchy (Category > Project > Task > Subtask) with priorities, phases, dependencies, due dates, and starring.
- **Claude Code Sessions** — Spawn AI coding sessions from any task. Sessions run via the Claude Code SDK with full tool access.
- **Memory System** — Per-project markdown memory files, daily logs, and session summaries. Full-text search + vector search (via Ollama embeddings).
- **Microsoft To-Do Sync** — Two-way sync with Microsoft To-Do lists. Tasks, phases, priorities, and notes stay in sync.
- **Plugin System** — External plugins loaded from `~/.walnut/plugins/`. Implement the `IntegrationSync` interface to add new integrations.
- **Cron Jobs** — Schedule recurring tasks with natural language or cron expressions. The agent can respond to cron triggers.
- **Heartbeat Checklists** — Daily/weekly checklists in markdown that the agent can run through.
- **Web Dashboard** — React SPA with task board, session viewer, memory browser, search, usage tracking, and more.
- **CLI** — Full-featured command-line interface for all operations.

## Quick Start

```bash
git clone https://github.com/EvanZhang008/walnut.git
cd walnut
npm install       # installs backend + frontend deps
npm start         # builds and starts server on http://localhost:3456
```

Open [http://localhost:3456](http://localhost:3456) in your browser.

## Prerequisites

- **Node.js** >= 22
- **AWS credentials** for Claude via Bedrock (or configure a different provider in `~/.walnut/config.yaml`)
- **Ollama** (optional) — for local embedding-based vector search

## Configuration

Walnut stores all data in `~/.walnut/`. Configuration is in `~/.walnut/config.yaml`:

```yaml
# AI model configuration
model: claude-sonnet-4-20250514
aws_region: us-west-2

# Microsoft To-Do sync (optional)
plugins:
  ms-todo:
    enabled: true
    client_id: YOUR_AZURE_AD_CLIENT_ID

# Heartbeat (optional)
heartbeat:
  enabled: true
```

Run `walnut auth` to set up Microsoft To-Do OAuth if needed.

## Project Structure

```
src/
  agent/          # AI agent: tools, context builder, loop, caching
  commands/       # CLI commands (start, chat, tasks, sessions, web, ...)
  core/           # Data layer: task-manager, memory, sessions, cron, config
  heartbeat/      # Daily/weekly checklist runner
  hooks/          # Lifecycle hooks (on-compact, on-stop)
  integrations/   # Built-in plugins (MS To-Do, git-sync, tmux)
  logging/        # Structured logger with redaction
  providers/      # Session providers (Claude Code SDK, SSH, subagent)
  session-server/ # Multi-session server via Claude Agent SDK
  utils/          # Shared utilities
  web/            # Express server, REST routes, WebSocket
web/              # React frontend (Vite + TypeScript)
tests/            # Unit, integration, e2e, and Playwright browser tests
```

See [ARCHITECTURE.md](./ARCHITECTURE.md) for detailed system design.

## Development

```bash
npm run dev           # Watch mode (backend only)
npm run web:dev       # Watch mode (backend + frontend with HMR)
npm run lint          # TypeScript type checking
npm run test          # Run all tests (unit + integration + e2e)
npm run test:unit     # Unit tests only
npm run test:e2e      # End-to-end tests only
```

## Scripts

| Command | Description |
|---------|-------------|
| `npm start` | Build and start production server on port 3456 |
| `npm run dev` | Watch mode for backend TypeScript |
| `npm run web:dev` | Full dev mode with frontend HMR |
| `npm run web:build` | Production build (backend + frontend) |
| `npm test` | Run all tests |
| `npm run lint` | TypeScript type check |

## Tech Stack

- **Backend**: Node.js, Express, TypeScript, better-sqlite3
- **Frontend**: React, Vite, TypeScript
- **AI**: Anthropic Claude via AWS Bedrock (Claude Agent SDK)
- **Testing**: Vitest (unit/integration/e2e), Playwright (browser)
- **Sync**: Microsoft Graph API (To-Do), plugin system for extensibility

## License

MIT

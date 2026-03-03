# Walnut — AI-Native Personal Productivity System with Claude Code Web UI

**An AI agent that manages your projects, notes, and coding sessions — with the missing web UI for Claude Code built in.**

Walnut is not just a dashboard — it's an AI-native app. A built-in AI agent with 30+ tools manages your tasks, accumulates knowledge, spawns and monitors Claude Code sessions, and acts on your behalf. It also gives Claude Code a proper web interface: real-time session streaming, multi-session monitoring, visual task boards, and persistent memory. Think of it as an AI butler that happens to have a beautiful UI.

> **Philosophy**: Walnut is human-first. It amplifies *your* productivity — not by building a swarm of agents talking to each other, but by giving *you* superpowers. You stay in control. The AI handles the grunt work, surfaces what matters, and gets out of your way. The goal is simple: make your day smooth, focused, and productive.

## Why Walnut?

**If you use Claude Code in the terminal**, you've probably felt the pain:
- Sessions disappear when you close the tab. No history, no context.
- You can't see multiple sessions at once.
- There's no way to attach a session to a task and track progress visually.
- You lose the knowledge gained in each session.

**If you use separate apps for tasks, notes, and AI coding**, you've felt this too:
- Context is scattered across Notion, Todoist, Apple Notes, and terminal windows.
- Your AI doesn't know what you're working on. You re-explain everything every time.
- Task completion doesn't capture what was learned or decided.

Walnut replaces all of that with one system:

| What you use today | Walnut equivalent |
|---|---|
| Claude Code (terminal) | Web UI with real-time streaming, multi-session view, model switching |
| Todoist / Notion projects | 4-layer task hierarchy (Category → Project → Task → Subtask) |
| Apple Notes / Obsidian | Per-project memory files, daily logs, session summaries |
| Manual AI workflows | 30+ agent tools, cron jobs, automated triage |

## Screenshots

### Talk to the agent, get things done

![Create a task through chat](docs/demo-create-task.png)

> "I need to file my tax before this week. Make it high priority and star."
>
> Walnut creates the category, project, and task — sets priority, due date, and star — in one shot.

### AI sessions that work for you

![Start a coding session](docs/demo-start-session.png)

> The agent spawns a Claude Code session attached to the task. It runs in plan mode, reports progress, and you can check on it anytime from the session panel.

## Key Features

### Claude Code Web UI
- **Real-time session streaming** — watch tool calls, outputs, and reasoning live in the browser
- **Multi-session dashboard** — run and monitor multiple Claude Code sessions side by side
- **Mid-session model switching** — swap between Opus, Sonnet, and Haiku without losing context
- **Plan → Execute workflow** — sessions produce a plan file for your review, then execute on approval
- **Remote sessions via SSH** — run Claude Code on remote machines with automatic node version detection (nvm, fnm, volta, asdf)
- **Session history & search** — every session is saved, searchable, and attached to a task
- **Focus Bar** — pin active tasks to a dock at the bottom; see live session previews, send messages, switch context in one click

### Project & Task Tracking
- **4-layer hierarchy**: Category → Project → Task → Subtask
- **7-phase lifecycle**: TODO → IN_PROGRESS → AGENT_COMPLETE → AWAIT_HUMAN_ACTION → PEER_CODE_REVIEW → RELEASE_IN_PIPELINE → COMPLETE
- **Rich metadata**: priorities (4 tiers), due dates, dependencies with cycle detection, starred favorites, tags
- **Parent-child tasks**: nested task hierarchies with starred-parent auto-includes-children
- **Drag-and-drop** task reordering within and across projects
- **Natural language task creation** — just tell the agent what you need

### Notes & Knowledge Base
- **Per-project memory** — `~/.walnut/memory/projects/{category}/{project}/MEMORY.md`
- **Daily activity logs** — auto-generated at `memory/daily/YYYY-MM-DD.md`
- **Session summaries** — knowledge captured automatically when sessions end
- **Full-text + semantic search** — SQLite FTS5 + BGE-M3 vector embeddings (local Ollama)
- **Knowledge accumulates** — the agent reads and writes memory as it works; it gets smarter over time

### AI Agent (30+ Tools)
- **Task management**: create, query, update, complete, delete tasks — with full hierarchy awareness
- **Memory**: append logs, update summaries, search across all knowledge
- **Sessions**: start, monitor, message, and archive Claude Code sessions
- **Execution**: run shell commands, read/write/edit files, apply patches
- **Web**: search the internet, fetch pages, analyze images
- **Scheduling**: cron jobs, heartbeat checklists, automated triage
- **Integrations**: Microsoft To-Do two-way sync, Slack notifications, plugin system

### Automation & Scheduling
- **Cron jobs** — one-time, interval, or cron expression with timezone support
- **Heartbeat checklists** — daily/weekly routines the agent runs autonomously
- **Session triage** — AI reviews session results and surfaces what needs your attention
- **Event-driven triggers** — react to session completions, cron finishes, and more

### Local-First & Private
- **100% local** — all data lives in `~/.walnut/` as plain JSON, Markdown, and SQLite files
- **No cloud database, no telemetry, no third-party accounts** required for core functionality
- **Git-sync backup** — auto-commits your data every 30 seconds to a git repo
- **Portable** — copy `~/.walnut/` to another machine and you're running
- **Integrations are optional** — Microsoft To-Do, Jira, and custom plugins are all opt-in

## Multi-Agent — But Human-Centered

Yes, Walnut supports multi-session and embedded subagents. You can run parallel Claude Code sessions, spawn triage agents, and automate workflows across tasks.

But that's not the point.

The point is **you**. Walnut doesn't try to build an autonomous agent network where bots talk to bots. That approach sounds impressive but often produces unreliable results and burns tokens. Instead, Walnut keeps the human in the loop:

- **You** decide what to work on. The AI organizes and executes.
- **You** review plans before execution. The AI doesn't go rogue.
- **You** get notified when something needs attention. The AI handles the rest silently.
- **You** accumulate knowledge over time. The AI makes it searchable and actionable.

The result: you feel in control, your day flows smoothly, and you get more done than you thought possible.

## Quick Start

```bash
git clone https://github.com/EvanZhang008/walnut.git
cd walnut
npm install       # installs backend + frontend dependencies
npm start         # builds everything and starts on http://localhost:3456
```

Open [http://localhost:3456](http://localhost:3456) in your browser.

### Prerequisites

- **Node.js** >= 22
- **AWS credentials** for Claude via Bedrock (or configure another provider in `~/.walnut/config.yaml`)
- **Ollama** (optional) — enables local vector search for memory

## Configuration

All configuration lives in `~/.walnut/config.yaml`:

```yaml
# AI model
model: claude-sonnet-4-20250514
aws_region: us-west-2

# Microsoft To-Do (optional)
plugins:
  ms-todo:
    enabled: true
    client_id: YOUR_AZURE_AD_CLIENT_ID

# Session limits (optional)
session:
  max_idle: 30          # max idle sessions per host
  idle_timeout_minutes: 30  # auto-kill idle sessions

# Heartbeat checklists (optional)
heartbeat:
  enabled: true
```

Run `walnut auth` to set up Microsoft To-Do OAuth.

External plugins go in `~/.walnut/plugins/{plugin-name}/`.

## Web Dashboard Pages

| Route | Page | What it does |
|---|---|---|
| `/` | **Home** | Chat (left) + Session panels (middle) + Todo panel (right) + Focus Bar (bottom) |
| `/sessions` | **Sessions** | Task tree browser + full session detail with chat, model picker, plan preview |
| `/tasks` | **Task Board** | Full task management with filters, search, drag-and-drop |
| `/tasks/:id` | **Task Detail** | Single task view with subtasks, sessions, notes, dependencies |
| `/search` | **Search** | Hybrid full-text + semantic search across tasks and memory |
| `/usage` | **Usage** | Token costs, cache efficiency, daily spending charts |
| `/settings` | **Settings** | Config editor, integration management |

## CLI

```bash
walnut                          # Interactive TUI
walnut web [--port 3456]        # Start web dashboard
walnut add "title" -p high -c Work -l Project  # Add task
walnut tasks [-s todo] [-c work]               # List/filter tasks
walnut done <id>                # Complete task
walnut sessions                 # List Claude Code sessions
walnut start <task_id>          # Start session for task
walnut recall "query"           # Search memory
walnut chat                     # Chat with agent (CLI)
walnut logs [-f] [--json]       # View structured logs
```

All commands support `--json` for scripting.

## Project Structure

```
src/
  agent/          # AI agent: 30+ tools, system prompt, context builder, caching
  commands/       # CLI command handlers
  core/           # Data layer: tasks, sessions, memory, cron, config, event bus
  heartbeat/      # Periodic AI self-check system
  hooks/          # Claude Code lifecycle hooks
  integrations/   # Plugins: MS To-Do, git-sync, custom
  logging/        # Structured JSON logging with redaction
  providers/      # Claude Code session runner, subagent runner
  utils/          # Shared utilities
  web/            # Express server, REST API (15 route files), WebSocket
web/              # React SPA (Vite + TypeScript)
tests/            # Unit, integration, e2e, and Playwright browser tests
```

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full system design.

## Development

```bash
npm run dev           # Watch mode (backend)
cd web && npx vite    # Frontend HMR on http://localhost:5173
npm run lint          # TypeScript type check
npm test              # All tests (parallel)
```

| Command | Description |
|---------|-------------|
| `npm start` | Build and start production server on port 3456 |
| `npm run dev` | Backend watch mode |
| `cd web && npx vite` | Frontend dev with hot reload (proxies API to :3456) |
| `npm test` | Run all tests |
| `npm run lint` | TypeScript type check |

## Tech Stack

- **Backend**: Node.js, Express, TypeScript, better-sqlite3
- **Frontend**: React, Vite, TypeScript
- **AI**: Anthropic Claude (Opus / Sonnet / Haiku) via AWS Bedrock
- **Sessions**: Claude Code CLI (`claude -p`) with stream-json I/O
- **Search**: SQLite FTS5 + BGE-M3 embeddings (local Ollama)
- **Testing**: Vitest, Playwright
- **Integrations**: Microsoft Graph API, plugin system

## License

MIT

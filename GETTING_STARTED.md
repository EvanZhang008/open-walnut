# Getting Started with Open Walnut

Open Walnut is a personal AI butler that manages tasks, accumulates knowledge, and orchestrates Claude Code sessions — all from a beautiful web UI. This guide walks you through installation, configuration, and your first productive session.

> **Time estimate**: 5 minutes for the fast track, 10 minutes for the full walkthrough.

---

## Fast Track (5 Minutes)

If you already have Node.js >= 22, here's the quickest path:

```bash
# 1. Install Claude Code CLI (needed for coding sessions)
npm install -g @anthropic-ai/claude-code
claude --version                      # verify it's installed

# 2. Clone and install
git clone https://github.com/EvanZhang008/open-walnut.git
cd open-walnut
npm install

# 3. Set your API key (Anthropic — simplest option)
export ANTHROPIC_API_KEY=sk-ant-...   # get one at console.anthropic.com

# 4. Start
npm start                             # builds everything, starts on port 3456
```

Open [http://localhost:3456](http://localhost:3456) — type "hello" in the chat and the agent should reply. You're done!

> **Want coding sessions too?** Run `claude` once in your terminal to complete the Claude Code CLI auth flow. This is separate from the API key above.

> **Not working?** See [Troubleshooting](#troubleshooting) below, or continue reading for the full setup.

---

## Table of Contents

- [Fast Track (5 Minutes)](#fast-track-5-minutes)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Provider Configuration](#provider-configuration)
- [First Run](#first-run)
- [Your First Tasks](#your-first-tasks)
- [Starting Sessions (Claude Code)](#starting-sessions-claude-code)
- [Chatting with the Agent](#chatting-with-the-agent)
- [Memory System](#memory-system)
- [Intermediate: Cron, Skills, Commands](#intermediate-cron-skills-commands)
- [Advanced: SSH, Integrations, Plugins](#advanced-ssh-integrations-plugins)
- [CLI Quick Reference](#cli-quick-reference)
- [Troubleshooting](#troubleshooting)
- [What's Next](#whats-next)

---

## Prerequisites

### Required

| Dependency | Version | How to install | Why |
|---|---|---|---|
| **Node.js** | >= 22 | [nodejs.org](https://nodejs.org/) or `nvm install 22` | Runtime for the server and frontend build |
| **npm** | (comes with Node.js) | — | Package manager for dependencies |
| **Claude Code CLI** | Latest | `npm install -g @anthropic-ai/claude-code` | Powers coding sessions |
| **API Key** | — | See [Provider Configuration](#provider-configuration) | Either an Anthropic API key or AWS Bedrock credentials |

> **Native modules**: Open Walnut uses `better-sqlite3` (for search index) and `sharp` (for image processing). Both ship prebuilt binaries for macOS, Linux, and Windows — no compiler needed in most cases. If prebuilds fail on your platform, you may need Python 3 and a C++ compiler (`xcode-select --install` on macOS, `build-essential` on Ubuntu).

### Optional

| Dependency | How to install | Why | Without it |
|---|---|---|---|
| **Ollama** + `bge-m3` model | `brew install ollama && ollama pull bge-m3` | Semantic (vector) search across memory | Search still works via keyword matching (SQLite FTS5). No errors — the Notifications panel shows "Ollama: Unavailable" but everything else is fully functional. |
| **Git** | `brew install git` or [git-scm.com](https://git-scm.com/) | Auto-backup of `~/.open-walnut/` every 30 seconds | Data is still saved locally, just not version-controlled. |

### Important: Two Separate AI Connections

Open Walnut uses AI in **two independent ways**, each with its own authentication:

| Connection | What it powers | How to authenticate |
|---|---|---|
| **Built-in agent** | The chat assistant on the home page | Set `ANTHROPIC_API_KEY` env var **or** configure AWS Bedrock credentials |
| **Claude Code sessions** | Coding sessions spawned by the agent | Run `claude` once in your terminal to complete the interactive auth flow |

Both need to work for the full experience. The agent works without sessions (chat, tasks, memory, cron — all fine), but coding sessions are where the real power is.

**Why separate?** The built-in agent calls the Anthropic/Bedrock API directly from the server. Claude Code sessions are separate `claude` CLI processes with their own authentication. This means you can use different API keys or providers for each.

---

## Installation

```bash
git clone https://github.com/EvanZhang008/open-walnut.git
cd open-walnut
npm install
```

This installs both backend and frontend dependencies. The first `npm start` will build everything automatically.

---

## Provider Configuration

The built-in agent needs an AI provider to respond in chat. Choose **one** of the paths below.

### Path A: Anthropic API (Recommended for New Users)

The simplest option — one environment variable and you're done.

1. Get an API key from [console.anthropic.com](https://console.anthropic.com/)
2. Export it:

```bash
export ANTHROPIC_API_KEY=sk-ant-api03-...
```

That's it. Open Walnut auto-detects the key and configures itself.

> **Tip**: Add the export to your `~/.zshrc` or `~/.bashrc` so it persists across terminal sessions.

### Path B: AWS Bedrock

If you have an AWS account with Claude model access enabled:

1. Ensure your AWS credentials are configured (via `~/.aws/credentials`, `AWS_PROFILE`, or IAM role)
2. Enable Claude model access in the [Bedrock console](https://console.aws.amazon.com/bedrock/) for your region
3. Either set the region via environment variable or config:

```bash
export AWS_REGION=us-west-2
```

Or add to `~/.open-walnut/config.yaml`:

```yaml
providers:
  bedrock:
    api: bedrock
    region: us-west-2
```

### Path C: Other Providers

Open Walnut supports additional providers via the `config.yaml` providers section. Add a provider entry with the appropriate `api` protocol:

```yaml
providers:
  my-provider:
    api: anthropic-messages      # Protocol: anthropic-messages or bedrock
    api_key: ${env:MY_API_KEY}   # Can reference environment variables
    base_url: https://api.example.com  # Custom endpoint (optional)
```

### Verify Your Setup

After starting the server (`npm start`), open [http://localhost:3456](http://localhost:3456) and type "hello" in the chat. If the agent replies, your provider is configured correctly.

---

## First Run

```bash
npm start
```

On first launch, Open Walnut:

1. **Creates `~/.open-walnut/`** — the data directory with all your tasks, memory, and config
2. **Seeds `config.yaml`** — with default model settings and available models
3. **Initializes directories** — `tasks/`, `memory/`, `sessions/`, and more
4. **Builds the frontend** — compiles the React SPA (takes ~10 seconds the first time)
5. **Starts the server** on [http://localhost:3456](http://localhost:3456)

The data directory structure:

```
~/.open-walnut/
  config.yaml          # Your configuration
  tasks/
    tasks.json         # Task database
  memory/
    daily/             # Daily activity logs
    projects/          # Per-project memory
    sessions/          # Session summaries
  sessions.json        # Session registry
  chat-history.json    # Persistent chat history
  MEMORY.md            # Global memory (agent reads/writes this)
```

> **All data is local** — plain JSON, YAML, Markdown, and SQLite files. No cloud database.

---

## Your First Tasks

Tasks are the core of Open Walnut. Everything revolves around them — sessions are attached to tasks, memory is organized by project, and the agent understands your task context.

### Task Hierarchy

```
Category → Project → Task → Subtask
```

For example: `Work → HomeLab → "Set up monitoring dashboard" → "Install Grafana"`

### Three Ways to Create Tasks

#### 1. Chat with the Agent (Easiest)

Just tell the agent what you need in the chat:

> "I need to file my taxes before Friday. High priority."

The agent creates the category, project, and task automatically — with priority, due date, and all metadata.

#### 2. Web UI

Click the **+** button in the Todo panel on the right side of the home page. Fill in the title, select a category and project, set priority, and save.

#### 3. CLI

```bash
open-walnut add "Set up monitoring" -c Work -l HomeLab -p high
```

Where `-c` is category, `-l` is project (label), and `-p` is priority.

### Task Lifecycle

Tasks move through phases automatically:

```
TODO → IN_PROGRESS → AGENT_COMPLETE → AWAIT_HUMAN_ACTION → COMPLETE
```

When the AI finishes its work, the task moves to `AGENT_COMPLETE`. Only you mark it `COMPLETE` — the AI never closes tasks without your approval.

---

## Starting Sessions (Claude Code)

Sessions are where the real coding happens. A session is a Claude Code process attached to a task, running in a specific working directory.

### Prerequisites for Sessions

Make sure the Claude Code CLI is installed and authenticated:

```bash
npm install -g @anthropic-ai/claude-code
claude --version    # Should print a version number
claude              # Run once to complete authentication if needed
```

### Starting a Session

#### From Chat

Tell the agent to start a session:

> "Start a session for the monitoring task in ~/projects/homelab"

The agent finds (or creates) the task, spawns a Claude Code session in the specified directory, and shows the session panel.

#### Quick Start (`/session` Command)

Type `/session` in the chat input to open a path picker. Select a working directory from your recent history, type your prompt, and send. This creates a starred task and starts a session in one step — great for quick coding tasks.

#### From the Sessions Page

Navigate to `/sessions` in the sidebar. Browse your task tree on the left, select a task, and click "New Session" to start one.

### Session Modes

| Mode | Behavior |
|---|---|
| `plan` | Session produces a plan file for your review before executing |
| `default` | Normal interactive mode — the AI works and asks for confirmation on risky actions |
| `bypass` | The AI runs without asking for permission (use with caution) |

### Watching Sessions

Active sessions stream in real-time. You can:

- **Watch live** — see tool calls, outputs, and reasoning as they happen
- **Send messages** — interact with the session mid-run
- **Switch models** — change between Opus, Sonnet, and Haiku without losing context
- **Monitor multiple** — open session panels for different tasks side by side

---

## Chatting with the Agent

The home page chat (`/`) is your primary interface. The agent has 30+ tools and can:

- **Manage tasks** — create, query, update, complete, and organize tasks
- **Search memory** — find information across your notes, daily logs, and session summaries
- **Start sessions** — spawn Claude Code sessions for coding tasks
- **Run commands** — execute shell commands, read/write files
- **Search the web** — look up information online
- **Schedule work** — create cron jobs for recurring tasks

### Task Context

Click a task in the Todo panel to set it as your **focused task**. The agent sees the task's full context (description, subtasks, notes, project memory) with every message you send. This makes conversations much more productive — no need to re-explain what you're working on.

### Inline Subagents

The agent can spawn lightweight subagents for quick AI-assisted tasks without creating a full session. These appear as collapsible boxes in the chat. Useful for things like "summarize this file" or "draft a commit message."

---

## Memory System

Open Walnut accumulates knowledge over time. The more you use it, the smarter it gets.

### How It Works

| Layer | Where | What |
|---|---|---|
| **Global memory** | `~/.open-walnut/MEMORY.md` | User preferences, facts the agent learns |
| **Project memory** | `memory/projects/{category}/{project}/MEMORY.md` | Per-project context and decisions |
| **Daily logs** | `memory/daily/YYYY-MM-DD.md` | Timestamped activity records |
| **Session summaries** | `memory/sessions/` | Auto-captured when coding sessions end |
| **Search index** | `memory/memory-index.sqlite` | Full-text search (SQLite FTS5) |

### Searching Memory

Use the search page (`/search`) or ask the agent:

> "What did we decide about the database schema for the auth service?"

The agent searches across all memory layers using hybrid keyword + semantic search.

### Semantic Search (Optional)

For vector-based semantic search, install Ollama and pull the embedding model:

```bash
# Install Ollama (macOS)
brew install ollama
ollama serve       # Start the Ollama server
ollama pull bge-m3 # Download the embedding model
```

Open Walnut auto-detects Ollama and enables semantic search alongside keyword search.

---

## Intermediate: Cron, Skills, Commands

### Cron Jobs

Schedule recurring tasks or automated agent actions:

```
You: "Set up a daily standup reminder at 9am Pacific"
```

Or configure via the Settings page. Three schedule types:

| Type | Example | Use Case |
|---|---|---|
| `at` | `2025-01-15T09:00:00` | One-time scheduled event |
| `every` | `30m`, `2h`, `1d` | Recurring interval |
| `cron` | `0 9 * * 1-5` (+ timezone) | Complex schedules (cron expression) |

Cron jobs can trigger agent turns (the agent runs a task) or system events.

### Skills

Skills are pluggable knowledge modules (`.md` files) that extend the agent's capabilities. Place them in:

- `~/.open-walnut/skills/` — user skills
- `~/.claude/skills/` — Claude Code skills (shared with CLI)

Each skill is a `SKILL.md` file with optional requirements (binaries, environment variables, platform). Only eligible skills appear in the agent's context.

### Heartbeat

A periodic self-check where the agent runs through a checklist you define:

1. Create `~/.open-walnut/HEARTBEAT.md` with your checklist items
2. Enable in config:

```yaml
heartbeat:
  enabled: true
  every: "30m"           # How often to run
  activeHours: [8, 22]   # Only during these hours (optional)
```

See [docs/HEARTBEAT-example.md](docs/HEARTBEAT-example.md) for a full example.

### Slash Commands

Create custom slash commands as Markdown files in `~/.open-walnut/commands/`:

```
~/.open-walnut/commands/
  standup.md       # /standup — your daily standup template
  review.md        # /review — code review checklist
```

Type `/` in the chat to see available commands.

---

## Advanced: SSH, Integrations, Plugins

### Remote Sessions via SSH

Run Claude Code sessions on remote machines:

```yaml
# ~/.open-walnut/config.yaml
hosts:
  my-server:
    hostname: dev.example.com
    user: myuser
    # Optional: identity_file, port, shell_setup
```

The agent handles node version detection (nvm, fnm, volta, asdf), image transfer, and session reconnection automatically. If SSH drops, the session keeps running on the remote host.

### Microsoft To-Do Sync

Two-way sync with Microsoft To-Do:

1. Create an Azure AD app registration with To-Do permissions
2. Add to config:

```yaml
plugins:
  ms-todo:
    enabled: true
    client_id: YOUR_CLIENT_ID
```

3. Run `open-walnut auth` to complete OAuth flow

Tasks sync bidirectionally — changes in either direction are reflected.

### Git Sync (Auto-Backup)

If `~/.open-walnut/` is a git repository, Open Walnut auto-commits changes every 30 seconds. Initialize it:

```bash
cd ~/.open-walnut
git init
git remote add origin git@github.com:you/walnut-data.git
```

The server handles commits, pulls, and pushes automatically.

### External Plugins

Install additional sync plugins in `~/.open-walnut/plugins/{plugin-name}/`. Each plugin needs a `manifest.json` and an entry point. See [ARCHITECTURE.md](ARCHITECTURE.md) for the plugin API.

---

## CLI Quick Reference

```bash
# Server
open-walnut web                          # Start web UI (port 3456)
open-walnut web --port 8080              # Custom port
open-walnut web --ephemeral              # Isolated test server (temp data, random port)

# Tasks
open-walnut add "title" -c Category -l Project -p high   # Create task
open-walnut tasks                        # List all tasks
open-walnut tasks -s todo -c work        # Filter by status and category
open-walnut done <task-id>               # Complete a task

# Sessions
open-walnut sessions                     # List sessions
open-walnut start <task-id>              # Start coding session for task

# Memory & Search
open-walnut recall "query"               # Search across all memory
open-walnut projects                     # List projects

# Chat & Logs
open-walnut chat                         # Chat with agent in terminal
open-walnut logs                         # View recent logs
open-walnut logs -f -s agent             # Follow agent logs
open-walnut logs --json                  # Raw JSON output
```

All commands support `--json` for structured output.

---

## Troubleshooting

### Agent doesn't reply in chat

**Symptoms**: You type a message but get no response, or see an error.

**Fixes**:
1. Check your API key: `echo $ANTHROPIC_API_KEY` (should not be empty)
2. Check server logs: `open-walnut logs -s agent` for error details
3. If using Bedrock, verify your AWS credentials: `aws sts get-caller-identity`
4. Check `~/.open-walnut/config.yaml` for provider configuration errors

### Session fails to start

**Symptoms**: "Failed to start session" error when trying to run Claude Code.

**Fixes**:
1. Verify Claude Code CLI: `claude --version`
2. Authenticate if needed: run `claude` in your terminal and follow the prompts
3. Check that the working directory exists and is accessible
4. Check session limits — by default, max 7 concurrent local sessions

### Port already in use

**Symptoms**: `EADDRINUSE: address already in use :::3456`

**Fixes**:
1. Use a different port: `open-walnut web --port 8080`
2. Find what's using port 3456: `lsof -i :3456`
3. If it's an old Walnut process, stop it and restart

### npm install fails

**Symptoms**: Build errors during `npm install`, especially around `better-sqlite3` or `sharp`.

**Fixes**:
1. Check Node.js version: `node --version` (must be >= 22)
2. On Apple Silicon, ensure you're using the arm64 version of Node.js (not Rosetta)
3. If `better-sqlite3` fails: prebuilt binaries should auto-download, but if they don't:
   - macOS: `xcode-select --install` (installs C++ compiler)
   - Ubuntu/Debian: `sudo apt install build-essential python3`
   - Then: `npm rebuild better-sqlite3`
4. If `sharp` fails: `npm rebuild sharp` (it downloads prebuilt libvips binaries for your platform)

### Semantic search not working

**Symptoms**: Search works but only returns keyword matches, no semantic results. The Notifications panel (bell icon) shows "Ollama: Unavailable".

**This is expected if Ollama is not installed.** Keyword search (SQLite FTS5) works perfectly without it. Semantic search is a nice-to-have upgrade.

**To enable semantic search**:
1. Install Ollama: `brew install ollama` (macOS) or see [ollama.com](https://ollama.com)
2. Start the Ollama server: `ollama serve`
3. Pull the embedding model: `ollama pull bge-m3`
4. Restart the Open Walnut server — it detects Ollama on startup and begins indexing

---

## What's Next

- **[README.md](README.md)** — Feature overview and screenshots
- **[ARCHITECTURE.md](ARCHITECTURE.md)** — Deep technical documentation of every subsystem
- **[CONTRIBUTING.md](CONTRIBUTING.md)** — How to contribute to the project
- **[docs/HEARTBEAT-example.md](docs/HEARTBEAT-example.md)** — Full heartbeat checklist example

Have questions? [Open an issue](https://github.com/EvanZhang008/open-walnut/issues) on GitHub.

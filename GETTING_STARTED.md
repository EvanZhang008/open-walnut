# Getting Started with Open Walnut

Open Walnut is a Personal AI that manages tasks, accumulates knowledge, and coordinates Claude Code sessions from one web UI. This guide walks you through installation, configuration, and your first productive session.

> **Time estimate**: 5 minutes for the fast track (plus a one-time ~1.16 GB model download on first start), 10 minutes for the full walkthrough.

---

## Fast Track (5 Minutes + Model Download)

If you already have Node.js >= 22, here's the quickest path:

```bash
# 1. Install Claude Code CLI (needed for coding sessions)
npm install -g @anthropic-ai/claude-code
claude --version                      # verify it's installed

# 2. Install Walnut from npm (nothing to build)
npm install -g open-walnut

# 3. Set your API key (Anthropic — simplest option)
export ANTHROPIC_API_KEY=sk-ant-...   # get one at console.anthropic.com

# 4. Start
open-walnut web                       # starts on port 3456
```

Working on Walnut itself? Swap step 2 for a checkout, and start with `npm start`, which
builds the server and the frontend first:

```bash
git clone https://github.com/EvanZhang008/open-walnut.git
cd open-walnut
npm install
npm start
```

Open [http://localhost:3456](http://localhost:3456) — type "hello" in the chat and the agent should reply. You're done!

> **First start is slower**: The BGE-M3 embedding model (~1.16 GB) downloads automatically on first launch. This is a one-time download that can take 5-30 minutes depending on your connection. The server starts and is usable while the download happens in the background.

> **Want coding sessions too?** Run `claude` once in your terminal to complete the Claude Code CLI auth flow. This is separate from the API key above.

> **Not working?** See [Troubleshooting](#troubleshooting) below, or continue reading for the full setup.

---

## Table of Contents

- [Fast Track (5 Minutes + Model Download)](#fast-track-5-minutes--model-download)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Provider Configuration](#provider-configuration)
- [First Run](#first-run)
- [Your First Tasks](#your-first-tasks)
- [Starting Sessions (Claude Code)](#starting-sessions-claude-code)
- [Chatting with the Agent](#chatting-with-the-agent)
- [Memory System](#memory-system)
- [Search & Embedding Setup](#search--embedding-setup)
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
| **Claude Code CLI** | Latest | `npm install -g @anthropic-ai/claude-code` | Required for coding sessions (chat, tasks, and memory work without it) |
| **API Key** | — | See [Provider Configuration](#provider-configuration) | Either an Anthropic API key or AWS Bedrock credentials |
| **Disk space** | ~2 GB free | — | For the embedding model (~1.16 GB) and search index |

> **Native modules**: Open Walnut uses `better-sqlite3` (for search index) and `sharp` (for image processing). Both ship prebuilt binaries for macOS, Linux, and Windows — no compiler needed in most cases. If prebuilds fail on your platform, you may need Python 3 and a C++ compiler (`xcode-select --install` on macOS, `build-essential` on Ubuntu).

### Older Linux (glibc before 2.29)

Walnut's one required native module, better-sqlite3, ships a prebuilt binary for glibc 2.29 and newer, which every mainstream distro since 2019 has. On an older C library (glibc 2.26 systems are still around) it compiles during `npm install`, and compiling against Node 22 needs Python 3.8+ and a C++20 compiler (GCC 10+), which such a system usually lacks. The stock toolchain fails inside node-gyp with a Python `SyntaxError` or C++ template errors that never mention either requirement.

`npm start` runs `scripts/check-native-toolchain.mjs`, which detects this and prints the commands for your box. On a yum-based glibc 2.26 system they are:

```bash
sudo yum install -y gcc10-c++ make
curl -LsSf https://astral.sh/uv/install.sh | sh        # node-gyp needs Python 3.8+; the system python3 is 3.7
~/.local/bin/uv python install 3.12                    # a static build that runs on glibc 2.17+, no sudo
PYTHON="$(~/.local/bin/uv python find 3.12)" CC=gcc10-gcc CXX=gcc10-g++ npm install
```

The Python step deliberately does not use the distro's package channel: on one such machine the channel had no Python 3.8 at all, while uv's managed Python installed in seconds and the compile went through (verified 2026-09-03).

sharp (image compression for pasted images) is optional and is skipped on such a system: images are sent uncompressed. If `npm_config_build_from_source` is set in your environment, unset it; it forces sharp into a source build that needs libvips.

Node itself has the same problem one step earlier: the official Node 22 binaries need glibc 2.28, so `nvm install 22` completes and then `node` dies with `GLIBC_2.28 not found`. Use the [community build for older glibc](https://unofficial-builds.nodejs.org/download/release/) (the `linux-x64-glibc-217` tarball of any v22 release), unpacked anywhere on your `PATH`:

```bash
v=$(curl -fsSL https://unofficial-builds.nodejs.org/download/release/index.tab | awk -F'\t' 'NR>1 && $1 ~ /^v22\./ && $0 ~ /linux-x64-glibc-217/ {print $1; exit}')
mkdir -p ~/.local/node22
curl -fsSL "https://unofficial-builds.nodejs.org/download/release/$v/node-$v-linux-x64-glibc-217.tar.gz" | tar -xz -C ~/.local/node22 --strip-components=1
export PATH="$HOME/.local/node22/bin:$PATH"   # add to your shell profile too
```

### Optional

| Dependency | How to install | Why | Without it |
|---|---|---|---|
| **Git** | macOS: `xcode-select --install`, Ubuntu: `sudo apt install git`, or [git-scm.com](https://git-scm.com/) | Cloning the repo, and auto-backup of `~/.open-walnut/` every 30 seconds | The npm install route needs no git. Data is still saved locally, just not version-controlled. |
| **Bun** | [bun.sh](https://bun.sh/) | Prebuilt session-daemon binaries (faster deploys to remote hosts) and the ACP worker bundle | Claude Code sessions still work: the daemon deploys from source instead, and `npm start` says so and carries on. Non-Claude providers that go over ACP need the worker bundle, so install Bun and re-run `npm run build:daemon` before using those. Not needed at all with the npm install route, which ships the bundle prebuilt. |

### One AI login: Claude Code

Open Walnut uses AI in three places, and by default all three run on the Claude Code you already have:

| What | How it runs | How to authenticate |
|---|---|---|
| **Ask Walnut** (the Walnut agent, on the home page) | A long-lived `claude` session | Run `claude` once in your terminal and sign in |
| **Coding sessions** | Separate `claude` CLI processes | Same login |
| **Background helpers** (summaries, titles, subagents) | Short `claude -p` calls | Same login, when Claude Code is installed |

Claude Code brings its own login, whatever kind it is: an Anthropic account, Bedrock (`CLAUDE_CODE_USE_BEDROCK=1` in `~/.claude/settings.json`), or Vertex. Walnut inherits it as-is and never asks for a key of its own. The first-run banner names what it found ("Walnut runs on your Claude Code, signed in with Bedrock (us-west-2)").

Settings → Ask Walnut Provider is the one place this is chosen, and it means exactly one thing: what Ask Walnut runs on. Pick Claude Code (the default) and Ask Walnut is a `claude` session; pick any other provider and Ask Walnut runs in the built-in agent loop calling that provider directly, with the background helpers following along. Coding sessions use your Claude Code either way. The paths below set up such a provider.

---

## Installation

```bash
git clone https://github.com/EvanZhang008/open-walnut.git
cd open-walnut
npm install
```

This installs both backend and frontend dependencies. The first `npm start` will build everything automatically.

---

## Provider Configuration (optional)

With Claude Code installed there is nothing to configure: it is the default provider for Ask Walnut and everything behind it. The paths below are for running Ask Walnut on a provider directly instead (Settings → Ask Walnut Provider, or `agent.main_provider` in `~/.open-walnut/config.yaml`). Choose **one**.

### Path A: Anthropic API key

One environment variable and you're done.

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
    api: anthropic-messages      # Protocol: anthropic-messages, openai-chat, bedrock, google-generative-ai, or ollama
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
5. **Downloads the embedding model** — BGE-M3 (~1.16 GB) for semantic search. This is a one-time download that can take 5-30 minutes depending on your connection. The server is usable while the download runs in the background.
6. **Starts the server** on [http://localhost:3456](http://localhost:3456)

The data directory structure:

```
~/.open-walnut/
  config.yaml              # Your configuration
  MEMORY.md                # Global memory (agent reads/writes this)
  sessions.json            # Session registry
  chat-history.json        # Persistent chat history
  cron-jobs.json           # Scheduled jobs
  usage.sqlite             # Usage tracking
  search.sqlite            # Search index over everything (keyword + vector)
  models/                  # Embedding model weights, fetched on first use
  tasks/
    tasks.json             # Task database
    archive/               # Completed task archives
  memory/
    daily/                 # Daily activity logs
    projects/              # Per-project memory
    sessions/              # Session summaries
    topics/                # Topic-based memory
    repos/                 # Per-repo memory
    compaction/            # Working memory snapshots
    working-memory.md      # Real-time conversation scratchpad
    index.md               # Memory index
  notes/                   # User notes and instructions
  recordings/              # Audio recordings and transcripts
  timeline/                # Timeline events
  repositories/            # Tracked repository metadata
  skills/                  # User-installed skills
  commands/                # Custom slash commands
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
walnut add "Set up monitoring" -c Work -l HomeLab -p immediate
```

Where `-c` is category, `-l` is project (label), and `-p` is priority.

### Task Lifecycle

Tasks move through phases automatically (simplified — see [README](README.md) for the full 7-phase lifecycle):

```
TODO → IN_PROGRESS → ... → AGENT_COMPLETE → ... → COMPLETE
```

When the AI finishes its work, the task moves to `AGENT_COMPLETE`. Only you mark it `COMPLETE` — the AI never closes tasks without your approval.

### Retiring Finished Pins

New tasks are pinned to the board, and completing one does not unpin it, so work you just finished stays visible in its tier. A completed pin then retires on its own three days later. Set the window (or switch retirement off) in `~/.open-walnut/config.yaml`:

```yaml
tasks:
  pin_retirement_days: 3   # days a finished pin stays on the board; 0 or negative keeps pins forever
```

Retirement only unpins. It never deletes a task, never touches an open task however old, and changes no other field.

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
| `accept` | The AI auto-accepts file edits but still asks for confirmation on other actions (shell commands, etc.) |
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
| **Working memory** | `memory/working-memory.md` | Real-time scratchpad for the active conversation (7 structured sections, 12K token budget) |
| **Project memory** | `memory/projects/{category}/{project}/MEMORY.md` | Per-project context and decisions |
| **Topic memory** | `memory/topics/` | Topic-based knowledge accumulated over time |
| **Daily logs** | `memory/daily/YYYY-MM-DD.md` | Timestamped activity records |
| **Session summaries** | `memory/sessions/` | Auto-captured when coding sessions end |
| **Compaction archive** | `memory/compaction/` | Working memory snapshots saved during context compaction |
| **Search index** | `~/.open-walnut/search.sqlite` | Hybrid search (BM25 keyword lanes + vector rescore) |

### Working Memory

Working memory is a real-time scratchpad that the agent maintains during conversations. It has 7 structured sections — Active Focus, User Requests, Decisions & Rationale, Struggles & Breakthroughs, Session Status, Open Threads, and Learnings. The agent updates it continuously as you chat, so context survives even when conversation history gets compacted. Working memory snapshots are archived to `memory/compaction/` automatically.

### Searching Memory

Use the search page (`/search`) or ask the agent:

> "What did we decide about the database schema for the auth service?"

The agent searches across all memory layers using hybrid keyword + semantic search.

---

## Search & Embedding Setup

Search is built in and runs entirely on your machine: one SQLite file (`~/.open-walnut/search.sqlite`) holding a keyword index over tasks, sessions, notes, memory files and skills, plus small quantized vectors used to rescore the keyword candidates. No external services, no separate search process.

### What Happens on First Start

Nothing you have to wait for. The keyword half answers immediately (a few milliseconds), and it is a complete search on its own. The embedding model is fetched in the background on first use and cached under `~/.open-walnut/models/`; until it arrives, results are keyword-ranked. Indexing your existing data happens in the background too, paced so it never competes with the UI.

Queries mixing Chinese and English work out of the box: the tokenizer splits `camelCase`, `snake_case` and `kebab-case` identifiers into their parts and indexes Chinese as ordered character pairs, so `operator` finds `PlatformEventOperator` and a Chinese phrase matches in order rather than as a bag of characters.

### Choosing an Embedding Model

Two models ship as presets, selected with an environment variable before startup:

| Preset | Model | Dimensions | Notes |
|---|---|---|---|
| `qwen3-0.6b` (default) | `onnx-community/Qwen3-Embedding-0.6B-ONNX` | 1024 | Best recall on realistic, wordy queries; strong Chinese + English |
| `e5-small` | `Xenova/multilingual-e5-small` | 384 | ~4x faster per query, a third of the index size; slightly weaker recall |

```bash
export WALNUT_SEARCH_V2_EMBED_MODEL=e5-small   # pick a preset
export WALNUT_SEARCH_V2_SEMANTIC=0             # keyword-only, no model at all
export WALNUT_DISABLE_SEARCH=1                 # do not index anything
npm start
```

Switching presets is safe: the index notices the model changed, drops the stored vectors, and re-embeds in the background. Keyword search keeps working the whole time. **Settings → Search** shows index health, per-kind document counts, and a **Rebuild index** button.

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
| `at` | `2030-01-15T09:00:00` | One-time scheduled event |
| `every` | `30m`, `2h`, `1d` | Recurring interval |
| `cron` | `0 9 * * 1-5` (+ timezone) | Complex schedules (cron expression) |

Cron jobs can trigger agent turns (the agent runs a task) or system events.

### Skills

Skills are pluggable knowledge modules (`.md` files) that extend the agent's capabilities. They are loaded from these directories (highest priority first):

1. `./skills/` — workspace-local skills (relative to the current working directory)
2. `~/.open-walnut/skills/` — user-installed global skills
3. Built-in skills shipped with Open Walnut
4. `~/.claude/skills/` — Claude Code skills (shared with the CLI)

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

See the [heartbeat example](docs/reference/heartbeat-example.md) for a full example.

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

Install a trusted Plugin by linking it under `~/.open-walnut/plugins/<plugin-id>/`, or use Settings → Plugin Store with a Git URL or npm spec. A Plugin can add full Node server logic, a native React App, Settings sections, Tools, Skills, Commands, Hooks, Cron actions, Agents, Providers, routes, and task sync. Installing a Plugin means trusting its code: a server entry is full Node, and a native web entry runs in the console's own React tree.

A Plugin App joins the same App Registry as Walnut's own screens, so one `walnut.ui.app` registration gives it a Sidebar entry, the route `/apps/<plugin-id>~<app-id>`, deep links into every subpath, a badge, and a Command Palette entry.

After the author packages reach npm, the whole first loop is a single command. They are not published yet; the Plugin guide gives the equivalent local-checkout command available today.

```bash
npx @open-walnut/plugin-cli new my-plugin --dev
```

That scaffolds the project, installs, builds, links it into `~/.open-walnut/plugins/`, asks the running Walnut to load it, prints the App URL, and then rebuilds and reloads on every save. Later loops are `npm run dev` in the project. See [Plugin development](docs/reference/plugin-development.md) for the full guide, and [examples/plugins/walnut-demo](examples/plugins/walnut-demo) (the Walnut Plugin Demo) for a runnable example of every public capability.

---

## CLI Quick Reference

```bash
# Server
walnut web                          # Start web UI (port 3456)
walnut web --port 8080              # Custom port
walnut web --ephemeral              # Isolated test server (temp data, random port)

# Tasks
walnut add "title" -c Category -l Project -p immediate   # Create task
walnut tasks                        # List all tasks
walnut tasks -s todo -c work        # Filter by status and category
walnut done <task-id>               # Complete a task

# Sessions
walnut sessions                     # List sessions
walnut start <task-id>              # Start coding session for task

# Memory & Search
walnut recall "query"               # Search across all memory
walnut projects                     # List projects

# Subtasks
walnut subtask add <task-id> "title"           # Add subtask
walnut subtask done <task-id> <subtask-id>     # Complete subtask
walnut subtask rm <task-id> <subtask-id>       # Remove subtask
walnut subtask list <task-id>                  # List subtasks

# Lists (categories/projects)
walnut lists                        # List all categories and projects
walnut lists create <name>          # Create a new list
walnut lists rename <id> <name>     # Rename a list
walnut lists delete <id>            # Delete a list

# Other
walnut chat                         # Chat with agent in terminal
walnut auth                         # Authenticate with external services
walnut sync                         # Sync with external integrations
walnut logs                         # View recent logs
walnut logs -f -s agent             # Follow agent logs
walnut logs --json                  # Raw JSON output
```

All commands support `--json` for structured output.

---

## Troubleshooting

### Agent doesn't reply in chat

**Symptoms**: You type a message but get no response, or see an error.

**Fixes**:
1. Check your API key: `echo $ANTHROPIC_API_KEY` (should not be empty)
2. Check server logs: `walnut logs -s agent` for error details
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
1. Use a different port: `walnut web --port 8080`
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

### Search or embedding model issues

**Symptoms**: results look keyword-only, or **Settings → Search** reports an error.

The embedding model is fetched on first use into `~/.open-walnut/models/`. Until it finishes, search answers from the keyword lanes alone, which is a working search, not a failure. If the download was interrupted, delete that folder and restart; it re-fetches.

**To use a smaller, faster model** (a third of the index size):
```bash
export WALNUT_SEARCH_V2_EMBED_MODEL=e5-small
npm start
```

If a machine should never spend anything on embeddings, `WALNUT_SEARCH_V2_SEMANTIC=0` keeps keyword search and skips the model entirely.

See [Search & Embedding Setup](#search--embedding-setup) for all model options.

---

## What's Next

- **[README.md](README.md)** — Feature overview and screenshots
- **[ARCHITECTURE.md](ARCHITECTURE.md)** — Deep technical documentation of every subsystem
- **[CONTRIBUTING.md](CONTRIBUTING.md)** — How to contribute to the project
- **[Heartbeat example](docs/reference/heartbeat-example.md)** — Full heartbeat checklist example

Have questions? [Open an issue](https://github.com/EvanZhang008/open-walnut/issues) on GitHub.

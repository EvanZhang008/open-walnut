---
name: walnut-console-ops
description: Operating the Walnut web UI (localhost:3456) via Playwright MCP tools — understanding the UI layout, chatting with main agent, interacting with sessions, monitoring status changes. Use when asked to test, verify, or interact with the Walnut web console as a human user would.
requires:
  bins: []
---

# Walnut Web Console — How It Works

This skill explains the Walnut web UI so you can operate it confidently via Playwright MCP tools, acting as a human user.

## Core Mental Models for SPA Console Testing

These principles are universal — they apply to any single-page app, not just Walnut.

### 1. Stay on one page — panels, not pages
SPAs show everything through panels that open/close on the same page. Don't navigate away to find something. The session panel opens inline when you click a session link — you don't need the `/sessions` page.

### 2. Disambiguate inputs by placeholder
Multiple input boxes coexist on screen. They look identical in the DOM. **Placeholder text** is the reliable discriminator. Check it before typing.

### 3. Same state, multiple renderings — verify all
One piece of state (e.g., "session mode") appears in 3+ places, each with different update paths (REST vs WebSocket vs React state). Check all of them. Bugs often show as one updating while another stays stale.

### 4. Act → Wait → Verify
Every action triggers async work. Pattern: **Act** → **Wait** (5-20s) → **Screenshot** (visual truth) → **Snapshot** (clickable refs). Skip the wait = see stale state.

### 5. Screenshot is ground truth
Screenshot shows what the user sees. DOM snapshot shows logical tree. When they disagree, trust the screenshot.

### 6. Refs are ephemeral
Playwright refs (`ref=e1234`) are tied to a specific DOM state. Any async change invalidates them. Always re-snapshot before interacting.

### 7. Build ≠ Deploy
Frontend changes (vite build) take effect on page refresh. Backend changes (npm run build) need server restart. Common mistake: build the fix, test, see no change — server is still running old code.

### 8. Trace WebSocket events through 4 stages
When the UI doesn't update: (1) Did backend emit the event? → (2) Did WebSocket forward it? → (3) Did frontend listen for it? → (4) Did component re-render? The bug is always at one stage.

## Understanding Session-Based Apps

These patterns apply to any app where you chat with an AI agent that spawns background sessions.

### Two conversation channels
There's a **main agent** (orchestrator) and **individual sessions** (workers). They have separate inputs. Typing in the wrong one sends your message to the wrong place. The main agent can create sessions, but once a session exists, you interact with it directly through its own input.

### Session lifecycle and status
Sessions go through states: created → running → stopped. They also have a **work status** (in_progress, awaiting_human, agent_complete) and a **mode** (bypass, plan, etc.). These update in real-time via WebSocket. Status displays in multiple UI locations, each updated by different code paths.

### Opening a session inline
When the agent creates a session and shows a link, click it to open a **session panel inline** on the same page. Don't navigate to a separate sessions page. The session panel has its own chat history, input box, and status header — all distinct from the main chat.

## Walnut Home Page Layout (`/`)

```
┌────────┬─────────────────┬─────────────────┬──────────────────┐
│Sidebar │  Main Chat      │  SessionPanel   │  TodoPanel       │
│        │                 │                 │  ┌─────────────┐ │
│ Home   │  Chat history   │  Session header │  │ Task list   │ │
│ Tasks  │  (main agent)   │  (status, mode) │  │ (grouped by │ │
│ Sess.  │                 │                 │  │  cat → proj)│ │
│ Search │                 │  Session chat   │  ├─────────────┤ │
│ Memory │                 │  (You ↔ Claude) │  │ TodoDetail  │ │
│ ...    │                 │                 │  │  Sessions   │ │
│        │ ┌─────────────┐ │                 │  │  Summary    │ │
│        │ │ Chat input  │ │  Session input  │  │  Triage     │ │
│        │ └─────────────┘ │                 │  └─────────────┘ │
│        │  Task context   │                 │  Quick add       │
└────────┴─────────────────┴─────────────────┴──────────────────┘
```

SessionPanel only appears when a session is open. Without it, Main Chat takes more space.

### 1. Main Chat
Where you talk to the **main agent**. It can create tasks, start sessions, query data, run tools. When it starts a session, it responds with a clickable session link:

> ✅ Session started: [Session Title](/sessions?id=xxx)

Input placeholder: `"Type a message... (/ for commands)"` or `"Ask about '<task name>'..."`

### 2. TodoPanel (right side, top)
Task list grouped by Category → Project. Each task row shows phase icon, title, **SessionPill** (e.g., `plan · Awaiting Human / Stopped`), priority, star. Clicking a task opens TodoDetailPanel below.

### 3. TodoDetailPanel (right side, bottom — when task selected)
Shows detail for the selected task:
- **Sessions list**: mode badge (**Plan** or none for bypass), work status, timestamp, clickable `↗`
- **Summary (AI)**: triage-generated summary
- **Triage history**: `View Triage History (N) →`

Clicking a session in this list also opens SessionPanel.

### 4. SessionPanel (middle — when session open)
Session chat with the Claude Code CLI process. Contains:
- **Header**: session title + process status (Running/Stopped) + work status (Awaiting Human, In Progress)
- **Task link**: `📋 Task Name ↗`
- **My Messages**: collapsible list of messages you've sent
- **Chat history**: full conversation with tool calls, thinking blocks, token counts
- **Input**: `"Send a message to this session... (/ for commands)"`

The session input sends messages **directly to the Claude Code CLI process** — not through the main agent.

### How Panels Connect
- Click **task** in TodoPanel → TodoDetailPanel opens, task context set in main chat
- Click **session link** in main chat → SessionPanel opens inline (stays on `/`)
- Click **session** in TodoDetailPanel → SessionPanel opens
- Close SessionPanel (`×`) → returns to layout without it

## Input Boxes

| Input | Placeholder | Purpose |
|---|---|---|
| Main chat | `"Type a message..."` or `"Ask about '...'"` | Talk to main agent |
| Session chat | `"Send a message to this session..."` | Talk directly to Claude Code CLI |
| Task search | `"Search tasks... ⌘K"` | Filter tasks in TodoPanel |
| Quick add | `"Quick add task..."` | Create task directly (no agent) |

## Common Actions

### Create a Task + Session
Talk to the main agent: `"Create task 'My Task' in Personal/Walnut, start a bypass session with prompt 'Just say HI'"`

Session modes: **bypass** (execute immediately), **plan** (investigate → write plan → ExitPlanMode)

### Interact with a Session
1. Find session link in chat or TodoDetailPanel
2. Click it → SessionPanel opens inline
3. Click session input (`"Send a message to this session..."`)
4. Type → Enter
5. Wait → screenshot → snapshot to verify

### Monitor Status Changes
After an action, check **three places**:
- **SessionPanel header**: process + work status
- **TodoPanel SessionPill**: mode prefix (`plan` / `session`) + status
- **TodoDetailPanel sessions list**: mode badge + work status label

## Routes

| Route | What it is |
|---|---|
| `/` | Home — main chat + SessionPanel + TodoPanel (most common) |
| `/tasks` | Full task board |
| `/tasks/:id` | Task detail page (standalone, different from TodoDetailPanel) |
| `/sessions` | Session tree browser (rarely needed from home) |
| `/search` | Full-text search |

Most of the time, `/` gives you everything you need.

## Interact Like a Human

**Prefer**:
- `browser_take_screenshot` — see what a real user sees, catch visual bugs
- `browser_snapshot` — accessibility tree with clickable refs
- `browser_click` — click buttons, links, tabs like a user would
- `browser_type` + `browser_press_key` — type into inputs and press Enter

**Use sparingly**:
- `browser_evaluate` / `browser_run_code` — useful for waits, but don't bypass the UI
- Direct DOM manipulation — defeats the purpose of testing

Principle: if a human would click a button, you click that button.

## Debugging Tips

- **`browser_snapshot`** — most useful tool, gives refs for clicking
- **`browser_take_screenshot`** — visual truth when DOM looks fine but something's wrong
- **Refs change** after DOM updates — re-snapshot before interacting
- **`browser_run_code`** — `await page.waitForTimeout(5000)` for delays
- **`browser_network_requests`** — check API calls and WebSocket frames
- **`browser_console_messages`** — check for JS errors
- **Server logs** (`/tmp/walnut/walnut-YYYY-MM-DD.log`) — when UI doesn't update, check if backend sent the event
- **WebSocket events**: `session:status-changed` carries mode/work_status/process_status; `task:updated` carries task data; `session:started`/`session:ended` for lifecycle

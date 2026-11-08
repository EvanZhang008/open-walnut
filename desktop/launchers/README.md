# Reach Walnut from a key anywhere on the Mac

Three ways in, all talking to the Walnut running on this Mac (`http://127.0.0.1:3456`, the routes
in `src/web/routes/quick-input-v1.ts`, documented under "Quick input" in
`docs/reference/api-v1.md`). Each does the same three things:

- **Quick answer**: a question, a text to revise or translate, a short search. A light model with
  no tools answers in about two seconds, and the answer can be pasted back into the app you were in.
  In Raycast a conversation can also run as **Quick Question**: a normal Claude Code session in Walnut
  (a quick question, with everything your Claude Code has), its reply shown in Raycast and the
  session one ⌘O away in Walnut. ⌘T switches between Quick Answer and Quick Question at any turn; the
  turns the other side has not seen go along with the next message.
- **Tell CEO**: the text goes into the CEO's chat as your message. In Raycast this is the first row and
  fire and forget: ↵ sends it and Raycast closes (⌘⇧↵ stays to watch the reply); Alfred and Spotlight
  show the CEO's reply as it is written.
- **Find a task**: tasks matching the words, opened in Walnut with `open-walnut://open?to=/tasks/<id>`.
  In Raycast ⌘↵ on a task writes a message straight into its chat instead (and starts it when it
  has no session), and notes matching the words list below the tasks.
- **Send a screenshot** (Raycast): copy one (⌃⇧⌘4), then ⌥↵ tells the CEO with it, and the task
  message form attaches it (a ticked checkbox). It is sent as a JPEG of at most 2000 px.

| | Spotlight (macOS 26) | Raycast | Alfred 5 (Powerpack) |
|---|---|---|---|
| Install | nothing: comes with the Mac app | `npm install && npm run dev` in `raycast/walnut` | build it (below), then open `Walnut.alfredworkflow` |
| Hotkey | give "Quick Question" a quick key in Spotlight's actions | Raycast Settings → Extensions → Walnut | the workflow's Hotkey trigger |
| Answer streams | no, shown when done | yes | yes |
| Follow-up question | no | yes | yes (⌘↵ starts a new one) |
| Selected text | no | "Quick Question About Selection" | the Hotkey or Universal Action sends it |
| Paste back | no | ↵ on an answer | ⌥↵ |

## Spotlight

`desktop/WalnutIntents.swift` gives the app three actions: Quick Question, Tell Walnut CEO and Open
Walnut Task. `build.sh` and `build-release.sh` list them with Xcode's `appintentsmetadataprocessor`
(full Xcode needed; without it the app builds and the actions are not listed). In Spotlight, type
"Quick Question", or open Spotlight's actions and give it a quick key. They work in Shortcuts and Siri too.

## Raycast

```bash
cd desktop/launchers/raycast/walnut
npm install
npm run dev     # loads it into Raycast
```

Raycast is the main launcher; Alfred and Spotlight are the alternatives. Commands: **Tell CEO**
(type, ↵ to tell the CEO and close, ⌘↵ for a quick answer, ⌘⇧↵ to tell the CEO and wait for its
reply, ⌥↵ to tell the CEO with the copied screenshot; tasks and notes listed below, ↵ opens one, ⌘↵
on a task messages it, ⌘⌥↵ asks a quick question), **Quick Question About Selection**, **Quick
Answer** (the model alone, a couple of seconds) and **Quick Question** (Walnut does the work, in a session with your
skills and tools), one chat with follow-ups where ⌘T moves between the two. To type anything in
Raycast's root search and send it to Walnut, add the two as fallback commands (Raycast Settings,
Extensions, Walnut, or "Manage Fallback Commands" in the root search's action panel). The port is a
preference of the extension.

## Alfred

```bash
bun desktop/launchers/alfred/build.mjs --out /tmp/walnut-alfred
open /tmp/walnut-alfred/Walnut.alfredworkflow
```

Keyword `w` (configurable): ↵ quick answer, ⌘↵ tell the CEO, a task row opens the task. In the answer
view: type a follow-up and ↵, ⌘↵ new conversation, ⌥↵ paste the answer, ⌃↵ copy it, ⇧↵ open the CEO.
Set a key on the Hotkey trigger to ask about the selected text from any app; the Universal Action
does the same from Alfred's own selection. The scripts are JavaScript for Automation, so nothing
else needs installing.

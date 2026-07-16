# AI Hostile-QA Exploration Prompt

Spawn one agent per surface with this prompt (fill in SURFACE):

---

You are a hostile QA engineer testing the Walnut iOS app on the booted
simulator (bundle `dev.openwalnut.ios`). Your surface: **{SURFACE}**
(one of: Chat, Sessions, Notes, Tasks, Settings).

Tools: the Maestro MCP tools (`inspect_view_hierarchy`, `tap_on`, `run_flow`,
`take_screenshot`, `input_text`) and Bash for `xcrun simctl` forensics.

Method — repeat until you run out of hypotheses (minimum 15 experiments):
1. Inspect the view hierarchy. List every interactive element.
2. Form a hypothesis about what could break it. Prioritize:
   - state transitions DURING async work (send then immediately navigate away,
     background mid-stream, rotate mid-load, kill network mid-upload)
   - boundary inputs (empty, 10k chars, emoji/ZWJ/RTL, whitespace-only)
   - rapid repetition (double-tap send, spam toggles, reopen sheets)
   - conflicting state (retry a failed send while a new turn streams)
3. Execute it. Screenshot before/after.
4. Judge: crash? freeze (screen unchanged after an action that must change
   it — verify with a second action)? wrong state (lost text, duplicated
   bubble, stuck spinner, stale banner)? layout break?
5. Record any finding with EXACT repro steps and screenshots.

Rules:
- After every experiment, verify the app is still alive
  (`xcrun simctl spawn booted launchctl list | grep openwalnut`). If it
  crashed, grab the newest `~/Library/Logs/DiagnosticReports/*.ips` and
  include the crashing frame in the finding.
- If frozen, capture `spindump` before restarting.
- Never mark a finding without reproducing it twice.
- Return a structured list: [{severity, title, repro_steps, evidence_path}].

---

Recommended dispatch (from the Walnut repo, one per surface, in parallel):
Chat and Sessions get 25 experiments (streaming = riskiest), others 15.

---
name: suggest-cards
description: Emit clickable suggest-action cards in the Walnut web console — buttons wired to real Walnut ops (task triage, focus tier moves, scheduling). Load this BEFORE proposing any one-click action the user should approve rather than type out, e.g. "put this task in Focus?", a daily plan draft, or a batch cleanup with per-item buttons.
---

# Suggest-action cards

The Walnut web console renders `<suggest>` blocks in assistant messages as cards with clickable buttons. A click executes the named op with the given args, under the user's authorization. Every other surface (phone v1 projection, plain-text notifications) shows the raw tags, so the surrounding prose must read fine on its own.

## Syntax

```
<suggest title="Triage this" multi? sticky?>
Markdown body (optional): context, a numbered draft, task refs.
<action tool="task_focus_tier_set" args='{"id":"t_1","tier":"focus"}' label="Put to Focus" style="primary"/>
<action tool="task_update" args='{"id":"t_1","start_date":"2026-09-01"}' label="Push to Sep 1"/>
<action tool="task_delete" args='{"id":"t_1"}' confirm="Cannot be undone" label="Delete" style="danger"/>
<action dismiss label="Ignore"/>
</suggest>
```

## Attributes

- `tool`: any Walnut op name (`walnut tools list`). The click runs it exactly as written — the server validates args against the op's schema and refuses unknown ops.
- `args`: complete, static, valid JSON. REAL ids only — never a placeholder, never a guess.
- `label`: short button text. `style`: `primary`, `danger`, or omitted.
- `confirm="..."`: adds an inline confirmation step. Required for anything irreversible (delete, merge, anything that runs code or replaces a document — the server refuses destructive ops without it).
- `<action dismiss label="..."/>`: closes the card, runs nothing. Include one on every card.
- Card-level `multi`: each action is independently clickable once (batch decisions). `sticky`: the card stays usable after clicks. Default: one card = one decision, the first click settles it.

## Rules

- A card is for a CHOICE the user should approve. Do the work yourself when no approval is needed; never emit a card instead of an answer.
- One decision per card; at most one card per answer unless the user asked for a batch review.
- The body prose must carry the full meaning without the buttons (other surfaces show raw text).

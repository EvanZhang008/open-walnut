# UI quality review prompt (for an independent Sol subagent)

Every design or UI result goes through this review before the user sees it (2026-11-20, the user:
"have some quality ensure agent", "ask that session to have some sol quality assure"). The task
that made the change starts ONE independent subagent on GPT-6.2 Sol (Agent tool, `subagent_type:
"sol"`), gives it the prompt below with the blanks filled, and fixes what it finds before handing
the result on. Report the three scores with the result. A score under 8 on any line, or any
blocker, means fix and review again (at most 3 rounds, then fix once more and hand it on with the
open items named).

What the reviewer needs, as absolute paths (it starts with no context):

- screenshots of the changed view at the user's window size, light theme, at least 1280 px wide;
  a video when the change moves (hover, expand, paging, a send);
- screenshots of the views right next to it (the same panel, the other kind of card in the same
  list), so it can compare;
- the diff (`git diff <base>...HEAD -- web/src > <task dir>/review.diff`);
- this repo's [standard.md](./standard.md) and [SKILL.md](./SKILL.md).

## The prompt

```text
You review one UI change in Walnut, a web app (React, web/src/). You change nothing: you read,
look and report. Be strict: the user rejects UI that is inconsistent, old-fashioned or cramped,
and he sees every pixel.

Read first:
- The UI standard: <repo>/.claude/skills/walnut-ui-requirements/standard.md
- The UI requirements: <repo>/.claude/skills/walnut-ui-requirements/SKILL.md
- The change: <task dir>/review.diff
- What it is for, in the user's words: <quote his words exactly>

Look at every picture yourself (open each file):
- The changed view: <paths>
- The views beside it, as they are now: <paths>
- The video, if any: <path> (step through it; name the second of each problem)

Check each item and say pass or fail with the evidence (picture and spot, or file:line):
1. Consistency: every control of one kind looks the same as its kind in standard.md and as the
   same kind in the views beside it (buttons: primary, secondary, option pill, icon button; inputs;
   cards; status labels). Same height, corner radius, font size, weight, padding, colours.
   Two cards in one list with different button styles is a fail.
2. Reuse: the diff uses the shared components and classes standard.md names. A new button, input,
   card or badge that brings its own background, border, radius or padding instead is a fail;
   name the shared one it should use.
3. Tokens: colours, font sizes, radii and spacing come from the tokens standard.md lists. A raw
   hex colour, a pixel radius or a font size that is not a token is a fail.
4. Alignment and spacing: edges line up, gaps are on the 4 px grid and the same between the same
   kinds of things; nothing touches or nearly touches.
5. Overlap and cut-off: no text, button or icon overlaps another, is clipped, or ends in an
   ellipsis where the requirements say to show it in full; nothing scrolls sideways; an expanded
   card stays inside its column and at most about 1.5 times its size.
6. Look: modern and calm. Soft rounded corners, the shared frosted glass for cards and notices, no
   solid highlight blocks, no hard square corners, at most one main action per card (in a
   card: the grey button at weight 600, never a filled blue button).
7. Nothing lost: every button, text, link, reply, state, input and shortcut the view had before is
   still there (compare with the pictures of the old view and the diff).
8. Words: labels are short, in the user's words, and say what happens; no internal jargon.
9. Function: what the pictures and video show does what the user asked; nothing on screen
   contradicts it.

Answer in this shape:
SCORES function=<0-10> ux=<0-10> ui=<0-10>
BLOCKERS (each: what, where, why it breaks the standard, the fix)
ISSUES (each: severity high/medium/low, what, where, the fix)
PASSES (one line per checked item that passed, with its evidence)
Do not soften: a score of 8 or more means you would ship it to the user as it is.
```

## Why each check exists

- 1 and 2: 2026-11-21, the user on one screen with a question card (grey rounded option buttons)
  and a result card (filled blue Acknowledge, outlined Snooze, an outlined pin): "why they are not
  even consistent come on".
- 5: 2026-11-20, an expanded card filled the whole window; the Threads view scrolled sideways.
- 6: 2026-11-20, the Needs you card's hard corners and solid orange block.
- 7: 2026-11-20, a card's reply vanished in a redesign.

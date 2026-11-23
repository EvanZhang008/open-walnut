---
name: walnut-ui-requirements
description: The requirements every change the user can see in Walnut must meet (cards, panels, lists, inbox, chat, states and tabs, styling, proof videos), the user's taste (round, quiet, consistent), the UI standard (one look per kind of control) and the Sol review prompt. MUST read before planning, building, testing or shipping any change to web/src/, the Mac app's web pages or the phone's views. Each rule is one line with a real incident.
---

# Walnut UI requirements

Read this before you plan a UI change, and check every rule again before you land it. Each rule is
one sentence; the example under it is a real incident from the user's own use. The implementation
detail lives elsewhere and is linked, never copied: [web/src/AGENTS.md](../../../web/src/AGENTS.md)
(invariants, menus and overlays), the `walnut-web-frontend` skill (how the SPA works), and the root
[AGENTS.md](../../../AGENTS.md) (test tiers, where browser runs go).

## The standard and the review

- [standard.md](./standard.md): one look per kind of control (the button family, inputs, cards,
  status labels, tokens). Reuse it; never bring a second style. `tests/web/ui-standard-ratchet.test.ts`
  fails on a new one. Its "Text that does not fit" section is rule 11 below in detail: titles and
  names wrap, only metadata cuts; its "Panes" section says how empty panes and widths behave.
- [review-prompt.md](./review-prompt.md): before any design or UI result reaches the user, one
  independent Sol subagent reviews it with this prompt and scores function, ux and ui out of 10.

## Keep what works

1. **Never drop an existing feature: before you change a card or panel, list everything it has now (buttons, text, links, replies, states, inputs, shortcuts), and after the change check each one is still there and still works.**
   Example (2026-11-20): after a thread card was redesigned, the user's reply on it vanished from the card and never reached the task.
2. **Walk the core flows again before every release, on a copy of the user's data, and add a test for each.**
   Example (2026-11-20): replying inside a card, pressing Acknowledge and switching tabs broke in builds that had passed their own new tests.

## States, tabs and words

3. **Use as few states and tabs as possible, named with the user's own words, and a tab shows only its own kind.**
   Example (2026-11-20): Threads shipped All / Needs you / To read / Waiting / Done plus a "Known" group, which the user could not read; he asked for Needs you / Waiting / Closed.
4. **A new design ships once its review and tests pass; tell the user in one line in its thread after it is live. Only a real choice of look (which of several designs) goes to him first, and so does any change to a look he did not ask about (a shape, colour, icon or layout beyond his words), as ONE before/after page; his own kinds of decision (a public release, an outward send, spending, credentials, deleting data) stay his.**
   Example (2026-11-22): asked to unify the input boxes, a task also turned every round key square and shipped it, and the user said "you did not align with me, you just changed all of these things"; on 2026-11-21 he had said "just ship it when it is ready to ship, don't ask me about this" about go-live. The page has every option's picture inline, your pick and why first; the rest of the work goes on meanwhile.
5. **Plain input is a plain message: never attach what the user types to a question or thread on its own.**
   Example (2026-11-20): every message in the main chat was labelled "Answer to ...".
6. **A card that asks the user to decide holds one decision at a time; several decisions page left and right.**
   Example (2026-11-20): on the Needs you card of a task row the user asked for "at most one decision per card, page left and right".
7. **The inbox holds only letters the user must act on: no threads, no plugin INFO notices.**
   Example (2026-11-20): a plugin's new-message count arrived as an info letter ("why send me this"). Rules: [org and inbox](../../../docs/reference/org-and-inbox.md).

## Layout and look

8. **Never fill the screen: an expanded card grows to about 1.5 times its size at most, stays inside its own column, shows the full text on hover, and never pushes its buttons out of view.**
   Example (2026-11-20): expanding a Needs you card filled the whole window, and a fix had to ship the same day.
9. **No hard square corners and no solid highlight blocks; notices, cards and shortcut bars share one frosted glass look.**
   Example (2026-11-20): the user found the Needs you card ugly for its hard square corners and its solid orange block, beside frosted glass notices.
10. **Lists scroll up and down only, never sideways.**
    Example (2026-11-20): the Threads view scrolled sideways and had to lose its horizontal overflow.
11. **Show text in full in a compact layout; never cut it to two lines with an ellipsis.**
    Example (2026-11-20): the user asked for card text in full and compact, after summaries cut to two lines hid the part he needed.
12. **Menus and overlays follow the hard rules in [web/src/AGENTS.md](../../../web/src/AGENTS.md#menus--overlays--hard-rules), and a page's view choice is kept with `usePageView`.**
    Example (2026-10): menus that overflowed the viewport and tabs that reset on reload; each rule there is a shipped incident.

13. **No toast for what the user can already see: a toast is only for a failure he cannot see, news from out of sight, or the Undo of a change that takes its object out of view.**
    Example (2026-11-21): creating a calendar event popped an "Event created" card with an Undo in the far corner while the new block sat on the grid under his pointer; the user complained. Rules: [standard.md](standard.md#toasts).

## Taste: round, quiet, consistent

The user's own taste, from his words of 2026-11-21 and 2026-11-22. They hold for every surface (web,
the Mac app, the phone). When in doubt, take the simpler, rounder, quieter one.

14. **Round, not square: boxes and controls are soft and rounded, keys and icon buttons are circles; a box one line tall is a rounded rectangle, never an oval pill.**
    Example (2026-11-22): the input boxes went to 8 px corners with square keys; the user: "it was so cute and round before, now you made everything into little squares", "It should be round instead of square for our UI". A message box is 20 px, a one-line box 12 px, keys 50 % ([standard.md](./standard.md#inputs); guard `tests/web/ui-taste-guard.test.ts`); on 11-21 he called the oval Threads box ugly.
15. **One shape per kind of element: when one chip, key or box of a kind is a pill, they all are, and when one is not, none is.**
    Example (2026-11-22): "why is this a pill and the others are not, let's keep it consistent ... so simple, very clean". Look at the neighbours before you give an element a shape.
16. **Quiet by default: no colour, icon, badge or line that carries no meaning; keep the user's own icons and their plain colour.**
    Example (2026-11-22): "I want my old nice icon back, I don't want this much color", "avoid too much visual element", "We need to be super simple".
17. **A signal is one plain dot: unread or needs-you is a small red dot, never a red number, a "!" mark, a blue dot beside it, or a word saying the same.**
    Example (2026-11-22): on the Org rows, "the number of red change to simple red dot", "the blue dot remove", "no ... the ! mark", "VP also show a status nonono".
18. **A row shows its name and its one signal; counts, relative times ("+7"), summaries ("1 thread ...") and statuses belong in the detail view, not the row.**
    Example (2026-11-22): "remove the text of 1 thread xxx", "the time remove +7", "just show name of vp icon, red dot for thread", "avoid too much info".
19. **A focused field shows only its own edge turning a shade darker: no ring, no glow, no blue or accent edge, on a click or from the keys.**
    Example (2026-11-23): the quick bar opened with a thick 2 px blue ring round its box; the user: "don't do this ... that highlight after it is selected, so gross!" The caret shows where the words go; only a box to tick or a slider, which has no edge, keeps a keyboard ring ([standard.md](./standard.md#inputs); guard `tests/web/focus-ring-owner-guard.test.ts`).
20. **An empty message box stays empty: no long hint text in it; a placeholder only when it says something the user cannot see otherwise (a reply he has not read yet), in a few words.**
    Example (2026-11-23): the session box read "Send a message to this session... (/ for commands)"; the user: "remove this too ugly", "clean simple". The box keeps its name for screen readers (`aria-label`), not on the screen.

## Proof and shipping

21. **Proof is a Playwright video recorded on a Linux dev host with a copy of the user's data, his window size and his flags, at least 1280 px wide, slow enough to see each step and its result.**
    Example (2026-11-20): a demo on toy fixtures looked good while the real product with real data looked bad.
22. **One task ships one thing; when many asks pile onto one task, split them and land them one at a time.**
    Example (2026-11-20): one task carried the Needs you card's new look, one-decision paging and the full-window expand fix at once, so each slipped behind the others.
23. **Report to the user briefly, with pictures or GIFs instead of long text.**
    Example (2026-11-20): the user's standing rule after long reports: pictures or GIFs over long text, his exact question answered first.

## Before you land

Go through this list for the change: every item of rule 1 checked, the core flows of rule 2 walked,
rules 14 to 20 held on every screen you touched (and nothing restyled that the user did not ask about, rule 4),
the video of rule 21 watched by you frame by frame, and, after it is live, the one-line note to the user in its thread (rule 4).

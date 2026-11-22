# Keyboard and undo

Walnut lets you work through many sessions without the mouse: jump between the session
columns, complete a task and land on the next one that needs you, and take any of it back.

## Keys

Press `?` anywhere outside a text box (or mod+/ anywhere) for the full sheet. `mod` is Cmd on a
Mac and Ctrl elsewhere.

| Keys | What it does |
|---|---|
| mod+1 to mod+8 | Go to the 1st to 8th session column from the left; the caret goes into its composer |
| mod+9 | Go to the last session column |
| mod+Shift+[ / mod+Shift+] | Previous / next session column (wraps) |
| mod+I | Put the caret in the current column's composer (with the session switching modifier too) |
| mod+Shift+D | Complete the current task, close its column, go to the next task that needs you |
| mod+Z | Undo the last complete, reopen, snooze, pin, delete or calendar change, for 5 seconds |
| mod+Shift+Z (also Ctrl+Y off the Mac) | Redo what was just undone, for 5 seconds |
| hold the jump modifier | Each column shows its number |

Browsers keep some chords for their tabs and never pass them to a page. So the session switching
keys (the number jumps and previous / next) use the modifier the place leaves free:

| Where | Session switching modifier |
|---|---|
| The Mac app | Cmd |
| A browser on a Mac | Control (Cmd+1 to Cmd+9 switch the browser's tabs) |
| A browser elsewhere | Alt (Ctrl+1 to Ctrl+9 switch the browser's tabs) |

The sheet and the column numbers always show the keys of the place you are in.

"The current column" is the one holding the caret, or, when the caret is nowhere (you clicked
into a transcript to read it), the one you last clicked in. With two columns or more it wears a
thin accent line along its top. Keys pressed faster than the caret moves stack up: two quick
"next" go two columns on.

## Completing and going on

Completing a task from its column's header, or with mod+Shift+D, closes that column and goes on
to the next task in the Needs you list, in the order the list had when you completed it (the
task after it, wrapping to the top). Its column opens in the place of the one that closed, in
the same frame, or takes the caret if it is open already. With the going-on off, or nothing
left that needs you, the caret goes to the column that takes the closed one's place.
With no column at hand, mod+Shift+D completes the task selected in the task list. Turn the
going-on off in Settings > Tasks ("Go to the next task after completing one").

## Undo

Complete, reopen, snooze (the start date), pin, unpin, a pin's group, and delete each show a
toast with Undo for 5 seconds, with a bar that shows the time left. The toasts stack at the bottom
left, over no session column. mod+Z takes back the newest one from anywhere (only its toast
shows the key; an older one keeps its button), except in a text box with text in it, where it
undoes your typing as usual. In an empty composer (where mod+Shift+D leaves the caret) it is the
task undo. A change the server refuses takes its toast down at once, with the error.

The lists sort by latest activity, and an Undo is activity too: a task you take back sits at the
top of its section.

Two actions on the same task inside the window (pin, then pick a group) undo together, back to
how it was before the first one.

A delete removes the task on the server only when its Undo window ends: until then the task is
only hidden. Closing or reloading the page inside the window sends the delete at once.

## Redo

An Undo can be done again: mod+Shift+Z (Ctrl+Y works too off the Mac), or the Redo button on the
"Undone" line, for 5 seconds after the Undo. Several Undos are redone newest first, and any new
action ends the redo list, as in every editor. A redo does the action again through the same call
that did it the first time. An Undo that finds its target changed elsewhere since (by an agent or
another window) leaves it and says "Not undone: it changed since", and then there is nothing to
redo, so a Redo never writes over that change.

## Calendar

On the homepage's day agenda and the Calendar page, a move, a resize, a copy, a new event, a task
dropped on the grid and a time edited in the popover are each one Undo, and each can be redone.
None of them raises a notice (the UI standard's toast rule): the block on the grid already shows
what happened, so mod+Z and mod+Shift+Z are their Undo and Redo.

Every time picked by pointer on the grid lands on a quarter hour: a click or drag that makes an
event, a move, a resize, an Alt copy, the right-click menu and a task dropped from a list. One
function snaps them (`gridSnapMinute` in `web/src/components/calendar/calendar-grid-settings.ts`);
the grid's rows stay half an hour tall (`tests/web/calendar-snap-guard.test.ts`).

A load that fails (the server answers 503 for a few seconds while it restarts) says so above the
grid, on the day agenda too, with a Retry button, and is tried again by itself (2 s, 5 s, 10 s,
30 s, then every minute) while the view is open. A refresh of events already on screen that fails
once is retried quietly; only a second failure in a row is said. A fetch that left before a write
landed never takes the new or moved event off the grid, in the browser or in the server's cache
(`src/integrations/calendar/service.ts`, `writeGen`): it is asked again once the writes settle. A
write the Mac must confirm first holds no answers back while it waits.
Hold Alt (Option on a Mac) while dragging an event to copy it: the block in your hand gets a "+"
and the original stays. Letting go of Alt before the drop makes it a move again. A copy takes only
the calendar, title and times, never the people invited, so it invites and notifies nobody. A task
dragged with Alt moves (a task is one piece of work, not something to duplicate). A meeting that
needs your confirmation to change asks again for its Undo and Redo, and an Undo waits for the
change it takes back to be written first.

Every block shown while dragging is drawn in the colour the item will have once dropped: a new
event in its calendar's colour (the default calendar the form starts on), a moved or copied one in
its own (`web/src/components/calendar/item-tint.ts`).

Code: `web/src/keyboard/`, `web/src/undo/`, `web/src/components/calendar/calendar-item-actions.ts`, `web/src/pages/useHomeKeyboard.ts`,
`web/src/pages/useColumnCompleteClose.ts`, `web/src/components/tasks/next-needs-you.ts`.

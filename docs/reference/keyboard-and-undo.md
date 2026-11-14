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
| mod+Z | Undo the last complete, reopen, snooze, pin or delete, for 5 seconds |
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

Code: `web/src/keyboard/`, `web/src/undo/`, `web/src/pages/useHomeKeyboard.ts`,
`web/src/pages/useColumnCompleteClose.ts`, `web/src/components/tasks/next-needs-you.ts`.

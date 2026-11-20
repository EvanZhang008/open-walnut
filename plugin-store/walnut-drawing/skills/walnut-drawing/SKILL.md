---
name: walnut-drawing
description: See, read, edit or add to the editable Drawing whiteboard in a task's Notes folder. Use when someone asks for a diagram, sketch or system design, wants text in a drawing changed, or wants a hand drawing turned into a clean diagram.
---

# Drawing

Drawing is an editable whiteboard, not a chat image. The App and the session pane show the same `.excalidraw` scene in Notes. A small app-state note tells you which drawing is on screen, its text and whether the person has unsaved edits.

1. Use `walnut_drawing_list` with the task or session id to find its drawings. Use the `path` from app state when a drawing is already open.
2. Use `walnut_drawing_render` to get an image of the drawing (an absolute file path) and look at it with your file reading tool. Do this before tidying a hand drawing: strokes have no text, so the picture is how you know what they mean.
3. Use `walnut_drawing_read` for the full scene and its revision: every element's id, type, position, size, text and arrow connections.
4. Use `walnut_drawing_update` to change what is there, in one checked step:
   - `update`: `[{id, text}]` fixes a label; `[{id, x, y}]` moves an element; colours, size, `fontSize` and `points` change the same way.
   - `remove`: ids to delete. Bindings and labels that point at them are cleaned up.
   - `add`: new shapes, as for append below. Give each a temporary `id` (for example `"box1"`), and give arrows `start: {id}` and `end: {id}` to connect shapes; the answer's `idMap` gives the real ids.
5. Use `walnut_drawing_append` when you only add and change nothing. Use `walnut_drawing_create` only when a new drawing is what the person asked for; pass the task or session so the file belongs to their work (no task means Inbox).
6. After any edit, render again and look at the result before you tell the person it is done.
7. Use `walnut_drawing_rename` to rename a drawing to a clear title (a few words that say what it shows); keep using the new `path` it returns.

Every write sends the revision from your last read. A stale revision is refused: read again (the person may have just drawn something) and redo the edit on the new scene. Never overwrite the whole scene to make an edit pass, and never remove elements the person did not ask you to change. If app state says unsaved, let the person's edits save first.

## Turning a hand drawing into a clean diagram

1. Render and look. Read the scene to get the ids of the `freedraw` strokes and the rough boxes, and any typed text.
2. Decide what each part means: a box, a label, an arrow from A to B.
3. One `walnut_drawing_update`: `remove` the strokes you replace, `add` clean `rectangle`/`ellipse`/`diamond` shapes with `text` labels near where the person drew them, and `arrow`s with `start`/`end` naming those shapes. Keep the person's own typed text and anything you did not interpret.
4. Render again and check that every word is readable and every arrow lands on the right shape.

## What the person said while drawing

A drawing may carry recorded walkthroughs: the person pressed Record and talked while drawing. `walnut_drawing_read` then answers with `walkthroughs`, an overview with one line per part: its time span, the element it was about (label and id) and the gist of what was said. Answer from it when you can ("which is the core table?": find the part that says so and name its element).

When the overview is not enough (a part about several elements, "this one" with no clear element, the exact words), call `walnut_drawing_narration` with `take` and `part` from the overview, or `from`/`to` in seconds. It lists each sentence with its times, the elements it was matched to and why (the pointer rested on it, it was selected, just drawn or changed, or named in the words), and every step on the canvas in that span. Say when a match is only a guess (nothing pointed at or selected), and give the time so the person can check.

## Shapes

`rectangle`, `ellipse`, `diamond`, `text`, `arrow`, `line` and `freedraw`. Give shapes `x`, `y`, `width` and `height`; give text `x`, `y`, `text` and optionally `fontSize`; give lines and arrows `x`, `y` and `points` relative to that origin, or `start`/`end` to connect shapes. A shape's optional `text` becomes its label. `strokeColor` and `backgroundColor` are optional. Match the existing scene's positions and styles. Complete scene elements are accepted too, but you do not need to build every internal field.

The Notes companion makes the diagram's words searchable. PNG and SVG are exports; the `.excalidraw` file is the editable original.

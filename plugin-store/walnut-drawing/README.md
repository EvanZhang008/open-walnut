# Drawing

An editable hand-drawn whiteboard in Walnut. Install Drawing from Apps, then open it there or from a session's Apps menu. The same editor also upgrades the composer's Draw action when the Drawing app experiment is enabled.

## Files

Drawings are standard `.excalidraw` scene files in the Notes vault, not images trapped in a chat. A drawing started without a task goes to `inbox/`; a task drawing goes under its project and task. A Markdown companion carries its title and diagram text into Notes search and links back to the editable scene. PNG and SVG exports are copies, not the editable original.

## Working with a session

The plugin contributes a `sessionPane` to its normal App. Walnut keeps the selected app and document per session and place. The plugin shares a small summary through `walnut.appState`; the scene stays on disk. The agent works on the same drawing through Drawing's tools: `render` writes an image of it that the agent can look at, `read` returns every element with its id and text, `update` edits text, positions and styles by id, removes elements (cleaning up their bindings) and adds new ones in one step, `append` only adds, and `rename` gives a drawing a clear title (its Notes entry follows). So the agent can turn a hand sketch into a clean diagram: look at it, remove the strokes, add labelled shapes and arrows bound to them. Every write requires the revision returned by the last read and refuses stale writes, so it never silently replaces someone else's edits; an open editor with no unsaved changes shows the agent's edit at once. The tools accept simple shape descriptions (temporary ids, arrows naming `start` and `end` shapes) and fill scene defaults; agents do not need to construct the editor's internal fields.

## Editor

The editor supports shapes, text, arrows, freehand strokes, erasing, selecting and moving, undo and redo, zoom and pan, dark mode, and PNG/SVG export. Its library is loaded only when someone opens a drawing. It uses Walnut's host view rather than copying the large editor into a plugin module.

## Credit

The editor uses [Excalidraw](https://github.com/excalidraw/excalidraw), licensed under the MIT license. The application name, design and hosting are Walnut's. See the library's included license for its copyright notice.

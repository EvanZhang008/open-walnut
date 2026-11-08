/**
 * cmNoDragEdits: a pointer drag never edits a CodeMirror document.
 *
 * CodeMirror's own mouse handling (MouseSelection in @codemirror/view) treats a
 * single press INSIDE the selection as the start of a possible text drag: it
 * leaves the press to the browser, the browser starts a native drag-and-drop,
 * and the drop MOVES the selected text to wherever the pointer lets go
 * (`move.drop`). In the Files viewer that turned "press at the start of a
 * selection and drag down to select more" into an edit that was auto-saved to
 * disk at once (2026-11-08, Mac WebKit, a 4000-character line).
 *
 * Walnut's code editors are mostly read and selected from (Ask here, comments),
 * so a drag selects, as in a plain text viewer:
 *  - a plain press inside the selection first collapses it to the press point,
 *    so CodeMirror's own handler starts a new selection there;
 *  - a native drag never starts from the editor (dragstart is cancelled);
 *  - nothing dropped onto it (text from elsewhere, a file) is inserted;
 *  - as the last word, a change filter refuses every drop transaction, whatever
 *    DOM path produced it.
 *
 * Every EditorView construction in web/src carries this extension
 * (tests/web/cm-no-drag-edit-guard.test.ts).
 */
import { EditorState, Prec, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

export function cmNoDragEdits(): Extension {
  return [
    Prec.highest(EditorView.domEventHandlers({
      mousedown: (event, view) => {
        // Only a plain primary press: shift extends the selection, Mod adds or
        // removes a range, Alt makes a rectangle, and a double or triple press
        // selects a word or line. CodeMirror never drags from any of those
        // except shift, and the dragstart guard below covers that one.
        if (event.button !== 0 || event.detail > 1) return false;
        if (event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return false;
        const main = view.state.selection.main;
        if (main.empty) return false;
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
        if (pos == null || pos < main.from || pos > main.to) return false;
        // Collapse first: CodeMirror's handler (it runs after this one) then sees
        // no selection under the press and starts a normal pointer selection,
        // preventing the browser's default, so no native drag can begin.
        view.dispatch({ selection: { anchor: pos }, userEvent: 'select.pointer' });
        return false;
      },
      dragstart: (event) => {
        event.preventDefault();
        return true;
      },
      drop: (event) => {
        event.preventDefault();
        return true;
      },
    })),
    EditorState.changeFilter.of((tr) => !(tr.isUserEvent('input.drop') || tr.isUserEvent('move.drop'))),
  ];
}

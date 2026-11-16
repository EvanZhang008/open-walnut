/**
 * Stands in for `@excalidraw/mermaid-to-excalidraw` (web/bundle-trim.ts sends it here).
 *
 * The editor package imports that library lazily for two things of its own: its built-in
 * "Mermaid to Excalidraw" dialog and turning pasted Mermaid text into shapes. Walnut uses
 * neither: its Text to diagram asks Walnut's server (drawing-diagram.ts), and the dialog's
 * toolbar entry is hidden (drawing-workspace.css). The real library pulls in all of Mermaid
 * (about 100 MB installed: every diagram kind, katex, cytoscape, langium), which made the web
 * build run Node out of memory at a 2 GB heap and added megabytes of chunks to the package.
 *
 * A paste of Mermaid-looking text calls this, gets the rejection, and the editor pastes the
 * words as text, which is its own fallback for a definition it cannot parse.
 * Guard: tests/web/bundle-trim.test.ts.
 */
export async function parseMermaidToExcalidraw(): Promise<never> {
  throw new Error('Mermaid diagrams are not part of this editor.');
}

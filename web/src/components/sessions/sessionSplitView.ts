/**
 * The three session "side panels" all share one full-screen split layout:
 *   [ left panel | existing chat ]
 *
 * - 'changed'  → SessionDiffView   (files this session changed)
 * - 'files'    → SessionFileExplorer (browse the working dir)
 * - 'terminal' → SessionTerminal (embedded xterm, NOT the old centered modal)
 *
 * A single `activeView` state drives which one is open (null = none). Opening any
 * view promotes the panel to fullscreen (useFullscreen); the chat moves into the
 * right column without remounting.
 */
export type SessionSplitView = 'changed' | 'files' | 'terminal';

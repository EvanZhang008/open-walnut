/**
 * The file viewer overlay, loaded the first time a file opens. It brings the editors (CodeMirror,
 * the notes editor) and the highlighter, about 1.5 MB, which a window that only chats never needs
 * at open (the browser side panel, popout/popout-views.ts); the console has it loaded by its other
 * pages already. Same props as FileViewer.
 */
import { lazy, Suspense, type ComponentProps } from 'react';
import type { FileViewer as FileViewerType } from './FileViewer';

const FileViewer = lazy(() => import('./FileViewer').then((m) => ({ default: m.FileViewer })));

export function LazyFileViewer(props: ComponentProps<typeof FileViewerType>) {
  return <Suspense fallback={null}><FileViewer {...props} /></Suspense>;
}

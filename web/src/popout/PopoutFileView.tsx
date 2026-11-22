import { useSearchParams } from 'react-router-dom';
import { FileContentView } from '@/components/common/FileContentView';
import { EmptyState } from '@/components/common/EmptyState';
import { ICON_FILE } from '@/components/common/Icons';

/**
 * Pop-out file view. Reads path/host/line/endLine from the query string and renders the
 * shared FileContentView filling the window. FileContentView is a one-shot fetch
 * with no websocket, so this pop-out holds zero live connections.
 *
 * `hidePopout` is passed so the in-window toolbar does NOT show another pop-out
 * button (we're already popped out).
 */
export function PopoutFileView() {
  const [params] = useSearchParams();
  const path = params.get('path') ?? '';
  const host = params.get('host') ?? undefined;
  const lineParam = params.get('line');
  const line = lineParam ? Number(lineParam) : undefined;
  const endLineParam = params.get('endLine');
  const endLine = endLineParam ? Number(endLineParam) : undefined;

  if (!path) {
    return (
      <EmptyState size="pane" icon={ICON_FILE} title="No file to show" hint="This window was opened without a file path." />
    );
  }

  return (
    <div className="popout-file">
      <FileContentView
        path={path}
        host={host}
        line={Number.isFinite(line) ? line : undefined}
        lineEnd={Number.isFinite(endLine) ? endLine : undefined}
        hidePopout
      />
    </div>
  );
}

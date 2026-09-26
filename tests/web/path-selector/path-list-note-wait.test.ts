/**
 * One wait, one indicator. When the selected host's note on top of the list is
 * already showing its connect steps (its listing is loading with a connect
 * phase), PathList must not add the generic "Loading paths..." line under it:
 * two spinners for one wait was the regression the picker specs caught.
 * (A connecting host WITHOUT a note draws its own steps row, a live store
 * component that server rendering cannot draw: pinned in the browser specs.)
 */
import { describe, it, expect } from 'vitest';
import { createElement } from '../../../web/node_modules/react/index.js';
import { renderToStaticMarkup } from '../../../web/node_modules/react-dom/server.node.js';

const { PathList } = await import('../../../web/src/components/sessions/path-selector/PathList');
type HostLiveState = import('../../../web/src/components/sessions/path-selector/useLiveDirs').HostLiveState;

const connecting: HostLiveState = {
  status: 'loading', parent: '', exists: true, dirs: [],
  pending: { phase: 'install-runtime', label: 'Installing the session daemon runtime on Dev box', elapsedMs: 1200 },
};
const loading: HostLiveState = { status: 'loading', parent: '', exists: true, dirs: [] };

function render(hostStates: Map<string, HostLiveState>, noteHosts?: Set<string>): string {
  return renderToStaticMarkup(createElement(PathList, {
    sections: [], selectedIdx: -1, expandSelected: false, loading: true, loadError: null,
    hostStates, hostLabels: new Map([['devbox', 'Dev box']]), pathMode: true,
    activeHostLabel: 'Dev box', createOption: null, emptyHint: 'No matches.',
    onItemClick: () => {}, onItemHover: () => {}, onCreate: () => {},
    topNote: createElement('div', { className: 'note-stub' }), noteHosts,
  }));
}

describe('PathList: the generic loading line next to a host note', () => {
  it('is left out while the note host is connecting', () => {
    expect(render(new Map([['devbox', connecting]]), new Set(['devbox']))).not.toContain('Loading paths...');
  });

  it('still shows for a plain listing in flight (the note host is up, nothing to join)', () => {
    expect(render(new Map([['devbox', loading]]), new Set(['devbox']))).toContain('Loading paths...');
  });
});

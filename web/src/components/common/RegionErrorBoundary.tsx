import { Component, Fragment, useEffect, useRef, useState, type ErrorInfo, type ReactNode } from 'react';
import { log } from '@/utils/log';
import { errorText } from '@/utils/error-text';
import '@/styles/region-error.css';

/**
 * The parts of a session's window that each keep their own crash to themselves.
 * A render or effect error in one of them (a composer control that loops, a side
 * thread that cannot draw) shows a small error with Retry in THAT part, and the
 * conversation, the other columns and the rest of the page keep working
 * (2026-11-18: one looping control in the composer replaced the whole session
 * panel, with no way back but closing it). tests/e2e/browser/region-error-boundary.spec.ts
 * crashes each of these on purpose and checks the rest of the page.
 */
export const ERROR_REGIONS = {
  'session-panel': 'This session',
  composer: 'The message box',
  'side-threads': 'Side chats',
} as const;

export type ErrorRegion = keyof typeof ERROR_REGIONS;

/**
 * Test hook: on a page whose test set `window.__walnutTestCrashHooks = true` before
 * it loaded, `window.dispatchEvent(new CustomEvent('walnut:test-crash', { detail:
 * { region, key } }))` makes that region throw on its next render, every region of
 * that kind whose ids hold `key` (a session id), so a browser test can prove the
 * region holds its crash and Retry brings it back. Without the flag nothing listens.
 */
function CrashProbe({ region, ids }: { region: ErrorRegion; ids?: Record<string, string | undefined> }): null {
  const [crash, setCrash] = useState(false);
  const idsRef = useRef(ids);
  idsRef.current = ids;
  useEffect(() => {
    if (!(globalThis as { __walnutTestCrashHooks?: boolean }).__walnutTestCrashHooks) return;
    const onCrash = (event: Event) => {
      const detail = (event as CustomEvent<{ region?: string; key?: string }>).detail;
      if (detail?.region !== region || !detail.key) return;
      const values = Object.values(idsRef.current ?? {});
      // A whole id or a whole part of a key (`draft:session:<id>`), never a prefix of another id.
      if (!values.some((v) => v === detail.key || v?.split(':').includes(detail.key!))) return;
      setCrash(true);
    };
    window.addEventListener('walnut:test-crash', onCrash);
    return () => window.removeEventListener('walnut:test-crash', onCrash);
  }, [region]);
  if (crash) throw new Error(`test crash in ${region}`);
  return null;
}

interface RegionErrorBoundaryProps {
  region: ErrorRegion;
  /** Ids for the log line (sessionId, taskId), full, never cut. */
  ids?: Record<string, string | undefined>;
  /** A change clears the error (another session in the same column). */
  resetKey?: unknown;
  /** Words for the error, when the region's name alone does not say it. */
  message?: string;
  /** Extra classes for the error box (a panel keeps `.session-panel` sizing). */
  className?: string;
  /** A one-line error for a small region (a popover, a composer). */
  compact?: boolean;
  /** More buttons beside Retry (a column's Close panel). */
  actions?: ReactNode;
  children: ReactNode;
}

interface RegionErrorBoundaryState {
  error: Error | null;
  /** Bumped by Retry: the children mount again from scratch. */
  attempt: number;
}

export class RegionErrorBoundary extends Component<RegionErrorBoundaryProps, RegionErrorBoundaryState> {
  state: RegionErrorBoundaryState = { error: null, attempt: 0 };

  static getDerivedStateFromError(error: Error): Partial<RegionErrorBoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    log.error('react', `${this.props.region} crashed; the rest of the page keeps working`, {
      region: this.props.region,
      ...this.props.ids,
      // WebKit's stack has no message line: it is logged on its own.
      error: errorText(error),
      componentStack: (info.componentStack ?? '').slice(0, 2000),
    });
  }

  componentDidUpdate(previous: RegionErrorBoundaryProps): void {
    if (this.state.error && previous.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  private retry = () => {
    log.info('react', `${this.props.region} retried after a crash`, { region: this.props.region, ...this.props.ids });
    this.setState((s) => ({ error: null, attempt: s.attempt + 1 }));
  };

  render() {
    const { region, message, className, compact, actions, children } = this.props;
    const { error, attempt } = this.state;
    if (!error) {
      return (
        <Fragment key={attempt}>
          <CrashProbe region={region} ids={this.props.ids} />
          {children}
        </Fragment>
      );
    }
    return (
      <div
        role="alert"
        className={`region-error${compact ? ' region-error--compact' : ''}${className ? ` ${className}` : ''}`}
        data-error-region={region}
      >
        <p className="region-error-title">{message ?? `${ERROR_REGIONS[region]} hit an error.`}</p>
        {!compact && error.message && <p className="region-error-detail">{error.message}</p>}
        <div className="region-error-actions">
          <button type="button" className="btn btn-sm btn-primary" onClick={this.retry} title={error.message || undefined}>
            Retry
          </button>
          {actions}
        </div>
      </div>
    );
  }
}

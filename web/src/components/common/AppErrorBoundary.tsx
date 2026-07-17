import { Component, createRef, useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { maybeSelfHeal, resetUiStateAndReload } from '@/utils/crash-recovery';
import { buildCrashReport, fetchServerEnrichment } from '@/utils/crash-report';
import { copyTextRobust } from '@/utils/clipboard';

/**
 * Root-level error boundary. Without one, ANY uncaught render/commit error in
 * React 19 unmounts the entire root → blank white page — and the default
 * reporting path is window.reportError, NOT console.error, so the crash was
 * also invisible to the browser-logger forwarder. This boundary (a) keeps a
 * recover UI on screen instead of a blank page, (b) logs the error + component
 * stack through console.error so it lands in the server log, (c) on repeated
 * crashes hands off to crash-recovery, which clears the persisted UI state
 * that would otherwise reproduce the crash on every reload forever, and
 * (d) offers a one-click "Copy crash report" so a remote user can hand us the
 * full picture without opening DevTools.
 *
 * Everything here renders with INLINE STYLES only — the app's CSS may not
 * have loaded when this screen appears.
 */
interface State {
  error: Error | null;
  componentStack: string | null;
  healing: boolean;
  report: string | null;
  showReport: boolean;
  copied: boolean;
}

const btnStyle: CSSProperties = { padding: '6px 14px', cursor: 'pointer' };

export class AppErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null, componentStack: null, healing: false, report: null, showReport: false, copied: false };
  private reportRef = createRef<HTMLTextAreaElement>();
  private copiedTimer: ReturnType<typeof setTimeout> | null = null;

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    // console.error routes through the browser-logger monkey-patch → server log.
    console.error('[error-boundary] render crash — tree recovered by boundary', {
      error: String(error?.stack ?? error),
      componentStack: (info?.componentStack ?? '').slice(0, 2000),
    });
    // Keep the stack for the crash report (it's not on the error object).
    this.setState({ componentStack: info?.componentStack ?? null });
    // Repeated crash within the window → persisted state is poisoned. Clear it
    // and reload at a clean URL instead of showing a dead-end recover UI.
    if (maybeSelfHeal()) this.setState({ healing: true });
  }

  componentWillUnmount() {
    if (this.copiedTimer) clearTimeout(this.copiedTimer);
  }

  /** Build once, then opportunistically append a live server probe. */
  private ensureReport(): string {
    if (this.state.report) return this.state.report;
    let text: string;
    try {
      text = buildCrashReport({ error: this.state.error, componentStack: this.state.componentStack });
    } catch (err) {
      // Defensive impossibility — buildCrashReport never throws by contract.
      text = `WALNUT CRASH REPORT\n(builder failed: ${String(err)})\nerror: ${String(this.state.error?.stack ?? this.state.error)}`;
    }
    this.setState({ report: text });
    void fetchServerEnrichment().then((extra) => {
      // If the user already copied the client-only version, that's fine too.
      this.setState((s) => (s.report ? { report: s.report + extra } : null));
    }).catch(() => { /* never rejects by contract */ });
    return text;
  }

  private handleCopy = () => {
    // A throw here would re-crash the boundary — everything guarded.
    try {
      const text = this.ensureReport();
      void copyTextRobust(text).then((result) => {
        if (result === 'failed') {
          this.setState({ showReport: true });
          return;
        }
        this.setState({ copied: true });
        if (this.copiedTimer) clearTimeout(this.copiedTimer);
        this.copiedTimer = setTimeout(() => this.setState({ copied: false }), 1200);
      }).catch(() => this.setState({ showReport: true }));
    } catch {
      this.setState({ showReport: true });
    }
  };

  private handleToggleReport = () => {
    try {
      this.ensureReport();
      this.setState((s) => ({ showReport: !s.showReport }), () => {
        if (this.state.showReport) this.reportRef.current?.select();
      });
    } catch { /* ignore */ }
  };

  render() {
    if (this.state.healing) {
      return (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', fontFamily: 'system-ui, sans-serif', fontSize: 13, color: '#888' }}>
          Recovering…
        </div>
      );
    }
    if (this.state.error) {
      return (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', gap: 12, padding: 16, fontFamily: 'system-ui, sans-serif' }}>
          <div style={{ fontSize: 15, fontWeight: 600 }}>Something went wrong rendering the page.</div>
          <div style={{ fontSize: 12, color: '#888', maxWidth: 560, textAlign: 'center', wordBreak: 'break-word' }}>
            {String(this.state.error.message || this.state.error)}
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
            <button type="button" onClick={() => this.setState({ error: null })} style={btnStyle}>
              Try to recover
            </button>
            <button type="button" onClick={() => window.location.reload()} style={btnStyle}>
              Reload
            </button>
            <button type="button" onClick={this.handleCopy} style={btnStyle}>
              {this.state.copied ? 'Copied ✓' : 'Copy crash report'}
            </button>
            <button type="button" onClick={this.handleToggleReport} style={btnStyle}>
              {this.state.showReport ? 'Hide report' : 'Show report'}
            </button>
            <button
              type="button"
              onClick={resetUiStateAndReload}
              title="Clears saved layout/panel state (tasks and sessions are untouched) and reloads"
              style={btnStyle}
            >
              Reset UI state &amp; reload
            </button>
          </div>
          {this.state.showReport && this.state.report && (
            <textarea
              ref={this.reportRef}
              readOnly
              value={this.state.report}
              onFocus={(e) => e.currentTarget.select()}
              style={{
                width: 'min(640px, 90vw)', height: '40vh', fontFamily: 'ui-monospace, monospace',
                fontSize: 11, padding: 8, whiteSpace: 'pre', boxSizing: 'border-box',
              }}
            />
          )}
        </div>
      );
    }
    return this.props.children;
  }
}

/**
 * Deliberate-crash probe for E2E tests and manual QA. Consumes a
 * sessionStorage flag in an effect (so the flag is spent exactly once and the
 * crash-recovery escalation can never loop), then throws on the next render.
 *
 * The arming MUST live in React state, not be derived from the flag at render
 * time: a render-phase throw makes React 19 retry the render synchronously
 * (error #520 recovery), and a probe that disarmed itself before throwing
 * would pass on the retry — the boundary would never catch. State survives
 * the retry, so the sync render throws again and reaches the boundary.
 * "Try to recover" remounts this component with fresh state + a spent flag →
 * no throw → recovery works.
 *
 * Compiled into production builds on purpose — Playwright runs the prod
 * bundle. Cost: one storage read per mount.
 */
export function DebugCrashProbe(): null {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    try {
      if (sessionStorage.getItem('open-walnut-debug-crash-once') === '1') {
        sessionStorage.removeItem('open-walnut-debug-crash-once');
        setArmed(true);
      }
    } catch { /* storage unavailable — never crash by accident */ }
  }, []);
  if (armed) {
    throw new Error('debug: deliberate crash (open-walnut-debug-crash-once)');
  }
  return null;
}

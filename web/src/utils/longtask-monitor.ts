/**
 * Long-task monitor — turns main-thread starvation from a victim-metric
 * ("json parse: 14757ms" on a 44-byte body = the event loop was blocked)
 * into a culprit-metric: PerformanceObserver longtask entries carry
 * attribution pointing at the script/frame that held the thread.
 *
 * Logs through the standard forwarder (console.warn → browser-logger →
 * server log), so starvation windows self-identify in
 * /tmp/open-walnut/open-walnut-<date>.log as subsystem=browser [perf] lines.
 *
 * Rate-limited so the observer can never become an amplifier itself.
 */

const REPORT_THRESHOLD_MS = 200;   // ignore ordinary jank; report real blocks
const MAX_REPORTS_PER_MIN = 10;    // hard cap on log volume

export function initLongTaskMonitor(): void {
  if (typeof PerformanceObserver === 'undefined') return;
  const supported = PerformanceObserver.supportedEntryTypes ?? [];
  if (!supported.includes('longtask')) return;

  let windowStart = Date.now();
  let reportsThisWindow = 0;
  // Aggregate what the cap suppressed so heavy storms still leave a trace.
  let suppressed = 0;
  let suppressedTotalMs = 0;

  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.duration < REPORT_THRESHOLD_MS) continue;

        const now = Date.now();
        if (now - windowStart > 60_000) {
          if (suppressed > 0) {
            console.warn('[perf] longtask (suppressed summary)', {
              count: suppressed, totalMs: Math.round(suppressedTotalMs),
            });
          }
          windowStart = now;
          reportsThisWindow = 0;
          suppressed = 0;
          suppressedTotalMs = 0;
        }
        if (reportsThisWindow >= MAX_REPORTS_PER_MIN) {
          suppressed++;
          suppressedTotalMs += entry.duration;
          continue;
        }
        reportsThisWindow++;

        // Attribution names the container (frame/script) that ran the task.
        const attr = (entry as PerformanceEntry & {
          attribution?: Array<{ name?: string; containerType?: string; containerName?: string; containerSrc?: string }>;
        }).attribution?.[0];
        console.warn('[perf] longtask', {
          durationMs: Math.round(entry.duration),
          startTime: Math.round(entry.startTime),
          name: entry.name,
          container: attr ? `${attr.containerType ?? ''}:${attr.containerName ?? attr.containerSrc ?? attr.name ?? ''}` : undefined,
          url: window.location.pathname,
        });
      }
    });
    observer.observe({ type: 'longtask', buffered: true });
  } catch {
    // Observer unsupported/blocked — monitoring is best-effort.
  }
}

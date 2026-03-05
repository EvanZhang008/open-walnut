/**
 * Lightweight performance logger — logs a waterfall table to browser console on page load.
 *
 * Usage in hooks:
 *   perf.mark('tasks:fetch-start');
 *   await fetchTasks();
 *   perf.mark('tasks:fetch-end');
 *   perf.measure('tasks:fetch', 'tasks:fetch-start', 'tasks:fetch-end');
 *
 * Or the shorthand:
 *   const end = perf.start('tasks:fetch');
 *   await fetchTasks();
 *   end();  // logs the measure
 *
 * On page load, call perf.summary() to print a console table.
 */

const ENABLE_PERF = typeof window !== 'undefined';
const t0 = ENABLE_PERF ? performance.now() : 0;

// Collected measures for the summary table
const measures: { name: string; start: number; duration: number; detail?: string }[] = [];

/** Place a Performance mark (no-op in SSR). */
function mark(name: string): void {
  if (!ENABLE_PERF) return;
  performance.mark(name);
}

/** Measure between two marks. */
function measure(label: string, startMark: string, endMark: string, detail?: string): number {
  if (!ENABLE_PERF) return 0;
  try {
    const m = performance.measure(label, startMark, endMark);
    measures.push({ name: label, start: Math.round(m.startTime - t0), duration: Math.round(m.duration), detail });
    return m.duration;
  } catch {
    return 0;
  }
}

/**
 * Shorthand: returns a function that completes the measure when called.
 *   const end = perf.start('tasks:fetch');
 *   ...
 *   end();            // completes with no extra info
 *   end('154 tasks'); // completes with detail string
 */
function start(label: string): (detail?: string) => number {
  if (!ENABLE_PERF) return () => 0;
  const startMark = `${label}:s`;
  performance.mark(startMark);
  return (detail?: string) => {
    const endMark = `${label}:e`;
    performance.mark(endMark);
    return measure(label, startMark, endMark, detail);
  };
}

/** Print a summary table to console, sorted by start time. */
function summary(): void {
  if (!ENABLE_PERF || measures.length === 0) return;
  const sorted = [...measures].sort((a, b) => a.start - b.start);

  // Visual waterfall
  const maxEnd = Math.max(...sorted.map(m => m.start + m.duration), 1);
  const barWidth = 40;

  console.group('%c⏱ Walnut Page Load Waterfall', 'font-weight:bold; color:#007AFF');
  console.log(`Total measures: ${sorted.length} | Page age: ${Math.round(performance.now() - t0)}ms`);
  console.log('');

  for (const m of sorted) {
    const barStart = Math.round((m.start / maxEnd) * barWidth);
    const barLen = Math.max(1, Math.round((m.duration / maxEnd) * barWidth));
    const bar = ' '.repeat(barStart) + '█'.repeat(barLen);
    const detail = m.detail ? ` (${m.detail})` : '';
    const color = m.duration > 200 ? 'color:red' : m.duration > 50 ? 'color:orange' : 'color:green';
    console.log(`%c${m.duration.toString().padStart(5)}ms%c  ${bar}  %c${m.name}${detail}`,
      color, 'color:gray', 'color:inherit');
  }

  console.log('');
  const totalBlocking = sorted.reduce((s, m) => s + m.duration, 0);
  console.log(`Sum of durations: ${Math.round(totalBlocking)}ms (overlapping calls counted separately)`);
  console.groupEnd();
}

/** Reset measures (useful for SPA navigation). */
function reset(): void {
  measures.length = 0;
}

export const perf = { mark, measure, start, summary, reset };

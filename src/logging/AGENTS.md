# Logging — Quick Reference

**Full implementation details: `.claude/skills/walnut-ops/SKILL.md`** (incident investigation
playbook, always-on sentinels, levels, redaction patterns, browser log persistence
architecture, investigation commands).

## Essentials

- `import { log } from '../logging/index.js'` → `log.<subsystem>.info('msg', { fields })`;
  child loggers via `log.agent.child('loop')`. `initLogging()` once at startup.
- All lines pass `redactSensitiveText()` before hitting disk (API keys, AWS creds, bearer
  tokens, PEM blocks, `password=`/`token=` values → `[REDACTED]`).
- Browser `console.log/warn/error` are persisted to the same disk log with
  `subsystem: 'browser'` (`console.debug` is NOT — never rely on it). Investigate frontend
  issues with `walnut logs -s browser` — the disk log survives page refresh.
- **A frozen event loop names its culprit** (`src/core/stall-recorder.ts`, on by default,
  `WALNUT_STALL_RECORDER=0` turns it off, `WALNUT_STALL_PROFILE=0` keeps only the counters).
  Every probe-late line of 1 s or more carries `hold`: the loop thread's own CPU against the hold
  (user and system), GC inside it (`gcMajorMs`: the part in full collections), faults, context
  switches, heap and RSS, load, and a `verdict` (`cpu`, `starved`, `gc`, `paging`, `off-cpu`).
  `cpu` is Walnut code holding the loop, also under machine load (`loadStretched: true` when load
  made the hold longer). The hold proper runs between two CPU checkpoints around the deadline
  (`holdFromMs`, `holdToMs`; checkpoints are the previous probe tick, a 100 ms timer, and the end
  of every loop iteration, at most every 5 ms): `holdCpuMs` is the thread's CPU in it,
  `afterHoldCpuMs` its CPU after it up to the probe, `loopIdleMs` the time the loop waited in poll
  inside it, `afterWaitMs` a pause it began right after and `afterHoldPauseMs` the pauses between
  its end and the probe (each a second or more the thread ran under a tenth of and under 250 ms
  in: more is a block load stretched, not a pause), and `baseCpuShare` the loop's rate in its
  normal turns over the 10 s before, or further back up to a minute when blocks and pauses filled
  them (`baseTurnMs` the largest of those turns). `holdVerdict`
  (`src/core/stall-recorder-hold.ts`) says `cpu` for 250 ms of CPU in the hold with code in the
  kept profile (`profileHold`: how much of the hold the sampler covered, the share with code on
  top as sampled, and the top frames), or 250 ms up to the probe, each past the backlog of the
  time the loop did not run its work (twice `baseCpuShare` times a pause, a wait in poll of a
  second or more or most of the hold, or a span the thread barely ran in; all of it when the rate
  is unknown; a span shorter than a stall also past `baseTurnMs`), or for 60% of the window. So no
  single field decides: a block that began behind the recorder's checkpoint shows in
  `afterHoldCpuMs`, with `profileAfter` (the profile's view of that part), and a stop's backlog
  can sit in either. `starved` means runnable but not run with little of its own to run (machine
  load), and then the profile only shows where the thread was parked. Cost on the loop thread, per
  second (2026-10-07 gate): idle +1.7 to 4.8 ms, a loop of 1 ms timers +3 to 10.6 ms, a loop
  reading a socket +7.7 to 19.6 ms. A rolling
  sampling CPU profile is kept only for a stall of 2 s or more, under
  `<log dir>/stall-profiles/` (newest 40, 3 days, 256 MB), and its
  `event-loop stall flight record` line adds the machine's paging counters, this process's
  compressed bytes and the kernel memory pressure level. Read them with
  `scripts/walnut-logs.sh stalls` and `node scripts/stall-profile-summary.mjs [file]`; never
  attach a profiler to production first.
  Windows rotate make-before-break (the next titled profile starts before the old one ends,
  `src/core/stall-recorder-profiler.ts`). Do not turn that back into `Profiler.stop` +
  `Profiler.start`: a start with no profile running walks the whole heap, measured 0.4 to 2 s
  on a 430 MB heap at load 300, which would make the recorder freeze the loop every window.
- **Memory pressure sheds background memory** (`src/core/memory-pressure.ts`): the kernel level
  (macOS `kern.memorystatus_vm_pressure_level`, Linux PSI) is read every 30 s off the loop, with
  two earlier signals that count as warn because the kernel level comes late
  (`src/core/memory-signals.ts`): the swap-out rate over 2 minutes and the compressor's share of
  RAM, each with an enter mark and a lower exit mark. At warn or critical the server releases the
  embedding model (about 2.2 GB of footprint per worker lane on the default model), holds the
  vector backfill and the changes prewarmer, and cuts the parsed history cache to a quarter,
  until every signal has read normal for the hold. The hold is 10 minutes, and doubles (20, 40,
  60) each time pressure comes back within 10 minutes of a clear, since reloading the model can be
  what brings it back; a later return starts again at 10. Log lines: `memory
  pressure: shedding background memory` and `memory pressure cleared`, both with `cause`
  (`kernel`, `swapout`, `compressor`, `forced`), `holdMs`, `compressorPct` and `swapoutMbPerMin`;
  stall flight records carry the same fields under `memoryPressure`.
  `WALNUT_MEMORY_PRESSURE_SHED=0` never sheds; `WALNUT_MEMORY_PRESSURE_EARLY=0` listens to the
  kernel alone; `WALNUT_MEMORY_PRESSURE_BACKOFF=0` keeps the hold at 10 minutes;
  `WALNUT_MEMORY_PRESSURE=warn` forces the level.

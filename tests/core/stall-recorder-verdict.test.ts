/**
 * The stall flight recorder's verdict (holdVerdict, src/core/stall-recorder-hold.ts)
 * on hold contexts measured by the probes and gates named in each case, and
 * the GC ring the `gc` rule reads. Each threshold the rules use is pinned by a
 * pair of cases on both sides of it.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { holdVerdict } from '../../src/core/stall-recorder.js'
import {
  gcWithin, pickHoldSpan, spanFields, startGcRing, stopGcRing, type CpuCheckpoint, type TickSample,
} from '../../src/core/stall-recorder-hold.js'

describe('holdVerdict', () => {
  const base = { lateByMs: 3_000, windowMs: 4_000, mainCpuMs: 0, gcMs: 0, majorFaults: 0, invCtxSwitches: 0 }
  it.each([
    ['cpu: the loop thread ran through the hold', { mainCpuMs: 3_800 }, 'cpu'],
    ['gc: most of the hold was collection', { mainCpuMs: 3_800, gcMs: 2_000 }, 'gc'],
    // A synchronous loop the machine also slowed is still code holding the loop:
    // the counters alone used to call these `starved`, read as "not Walnut code".
    ['cpu: a busy loop preempted a lot (measured shape, 1.6 s of 3.6 s, 10k switches)', { windowMs: 3_590, mainCpuMs: 1_592, invCtxSwitches: 10_110 }, 'cpu'],
    ['cpu: a measured hot loop at load 120 (1.35 s of 4.5 s, 6559 involuntary, 0 voluntary)', { lateByMs: 3_486, windowMs: 4_486, mainCpuMs: 1_353, procCpuMs: 1_355, invCtxSwitches: 6_559, volCtxSwitches: 0, gcMs: 76 }, 'cpu'],
    ['cpu: the profile shows code on the thread, which ran a stall\'s worth of it, although the counters look starved', { lateByMs: 3_000, windowMs: 4_000, mainCpuMs: 400, invCtxSwitches: 900, volCtxSwitches: 0, codeShare: 0.9, profileSamples: 120 }, 'cpu'],
    // Code on top all along, but 150 ms of CPU: a thread preempted inside a short
    // callback is sampled there for as long as the machine keeps it waiting.
    ['starved: code sampled on the thread, but it ran less than one stall threshold', { lateByMs: 3_000, windowMs: 4_000, mainCpuMs: 150, invCtxSwitches: 900, volCtxSwitches: 0, codeShare: 0.9, profileSamples: 120 }, 'starved'],
    ['starved: the profile shows the thread idle, so the counters stand', { lateByMs: 3_000, windowMs: 4_000, mainCpuMs: 400, invCtxSwitches: 900, volCtxSwitches: 0, codeShare: 0.05, profileSamples: 120 }, 'starved'],
    ['starved: too few samples to outrank the counters', { lateByMs: 3_000, windowMs: 4_000, mainCpuMs: 400, invCtxSwitches: 900, volCtxSwitches: 0, codeShare: 1, profileSamples: 2 }, 'starved'],
    // Two shapes a SIGSTOP probe reproduced. The first carries the code share it
    // read then (and still reads: the few samples it got were in code); its
    // thread CPU decides. The second carries the share it gets now that the
    // 3 s gap is not credited to the sample before it (it read 84%).
    ['starved: a process the machine starved (measured 48 ms of 5.4 s, 13 samples read 68% code)', { lateByMs: 4_409, windowMs: 5_409, mainCpuMs: 48, procCpuMs: 49, invCtxSwitches: 455, volCtxSwitches: 0, gcMs: 2, codeShare: 0.68, profileSamples: 13 }, 'starved'],
    ['starved: a 3 s SIGSTOP (measured 291 ms of 4.1 s) once the sampler\'s gap is not counted as code', { lateByMs: 3_126, windowMs: 4_126, mainCpuMs: 291, procCpuMs: 293, invCtxSwitches: 510, volCtxSwitches: 0, gcMs: 2, codeShare: 0.34, profileSamples: 53 }, 'starved'],
    // holdCpuMs is the thread's CPU since the loop last ran a timer before the
    // hold was due. For a stopped busy loop that is a few ms of catch-up, though
    // the window holds its usual work before the stop and the few samples around
    // the stop can be code (the loop catching up).
    ['starved: a busy loop stopped for 3 s, code on half of the few samples around the stop (measured 234 ms of 4.1 s)', { lateByMs: 3_117, windowMs: 4_117, mainCpuMs: 234, holdCpuMs: 0, invCtxSwitches: 500, volCtxSwitches: 0, gcMs: 2, codeShare: 0.5, profileSamples: 9 }, 'starved'],
    ['starved: the same 291 ms of window CPU with the 56% code share a rerun read, its work before the stop left out', { lateByMs: 3_126, windowMs: 4_126, mainCpuMs: 291, holdCpuMs: 0, invCtxSwitches: 510, volCtxSwitches: 0, gcMs: 2, codeShare: 0.56, profileSamples: 11 }, 'starved'],
    ['cpu: with no hold CPU given, the window CPU stands', { lateByMs: 3_126, windowMs: 4_126, mainCpuMs: 291, invCtxSwitches: 510, volCtxSwitches: 0, gcMs: 2, codeShare: 0.56, profileSamples: 11 }, 'cpu'],
    ['cpu: a loop busy before the hold still held it once its work before the hold is left out', { lateByMs: 3_486, windowMs: 4_486, mainCpuMs: 1_353, holdCpuMs: 1_053, procCpuMs: 1_355, invCtxSwitches: 6_559, volCtxSwitches: 0, gcMs: 76 }, 'cpu'],
    ['starved: a 1 s hold whose window CPU is the loop\'s work before it (no profile)', { lateByMs: 1_000, windowMs: 2_000, mainCpuMs: 320, holdCpuMs: 20, invCtxSwitches: 300, volCtxSwitches: 0 }, 'starved'],
    // Measured 2026-10-04 with the gate's probe (load 105 to 175). A real block
    // of 300 ms of thread CPU, stopped 50 ms in for 3 s, keeps all of its CPU
    // (313 ms); an earlier estimate left 7 ms of the same shape and called it starved.
    ['cpu: a real 300 ms block the machine stopped for 3 s, 50 ms in', { lateByMs: 3_699, windowMs: 4_699, mainCpuMs: 612, holdCpuMs: 313, procCpuMs: 614, invCtxSwitches: 4_049, volCtxSwitches: 0, gcMs: 3, codeShare: 0.72, profileSamples: 19 }, 'cpu'],
    ['starved: the same block as the earlier estimate measured it (7 ms of its own)', { lateByMs: 2_670, windowMs: 3_670, mainCpuMs: 365, holdCpuMs: 7, procCpuMs: 369, invCtxSwitches: 2_949, volCtxSwitches: 0, gcMs: 1, majorFaults: 1, codeShare: 0.88, profileSamples: 82 }, 'starved'],
    // The same shape measured 2026-10-05 at load 16, where the sampler the
    // machine starved left fewer than 5 samples in the hold: the hold's own CPU
    // names the block. A profile that sampled the hold and saw no code there
    // still wins, and without the hold's own CPU the window's (the loop's work
    // before the hold included) is not enough.
    ['cpu: a real 300 ms block stopped 50 ms in for 3 s, the hold not sampled', { lateByMs: 2_957, windowMs: 3_957, mainCpuMs: 459, holdCpuMs: 313, afterHoldCpuMs: 12, procCpuMs: 460, invCtxSwitches: 986, volCtxSwitches: 0, gcMs: 1, loopIdleMs: 3, holdFromMs: -568, holdToMs: 2_943, afterWaitMs: 0 }, 'cpu'],
    ['starved: the same CPU in a hold the profile sampled and saw no code in', { lateByMs: 2_957, windowMs: 3_957, mainCpuMs: 459, holdCpuMs: 313, afterHoldCpuMs: 12, procCpuMs: 460, invCtxSwitches: 986, volCtxSwitches: 0, gcMs: 1, loopIdleMs: 3, holdFromMs: -568, holdToMs: 2_943, afterWaitMs: 0, codeShare: 0.1, profileSamples: 20 }, 'starved'],
    ['starved: the same window, no hold CPU and no profile', { lateByMs: 2_957, windowMs: 3_957, mainCpuMs: 459, procCpuMs: 460, invCtxSwitches: 986, volCtxSwitches: 0, gcMs: 1 }, 'starved'],
    // A loop 80% busy in 1.3 s phases, stopped for 3 s: 637 ms in the window and
    // code on most samples, 1 ms since the last timer before the deadline. After
    // a quiet second, an earlier estimate subtracted nothing (484 of 487 ms) and
    // called it cpu.
    ['starved: a bursty loop stopped for 3 s right after a busy phase', { lateByMs: 2_958, windowMs: 3_958, mainCpuMs: 637, holdCpuMs: 1, procCpuMs: 640, invCtxSwitches: 860, volCtxSwitches: 0, gcMs: 4, codeShare: 0.82, profileSamples: 14 }, 'starved'],
    // A SIGSTOP in the middle of a scavenge: the GC entry lasts the whole stop.
    ['starved: a scavenge stopped for 3 s is not a collection that held the loop (14 ms of its own)', { lateByMs: 3_034, windowMs: 4_034, mainCpuMs: 252, holdCpuMs: 14, procCpuMs: 254, invCtxSwitches: 1_232, volCtxSwitches: 1, gcMs: 3_092, codeShare: 0.49, profileSamples: 13 }, 'starved'],
    // The hold itself ends at the first checkpoint after the deadline (the one
    // at the end of the loop iteration, after a stop). After a stop, the
    // timers that came due catch up before the probe; that is afterHoldCpuMs.
    // A stopped loop with 25 timers of 15 ms every 900 ms: counting the 375 ms
    // of catch-up as the hold's called 8 or 9 of 11 such stops cpu.
    ['starved: a stopped loop whose timers catch up after the stop, code on most samples', { lateByMs: 3_375, windowMs: 4_375, mainCpuMs: 790, holdCpuMs: 15, afterHoldCpuMs: 380, procCpuMs: 795, invCtxSwitches: 1_500, volCtxSwitches: 0, gcMs: 3, codeShare: 0.8, profileSamples: 20, loopIdleMs: 0, holdFromMs: -5, holdToMs: 3_010 }, 'starved'],
    // A stop while the loop waited in poll for work: whatever ran after it before
    // the recorder's timer (a list due just ahead of it, at the slow cadence) is
    // catch-up too, and the loop's idle time says it was waiting, not running.
    ['starved: a hold the loop spent waiting in poll, catch-up ahead of the recorder\'s timer', { lateByMs: 3_300, windowMs: 4_300, mainCpuMs: 700, holdCpuMs: 380, afterHoldCpuMs: 0, procCpuMs: 705, invCtxSwitches: 1_200, volCtxSwitches: 0, gcMs: 2, codeShare: 0.8, profileSamples: 20, loopIdleMs: 2_990, holdFromMs: -60, holdToMs: 3_390 }, 'starved'],
    // Right after such a wait the probe can run before the reads that piled up;
    // they then hold the next probe (measured with the gate's I/O backlog probe:
    // 273 ms of reads stretched to 3 s at load 58, code on all 21 samples).
    ['starved: a hold that begins with the backlog of a 3 s wait in poll', { lateByMs: 1_987, windowMs: 2_987, mainCpuMs: 274, holdCpuMs: 273, afterHoldCpuMs: 0, procCpuMs: 274, invCtxSwitches: 4_678, volCtxSwitches: 2, gcMs: 2, codeShare: 1, profileSamples: 21, loopIdleMs: 0, holdFromMs: -1_000, holdToMs: 1_987, afterWaitMs: 3_117 }, 'starved'],
    ['cpu: the same CPU and samples in a hold the loop spent running', { lateByMs: 3_300, windowMs: 4_300, mainCpuMs: 700, holdCpuMs: 380, afterHoldCpuMs: 0, procCpuMs: 705, invCtxSwitches: 1_200, volCtxSwitches: 0, gcMs: 2, codeShare: 0.8, profileSamples: 20, loopIdleMs: 10, holdFromMs: -60, holdToMs: 3_390 }, 'cpu'],
    // A block that starts after the deadline, behind the recorder's timer: the
    // hold proper is short, and the CPU up to the probe names the culprit.
    ['cpu: a 1.2 s block that began just after the deadline', { lateByMs: 1_210, windowMs: 2_210, mainCpuMs: 1_260, holdCpuMs: 4, afterHoldCpuMs: 1_200, procCpuMs: 1_262, invCtxSwitches: 40, volCtxSwitches: 0, gcMs: 0, holdFromMs: -10, holdToMs: 5 }, 'cpu'],
    ['cpu: a block that began 200 ms before the deadline, the loop running through the hold span', { lateByMs: 1_100, windowMs: 2_100, mainCpuMs: 1_250, holdCpuMs: 200, afterHoldCpuMs: 1_000, procCpuMs: 1_252, invCtxSwitches: 40, volCtxSwitches: 0, gcMs: 0, holdFromMs: -200, holdToMs: 100 }, 'cpu'],
    ['cpu: a hold context without its span, the CPU up to the probe stands', { lateByMs: 1_000, windowMs: 2_000, mainCpuMs: 450, holdCpuMs: 20, afterHoldCpuMs: 400, procCpuMs: 452, invCtxSwitches: 40, volCtxSwitches: 0, gcMs: 0 }, 'cpu'],
    // Measured 2026-10-05 by the gate (25 timers of 25 ms every 900 ms, stopped
    // 1.5 s, load 46): the recorder's timer ran right after the stop, and the
    // timers that came due in it ran after that. A long span the thread barely
    // ran in is a stop, not a block that began after the deadline.
    ['starved: a stop whose catch-up ran after the recorder\'s timer, a quarter of the hold', { lateByMs: 1_511, windowMs: 2_511, mainCpuMs: 594, holdCpuMs: 2, afterHoldCpuMs: 452, procCpuMs: 596, invCtxSwitches: 3_000, volCtxSwitches: 0, gcMs: 3, loopIdleMs: 0, holdFromMs: -761, holdToMs: 836, afterWaitMs: 0 }, 'starved'],
    // A full collection stopped 150 ms in: 194 ms on the loop thread, 793 ms on
    // the GC's helpers, read off-cpu once while the helpers did not count.
    ['gc: a full collection stopped 150 ms in, most of its CPU on the helper threads', { lateByMs: 3_310, windowMs: 4_310, mainCpuMs: 200, holdCpuMs: 194, afterHoldCpuMs: 2, procCpuMs: 987, invCtxSwitches: 300, volCtxSwitches: 2, gcMs: 3_280, holdFromMs: -20, holdToMs: 3_300 }, 'gc'],
    ['off-cpu: a busy worker thread is not a GC helper (a scavenge stopped for 3 s)', { lateByMs: 3_034, windowMs: 4_034, mainCpuMs: 30, holdCpuMs: 14, procCpuMs: 2_000, invCtxSwitches: 1_232, volCtxSwitches: 1, gcMs: 3_092 }, 'off-cpu'],
    // A full collection stopped for 3 s whose marking all ran on the helpers
    // (measured 2026-10-05, load 354: 6 ms on the loop thread, 966 ms on the
    // others). A scavenge with a short full collection beside it is not one.
    ['gc: a full collection stopped for 3 s, its marking all on the helpers', { lateByMs: 4_067, windowMs: 5_067, mainCpuMs: 6, holdCpuMs: 6, procCpuMs: 972, invCtxSwitches: 6_035, volCtxSwitches: 0, gcMs: 4_989, gcMajorMs: 4_989 }, 'gc'],
    ['off-cpu: a scavenge stopped for 3 s beside a short full collection, a busy worker thread', { lateByMs: 3_034, windowMs: 4_034, mainCpuMs: 30, holdCpuMs: 14, procCpuMs: 2_000, invCtxSwitches: 1_232, volCtxSwitches: 1, gcMs: 3_132, gcMajorMs: 40 }, 'off-cpu'],
    ['paging: barely ran, many hard faults', { mainCpuMs: 200, majorFaults: 500 }, 'paging'],
    ['off-cpu: barely ran, no faults, few switches (a blocking call)', { mainCpuMs: 20, invCtxSwitches: 3 }, 'off-cpu'],
    ['starved at 5% share: preempted, never waited (measured task-list shape, 110 ms CPU, 700 involuntary, 1 voluntary)', { lateByMs: 1_200, windowMs: 2_200, mainCpuMs: 110, invCtxSwitches: 700, volCtxSwitches: 1 }, 'starved'],
    ['off-cpu at 5% share: it waited on its own (voluntary switches dominate)', { mainCpuMs: 200, invCtxSwitches: 300, volCtxSwitches: 400 }, 'off-cpu'],
    ['starved at 0% share: runnable, never scheduled (measured isolated 7.5 s freeze: 5 ms CPU in 8.5 s, 148 involuntary, 1 voluntary)', { lateByMs: 7_483, windowMs: 8_483, mainCpuMs: 5, procCpuMs: 6, invCtxSwitches: 148, volCtxSwitches: 1 }, 'starved'],
    ['off-cpu: the switches belong to a busy worker thread, not the waiting loop', { mainCpuMs: 20, procCpuMs: 3_000, invCtxSwitches: 400, volCtxSwitches: 2 }, 'off-cpu'],
    // A pause right before the hold leaves a backlog, and only the CPU past it
    // counts: twice the loop's normal rate (baseCpuShare) times the pause.
    // Measured 2026-10-07 by the gate (a light loop, 4% busy, stopped 3 s): a
    // 1.5 s block right after the stop, code on all 32 samples, read `starved`
    // while any pause before the hold ruled its CPU out.
    ['cpu: a 1.5 s block right after a 3 s stop, past the backlog of a loop 5% busy', { lateByMs: 2_771, windowMs: 3_771, mainCpuMs: 1_502, holdCpuMs: 1_500, afterHoldCpuMs: 1, procCpuMs: 1_504, invCtxSwitches: 2_500, volCtxSwitches: 0, gcMs: 7, loopIdleMs: 0, holdFromMs: -962, holdToMs: 2_770, afterWaitMs: 3_236, baseCpuShare: 0.05, codeShare: 1, profileSamples: 32 }, 'cpu'],
    ['starved: the same block when the loop\'s rate before the stop is unknown', { lateByMs: 2_771, windowMs: 3_771, mainCpuMs: 1_502, holdCpuMs: 1_500, afterHoldCpuMs: 1, procCpuMs: 1_504, invCtxSwitches: 2_500, volCtxSwitches: 0, gcMs: 7, loopIdleMs: 0, holdFromMs: -962, holdToMs: 2_770, afterWaitMs: 3_236, codeShare: 1, profileSamples: 32 }, 'starved'],
    // The backlog of a 3 s pause at a 10% rate is 0.6 s: 860 ms of code past a
    // stall's worth of it, 840 ms not (the factor of two, pinned both ways).
    ['cpu: 860 ms of code after a 3 s pause of a loop 10% busy', { lateByMs: 1_900, windowMs: 2_900, mainCpuMs: 862, holdCpuMs: 860, afterHoldCpuMs: 0, procCpuMs: 864, invCtxSwitches: 2_000, volCtxSwitches: 0, loopIdleMs: 0, holdFromMs: -1_000, holdToMs: 1_900, afterWaitMs: 3_000, baseCpuShare: 0.1, codeShare: 1, profileSamples: 40 }, 'cpu'],
    ['starved: 840 ms of code after the same pause', { lateByMs: 1_900, windowMs: 2_900, mainCpuMs: 842, holdCpuMs: 840, afterHoldCpuMs: 0, procCpuMs: 844, invCtxSwitches: 2_000, volCtxSwitches: 0, loopIdleMs: 0, holdFromMs: -1_000, holdToMs: 1_900, afterWaitMs: 3_000, baseCpuShare: 0.1, codeShare: 1, profileSamples: 40 }, 'starved'],
    // The gate's I/O backlog probe (a peer writing to a socket all through a 3
    // s stop outside poll): the reads that piled up ran right after the previous
    // probe and held this one, code on every sample, and read `cpu` while only a
    // wait in poll counted as a pause.
    ['starved: 610 ms of reads piled up in a 3 s stop outside poll, the loop 20% busy before it', { lateByMs: 1_504, windowMs: 2_504, mainCpuMs: 610, holdCpuMs: 610, afterHoldCpuMs: 0, procCpuMs: 612, invCtxSwitches: 3_000, volCtxSwitches: 2, loopIdleMs: 0, holdFromMs: -1_000, holdToMs: 1_504, afterWaitMs: 2_330, baseCpuShare: 0.2, codeShare: 1, profileSamples: 32 }, 'starved'],
    // A wait in poll of a second or more inside the hold owes its backlog too,
    // however long load stretched what came after it. Measured 2026-10-07 by
    // the gate's I/O backlog probe at load 322: a 3 s stop in poll, then 415 ms
    // of the reads it queued over 5.5 s, read `cpu` while only a wait that was
    // most of the hold counted.
    ['starved: 415 ms of reads a 3 s wait in poll queued, stretched to 5.5 s', { lateByMs: 8_522, windowMs: 9_522, mainCpuMs: 450, holdCpuMs: 415, afterHoldCpuMs: 0, procCpuMs: 457, invCtxSwitches: 3_000, volCtxSwitches: 0, loopIdleMs: 3_031, holdFromMs: -479, holdToMs: 8_522, afterWaitMs: 0, baseCpuShare: 0.083, baseTurnMs: 51, codeShare: 0.98, profileSamples: 74 }, 'starved'],
    ['cpu: a 1.5 s block after the same wait', { lateByMs: 8_522, windowMs: 9_522, mainCpuMs: 1_535, holdCpuMs: 1_500, afterHoldCpuMs: 0, procCpuMs: 1_540, invCtxSwitches: 3_000, volCtxSwitches: 0, loopIdleMs: 3_031, holdFromMs: -479, holdToMs: 8_522, afterWaitMs: 0, baseCpuShare: 0.083, baseTurnMs: 51, codeShare: 0.98, profileSamples: 74 }, 'cpu'],
    // A second of waiting, both ways (a loop 50% busy, 1.2 s of code in a 5 s span).
    ['cpu: 1.2 s of code after 990 ms in poll', { lateByMs: 5_000, windowMs: 6_000, mainCpuMs: 1_250, holdCpuMs: 1_200, afterHoldCpuMs: 0, procCpuMs: 1_252, invCtxSwitches: 3_000, volCtxSwitches: 0, loopIdleMs: 990, holdFromMs: -10, holdToMs: 4_990, afterWaitMs: 0, baseCpuShare: 0.5, baseTurnMs: 20, codeShare: 1, profileSamples: 60 }, 'cpu'],
    ['starved: 1.2 s of code after 1010 ms in poll (its backlog is 1010 ms)', { lateByMs: 5_000, windowMs: 6_000, mainCpuMs: 1_250, holdCpuMs: 1_200, afterHoldCpuMs: 0, procCpuMs: 1_252, invCtxSwitches: 3_000, volCtxSwitches: 0, loopIdleMs: 1_010, holdFromMs: -10, holdToMs: 4_990, afterWaitMs: 0, baseCpuShare: 0.5, baseTurnMs: 20, codeShare: 1, profileSamples: 60 }, 'starved'],
    // The same backlog where the thread ran most of the span (no code sampled):
    // 1.6 s in a 3 s span after 1.2 s in poll, a loop 40% or 60% busy.
    ['cpu: 1.6 s after 1.2 s in poll, past the backlog of a loop 40% busy', { lateByMs: 3_000, windowMs: 4_000, mainCpuMs: 1_610, holdCpuMs: 1_600, afterHoldCpuMs: 0, procCpuMs: 1_612, invCtxSwitches: 3_000, volCtxSwitches: 0, loopIdleMs: 1_200, holdFromMs: -10, holdToMs: 2_990, afterWaitMs: 0, baseCpuShare: 0.4, baseTurnMs: 20, codeShare: 0.2, profileSamples: 30 }, 'cpu'],
    ['starved: the same, within the backlog of a loop 60% busy', { lateByMs: 3_000, windowMs: 4_000, mainCpuMs: 1_610, holdCpuMs: 1_600, afterHoldCpuMs: 0, procCpuMs: 1_612, invCtxSwitches: 3_000, volCtxSwitches: 0, loopIdleMs: 1_200, holdFromMs: -10, holdToMs: 2_990, afterWaitMs: 0, baseCpuShare: 0.6, baseTurnMs: 20, codeShare: 0.2, profileSamples: 30 }, 'starved'],
    // The block ran after the recorder's checkpoint at the end of the stop's
    // iteration (a timer that came due in the stop), so the hold's span is the
    // stop and the block is the part after it: past the stop's backlog, it counts.
    ['cpu: a 1.5 s block that came due in a 3 s stop and ran after the recorder\'s checkpoint', { lateByMs: 7_587, windowMs: 8_587, mainCpuMs: 1_516, holdCpuMs: 0, afterHoldCpuMs: 1_502, procCpuMs: 1_519, invCtxSwitches: 6_000, volCtxSwitches: 0, loopIdleMs: 3_139, holdFromMs: -600, holdToMs: 2_540, afterWaitMs: 0, baseCpuShare: 0.05 }, 'cpu'],
    ['starved: the catch-up of the same stop when it is the loop\'s own backlog (a loop 30% busy, 400 ms)', { lateByMs: 3_400, windowMs: 4_400, mainCpuMs: 420, holdCpuMs: 0, afterHoldCpuMs: 400, procCpuMs: 422, invCtxSwitches: 3_000, volCtxSwitches: 0, loopIdleMs: 3_139, holdFromMs: -600, holdToMs: 2_540, afterWaitMs: 0, baseCpuShare: 0.3 }, 'starved'],
    // A block that began behind the recorder's checkpoint right after the
    // deadline, and was stopped: however long the stop, the CPU up to the probe
    // is the block's (2026-10-07 gate: with a quarter of the hold also required,
    // a 460 ms block stopped for 3 s at load 137 read `starved`).
    ['cpu: a 460 ms block that began right after the deadline, stopped for 5 s', { lateByMs: 6_340, windowMs: 7_340, mainCpuMs: 700, holdCpuMs: 10, afterHoldCpuMs: 450, procCpuMs: 702, invCtxSwitches: 4_000, volCtxSwitches: 0, gcMs: 2, loopIdleMs: 1, holdFromMs: -1, holdToMs: 100, afterWaitMs: 0, baseCpuShare: 0.45, baseTurnMs: 30 }, 'cpu'],
    ['starved: the same block when the loop\'s turns are unknown (a quarter of the hold is required then)', { lateByMs: 6_340, windowMs: 7_340, mainCpuMs: 700, holdCpuMs: 10, afterHoldCpuMs: 450, procCpuMs: 702, invCtxSwitches: 4_000, volCtxSwitches: 0, gcMs: 2, loopIdleMs: 1, holdFromMs: -1, holdToMs: 100, afterWaitMs: 0 }, 'starved'],
    ['starved: the same short span right after a 3 s pause of a loop 45% busy (its backlog)', { lateByMs: 1_460, windowMs: 2_460, mainCpuMs: 470, holdCpuMs: 10, afterHoldCpuMs: 450, procCpuMs: 472, invCtxSwitches: 2_000, volCtxSwitches: 0, gcMs: 2, loopIdleMs: 1, holdFromMs: -1, holdToMs: 100, afterWaitMs: 3_000, baseCpuShare: 0.45, baseTurnMs: 30 }, 'starved'],
    // What ran behind that checkpoint was due before the deadline, and the
    // loop's own work due then is one of its turns: the gate's 25 timers of
    // 25 ms every 900 ms, stopped 1.5 s right after the checkpoint (measured
    // 2026-10-07, load 161): 278 ms up to the probe read `cpu` past no turn.
    // The same shape's largest turns measured 89 to 247 ms (load 226 to 326).
    ['starved: a stopped burst of the loop\'s own timers that came due just before the deadline', { lateByMs: 2_751, windowMs: 3_751, mainCpuMs: 414, holdCpuMs: 33, afterHoldCpuMs: 245, procCpuMs: 418, invCtxSwitches: 3_000, volCtxSwitches: 0, gcMs: 15, loopIdleMs: 1, holdFromMs: -180, holdToMs: 30, afterWaitMs: 0, baseCpuShare: 0.153, baseTurnMs: 89 }, 'starved'],
    // A stall's worth past the largest turn, both ways (a turn of 100 ms).
    ['cpu: 355 ms behind the checkpoint, past a 100 ms turn', { lateByMs: 3_000, windowMs: 4_000, mainCpuMs: 400, holdCpuMs: 5, afterHoldCpuMs: 350, procCpuMs: 402, invCtxSwitches: 2_000, volCtxSwitches: 0, loopIdleMs: 0, holdFromMs: -5, holdToMs: 5, afterWaitMs: 0, baseCpuShare: 0.3, baseTurnMs: 100 }, 'cpu'],
    ['starved: 345 ms behind the checkpoint, past a 100 ms turn', { lateByMs: 3_000, windowMs: 4_000, mainCpuMs: 400, holdCpuMs: 5, afterHoldCpuMs: 340, procCpuMs: 402, invCtxSwitches: 2_000, volCtxSwitches: 0, loopIdleMs: 0, holdFromMs: -5, holdToMs: 5, afterWaitMs: 0, baseCpuShare: 0.3, baseTurnMs: 100 }, 'starved'],
    // A pause the loop came back from behind that checkpoint owes its backlog
    // too. Measured 2026-10-09 at load 473 (25 timers of 18 ms every 900 ms,
    // stopped 2 s): an 18 ms span, then 368 ms of the timers that came due in
    // the stop, ahead of the probe, read `cpu` past the 123 ms turn.
    ['starved: the timers a 2 s stop behind the checkpoint left, ahead of the probe', { lateByMs: 2_566, windowMs: 3_566, mainCpuMs: 789, holdCpuMs: 18, afterHoldCpuMs: 368, procCpuMs: 793, invCtxSwitches: 1_940, volCtxSwitches: 0, gcMs: 3, loopIdleMs: 0, holdFromMs: -3, holdToMs: 15, afterWaitMs: 0, afterHoldPauseMs: 2_000, baseCpuShare: 0.376, baseTurnMs: 123 }, 'starved'],
    ['cpu: the same CPU behind the checkpoint with no pause after it', { lateByMs: 2_566, windowMs: 3_566, mainCpuMs: 789, holdCpuMs: 18, afterHoldCpuMs: 368, procCpuMs: 793, invCtxSwitches: 1_940, volCtxSwitches: 0, gcMs: 3, loopIdleMs: 0, holdFromMs: -3, holdToMs: 15, afterWaitMs: 0, afterHoldPauseMs: 0, baseCpuShare: 0.376, baseTurnMs: 123 }, 'cpu'],
    // Past that backlog and the largest turn, both ways (a 3 s pause of a loop
    // 10% busy, a 50 ms turn: 900 ms).
    ['cpu: 905 ms after a 3 s pause behind the checkpoint', { lateByMs: 4_000, windowMs: 5_000, mainCpuMs: 910, holdCpuMs: 5, afterHoldCpuMs: 900, procCpuMs: 912, invCtxSwitches: 3_000, volCtxSwitches: 0, loopIdleMs: 0, holdFromMs: -5, holdToMs: 5, afterWaitMs: 0, afterHoldPauseMs: 3_000, baseCpuShare: 0.1, baseTurnMs: 50 }, 'cpu'],
    ['starved: 895 ms after the same pause', { lateByMs: 4_000, windowMs: 5_000, mainCpuMs: 900, holdCpuMs: 5, afterHoldCpuMs: 890, procCpuMs: 902, invCtxSwitches: 3_000, volCtxSwitches: 0, loopIdleMs: 0, holdFromMs: -5, holdToMs: 5, afterWaitMs: 0, afterHoldPauseMs: 3_000, baseCpuShare: 0.1, baseTurnMs: 50 }, 'starved'],
    // Without the loop's rate nothing counts after such a pause (the 1.2 s block
    // above, had a 1.5 s pause come before it).
    ['starved: a 1.2 s block behind the checkpoint after a 1.5 s pause, the loop\'s rate unknown', { lateByMs: 2_710, windowMs: 3_710, mainCpuMs: 1_260, holdCpuMs: 4, afterHoldCpuMs: 1_200, procCpuMs: 1_262, invCtxSwitches: 40, volCtxSwitches: 0, gcMs: 0, holdFromMs: -10, holdToMs: 5, afterHoldPauseMs: 1_500 }, 'starved'],
    // The other branches of rule 3 count such a pause too: a span the thread ran
    // half of (the 51% case below, after a 1.5 s pause), and a stop's span (the
    // 1.5 s block's shape at 700 ms, after a 2 s pause).
    ['starved: the thread ran 51% of a 1 s span, then 400 ms more after a 1.5 s pause', { lateByMs: 3_100, windowMs: 4_100, mainCpuMs: 950, holdCpuMs: 510, afterHoldCpuMs: 400, procCpuMs: 952, invCtxSwitches: 3_000, volCtxSwitches: 0, loopIdleMs: 0, holdFromMs: -500, holdToMs: 500, afterWaitMs: 0, afterHoldPauseMs: 1_500, baseCpuShare: 0.3, codeShare: 0.2, profileSamples: 30 }, 'starved'],
    ['cpu: 700 ms that came due in a 3 s stop and ran after the recorder\'s checkpoint', { lateByMs: 7_587, windowMs: 8_587, mainCpuMs: 716, holdCpuMs: 0, afterHoldCpuMs: 700, procCpuMs: 719, invCtxSwitches: 6_000, volCtxSwitches: 0, loopIdleMs: 3_139, holdFromMs: -600, holdToMs: 2_540, afterWaitMs: 0, baseCpuShare: 0.05 }, 'cpu'],
    // Measured 2026-10-09 by the probe (edge-u, load 99): a real 400 ms block
    // that came due after the hold's span, stretched to 15 s, past the backlog
    // of the pause before the hold and the span (afterHoldPauseMs 0 once the
    // block's own gap is not a pause; it read 17122 and `starved`).
    ['cpu: a 400 ms block behind a 2 s span after a 2.4 s pause, a loop 1.7% busy', { lateByMs: 18_320, windowMs: 19_320, mainCpuMs: 414, holdCpuMs: 0, afterHoldCpuMs: 414, procCpuMs: 421, invCtxSwitches: 5_406, volCtxSwitches: 0, gcMs: 4, loopIdleMs: 0, holdFromMs: -1_000, holdToMs: 1_031, afterWaitMs: 2_404, afterHoldPauseMs: 0, baseCpuShare: 0.017, baseTurnMs: 15, codeShare: 1, profileSamples: 13 }, 'cpu'],
    ['starved: the same right after a 2 s pause before the hold', { lateByMs: 7_587, windowMs: 8_587, mainCpuMs: 716, holdCpuMs: 0, afterHoldCpuMs: 700, procCpuMs: 719, invCtxSwitches: 6_000, volCtxSwitches: 0, loopIdleMs: 3_139, holdFromMs: -600, holdToMs: 2_540, afterWaitMs: 2_000, baseCpuShare: 0.05 }, 'starved'],
    ['starved: the same after a 2 s pause behind it', { lateByMs: 7_587, windowMs: 8_587, mainCpuMs: 716, holdCpuMs: 0, afterHoldCpuMs: 700, procCpuMs: 719, invCtxSwitches: 6_000, volCtxSwitches: 0, loopIdleMs: 3_139, holdFromMs: -600, holdToMs: 2_540, afterWaitMs: 0, afterHoldPauseMs: 2_000, baseCpuShare: 0.05 }, 'starved'],
    // Only a span shorter than a stall is spared the span's backlog: 600 ms the
    // thread barely ran in, then 400 ms of a 40% loop's catch-up.
    ['starved: a 600 ms span the thread barely ran in, then 400 ms of a 40% loop\'s catch-up', { lateByMs: 1_200, windowMs: 2_200, mainCpuMs: 600, holdCpuMs: 10, afterHoldCpuMs: 400, procCpuMs: 602, invCtxSwitches: 2_000, volCtxSwitches: 0, loopIdleMs: 0, holdFromMs: -300, holdToMs: 300, afterWaitMs: 0, baseCpuShare: 0.4 }, 'starved'],
    // Rule 3's split: the thread ran half of the span (a block began in it, and
    // the CPU up to the probe counts), or less (only what ran after the span,
    // past the span's backlog). 510 and 490 ms of a 1 s span.
    ['cpu: the thread ran 51% of a 1 s span, then 400 ms more', { lateByMs: 1_600, windowMs: 2_600, mainCpuMs: 950, holdCpuMs: 510, afterHoldCpuMs: 400, procCpuMs: 952, invCtxSwitches: 3_000, volCtxSwitches: 0, loopIdleMs: 0, holdFromMs: -500, holdToMs: 500, afterWaitMs: 0, baseCpuShare: 0.3, codeShare: 0.2, profileSamples: 30 }, 'cpu'],
    ['starved: the thread ran 49% of the same span, then 400 ms more (less than its backlog allows)', { lateByMs: 1_600, windowMs: 2_600, mainCpuMs: 950, holdCpuMs: 490, afterHoldCpuMs: 400, procCpuMs: 952, invCtxSwitches: 3_000, volCtxSwitches: 0, loopIdleMs: 0, holdFromMs: -500, holdToMs: 500, afterWaitMs: 0, baseCpuShare: 0.3, codeShare: 0.2, profileSamples: 30 }, 'starved'],
    // And a quarter of the hold: 310 ms in a 600 ms span of a 2 s hold, the
    // profile seeing no code there, is not one.
    ['starved: the thread ran 52% of a 600 ms span of a 2 s hold, the profile seeing no code', { lateByMs: 2_000, windowMs: 3_000, mainCpuMs: 320, holdCpuMs: 310, afterHoldCpuMs: 5, procCpuMs: 322, invCtxSwitches: 2_000, volCtxSwitches: 0, loopIdleMs: 0, holdFromMs: -300, holdToMs: 300, afterWaitMs: 0, baseCpuShare: 0.3, codeShare: 0.2, profileSamples: 30 }, 'starved'],
    // A wait in poll under a second owes its backlog when it was half the span or
    // more: 600 ms of code in a 1.6 s span after 850 or 790 ms in poll (a loop 30% busy).
    ['starved: 600 ms of code in a 1.6 s span after 850 ms in poll', { lateByMs: 1_590, windowMs: 2_600, mainCpuMs: 610, holdCpuMs: 600, afterHoldCpuMs: 0, procCpuMs: 612, invCtxSwitches: 2_000, volCtxSwitches: 0, loopIdleMs: 850, holdFromMs: -10, holdToMs: 1_590, afterWaitMs: 0, baseCpuShare: 0.3, baseTurnMs: 20, codeShare: 1, profileSamples: 40 }, 'starved'],
    ['cpu: the same after 790 ms in poll', { lateByMs: 1_590, windowMs: 2_600, mainCpuMs: 610, holdCpuMs: 600, afterHoldCpuMs: 0, procCpuMs: 612, invCtxSwitches: 2_000, volCtxSwitches: 0, loopIdleMs: 790, holdFromMs: -10, holdToMs: 1_590, afterWaitMs: 0, baseCpuShare: 0.3, baseTurnMs: 20, codeShare: 1, profileSamples: 40 }, 'cpu'],
    // Rule 2, alone: the thread ran 61% or 59% of the window, its work before
    // the hold, while neither the hold nor the part after it shows code.
    ['cpu: the thread ran 61% of the window', { lateByMs: 3_000, windowMs: 4_000, mainCpuMs: 2_440, holdCpuMs: 100, afterHoldCpuMs: 0, procCpuMs: 2_442, invCtxSwitches: 3_000, volCtxSwitches: 0, loopIdleMs: 0, holdFromMs: -10, holdToMs: 2_990, afterWaitMs: 0, baseCpuShare: 0.3, codeShare: 0.1, profileSamples: 40 }, 'cpu'],
    ['starved: the thread ran 59% of the window', { lateByMs: 3_000, windowMs: 4_000, mainCpuMs: 2_360, holdCpuMs: 100, afterHoldCpuMs: 0, procCpuMs: 2_362, invCtxSwitches: 3_000, volCtxSwitches: 0, loopIdleMs: 0, holdFromMs: -10, holdToMs: 2_990, afterWaitMs: 0, baseCpuShare: 0.3, codeShare: 0.1, profileSamples: 40 }, 'starved'],
  ])('%s', (_name, over, verdict) => {
    expect(holdVerdict({ ...base, ...over })).toBe(verdict)
  })
})

describe('a hold read from its checkpoints (pickHoldSpan, spanFields, holdVerdict)', () => {
  const tick = (mono: number, cpuMs: number): TickSample => ({
    mono, threadUserUs: cpuMs * 1000, threadSysUs: 0, procUserUs: cpuMs * 1000, procSysUs: 0, majflt: 0, minflt: 0, nivcsw: 0, nvcsw: 0, idleMs: 0,
  })
  const cp = (mono: number, cpuMs: number): CpuCheckpoint => ({ mono, cpuUs: cpuMs * 1000, idleMs: 0 })
  /** A loop 5% busy up to 500 ms, then `before` ms of CPU without a checkpoint
   *  for `beforeMs`, the probe, and a real 1.5 s block stretched to 10 s by load
   *  (the r9 gate's W2): the verdict for that block, read as captureHold reads it. */
  function secondBlock(before: number, beforeMs: number, profile: boolean): string {
    const cps: CpuCheckpoint[] = []
    for (let t = -15_000; t <= 500; t += 100) cps.push(cp(t, (t + 15_000) * 0.05))
    const probe = 500 + beforeMs
    const cpu = 15_500 * 0.05 + before
    const prev = tick(probe, cpu)
    cps.push(cp(probe + 1, cpu + 0.1), cp(probe + 10_002, cpu + 1_500.2))
    const monoNow = probe + 10_003
    const lateByMs = monoNow - probe - 1_000
    const now = tick(monoNow, cpu + 1_500.3)
    const fields = spanFields(prev, now, lateByMs, monoNow, pickHoldSpan(prev, cps, monoNow - lateByMs, monoNow))
    expect(fields.holdCpuMs).toBe(1_500)
    return holdVerdict({
      lateByMs, ...fields, procCpuMs: fields.mainCpuMs + 2, gcMs: 0, majorFaults: 0, invCtxSwitches: 4_000, volCtxSwitches: 0,
      ...(profile ? { codeShare: 1, profileSamples: 40 } : {}),
    })
  }

  it('a real block right after a block load stretched to 7.5% of a core is code, not the machine', () => {
    // r9 counted the first block as a pause (under a tenth of its 20 s) and had
    // the second owe 2 s of backlog: `starved`, while main read `cpu`.
    expect(secondBlock(1_500, 20_000, true)).toBe('cpu')
    expect(secondBlock(1_500, 20_000, false)).toBe('cpu')
    // At 12% of a core the first block was never a pause.
    expect(secondBlock(1_500, 12_500, true)).toBe('cpu')
  })

  it('a real stop before it still owes its backlog: under a stall\'s worth in 20 s', () => {
    expect(secondBlock(249, 20_000, true)).not.toBe('cpu')
    expect(secondBlock(249, 20_000, false)).not.toBe('cpu')
  })
})

describe('gcWithin', () => {
  afterEach(() => stopGcRing())

  it('keeps the time in full collections apart (gcMajorMs), which the gc rule weighs', async () => {
    startGcRing()
    const v8 = await import('node:v8')
    const vm = await import('node:vm')
    v8.setFlagsFromString('--expose-gc')
    const gc = vm.runInNewContext('gc') as () => void
    // A live heap a full collection takes a few ms to mark.
    const keep = Array.from({ length: 400_000 }, (_, i) => ({ i, s: `marina-${i}` }))
    const from = performance.now()
    gc()
    const end = Date.now() + 5_000
    let g = gcWithin(from, performance.now())
    while (g.major < 1 && Date.now() < end) {
      await new Promise((r) => setTimeout(r, 20))
      g = gcWithin(from, performance.now())
    }
    expect(keep.length).toBe(400_000)
    expect(g.major).toBeGreaterThanOrEqual(1)
    expect(g.majorMs).toBeGreaterThan(0)
    expect(g.majorMs).toBeLessThanOrEqual(g.ms)
  })
})

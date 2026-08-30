import Foundation
import UIKit

/// Attention windows: PURE. Opening, closing and floor/ceiling rules live here
/// so they are unit-testable with an explicit clock and no simulator.
enum AttentionWindowMachine {
    /// A window shorter than this is screen churn (a tab passed through on the
    /// way somewhere else), not attention.
    static let minSampleMs = 1_000
    /// A single sample never claims more than this. The server clamps at exactly
    /// 10 minutes (`MAX_SAMPLE_MS`), and a clamp that happens server-side is a
    /// silent one — so the ceiling is applied here, where it can be logged.
    /// Only reachable if the flush timer never fired (a stopped clock, a wall
    /// clock jumping forward); a normal window closes at the 60s flush.
    static let maxSampleMs = 10 * 60 * 1_000

    /// An open window: what the user is looking at, and since when.
    struct Window: Equatable {
        var target: AttentionTarget
        var startedAt: Date
    }

    /// Close `window` at `endingAt` and return what it earned.
    ///
    /// Nil for a sub-floor window and for a backwards clock (a negative duration
    /// is not attention, it is a clock change) — dropping is right in both cases,
    /// because the alternative is banking a fabricated interval.
    ///
    /// WALL-CLOCK ASSUMPTION: both instants come from `Date`, not from a monotonic
    /// clock, because the sample's `ts` must be wall time for the server to date it
    /// to a local day. The cost is bounded and paid on purpose: a clock correction
    /// (NTP, a manual date change, a device waking with a dead battery clock)
    /// jumping BACKWARDS makes the open window measure negative and it is dropped,
    /// losing at most the seconds since the last flush boundary; jumping FORWARD
    /// inflates it, which the 10-minute ceiling caps. Measuring the duration
    /// monotonically and stamping `ts` from the wall clock would drift the two
    /// apart, and the day a sample lands on matters more than a few seconds of it.
    static func bank(_ window: Window, endingAt: Date) -> AttentionSample? {
        let rawMs = (endingAt.timeIntervalSince(window.startedAt) * 1000).rounded()
        guard rawMs >= Double(minSampleMs) else { return nil }
        let durationMs = Int(min(rawMs, Double(maxSampleMs)))
        return AttentionSample(
            startMs: Int64((window.startedAt.timeIntervalSince1970 * 1000).rounded()),
            durationMs: durationMs,
            kind: window.target.kind,
            taskId: window.target.taskId,
            sessionId: window.target.sessionId
        )
    }
}

/// Reports the user's in-app attention time to the server so phone usage lands
/// in the SAME per-day per-task buckets the web console shows.
///
/// The model, and how it differs from the browser's:
///
///  - The console uses a LEASE: only a real interaction (pointerdown/keydown/
///    wheel) earns runway, because a browser tab can sit open on a second
///    monitor for hours with nobody looking at it. A phone cannot: the screen
///    locks, and locking backgrounds the app. So here PRESENCE is the signal —
///    the clock runs while `scenePhase == .active` and stops the instant it is
///    not. That keeps the counting honest without an interaction listener on
///    every screen (which is also the thing most likely to cause a render storm).
///  - Windows close on a context switch (`AttentionContext`) and at each flush,
///    so granularity is 1-60s. A switch banks the outgoing context up to the
///    switch instant, so no interval is ever counted twice.
///
/// Durability: a closed window is written to disk BEFORE any network attempt
/// (`TimeSampleStore`), so nothing is lost to a failed POST, a killed process, or
/// a phone that is offline for a day. `ts` is the START of the window and the
/// server assigns the local day from it, so late delivery still lands on the
/// right day.
///
/// Battery: no timer exists while backgrounded, the flush timer carries a wide
/// tolerance (this is telemetry, not worth waking a sleeping run loop for), and
/// nothing but the cheap window bookkeeping happens on the main thread — the
/// queue is an actor and the POST is a detached task.
@MainActor
final class TimeHeartbeatReporter: LifecycleSuspendable {
    static let shared = TimeHeartbeatReporter()

    /// How often an active app ships what it has earned.
    static let flushInterval: TimeInterval = 60
    /// Backoff ladder for a retryable flush failure, in seconds. Deliberately
    /// slow: nothing is lost by waiting, and this must never look like polling.
    static let retryDelays: [TimeInterval] = [30, 60, 120, 300]

    private let store: TimeSampleStore
    private let injectedSender: TimeSampleStore.Sender?
    private let clock: () -> Date
    private let api = WalnutAPI()

    private var window: AttentionWindowMachine.Window?
    private var flushTimer: Timer?
    private var retryTask: Task<Void, Never>?
    private var retryAttempt = 0
    /// One flush at a time: a retry firing on top of a 30s-timeout POST would
    /// take the same batch twice, and the second answer would commit samples the
    /// first attempt is still waiting on.
    private var flushing = false
    /// A flush requested while one was in flight (see `flush(reason:)`).
    private var pendingFlushReason: String?
    private var isActive = false
    private var started = false

    init(
        store: TimeSampleStore = TimeSampleStore(),
        sender: TimeSampleStore.Sender? = nil,
        clock: @escaping () -> Date = { Date() }
    ) {
        self.store = store
        self.injectedSender = sender
        self.clock = clock
    }

    // MARK: - Wiring

    /// Subscribe the attention signal and the lifecycle fan-out. Idempotent.
    ///
    /// Called from the root view's first activation, so a background/prewarm
    /// launch never starts a timer or a POST (the build-27 rule — see LaunchGate).
    func start() {
        guard !started else { return }
        started = true
        AttentionContext.shared.onChange = { [weak self] target in
            self?.contextChanged(to: target)
        }
        LifecycleHub.shared.register(self)
        AppLog.info("time", "attention reporter started", [
            "flushSec": String(Int(Self.flushInterval)),
        ])
    }

    // MARK: - Scene phase

    /// The single "is the user looking at us" entry point, and the ONLY writer of
    /// `isActive`.
    ///
    /// Driven by the root view's `scenePhase` change, which covers `.inactive`
    /// too — the app switcher, a system alert, the screen locking. Idempotent.
    ///
    /// Deliberately NOT driven by `LifecycleHub`: see `suspendForBackground`.
    func setActive(_ active: Bool) {
        guard active != isActive else { return }
        isActive = active
        if active {
            window = AttentionWindowMachine.Window(target: AttentionContext.shared.current, startedAt: clock())
            armFlushTimer()
            // A foreground is the moment to drain whatever an offline stretch
            // left behind — this is the "retry on next launch/foreground" half.
            flush(reason: "foreground")
        } else {
            disarmFlushTimer()
            cancelRetry()
            closeWindow(at: clock())
            // The samples are on disk before this runs, so suspension can't lose
            // the TIME. What it can lose is the ACK: the server banks the batch,
            // the 204 never gets back to us, and the next foreground re-sends the
            // same windows. Two things make that safe — a background assertion
            // around the POST (see `flush`) so the response usually does arrive,
            // and an idempotency id per sample so a re-send is deduped rather
            // than double-counted when it doesn't.
            flush(reason: "background")
        }
    }

    /// The user moved to a different lane. Bank the outgoing one up to now and
    /// start counting the new one from the same instant.
    func contextChanged(to target: AttentionTarget) {
        guard isActive else { return }
        let now = clock()
        closeWindow(at: now)
        window = AttentionWindowMachine.Window(target: target, startedAt: now)
    }

    // MARK: - LifecycleSuspendable
    //
    // These two gate the NETWORK side only. They must not touch `isActive`,
    // because the hub's edges are not the presence signal: `teardownAll()`
    // (Settings → Disconnect) fans `suspendForBackground` out while the app is in
    // the FOREGROUND, and no `.active` transition follows to undo it — the scene
    // never left active. Latching the clock off here (which an earlier version of
    // this file did) killed attention counting for the rest of the foreground
    // session, including after a successful re-pair. LifecycleHub's own
    // `teardownAll` docstring warns about exactly this class of latch.

    /// Stop chasing a failed flush. Called on `.background` (where `setActive`
    /// has already closed the window and shipped it) and on a disconnect
    /// teardown, where there is no longer a server to talk to — the clock keeps
    /// running either way, and banked samples keep landing on disk.
    func suspendForBackground() { cancelRetry() }

    /// Re-pair or return to the foreground. The flush timer belongs to `isActive`,
    /// so this only ensures it exists and kicks the backlog; when the app is not
    /// on screen there is nothing to resume.
    func resumeForForeground() {
        guard isActive else { return }
        armFlushTimer()
        flush(reason: "resume")
    }

    // MARK: - Windows

    private func closeWindow(at instant: Date) {
        guard let open = window else { return }
        window = nil
        guard let sample = AttentionWindowMachine.bank(open, endingAt: instant) else { return }
        bank(sample, at: instant)
    }

    /// Bank the elapsed part of the OPEN window without leaving a gap — what a
    /// flush boundary owes when the user is still on the same screen.
    private func sliceWindow(at instant: Date) {
        guard let open = window else { return }
        if let sample = AttentionWindowMachine.bank(open, endingAt: instant) {
            bank(sample, at: instant)
            window = AttentionWindowMachine.Window(target: open.target, startedAt: instant)
        }
        // Sub-floor: leave the window open so the fragment is not lost, it just
        // keeps accumulating into the next boundary.
    }

    private func bank(_ sample: AttentionSample, at instant: Date) {
        let store = self.store
        appendStoreWork { await store.enqueue([sample], now: instant) }
    }

    // MARK: - Serial store work
    //
    // Every enqueue and every flush is appended to ONE chain, so a window banked
    // at instant T is on disk BEFORE the flush that follows it runs. An
    // independent `Task` per operation gives no such ordering: the background
    // flush (the most important one — the app is about to be suspended) could
    // start before the window it exists to ship had been enqueued, and that
    // window then waited for the next foreground.

    private var storeWork: Task<Void, Never>?
    /// Bumped per append — `drainForTesting` uses it to notice work that was
    /// appended BY the work it just awaited (a follow-up flush).
    private var storeWorkCount = 0

    private func appendStoreWork(_ operation: @escaping () async -> Void) {
        let previous = storeWork
        storeWorkCount += 1
        storeWork = Task { @MainActor in
            await previous?.value
            await operation()
        }
    }

    /// Tests only: await every enqueue/flush queued so far, including follow-ups
    /// they schedule. Bounded so a pathological loop fails the test rather than
    /// hanging it.
    func drainForTesting() async {
        for _ in 0..<10 {
            let before = storeWorkCount
            await storeWork?.value
            if storeWorkCount == before { return }
        }
    }

    // MARK: - Timers

    /// Idempotent: a second call keeps the running timer rather than restarting
    /// its 60s countdown (a re-pair fans a resume through the hub on top of the
    /// scene-phase edge, and the flush cadence should not slip each time).
    private func armFlushTimer() {
        guard flushTimer == nil else { return }
        let timer = Timer.scheduledTimer(withTimeInterval: Self.flushInterval, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.flushTick() }
        }
        // Telemetry is never worth waking a scrolling run loop for.
        timer.tolerance = 10
        flushTimer = timer
    }

    private func disarmFlushTimer() {
        flushTimer?.invalidate()
        flushTimer = nil
    }

    private func cancelRetry() {
        retryTask?.cancel()
        retryTask = nil
        retryAttempt = 0
    }

    private func flushTick() {
        guard isActive else { return }
        sliceWindow(at: clock())
        flush(reason: "tick")
    }

    // MARK: - Flush

    /// Ship the oldest batch. Never throws, never blocks the caller, and never
    /// runs two at once.
    ///
    /// A request that arrives while one is in flight is REMEMBERED, not dropped:
    /// the important flush is the background one, and a 20s POST that started
    /// 3 seconds before the user swiped up would otherwise swallow it, stranding
    /// the just-closed window until the next foreground.
    ///
    /// EVERY flush holds a background assertion, not just the one on the
    /// `.background` edge. What suspension costs is not the samples (they are on
    /// disk) but the ACK: a batch the server banked and answered 204 to, whose
    /// answer we never read, comes back on the next foreground as a re-send. The
    /// idempotency id makes that harmless; the assertion makes it rare. And the
    /// case worth protecting is precisely a *foreground* flush — a 60s tick that
    /// fires two seconds before the user swipes up is the one most likely to be
    /// cut off, and it never sees the `.background` edge at all.
    func flush(reason: String) {
        if flushing {
            pendingFlushReason = reason
            return
        }
        // Unpaired (first run, or after a disconnect): there is nowhere to send.
        // The samples stay on disk and go out once a server is configured. An
        // injected sender IS the transport, so it answers for itself.
        guard injectedSender != nil || AppConfig.isConfigured else { return }
        flushing = true
        let store = self.store
        let client = api
        let send: TimeSampleStore.Sender = injectedSender ?? { samples in
            try await client.postTimeHeartbeats(samples)
        }
        let now = clock()
        // On the same chain as the enqueues, so it can never overtake the window
        // it is meant to ship. Inherits this MainActor context, so
        // `flushFinished` needs no hop; the work itself suspends into the store
        // actor and URLSession.
        appendStoreWork { [weak self] in
            // Held across the whole POST so iOS lets the response land instead of
            // freezing the process on top of an unacknowledged batch.
            let assertion = BackgroundAssertion.begin("walnut.time.heartbeats")
            defer { BackgroundAssertion.end(assertion) }
            let outcome = await store.flush(using: send, now: now)
            self?.flushFinished(outcome, reason: reason)
        }
    }

    private func flushFinished(_ outcome: TimeSampleStore.FlushOutcome, reason: String) {
        flushing = false
        if let queued = pendingFlushReason {
            pendingFlushReason = nil
            flush(reason: queued)
            // The follow-up owns the retry decision for whatever it finds; this
            // outcome is stale the moment a newer request exists.
            return
        }
        switch outcome {
        case .empty:
            retryAttempt = 0
        case .sent(let count, let remaining):
            retryAttempt = 0
            AppLog.debug("time", "heartbeats banked", [
                "sent": String(count), "remaining": String(remaining), "reason": reason,
            ])
            // A backlog bigger than one batch drains over the following ticks
            // rather than in a tight loop — 200 samples per minute clears even a
            // multi-day queue quickly, and a loop here would be a request storm.
            if remaining > 0, isActive { scheduleRetry(immediate: true) }
        case .kept(let retryable):
            guard retryable, isActive else { return }
            scheduleRetry(immediate: false)
        }
    }

    /// Backoff, but only while the app is on screen: a background retry timer is
    /// exactly the battery drain this feature must not become. Whatever is left
    /// goes out on the next foreground.
    private func scheduleRetry(immediate: Bool) {
        retryTask?.cancel()
        let delay: TimeInterval
        if immediate {
            delay = 5
        } else {
            delay = Self.retryDelays[min(retryAttempt, Self.retryDelays.count - 1)]
            retryAttempt += 1
        }
        retryTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            guard !Task.isCancelled, let self, self.isActive else { return }
            self.flush(reason: immediate ? "drain" : "retry")
        }
    }

    // MARK: - Introspection (tests + Settings diagnostics)

    var hasOpenWindow: Bool { window != nil }
    var openTarget: AttentionTarget? { window?.target }
    var isCounting: Bool { isActive }

    func queuedSampleCount() async -> Int { await store.queuedCount }
}

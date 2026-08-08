import SwiftUI

/// Converts scroll geometry into sticky user intent. Programmatic layout,
/// streaming growth, and keyboard resizing never unpin a reader by themselves.
///
/// Intent is written through `setPinned` rather than a `@Binding`, and the store
/// keeps it `@ObservationIgnored`. That is load-bearing, not a style choice:
/// `onScrollGeometryChange`'s action runs *inside* the scroll view's layout pass,
/// so publishing from it re-invalidates the very subtree being measured. With a
/// tall LazyVStack of variable-height rows that feedback does not converge —
/// placement dirties the lazy item phases, the phase mutation dirties placement,
/// and `GraphHost.flushTransactions()` spins the main thread at 100% forever
/// (P0-2: the chat timeline went permanently blank under keyboard churn).
/// Intent is only ever *read* outside the view graph, so nothing needs to observe it.
struct ScrollBottomTracking: ViewModifier {
    let isPinned: () -> Bool
    let setPinned: (Bool) -> Void
    let geometryFrozen: () -> Bool
    @State private var tracking = TrackingState()

    private static let unpinThreshold: CGFloat = 200
    private static let repinThreshold: CGFloat = 40

    /// Reference state avoids publishing every geometry sample back into the
    /// view graph, which can otherwise trigger multiple-update-per-frame faults.
    private final class TrackingState {
        var distanceFromBottom: CGFloat = 0
        var userScrolling = false
    }

    func body(content: Content) -> some View {
        content
            .onScrollGeometryChange(for: CGFloat.self) { geometry in
                max(0, geometry.contentSize.height - geometry.visibleRect.maxY)
            } action: { _, distance in
                tracking.distanceFromBottom = distance
                updateIntent(distance: distance)
            }
            .onScrollPhaseChange { _, phase in
                tracking.userScrolling = phase == .interacting || phase == .decelerating
                guard tracking.userScrolling else { return }
                updateIntent(distance: tracking.distanceFromBottom)
            }
    }

    private func updateIntent(distance: CGFloat) {
        guard tracking.userScrolling, !geometryFrozen() else { return }
        let want: Bool
        if distance > Self.unpinThreshold {
            want = false
        } else if distance < Self.repinThreshold {
            want = true
        } else {
            return  // inside the hysteresis band: keep the current intent
        }
        // Idempotent: a geometry stream that never crosses a threshold must not
        // keep re-writing the same value.
        guard isPinned() != want else { return }
        setPinned(want)
    }
}

/// Decision core of `KeyboardBottomRepin`, extracted out of the ViewModifier so
/// the freeze regression suite can drive the REAL state machine instead of a
/// hand-copied model (`WalnutTests/ComposerFreezeTests`). A ViewModifier's
/// `@State` is unreachable from XCTest, and the machine is where every
/// amplification bug lives, so this is the part that must be testable.
///
/// Contract: **N keyboard transitions produce at most N repins.** A machine that
/// produces more has amplified user input into self-driven work, which is how a
/// 50ms relayout becomes a multi-second stall (build-35 0x8BADF00D field kills,
/// all with appCPU ≈ CPU allowance — a compute loop, not a block).
///
/// Main-thread only by construction: every caller is a keyboard-notification
/// handler. Deliberately NOT `@Observable` — this state is written from inside
/// geometry-driven callbacks, and publishing from there is the P0-2
/// non-convergent-layout bug this file's header describes.
final class KeyboardRepinMachine {
    /// What the view must do after an event. `frozen` is the value to write into
    /// `keyboardGeometryFrozen`; `repin` runs the re-entrant scroll.
    struct Outcome: Equatable {
        var frozen: Bool
        var repin = false
    }

    /// How long the *arming* gate stays closed after a repin has run — and it
    /// EXTENDS on every keyboard event that arrives while it is closed (see
    /// `willChangeFrame`). The bug it fixes: `finishTransition()` used to clear
    /// the gate BEFORE running the re-entrant `repin()`, so
    /// `scrollTo(edge:.bottom)`'s own keyboard/safe-area geometry arrived with the
    /// arming gate open and re-armed `pendingRepin` (`isPinned()` is
    /// `bottomPinned`, which is true for anyone at the bottom) — 1 real
    /// transition measured 200 repins (pump limit) instead of 1.
    ///
    /// WHY IT EXTENDS RATHER THAN JUST EXPIRING. Read the provenance labels here
    /// literally — one part is observed, one part is inferred, and nothing here is
    /// field data from a real phone yet.
    ///
    ///  - OBSERVED (2026-08-07 simulator smoke; artifact `/tmp/freeze-fix/mock.log`,
    ///    the app's own uploaded telemetry): with a FIXED 300ms hold, driving the
    ///    real composer on a booted simulator logged `repin ring broken
    ///    {repins: 13, windowSeconds: 5.0}` at 18:47:31Z, 18:49:15Z and 18:51:52Z.
    ///    So a ring survived the fixed hold three times, and the breaker below is
    ///    the only reason it stopped. That is a real, reproduced observation.
    ///  - INFERRED, NOT MEASURED: 13 repins inside a 5s window implies an
    ///    inter-repin gap of roughly 380ms, i.e. the ring's closing edge lands
    ///    somewhat LATER than a 300ms hold and later than the sibling
    ///    `programmaticGeometryFrozen` (250ms). No timestamp delta between a
    ///    `scrollTo` and its keyboard fallout was captured — the gap is derived
    ///    from the logged repin RATE, and the true value is unknown.
    ///
    /// Extending the hold on each event that arrives WHILE IT IS CLOSED widens the
    /// window this mechanism covers, because churn keeps pushing the deadline out.
    /// The concrete 0.45s is a first-principles floor, not a fitted constant: it
    /// must exceed the longest system keyboard animation (~250ms, and ~300ms for
    /// input-mode/QuickType resizes) plus margin.
    ///
    /// HONEST LIMIT OF THIS MECHANISM — do not over-claim it. Timing alone cannot
    /// distinguish "repin fallout" from "user intent" when the fallout arrives
    /// AFTER the hold has expired: both are then just a keyboard event following
    /// quiet. So the division of labour is explicit:
    ///   * fallout faster than the hold  → fully suppressed, 1 repin per
    ///     transition (the common case, and the one the ordering bug broke);
    ///   * fallout slower than the hold  → NOT suppressed; bounded and REPORTED by
    ///     the cycle breaker below. An unbounded loop becomes ≤ `ringLimit` repins
    ///     per window plus one log line.
    /// Closing the slow case properly needs the missing signal (whether the scroll
    /// view is already at the bottom, i.e. whether the repin is a no-op), which is
    /// not available here. Build 36's field data will say whether it matters.
    ///
    /// Note the gate is INTERNAL: the `keyboardGeometryFrozen` binding still
    /// clears immediately (so history-reading intent isn't suppressed any longer
    /// than before) — only *arming* is held.
    static let armHoldSeconds: TimeInterval = 0.45
    /// Ceiling on how far the extension above can push the hold past the repin
    /// that started it. Without a cap, any environment that emits keyboard
    /// geometry on a steady sub-hold cadence for a LEGITIMATE reason would
    /// disable auto-scroll-to-bottom permanently — a silent UX death. With it,
    /// the worst case is losing repins for 1.5s; if churn outlives that, the
    /// cycle breaker below is the mechanism that reports it.
    static let armHoldMaxSeconds: TimeInterval = 1.5
    /// Cycle breaker (defense in depth). The simulator cannot produce the real
    /// keyboard's ignition sources (predictive/QuickType bar, dictation,
    /// autocorrect, input-mode resize — all of which arrive as
    /// `keyboardDidChangeFrame`), so a ring pacing itself SLOWER than
    /// `armHoldSeconds` may still exist in the field. Above this rate we stop
    /// repinning and log once: an infinite loop becomes a one-line anomaly.
    ///
    /// SIZING — from first principles, and BOUNDED ON BOTH SIDES. Getting either
    /// side wrong makes the breaker useless in a way that still reads like a
    /// safeguard, so both are stated explicitly:
    ///
    ///  - UPPER BOUND (reachability). The hold already caps a ring that evades it
    ///    at 1/`armHoldSeconds` ≈ 2.2 repins/s, i.e. at most ~11 inside a 5s
    ///    window. Any limit ≥ 11 can therefore NEVER fire — it is dead code. (The
    ///    first draft of this constant was 12 and was exactly that; the regression
    ///    test caught it: 30 self-driven transitions, 0 breaks.) A "4 per second"
    ///    limit fails the same way.
    ///  - LOWER BOUND (false positives). A settling keyboard transition
    ///    legitimately repins ONCE — that is the machine's contract, asserted by
    ///    the paced arm of `testKeyboardRepinIsBoundedByTransitionCount`. Bursts of
    ///    genuine human focus/dismiss activity in the null-result simulator runs
    ///    never exceeded ~2 within a window.
    ///
    /// 8 sits in the middle of that corridor: 4x the largest legitimate burst, and
    /// comfortably under the ~11 ceiling so a real ring trips it. The window is the
    /// watchdog's own 5s line — a self-driven loop that has been turning for five
    /// continuous seconds is precisely the one that kills the app.
    ///
    /// False-positive cost is deliberately low: repins are suppressed (the view
    /// stops auto-scrolling to the bottom), and one quiet window releases it.
    static let ringWindowSeconds: TimeInterval = 5.0
    static let ringLimit = 8

    /// Armed intent: this transition should end in a repin.
    private(set) var pendingRepin = false
    /// Repins actually performed (test observable).
    private(set) var repinsPerformed = 0
    /// True while the breaker is suppressing repins; self-heals after a quiet
    /// window (test observable).
    private(set) var ringBroken = false
    /// Total times the breaker engaged (test observable).
    private(set) var ringBreaks = 0

    /// A keyboard transition is in flight (mirrors `keyboardGeometryFrozen`).
    private var transitionInFlight = false
    /// Uptime until which arming stays blocked because a repin just ran.
    private var armHoldUntil: TimeInterval = 0
    /// Hard ceiling for the current hold's extensions (`armHoldMaxSeconds` past
    /// the repin that opened it).
    private var armHoldCeiling: TimeInterval = 0
    /// Uptimes of recent repin *attempts* (successful or suppressed) — the
    /// breaker's window.
    private var recentAttempts: [TimeInterval] = []
    private let clock: () -> TimeInterval

    /// `clock` is injectable so tests drive the hold/breaker windows
    /// deterministically instead of sleeping.
    init(clock: @escaping () -> TimeInterval = { FreezeContext.uptimeNow() }) {
        self.clock = clock
    }

    /// `keyboardWillChangeFrame`. Arms a repin only if nothing else already owns
    /// geometry: an in-flight transition, the post-repin hold, or a programmatic
    /// scroll (`programmaticGeometryFrozen`, the interlock that existed but was
    /// only ever consulted by `ScrollBottomTracking`).
    func willChangeFrame(isPinned: Bool, programmaticFrozen: Bool) -> Outcome {
        let now = clock()
        let held = now < armHoldUntil
        let gateClosed = transitionInFlight || held || programmaticFrozen
        if !gateClosed {
            pendingRepin = isPinned
        } else if held {
            // Still inside the hold ⇒ this event is a consequence of the repin we
            // just performed, not user intent. Push the deadline out so a ring
            // whose closing edge is slower than one hold cannot walk through the
            // gap between holds (measured: fallout arrives ~350ms after the
            // repin, which a fixed window lets through every cycle). Capped, so
            // steady legitimate churn can't disable repinning forever.
            armHoldUntil = min(now + Self.armHoldSeconds, armHoldCeiling)
        }
        transitionInFlight = true
        return Outcome(frozen: true)
    }

    /// Any terminal signal (`didShow` / `didHide` / `willHide` /
    /// `didChangeFrame`) or the 1s failsafe.
    func finishTransition() -> Outcome {
        let now = clock()
        transitionInFlight = false
        guard pendingRepin else { return Outcome(frozen: false) }
        pendingRepin = false

        recentAttempts.removeAll { now - $0 >= Self.ringWindowSeconds }
        recentAttempts.append(now)
        if ringBroken {
            // Only this attempt inside the window ⇒ geometry went quiet, so the
            // ring is over and normal repinning resumes.
            if recentAttempts.count == 1 { ringBroken = false } else { return Outcome(frozen: false) }
        }
        if recentAttempts.count > Self.ringLimit {
            ringBroken = true
            ringBreaks += 1
            // Field telemetry: if this ever engages on a real phone, the freeze
            // reports say so instead of the app just spinning.
            // Merge the freeze-context snapshot so a field ring-break line is
            // self-describing (screen, keyboard flips, draft size, trail) —
            // without it the line proves the ring ran but not what fed it.
            var meta = FreezeContext.shared.snapshotMeta()
            meta["repins"] = String(recentAttempts.count)
            meta["windowSeconds"] = String(format: "%.1f", Self.ringWindowSeconds)
            meta["totalRepins"] = String(repinsPerformed)
            AppLog.error("freeze", "repin ring broken", meta)
            FreezeContext.shared.note("repin-ring-break", recentAttempts.count)
            return Outcome(frozen: false)
        }

        repinsPerformed += 1
        // Hold the ARMING gate across the re-entrant repin: its geometry
        // consequences are the app talking to itself, never user intent.
        armHoldUntil = now + Self.armHoldSeconds
        armHoldCeiling = now + Self.armHoldMaxSeconds
        return Outcome(frozen: false, repin: true)
    }

    /// The view went away. The armed intent belonged to a transition that is now
    /// over (a retained nav-stacked view kept it and yanked a history reader to
    /// the bottom on the next keyboard event).
    func reset() {
        pendingRepin = false
        transitionInFlight = false
        armHoldUntil = 0
        armHoldCeiling = 0
        recentAttempts = []
        ringBroken = false
    }
}

/// Freezes intent tracking while the keyboard changes the viewport, then asks
/// the sole ScrollPosition authority to restore a previously pinned bottom.
/// All decisions live in `KeyboardRepinMachine`; this type only wires
/// notifications to it and applies the outcome.
struct KeyboardBottomRepin: ViewModifier {
    @Binding var keyboardGeometryFrozen: Bool
    let isPinned: () -> Bool
    /// The sibling interlock: a programmatic scroll owns geometry for 250ms, so
    /// its keyboard/safe-area fallout must not arm a repin either. Previously
    /// this flag was passed ONLY to `ScrollBottomTracking`.
    let programmaticFrozen: () -> Bool
    let repin: () -> Void
    @State private var machine = KeyboardRepinMachine()
    @State private var failsafeTask: Task<Void, Never>?

    func body(content: Content) -> some View {
        content
            .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillChangeFrameNotification)) { _ in
                apply(machine.willChangeFrame(isPinned: isPinned(),
                                              programmaticFrozen: programmaticFrozen()))
                armFailsafe()
            }
            .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardDidShowNotification)) { _ in
                finishTransition()
            }
            .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardDidHideNotification)) { _ in
                finishTransition()
            }
            // willHide can be the ONLY terminal signal for some interactive
            // dismissals; without it (and the failsafe below) the freeze
            // sticks and the user can never unpin to read history.
            .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) { _ in
                finishTransition()
            }
            // Frame-only changes (rotation, QuickType bar, input-mode resize)
            // complete with didChangeFrame and never emit didShow/didHide.
            .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardDidChangeFrameNotification)) { _ in
                finishTransition()
            }
            .onDisappear {
                failsafeTask?.cancel()
                failsafeTask = nil
                keyboardGeometryFrozen = false
                // Also drop the pending intent. A view dismissed mid-keyboard-
                // transition kept `pendingRepin = true` (it is @State on a
                // retained view — a tab switch or nav pop does not reset it), so
                // the FIRST keyboard event after returning fired a repin that
                // the user never asked for, yanking a history reader to the
                // bottom. The repin belongs to the transition that armed it, and
                // that transition is over.
                machine.reset()
            }
    }

    /// Publish one outcome. The `repin()` call runs LAST and the machine's
    /// arming gate is already held across it, so the scroll's own geometry
    /// fallout cannot arm the next cycle.
    private func apply(_ outcome: KeyboardRepinMachine.Outcome) {
        if keyboardGeometryFrozen != outcome.frozen { keyboardGeometryFrozen = outcome.frozen }
        if outcome.repin { repin() }
    }

    /// Keyboard transitions that never emit a terminal notification (e.g. a
    /// predictive-bar frame change) must not wedge the freeze forever.
    private func armFailsafe() {
        failsafeTask?.cancel()
        failsafeTask = Task { @MainActor in
            try? await Task.sleep(for: .seconds(1))
            guard !Task.isCancelled else { return }
            finishTransition()
        }
    }

    private func finishTransition() {
        failsafeTask?.cancel()
        failsafeTask = nil
        apply(machine.finishTransition())
    }
}

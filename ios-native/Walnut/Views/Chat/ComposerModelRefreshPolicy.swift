import SwiftUI

// MARK: - View glue

extension View {
    /// Keep a composer's model pill pointed at the right source, and re-ask when
    /// the owner's stream reconnects.
    ///
    /// A modifier of its own (not two more `onChange`s inline) because
    /// `ComposerBar.body` is already at the edge of what the type checker will
    /// solve in reasonable time.
    func modelPillFollows(
        _ controls: ComposerControlsModel,
        source: ComposerControlsModel.Source?,
        fallbackModel: String?,
        revalidateToken: Int
    ) -> some View {
        self
            // The chat composer's source follows the active conversation, and the
            // SAME mounted composer sees it change (hydration fills a nil id, the
            // drawer switches conversations) with no appear in between. Without
            // this the pill stayed on the conversation it first saw, and a pick
            // wrote to that conversation's session.
            .onChange(of: source) { _, next in
                if let next { controls.attach(next, fallbackModel: fallbackModel) }
            }
            .onChange(of: revalidateToken) { _, _ in
                controls.revalidate(.streamConnected)
            }
    }
}

// MARK: - Transport seam

/// The six calls the composer's model pill makes, behind a protocol so a hosted
/// test can drive the REAL refresh state machine (retry ladder, generation guard,
/// pick-wins) against a scripted transport. Same pattern as `SessionSendTransport`:
/// the requirements match `WalnutAPI`'s existing methods, so conformance is empty.
protocol ComposerModelTransport {
    func chatEngine(agentID: String, conversationID: String?) async throws -> ChatEngineInfo
    func chatEngineSession(agentID: String, conversationID: String?) async throws -> ChatEngineInfo
    func sessionModelOptions(id: String) async throws -> SessionModelOptions
    func setSessionModel(id: String, model: String) async throws -> SessionModelChange
    func setSessionEffort(id: String, effort: String) async throws -> SessionEffortChange
    func setChatModel(
        agentID: String, conversationID: String?, model: String?, effort: String?
    ) async throws -> ChatModelChange
}

extension WalnutAPI: ComposerModelTransport {}

// MARK: - When to ask again (pure)

/// WHEN the composer's model pill asks the box again, decided without a clock, a
/// timer or a network, so every rule is a unit test.
///
/// The bug this exists for (TestFlight build 82, phone on a cloud replica): the
/// Mac's bridge to the replica blipped for about 1.3s, the phone's one
/// `GET /chat/engine` landed inside the gap, and an old replica answered its own
/// one-model config. The pill then said "Opus 5" with a one-row menu for 5.5
/// hours while the Mac offered ten models, because nothing ever asked again: the
/// only refresh path was a Retry button that the unreachable state alone showed.
///
/// So an answer is never final. Three kinds of re-ask, with different clocks:
///  - RETRY: the last lookup failed (unreachable or unusable). Back off 1, 2, 4,
///    8, 15, then every 30s, so a Mac that comes back is noticed within seconds and
///    a phone that is offline for hours asks twice a minute, never in a tight loop.
///  - RECHECK: the last lookup succeeded with a SUSPECT answer, a one-model
///    in-process catalog (what an old replica says about itself while the Mac is
///    away; a current server never answers in-process through a replica). Re-ask
///    on the ladder's early rungs (1, 2, 4, 8, 15s), then fall back to the `ttl`,
///    so that answer heals within seconds with nobody touching the pill.
///  - REVALIDATE: the last lookup succeeded but may be stale. Re-ask on the moments
///    something may have changed (the app coming to the front, the conversation
///    stream reconnecting, the composer coming back on screen with an answer older
///    than `staleAfter`), and on a `ttl` while the composer is on screen.
///
/// Opening the menu is deliberately NOT a trigger. An answer landing while the
/// menu is up would change the rows under the finger; the menu only ever shows
/// what was known when it opened (see `ComposerControlsModel.setMenuPresented`).
///
/// Nothing runs while the composer is off screen or the app is in the background:
/// `nextWake` answers nil there, and the foreground edge is itself a trigger.
enum ComposerModelRefreshPolicy {
    /// Delay before retry N (1-based) after consecutive failures. The last entry
    /// is the cap every later retry uses.
    static let retryDelays: [TimeInterval] = [1, 2, 4, 8, 15, 30]
    static var retryCap: TimeInterval { retryDelays[retryDelays.count - 1] }
    /// The composer coming back on screen re-asks only when the settled answer is
    /// at least this old. Younger than this, it IS the answer.
    static let staleAfter: TimeInterval = 10
    /// Delay before recheck N (1-based) after N suspect answers in a row: the
    /// retry ladder's early rungs. Past the last one the `ttl` takes over.
    static var recheckDelays: [TimeInterval] { Array(retryDelays.dropLast()) }
    /// How often an on-screen composer re-validates a settled answer.
    static let ttl: TimeInterval = 60
    /// A trigger that lands this soon after a load STARTED is answered by that
    /// load: it was sent into the same world. (SwiftUI delivers an appear and a
    /// scene-phase edge in the same breath, and a new conversation's stream
    /// connects right after the composer attached to it.)
    static let coalesceWindow: TimeInterval = 1

    static func retryDelay(afterFailures failures: Int) -> TimeInterval {
        guard failures > 0 else { return 0 }
        return retryDelays[min(failures, retryDelays.count) - 1]
    }

    enum Trigger: String, Equatable {
        /// The Retry button. Always asks, and restarts the ladder.
        case manual
        /// The app came to the front (scene phase became active).
        case foreground
        /// The conversation's SSE stream (re)connected: the box can talk again.
        case streamConnected
        /// The composer came (back) on screen, e.g. a tab switch.
        case appeared
        /// The settled answer reached its `ttl`.
        case ttl
        /// A scheduled retry after a failure came due.
        case retry
        /// A scheduled recheck of a suspect answer came due.
        case recheck
        /// A re-ask owed from earlier: a trigger arrived while a load or a pick was
        /// in flight, or a pick superseded a load. Asks as soon as it may.
        case followUp
    }

    /// Everything the decision reads, captured at one instant.
    struct Snapshot: Equatable {
        /// The composer is on screen AND the app is in the foreground.
        var active: Bool
        /// A user pick is being written. The pick wins: nothing may start under it.
        var applying = false
        /// When the in-flight load started; nil = none in flight.
        var loadStartedAt: Date?
        var lastSuccessAt: Date?
        var lastFailureAt: Date?
        var consecutiveFailures = 0
        /// Suspect answers in a row (see RECHECK above); 0 after any other answer.
        var suspectAnswers = 0

        /// When the most recent attempt ended, whichever way it went.
        var lastAttemptEndedAt: Date? {
            switch (lastSuccessAt, lastFailureAt) {
            case let (success?, failure?): return max(success, failure)
            case let (success?, nil): return success
            case let (nil, failure?): return failure
            case (nil, nil): return nil
            }
        }
    }

    enum Decision: Equatable {
        /// Start a load now (a manual retry restarts one already in flight).
        case loadNow
        /// Something in flight may carry an answer from before this trigger: ask
        /// once more when it settles.
        case afterCurrent
        case skip
    }

    static func decide(_ trigger: Trigger, _ s: Snapshot, now: Date) -> Decision {
        if s.applying { return .afterCurrent }
        if trigger == .manual { return .loadNow }
        if let started = s.loadStartedAt {
            switch trigger {
            case .foreground, .streamConnected, .followUp:
                // A load sent just now already sees what this trigger announces.
                // One sent earlier may have been sent into the gap it ends.
                return now.timeIntervalSince(started) < coalesceWindow ? .skip : .afterCurrent
            case .appeared, .ttl, .retry, .recheck, .manual:
                return .skip
            }
        }
        guard s.active else { return .skip }
        switch trigger {
        case .foreground, .streamConnected:
            // An answer that landed this instant already describes the world the
            // trigger announces. Measured on launch: the attach load's 503 came
            // back in under 0.1s and the scene's first `.active` edge asked again
            // right behind it. A failure keeps its own retry rung either way.
            if let ended = s.lastAttemptEndedAt, now.timeIntervalSince(ended) < coalesceWindow {
                return .skip
            }
            return .loadNow
        case .ttl, .retry, .recheck, .followUp, .manual:
            return .loadNow
        case .appeared:
            // In the retry state a look at the pill is a fine moment to try, but
            // no sooner than the ladder's first rung (a tab flicked back and forth
            // must not become a request per flick).
            if s.consecutiveFailures > 0 {
                if let ended = s.lastAttemptEndedAt, now.timeIntervalSince(ended) < coalesceWindow {
                    return .skip
                }
                return .loadNow
            }
            guard let last = s.lastSuccessAt else { return .loadNow }
            return now.timeIntervalSince(last) >= staleAfter ? .loadNow : .skip
        }
    }

    /// Is this composer on screen, for the pill's timers and re-asks? ONE rule,
    /// applied by the model to every input (its view's appear and disappear, the
    /// app returning, the surface in front changing), so no path can bypass it.
    ///
    /// On screen = its view is mounted (`appeared`) AND, when it declares a
    /// surface, that surface is the one in front (`FilePreviewDock.activeComposerSurface`).
    /// The appear alone is no evidence: a `TabView` keeps the Chat tab mounted
    /// while the user is on another tab, sends its composer no disappear on the
    /// switch (measured on iOS 26), and can re-run its appear there (gate r2 D4:
    /// two re-asks on Inbox in 130s, `trigger=appeared` at a stream reconnect,
    /// each arming the 60s TTL; measured again here as `trigger=streamConnected`).
    /// The appear still counts as a necessary condition, so a composer whose view
    /// is really gone stops asking even if its surface is in front.
    static func composerOnScreen(
        appeared: Bool, surface: ComposerSurfaceID, activeSurface: ComposerSurfaceID?
    ) -> Bool {
        guard appeared else { return false }
        guard surface != .unattached, let activeSurface, activeSurface != .unattached else { return true }
        return surface == activeSurface
    }

    /// Triggers that restart the retry ladder at its first rung: a person is
    /// looking right now, so the next few seconds are the ones worth spending.
    static func resetsBackoff(_ trigger: Trigger) -> Bool {
        trigger == .manual || trigger == .foreground
    }

    /// The one scheduled re-ask, if any.
    struct Wake: Equatable {
        var trigger: Trigger
        /// Seconds from `now`.
        var delay: TimeInterval
    }

    static func nextWake(_ s: Snapshot, now: Date) -> Wake? {
        // Off screen or backgrounded: no timers at all. The foreground edge (and
        // the composer reappearing) is what resumes.
        guard s.active, !s.applying, s.loadStartedAt == nil else { return nil }
        if s.consecutiveFailures > 0 {
            let delay = retryDelay(afterFailures: s.consecutiveFailures)
            let due = (s.lastFailureAt ?? now).addingTimeInterval(delay)
            return Wake(trigger: .retry, delay: max(0, due.timeIntervalSince(now)))
        }
        if let last = s.lastSuccessAt {
            if s.suspectAnswers > 0, s.suspectAnswers <= recheckDelays.count {
                let due = last.addingTimeInterval(recheckDelays[s.suspectAnswers - 1])
                return Wake(trigger: .recheck, delay: max(0, due.timeIntervalSince(now)))
            }
            let due = last.addingTimeInterval(ttl)
            return Wake(trigger: .ttl, delay: max(0, due.timeIntervalSince(now)))
        }
        return nil
    }
}

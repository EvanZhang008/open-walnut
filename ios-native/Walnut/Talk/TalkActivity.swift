import ActivityKit
import Foundation
import UIKit

/// Shows a take's progress where the person looks with Walnut closed: the Lock
/// Screen and the Dynamic Island.
@MainActor
protocol TalkActivityPresenting: AnyObject {
    /// Start the Live Activity for a new take. False when iOS refused it (Live
    /// Activities turned off for Walnut), which the caller reports.
    func start(_ state: TalkActivityAttributes.ContentState) -> Bool
    /// Whether `start` can show one now (Live Activities are on for Walnut).
    var canShow: Bool { get }
    func update(_ state: TalkActivityAttributes.ContentState)
    /// End it, showing `state` in the Dynamic Island briefly and on the Lock
    /// Screen for `linger` (0: gone at once).
    func end(_ state: TalkActivityAttributes.ContentState, linger: TimeInterval)
    /// End what a process that died mid-take left showing as still going, and
    /// every "Not sent" or "Waiting to send" card whose take is no longer in
    /// `kept` (sent since, or deleted). Any other finished one stays until its
    /// own time is up.
    func endLeftovers(keeping kept: Set<String>)
}

@MainActor
final class TalkLiveActivity: TalkActivityPresenting {
    private var activity: Activity<TalkActivityAttributes>?
    /// Every change waits for the one before, so an update never lands after
    /// the end that followed it.
    private var queue: Task<Void, Never>?

    var canShow: Bool { ActivityAuthorizationInfo().areActivitiesEnabled }

    func start(_ state: TalkActivityAttributes.ContentState) -> Bool {
        for old in Activity<TalkActivityAttributes>.activities where old.id != activity?.id {
            enqueue { await old.end(nil, dismissalPolicy: .immediate) }
        }
        guard ActivityAuthorizationInfo().areActivitiesEnabled else {
            AppLog.warn("talk", "live activities disabled", [:])
            return false
        }
        do {
            // A take ends by the 5-minute cap: past it, a card a dead process left
            // saying Listening shows as out of date until the next launch ends it.
            activity = try Activity.request(
                attributes: TalkActivityAttributes(),
                content: ActivityContent(state: state, staleDate: Date().addingTimeInterval(Self.listenStale)),
                pushType: nil
            )
            AppLog.info("talk", "live activity started", [:])
            return true
        } catch {
            AppLog.error("talk", "live activity refused", ["error": String(describing: error)])
            return false
        }
    }

    func update(_ state: TalkActivityAttributes.ContentState) {
        guard let activity else { return }
        enqueue { await activity.update(ActivityContent(state: state, staleDate: nil)) }
    }

    func end(_ state: TalkActivityAttributes.ContentState, linger: TimeInterval) {
        guard let activity else { return }
        self.activity = nil
        let content = ActivityContent(state: state, staleDate: nil)
        guard linger > 0 else {
            enqueue { await activity.end(content, dismissalPolicy: .immediate) }
            return
        }
        // An ended activity leaves the Dynamic Island at once and stays only on
        // the Lock Screen, so an unlocked phone would never see "Sent": show the
        // outcome in the island first, then end it.
        let hold = min(linger, Self.islandHold)
        let keepRunning = UIApplication.shared.beginBackgroundTask(withName: "talk-activity-end")
        // The outcome expands the island so the person reads it: a take that is
        // lost with a sound (it must not pass unnoticed), anything else in
        // silence: a send showing the words Walnut heard, a take saved to go
        // out later, nothing heard.
        let alert = AlertConfiguration(
            title: "\(state.title)", body: "\(state.subtitle)",
            sound: state.needsAttention && !AudioSilence.isOn ? .default : .named(Self.silentSound)
        )
        enqueue {
            await activity.update(content, alertConfiguration: alert)
            try? await Task.sleep(for: .seconds(hold))
            await activity.end(content, dismissalPolicy: .after(Date().addingTimeInterval(max(0, linger - hold))))
            await MainActor.run { UIApplication.shared.endBackgroundTask(keepRunning) }
        }
    }

    /// A bundled sound of silence: an alert must name a sound, and a sent take
    /// should only show, never ring.
    static let silentSound = "talk-silent.caf"

    /// Past the take's 5-minute cap, with a margin.
    static let listenStale: TimeInterval = 6 * 60

    /// How long the outcome shows in the Dynamic Island before the activity ends.
    static let islandHold: TimeInterval = 3

    func endLeftovers(keeping kept: Set<String>) {
        for old in Activity<TalkActivityAttributes>.activities
        where old.id != activity?.id && Self.endsNow(old.content.state, keeping: kept) {
            enqueue { await old.end(nil, dismissalPolicy: .immediate) }
        }
    }

    /// Whether a card another take (or another process) left ends now: one
    /// still going, or a failed one whose take left the list.
    nonisolated static func endsNow(_ state: TalkActivityAttributes.ContentState, keeping kept: Set<String>) -> Bool {
        switch state.phase {
        case .listening, .transcribing, .sending: return true
        case .sent: return false
        case .failed:
            guard let take = state.take else { return false }
            return !kept.contains(take)
        }
    }

    private func enqueue(_ work: @escaping @Sendable () async -> Void) {
        let previous = queue
        queue = Task {
            await previous?.value
            await work()
        }
    }
}

import Foundation

/// Work that must stop before iOS backgrounds the process.
@MainActor
protocol LifecycleSuspendable: AnyObject {
    func suspendForBackground()
    func resumeForForeground()
}

/// A participant holding a connection built for one server ORIGIN (an SSE
/// stream captures its URL at construction). On a route switch the same Walnut
/// is now reached at another origin, so the connection is rebuilt there.
@MainActor
protocol RouteRestartable: LifecycleSuspendable {
    func restartForRouteChange()
}

/// App-scoped lifecycle fan-out. Participants are weak so dismissed screens and
/// their stores are never kept alive solely by lifecycle registration.
@MainActor
final class LifecycleHub {
    static let shared = LifecycleHub()

    private struct WeakParticipant {
        weak var value: (any LifecycleSuspendable)?
    }

    private var participants: [WeakParticipant] = []
    private var suspended = false

    private init() {}

    func register(_ participant: any LifecycleSuspendable) {
        participants.removeAll { $0.value == nil || $0.value === participant }
        participants.append(WeakParticipant(value: participant))
        if suspended { participant.suspendForBackground() }
    }

    func suspendAll() {
        suspended = true
        forEachParticipant { $0.suspendForBackground() }
    }

    /// Tear every participant down WITHOUT latching the suspended flag — for
    /// disconnect, where the app stays in the foreground. Latching here would
    /// be wrong twice over: no `.active` transition is coming to clear it (the
    /// scene never left active), so stores registered afterwards (a re-pair, a
    /// freshly opened session page) would be born suspended and stay dead.
    func teardownAll() {
        forEachParticipant { $0.suspendForBackground() }
        suspended = false
    }

    func resumeAll() {
        suspended = false
        forEachParticipant { $0.resumeForForeground() }
    }

    /// Route switch (RouteCoordinator): only participants that hold a
    /// connection to the old origin take part, so a recording, an open preview
    /// or a draft is never disturbed. Nothing to do while suspended: the
    /// foreground resume builds every connection from the new URL anyway.
    func restartForRouteChange() {
        guard !suspended else { return }
        forEachParticipant { ($0 as? any RouteRestartable)?.restartForRouteChange() }
    }

    private func forEachParticipant(_ action: (any LifecycleSuspendable) -> Void) {
        participants.removeAll { $0.value == nil }
        for participant in participants.compactMap(\.value) {
            action(participant)
        }
    }
}

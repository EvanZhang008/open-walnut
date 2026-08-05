import Foundation

/// Work that must stop before iOS backgrounds the process.
@MainActor
protocol LifecycleSuspendable: AnyObject {
    func suspendForBackground()
    func resumeForForeground()
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

    private func forEachParticipant(_ action: (any LifecycleSuspendable) -> Void) {
        participants.removeAll { $0.value == nil }
        for participant in participants.compactMap(\.value) {
            action(participant)
        }
    }
}

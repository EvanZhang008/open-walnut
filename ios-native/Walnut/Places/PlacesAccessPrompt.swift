import UIKit

/// What Walnut does when an agent reads Places in a conversation open on this
/// phone. Pure, so the rules are tested. Same rule as Apple Health: ask only at
/// the moment it is needed, never on app open.
enum PlacesAccessDecision {
    enum Action: String, Equatable { case nothing, syncNow, offerTurnOn, askIOS, showAccessNote }

    struct State: Equatable {
        /// Paired with a real Mac.
        var available: Bool
        var enabled: Bool
        var access: PlacesPhoneState.Access
        /// iOS's "Change to Always Allow" question was already shown once.
        var askedAlways: Bool
        var busy: Bool
        var quietUntil: Date?
        var lastNudgeAt: Date?
        var now: Date
    }

    static let declinedQuiet: TimeInterval = 600
    static let nudgeInterval: TimeInterval = 60

    static func decide(_ s: State) -> Action {
        guard s.available, !s.busy else { return .nothing }
        if s.enabled && s.access == .always {
            if let last = s.lastNudgeAt, s.now.timeIntervalSince(last) < nudgeInterval { return .nothing }
            return .syncNow
        }
        if let quiet = s.quietUntil, s.now < quiet { return .nothing }
        if !s.enabled { return .offerTurnOn }
        // The user turned Places on and iOS still has its question to ask.
        if s.access == .notDetermined || (s.access == .whenInUse && !s.askedAlways) { return .askIOS }
        return .showAccessNote
    }

    static let placesOps: Set<String> = ["places_status", "places_visits"]

    /// The op itself (`mcp__walnut__places_visits`), or a CLI session running it
    /// through its shell (`walnut tools call places_visits`).
    static func isPlacesRead(name: String, detail: String?) -> Bool {
        let op = name.components(separatedBy: "__").last ?? name
        if placesOps.contains(op) { return true }
        guard let detail, detail.contains("tools call ") else { return false }
        return placesOps.contains { detail.contains("tools call \($0)") }
    }
}

/// Carries out `PlacesAccessDecision`.
@MainActor
final class PlacesAccessPrompt {
    static let shared = PlacesAccessPrompt()

    private var busy = false
    private var quietUntil: Date?
    private var lastNudgeAt: Date?

    func placesReadStarted() {
        guard !PlacesRecorder.isHostedUnitTestProcess, UIApplication.shared.applicationState == .active else { return }
        Task { @MainActor in await self.consider() }
    }

    func consider() async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        let recorder = PlacesRecorder.shared
        let state = PlacesAccessDecision.State(
            available: AppConfig.serverURL != nil && !(AppConfig.token ?? "").isEmpty,
            enabled: PlacesSettings.isEnabled, access: recorder.access, askedAlways: PlacesSettings.askedAlways,
            busy: PlacesStore.shared.busy != nil, quietUntil: quietUntil, lastNudgeAt: lastNudgeAt, now: Date()
        )
        let action = PlacesAccessDecision.decide(state)
        guard action != .nothing else { return }
        AppLog.info("places", "access prompt", ["action": action.rawValue, "access": state.access.rawValue])
        switch action {
        case .nothing:
            return
        case .syncNow:
            lastNudgeAt = Date()
            recorder.syncSoon(reason: "agent-read")
        case .offerTurnOn:
            guard await confirm(.turnOn) else {
                quietUntil = Date().addingTimeInterval(PlacesAccessDecision.declinedQuiet)
                return
            }
            await PlacesStore.shared.turnOn()
            announce()
        case .askIOS:
            quietUntil = Date().addingTimeInterval(120)
            await PlacesStore.shared.turnOn()
            announce()
        case .showAccessNote:
            guard await confirm(.accessNote) else {
                quietUntil = Date().addingTimeInterval(PlacesAccessDecision.declinedQuiet)
                return
            }
            recorder.openSettings()
        }
    }

    private func announce() {
        if PlacesRecorder.shared.access == .always {
            HealthToast.show("Places is on. Walnut records the places you visit from now on, and keeps them on your Mac.")
        }
    }

    private enum Note { case turnOn, accessNote }

    private func confirm(_ note: Note) async -> Bool {
        guard let top = HealthToast.topViewController() else { return false }
        return await withCheckedContinuation { done in
            let alert: UIAlertController
            let yes: UIAlertAction
            switch note {
            case .turnOn:
                alert = UIAlertController(
                    title: "Turn On Places?",
                    message: "Your AI is asking about places you went, and Places is off, so nothing is recorded. Turn it on and Walnut records the places you visit from now on. They go only to your Mac.",
                    preferredStyle: .alert
                )
                yes = UIAlertAction(title: "Turn On", style: .default) { _ in done.resume(returning: true) }
                alert.view.accessibilityIdentifier = "places.offer"
            case .accessNote:
                alert = UIAlertController(
                    title: "Places Needs Location Always",
                    message: "Your AI is asking about places you went. iOS tells Walnut about your visits only with location access set to Always. In Settings, tap Location, then Always.",
                    preferredStyle: .alert
                )
                yes = UIAlertAction(title: "Open Settings", style: .default) { _ in done.resume(returning: true) }
                alert.view.accessibilityIdentifier = "places.access-note"
            }
            alert.addAction(UIAlertAction(title: "Not Now", style: .cancel) { _ in done.resume(returning: false) })
            alert.addAction(yes)
            alert.preferredAction = yes
            top.present(alert, animated: true)
        }
    }
}

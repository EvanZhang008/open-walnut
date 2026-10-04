import HealthKit
import UIKit

/// When Walnut asks for Apple Health. Pure, so the rules are tested.
///
/// Only when it is needed: an agent starts reading health data in a conversation
/// open on this phone. Never on app open: a sheet that comes up before the user
/// asked anything reads as a demand and gets Don't Allow (2026-10-03), and iOS
/// shows that sheet only once. What the phone shows depends on where access stands:
/// Apple's sheet while it still has something to ask, a one-tap Turn On when sync
/// is off here, a note with the way to the switch and a button to Settings when
/// iOS gives Walnut nothing to read, and a sync right away when everything is on.
enum HealthAccessDecision {
    enum Action: String, Equatable { case nothing, syncNow, showSheet, offerTurnOn, showAccessOff }

    struct State: Equatable {
        /// HealthKit present, paired with a real Mac, not the demo.
        var available: Bool
        var enabled: Bool
        /// Apple's sheet still has something to ask, so asking shows it.
        var sheetWillShow: Bool
        /// HealthKit hands Walnut at least one sample.
        var readable: Bool
        /// A turn-on, an ask or an offer is already under way.
        var busy: Bool
        /// No sheet or note before this (the user just answered one).
        var quietUntil: Date?
        var lastNudgeAt: Date?
        var now: Date
    }

    /// After a note the user turned down.
    static let declinedQuiet: TimeInterval = 600
    /// After Apple's sheet: the rest of that turn's health reads stay quiet.
    static let afterSheetQuiet: TimeInterval = 120
    /// A run of health reads in one turn starts one sync, not one each.
    static let nudgeInterval: TimeInterval = 60

    /// An agent started reading Apple Health in a conversation open on this phone.
    static func decide(_ s: State) -> Action {
        guard s.available, !s.busy else { return .nothing }
        if s.enabled && s.readable && !s.sheetWillShow {
            if let last = s.lastNudgeAt, s.now.timeIntervalSince(last) < nudgeInterval { return .nothing }
            return .syncNow
        }
        if let quiet = s.quietUntil, s.now < quiet { return .nothing }
        if s.sheetWillShow { return .showSheet }
        return s.enabled ? .showAccessOff : .offerTurnOn
    }

    /// The Walnut ops that read Apple Health.
    static let healthOps: Set<String> = ["health_status", "health_sleep", "health_daily", "health_series", "health_samples"]

    /// A tool call that reads Apple Health: the op itself (`mcp__walnut__health_sleep`),
    /// or a CLI session running it through its shell (`walnut tools call health_sleep`).
    static func isHealthRead(name: String, detail: String?) -> Bool {
        let op = name.components(separatedBy: "__").last ?? name
        if healthOps.contains(op) { return true }
        guard let detail, detail.contains("tools call ") else { return false }
        return healthOps.contains { detail.contains("tools call \($0)") }
    }
}

/// Carries out `HealthAccessDecision`: Apple's sheet, the one-tap notes, and a
/// short line once the Mac has the data.
@MainActor
final class HealthAccessPrompt {
    static let shared = HealthAccessPrompt()
    /// How long the line after turning on waits for the Mac to have data.
    static let firstSyncWait: TimeInterval = 60

    private var busy = false
    private var quietUntil: Date?
    private var lastNudgeAt: Date?
    /// Set when the user went to Settings from the access note; their return
    /// is when access may have changed.
    private var awaitingReturn = false

    /// From both live streams (LiveStreamEvents): an agent started reading Apple
    /// Health in a conversation open on this phone.
    func healthReadStarted() {
        guard !HealthBackground.isHostedUnitTestProcess,
              UIApplication.shared.applicationState == .active else { return }
        Task { @MainActor in await self.consider() }
    }

    /// From HealthBackground's activation observer. Asks nothing: it only tells
    /// the user when access they just turned on in Settings has reached the Mac.
    func appBecameActive() {
        guard awaitingReturn, !HealthBackground.isHostedUnitTestProcess else { return }
        awaitingReturn = false
        Task { @MainActor in
            guard HealthSync.isEnabled, await HealthKitDataSource.shared.canReadAnySample() else { return }
            AppLog.info("health", "access turned on in Settings")
            await self.announceFirstSync(askAgain: true)
        }
    }

    private var available: Bool {
        !DemoMode.isActive && HKHealthStore.isHealthDataAvailable()
            && AppConfig.serverURL != nil && !(AppConfig.token ?? "").isEmpty
    }

    func consider() async {
        guard !busy, available else { return }
        busy = true
        defer { busy = false }
        let source = HealthKitDataSource.shared
        let enabled = HealthSync.isEnabled
        let state = HealthAccessDecision.State(
            available: true, enabled: enabled,
            sheetWillShow: await source.shouldRequestAuthorization(for: HealthTypeCatalog.all),
            readable: await source.canReadAnySample(),
            busy: HealthSyncStore.shared.busy != nil, quietUntil: quietUntil, lastNudgeAt: lastNudgeAt, now: Date()
        )
        let action = HealthAccessDecision.decide(state)
        guard action != .nothing else { return }
        AppLog.info("health", "access prompt", ["action": action.rawValue, "readable": String(state.readable)])
        switch action {
        case .nothing:
            return
        case .syncNow:
            lastNudgeAt = Date()
            HealthBackground.shared.syncNow()
        case .showSheet:
            quietUntil = Date().addingTimeInterval(HealthAccessDecision.afterSheetQuiet)
            await HealthSyncStore.shared.turnOn()
            guard HealthSync.isEnabled else { return }
            // Don't Allow on the sheet is an answer: say nothing more now. The
            // next health question after the quiet spell shows the access note.
            if await source.canReadAnySample() { await announceFirstSync(askAgain: true) }
        case .offerTurnOn:
            guard await confirm(.turnOn) else {
                quietUntil = Date().addingTimeInterval(HealthAccessDecision.declinedQuiet)
                return
            }
            await HealthSyncStore.shared.turnOn()
            guard HealthSync.isEnabled else { return }
            if await source.canReadAnySample() {
                await announceFirstSync(askAgain: true)
            } else {
                await showAccessOff()
            }
        case .showAccessOff:
            await showAccessOff()
        }
    }

    /// iOS gives Walnut nothing to read, and it never shows its sheet twice: one
    /// tap to Settings, and the note names the rest of the way (Privacy &
    /// Security, Health, Walnut). Apple has no public link to that page, and on
    /// a 2026-10 simulator the Health app's own Apps list stayed empty for Walnut.
    private func showAccessOff() async {
        guard await confirm(.accessOff) else {
            quietUntil = Date().addingTimeInterval(HealthAccessDecision.declinedQuiet)
            return
        }
        guard let settings = URL(string: UIApplication.openSettingsURLString) else { return }
        awaitingReturn = true
        AppLog.info("health", "opening Settings for access")
        await UIApplication.shared.open(settings)
    }

    /// Say what happened once the Mac has data, or why it does not yet.
    private func announceFirstSync(askAgain: Bool) async {
        let store = HealthSyncStore.shared
        let deadline = Date().addingTimeInterval(Self.firstSyncWait)
        while Date() < deadline {
            try? await Task.sleep(for: .seconds(4))
            await store.refresh()
            if store.macHasSamples {
                HealthToast.show(askAgain
                    ? "Apple Health is on. Your Mac has your recent health data now, so ask again."
                    : "Apple Health is on. Your Mac has your recent health data now.")
                return
            }
            if store.progress.lastOutcome == .macUnreachable {
                HealthToast.show("Apple Health is on. Walnut syncs as soon as your Mac can be reached.")
                return
            }
        }
    }

    private enum Note { case turnOn, accessOff }

    private func confirm(_ note: Note) async -> Bool {
        guard let top = HealthToast.topViewController() else { return false }
        return await withCheckedContinuation { done in
            let alert: UIAlertController
            let yes: UIAlertAction
            switch note {
            case .turnOn:
                alert = UIAlertController(
                    title: "Let Walnut Use Apple Health?",
                    message: "Your AI is asking about your health. Turn on Apple Health and Walnut keeps your Mac up to date with your sleep, heart, activity and the rest. It goes only to your Mac.",
                    preferredStyle: .alert
                )
                yes = UIAlertAction(title: "Turn On", style: .default) { _ in done.resume(returning: true) }
                alert.view.accessibilityIdentifier = "health.offer"
            case .accessOff:
                alert = UIAlertController(
                    title: "Walnut Can't Read Apple Health",
                    message: "Your AI is asking about your health, but Apple Health access for Walnut is off, and iOS asks only once. In Settings, go to Privacy & Security, then Health, then Walnut, and tap Turn On All.",
                    preferredStyle: .alert
                )
                yes = UIAlertAction(title: "Open Settings", style: .default) { _ in done.resume(returning: true) }
                alert.view.accessibilityIdentifier = "health.access-off"
            }
            alert.addAction(UIAlertAction(title: "Not Now", style: .cancel) { _ in done.resume(returning: false) })
            alert.addAction(yes)
            alert.preferredAction = yes
            top.present(alert, animated: true)
        }
    }
}

/// A short note pinned under the status bar, gone after a few seconds.
@MainActor
enum HealthToast {
    static func keyWindow() -> UIWindow? {
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .first { $0.isKeyWindow }
    }

    static func topViewController() -> UIViewController? {
        guard var top = keyWindow()?.rootViewController else { return nil }
        while let presented = top.presentedViewController { top = presented }
        return top
    }

    static func show(_ text: String) {
        guard let window = keyWindow() else { return }
        AppLog.info("health", "toast shown", ["text": text])
        let toast = UIView()
        toast.translatesAutoresizingMaskIntoConstraints = false
        toast.isUserInteractionEnabled = false
        // Opaque: it sits over the screen's own header for a few seconds.
        toast.backgroundColor = .secondarySystemGroupedBackground
        toast.layer.cornerRadius = 18
        toast.layer.cornerCurve = .continuous
        toast.layer.borderWidth = 0.5
        toast.layer.borderColor = UIColor.separator.withAlphaComponent(0.35).cgColor
        toast.layer.shadowColor = UIColor.black.cgColor
        toast.layer.shadowOpacity = 0.12
        toast.layer.shadowRadius = 12
        toast.layer.shadowOffset = CGSize(width: 0, height: 4)
        let label = UILabel()
        label.text = text
        label.numberOfLines = 3
        label.textAlignment = .center
        label.font = .systemFont(ofSize: 14, weight: .semibold)
        label.textColor = .label
        label.translatesAutoresizingMaskIntoConstraints = false
        toast.addSubview(label)
        toast.accessibilityIdentifier = "health.toast"
        toast.isAccessibilityElement = true
        toast.accessibilityLabel = text
        window.addSubview(toast)
        NSLayoutConstraint.activate([
            label.leadingAnchor.constraint(equalTo: toast.leadingAnchor, constant: 16),
            label.trailingAnchor.constraint(equalTo: toast.trailingAnchor, constant: -16),
            label.topAnchor.constraint(equalTo: toast.topAnchor, constant: 10),
            label.bottomAnchor.constraint(equalTo: toast.bottomAnchor, constant: -10),
            toast.centerXAnchor.constraint(equalTo: window.centerXAnchor),
            toast.topAnchor.constraint(equalTo: window.safeAreaLayoutGuide.topAnchor, constant: 8),
            toast.widthAnchor.constraint(lessThanOrEqualTo: window.widthAnchor, constant: -32),
        ])
        UIAccessibility.post(notification: .announcement, argument: text)
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(6))
            UIView.animate(withDuration: 0.25, animations: { toast.alpha = 0 }) { _ in toast.removeFromSuperview() }
        }
    }
}

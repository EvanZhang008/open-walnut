import HealthKit
import UIKit

/// When Walnut asks for Apple Health by itself. Pure, so the rules are tested.
///
/// Nobody should have to find the switch: the app shows Apple's own permission
/// sheet the first time it is open on a paired phone, and again whenever an agent
/// reads health data in a conversation open on this phone while Apple Health is
/// off here. The sheet is Apple's consent screen; Walnut never starts sending
/// without it, or without a tap on its own Turn On.
enum HealthAccessDecision {
    enum Trigger: String, Equatable { case appOpen, healthRead }
    enum Action: String, Equatable { case nothing, syncNow, showSheet, offerTurnOn }

    struct State: Equatable {
        /// HealthKit present, paired with a real Mac, not the demo.
        var available: Bool
        var enabled: Bool
        /// Walnut showed the Health sheet before, by itself or from Turn On.
        var offered: Bool
        /// Apple's sheet still has something to ask, so asking shows it.
        var sheetWillShow: Bool
        /// A turn-on, an ask or an offer is already under way.
        var busy: Bool
        var lastOfferAt: Date?
        var lastNudgeAt: Date?
        var now: Date
    }

    /// An offer the user turned down is not repeated sooner than this.
    static let offerInterval: TimeInterval = 600
    /// A run of health reads in one turn starts one sync, not one each.
    static let nudgeInterval: TimeInterval = 60

    static func decide(_ trigger: Trigger, _ s: State) -> Action {
        guard s.available, !s.busy else { return .nothing }
        if s.enabled {
            // On already: a health read gets the Mac current now, not at the next wake-up.
            guard trigger == .healthRead else { return .nothing }
            if let last = s.lastNudgeAt, s.now.timeIntervalSince(last) < nudgeInterval { return .nothing }
            return .syncNow
        }
        switch trigger {
        case .appOpen:
            // Once, and only when Apple's sheet will really ask. A phone paired again
            // after Disconnect (sheet answered long ago, maybe for another Mac)
            // never starts sending on its own.
            return !s.offered && s.sheetWillShow ? .showSheet : .nothing
        case .healthRead:
            if s.sheetWillShow { return .showSheet }
            if let last = s.lastOfferAt, s.now.timeIntervalSince(last) < offerInterval { return .nothing }
            return .offerTurnOn
        }
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

/// Carries out `HealthAccessDecision`: shows the sheet, the one-tap offer, and a
/// short note once the Mac has the data.
@MainActor
final class HealthAccessPrompt {
    static let shared = HealthAccessPrompt()
    /// Erased with every other preference by Disconnect.
    static let offeredKey = "walnut.health.offered"
    /// After an activation, so the app is on screen and settled when the sheet comes up.
    static let appOpenDelay: Duration = .milliseconds(1200)
    /// How long the note after turning on waits for the Mac to have data.
    static let firstSyncWait: TimeInterval = 60

    static var offered: Bool {
        get { UserDefaults.standard.bool(forKey: offeredKey) }
        set { UserDefaults.standard.set(newValue, forKey: offeredKey) }
    }

    private var busy = false
    private var lastOfferAt: Date?
    private var lastNudgeAt: Date?

    /// From HealthBackground's activation observer.
    func appBecameActive() {
        guard !HealthBackground.isHostedUnitTestProcess else { return }
        Task { @MainActor in
            try? await Task.sleep(for: Self.appOpenDelay)
            guard UIApplication.shared.applicationState == .active else { return }
            await self.consider(.appOpen)
        }
    }

    /// From both live streams (LiveStreamEvents): an agent started reading Apple
    /// Health in a conversation open on this phone.
    func healthReadStarted() {
        guard !HealthBackground.isHostedUnitTestProcess,
              UIApplication.shared.applicationState == .active else { return }
        Task { @MainActor in await self.consider(.healthRead) }
    }

    private var available: Bool {
        !DemoMode.isActive && HKHealthStore.isHealthDataAvailable()
            && AppConfig.serverURL != nil && !(AppConfig.token ?? "").isEmpty
    }

    func consider(_ trigger: HealthAccessDecision.Trigger) async {
        guard !busy, available else { return }
        // Opening the app only ever asks once: skip the HealthKit lookup after that.
        if trigger == .appOpen && (Self.offered || HealthSync.isEnabled) { return }
        busy = true
        defer { busy = false }
        let enabled = HealthSync.isEnabled
        let sheetWillShow = enabled
            ? false
            : await HealthKitDataSource.shared.shouldRequestAuthorization(for: HealthTypeCatalog.all)
        let state = HealthAccessDecision.State(
            available: true, enabled: enabled, offered: Self.offered, sheetWillShow: sheetWillShow,
            busy: HealthSyncStore.shared.busy != nil, lastOfferAt: lastOfferAt, lastNudgeAt: lastNudgeAt, now: Date()
        )
        let action = HealthAccessDecision.decide(trigger, state)
        guard action != .nothing else { return }
        AppLog.info("health", "access prompt", ["trigger": trigger.rawValue, "action": action.rawValue])
        switch action {
        case .nothing:
            return
        case .syncNow:
            lastNudgeAt = Date()
            HealthBackground.shared.syncNow()
        case .showSheet:
            await turnOn(trigger)
        case .offerTurnOn:
            lastOfferAt = Date()
            if await confirmOffer() { await turnOn(trigger) }
        }
    }

    private func turnOn(_ trigger: HealthAccessDecision.Trigger) async {
        await HealthSyncStore.shared.turnOn()
        guard HealthSync.isEnabled else { return }
        await announceFirstSync(askAgain: trigger == .healthRead)
    }

    /// Say what happened once the Mac has data, or why it does not yet.
    private func announceFirstSync(askAgain: Bool) async {
        let store = HealthSyncStore.shared
        let deadline = Date().addingTimeInterval(Self.firstSyncWait)
        while Date() < deadline {
            try? await Task.sleep(for: .seconds(4))
            await store.refresh()
            if store.macDataFrom != nil {
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
        if store.progress.lastOutcome == .synced {
            HealthToast.show("Walnut can't read any Apple Health data yet. To allow it, open the Health app, tap your picture, then Apps, then Walnut.")
        }
    }

    /// Apple's sheet was answered before, so it will not show again: one tap here.
    private func confirmOffer() async -> Bool {
        guard let top = HealthToast.topViewController() else { return false }
        return await withCheckedContinuation { done in
            let alert = UIAlertController(
                title: "Let Walnut Use Apple Health?",
                message: "Your AI is asking about your health. Turn on Apple Health and Walnut keeps your Mac up to date with your sleep, heart, activity and the rest. It goes only to your Mac.",
                preferredStyle: .alert
            )
            alert.addAction(UIAlertAction(title: "Not Now", style: .cancel) { _ in done.resume(returning: false) })
            let turnOn = UIAlertAction(title: "Turn On", style: .default) { _ in done.resume(returning: true) }
            alert.addAction(turnOn)
            alert.preferredAction = turnOn
            alert.view.accessibilityIdentifier = "health.offer"
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

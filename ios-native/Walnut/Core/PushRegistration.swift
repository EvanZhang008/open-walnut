import Foundation
import Observation
import UIKit
import UserNotifications

/// APNs registration, notification permission, and the letter-notification mode.
///
/// The receive half already existed (`LetterDeepLink` routes a tapped letter to
/// its reader); what was missing is that the app never registered with APNs, so
/// no device token was ever minted and push to this app was entirely dead. This
/// is the mint-and-upload half.
///
/// Three rules encoded here, each one a way this feature fails silently:
///
///  - **Permission is asked LATE, never at first launch.** A notification prompt
///    on a screen the user hasn't understood yet gets denied, and iOS only ever
///    asks once — a denial is effectively permanent (Settings-only recovery). So
///    the ask happens when the user has arrived at the Inbox, where the letters
///    a notification would be about are visible on screen.
///  - **Registration is separate from permission.** `registerForRemoteNotifications`
///    is what mints the token, and it is called only AFTER authorization is
///    granted; asking APNs first would produce a token for a device that can
///    show nothing.
///  - **The upload is idempotent and re-runs on re-pair.** APNs mints a fresh
///    token on reinstall and can rotate it at any time, so the token is uploaded
///    whenever it differs from the last one this install successfully sent, and
///    whenever the paired server changes.
@Observable
@MainActor
final class PushRegistration {
    static let shared = PushRegistration()

    // MARK: - The mode (the user's choice)

    /// Letter-notification mode. `always` is the default, deliberately: an inbox
    /// letter is a document an agent wrote for the human, and the failure the
    /// user reported was letters NOT arriving. Quiet-by-default would reproduce it.
    enum Mode: String, CaseIterable, Identifiable {
        /// Every letter notifies, whatever the app is doing.
        case always
        /// Slack's rule: quiet while the app is on screen, notify when it isn't.
        case whenInactive = "when-inactive"

        var id: String { rawValue }

        var label: String {
            switch self {
            case .always: return "Always"
            case .whenInactive: return "When App Is Closed"
            }
        }

        var blurb: String {
            switch self {
            case .always:
                return "Every letter your agents write shows up as a notification, even while you're using Walnut."
            case .whenInactive:
                return "Letters only notify when Walnut isn't open on this phone — like Slack. While you're in the app, the Inbox badge is the only signal."
            }
        }
    }

    /// UserDefaults key, matching the app's existing preference convention
    /// (`VoiceRecorder.micRouteKey`). Stored as the raw string because
    /// `@AppStorage` needs a plain type.
    nonisolated static let modeKey = "walnut.push.notificationMode"

    /// Read the mode from outside SwiftUI.
    nonisolated static var mode: Mode {
        Mode(rawValue: UserDefaults.standard.string(forKey: modeKey) ?? "") ?? .always
    }

    /// The token this install last uploaded successfully, so a relaunch doesn't
    /// re-POST an unchanged token on every open.
    nonisolated static let uploadedTokenKey = "walnut.push.uploadedToken"

    // MARK: - Observable state (what Settings shows)

    /// Whether the user has granted notification permission, as far as we know.
    private(set) var authorization: UNAuthorizationStatus = .notDetermined
    /// The APNs token this device holds, hex-encoded. Nil until APNs answers.
    private(set) var deviceToken: String?
    /// Set when the server accepted the token but says it cannot deliver — the
    /// honest surface for "the server has no APNs key configured".
    private(set) var serverDeliverable: Bool?
    /// Last registration/upload failure, shown in Settings rather than swallowed.
    private(set) var lastError: String?

    /// `WalnutAPI` is a stateless struct that reads the server URL + token from
    /// `AppConfig` per request, so one instance is safe to hold (same as the
    /// stores do) and re-pairing needs no re-wiring here.
    private let api = WalnutAPI()

    private init() {}

    // MARK: - Pure helpers (unit-testable)

    /// APNs hands back opaque bytes; the server needs lowercase hex. Getting this
    /// wrong yields a token Apple rejects as malformed, which reads like a
    /// server bug.
    nonisolated static func hexString(from data: Data) -> String {
        data.map { String(format: "%02x", $0) }.joined()
    }

    /// Which APNs environment this BUILD registered against. A debug build gets a
    /// sandbox token, a TestFlight/App Store build a production one, and sending
    /// a sandbox token to the production gateway fails in a way that looks
    /// exactly like a bad token — so the build tells the server which it is
    /// rather than letting the server guess.
    nonisolated static var environment: String {
        #if DEBUG
        return "sandbox"
        #else
        return "production"
        #endif
    }

    // MARK: - Permission + registration

    /// Refresh the cached authorization status (cheap; no prompt).
    func refreshAuthorization() async {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        authorization = settings.authorizationStatus
        // Already granted from a previous launch: re-register so a rotated token
        // is picked up. Registration itself never prompts.
        if settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional {
            UIApplication.shared.registerForRemoteNotifications()
        }
    }

    /// Ask for notification permission, then register with APNs.
    ///
    /// Safe to call repeatedly: iOS answers a second `requestAuthorization` from
    /// the stored decision without re-prompting, so callers don't have to track
    /// whether the ask already happened.
    func requestPermissionAndRegister() async {
        let center = UNUserNotificationCenter.current()
        let current = await center.notificationSettings().authorizationStatus
        authorization = current
        // Denied is Settings-only to recover from — asking again does nothing but
        // waste a round trip, and must NOT be reported as an error.
        guard current != .denied else {
            AppLog.info("push", "notification permission previously denied", [:])
            return
        }
        do {
            let granted = try await center.requestAuthorization(options: [.alert, .sound, .badge])
            authorization = await center.notificationSettings().authorizationStatus
            AppLog.info("push", "notification permission answered", ["granted": granted ? "true" : "false"])
            guard granted else { return }
            // Only now mint a token: a token for a device that can display
            // nothing is a token that produces silent pushes.
            UIApplication.shared.registerForRemoteNotifications()
        } catch {
            lastError = String(describing: error)
            AppLog.warn("push", "notification permission request failed", ["error": lastError ?? ""])
        }
    }

    // MARK: - Token upload

    /// APNs delivered a token. Upload it unless this install already uploaded
    /// exactly this one to this server.
    func didRegister(deviceToken data: Data) {
        let hex = Self.hexString(from: data)
        deviceToken = hex
        lastError = nil
        AppLog.info("push", "apns token minted", [
            "tokenPrefix": String(hex.prefix(12)),
            "environment": Self.environment,
        ])
        let alreadyUploaded = UserDefaults.standard.string(forKey: Self.uploadedTokenKey)
        guard alreadyUploaded != hex else { return }
        upload(token: hex)
    }

    func didFailToRegister(error: Error) {
        // The common cause is a build whose provisioning profile lacks the push
        // entitlement — worth naming, because the error itself is opaque.
        lastError = String(describing: error)
        AppLog.warn("push", "apns registration failed", [
            "error": lastError ?? "",
            "hint": "check the App ID has Push Notifications enabled and the profile carries aps-environment",
        ])
    }

    /// POST the token, then the mode. Fire-and-forget: push is a courtesy layer
    /// and must never block or fail anything the user is doing.
    private func upload(token: String) {
        guard AppConfig.isConfigured else { return }
        let mode = Self.mode
        Task { [api] in
            do {
                let ack = try await api.registerPushToken(
                    token: token,
                    environment: Self.environment,
                    mode: mode.rawValue
                )
                UserDefaults.standard.set(token, forKey: Self.uploadedTokenKey)
                serverDeliverable = ack.deliverable
                if ack.deliverable == false {
                    // Registered but undeliverable = the server has no APNs key.
                    // Surfaced, never silent: otherwise this looks like pushes
                    // that simply never arrive.
                    AppLog.warn("push", "server cannot deliver pushes yet", [
                        "hint": "server has no APNs auth key configured",
                    ])
                }
                AppLog.info("push", "token uploaded", [
                    "deliverable": (ack.deliverable ?? true) ? "true" : "false",
                ])
            } catch {
                lastError = String(describing: error)
                AppLog.warn("push", "token upload failed", ["error": lastError ?? ""])
            }
        }
    }

    /// Re-send the token after the mode changes, and push the new mode up.
    func modeChanged(to mode: Mode) {
        UserDefaults.standard.set(mode.rawValue, forKey: Self.modeKey)
        guard AppConfig.isConfigured else { return }
        Task { [api] in
            do {
                try await api.setPushPreferences(mode: mode.rawValue)
                AppLog.info("push", "mode updated", ["mode": mode.rawValue])
                // Entering `whenInactive` while the app is on screen has to
                // claim the lease immediately, or the next letter buzzes even
                // though the user is looking at the app.
                if mode == .whenInactive { reportActive(true) }
            } catch {
                lastError = String(describing: error)
                AppLog.warn("push", "mode update failed", ["error": lastError ?? ""])
            }
        }
    }

    // MARK: - Foreground reporting (only `when-inactive` needs it)

    /// How often the foreground lease is renewed while the app is on screen.
    ///
    /// The server's lease is 90s (`ACTIVE_LEASE_MS`), so this has to be
    /// comfortably shorter or the lease expires under the user and a letter
    /// buzzes while they are looking at the app. Without this timer the mode was
    /// broken for any session longer than 90 seconds.
    static let activeRefreshInterval: TimeInterval = 30

    private var activeRefreshTimer: Timer?

    /// Tell the server whether this app is on screen, and keep the lease alive
    /// while it is.
    ///
    /// Skipped entirely in `always` mode: the server never reads the value there,
    /// so reporting it would be pure churn. The server treats a report as a short
    /// LEASE, so a force-quit phone decays back to receiving pushes instead of
    /// muting itself forever.
    func reportActive(_ active: Bool) {
        activeRefreshTimer?.invalidate()
        activeRefreshTimer = nil
        guard Self.mode == .whenInactive, AppConfig.isConfigured else { return }
        postActive(active)
        guard active else { return }
        // Renew until the app leaves the foreground. Repeating rather than
        // one-shot because the lease has to outlive an arbitrarily long session.
        let timer = Timer.scheduledTimer(withTimeInterval: Self.activeRefreshInterval, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.postActive(true) }
        }
        // The lease is a courtesy, not worth waking a scrolling run loop for.
        timer.tolerance = 5
        activeRefreshTimer = timer
    }

    private func postActive(_ active: Bool) {
        Task { [api] in
            do { try await api.reportPushActive(active) }
            catch {
                // Losing this is safe by design — the lease expires and letters
                // resume. Log at info, not warn.
                AppLog.info("push", "active report skipped", ["error": String(describing: error)])
            }
        }
    }
}

extension QuickActionDelegate {
    /// APNs handed us a device token. The only place a token is ever minted.
    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        Task { @MainActor in
            PushRegistration.shared.didRegister(deviceToken: deviceToken)
        }
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        Task { @MainActor in
            PushRegistration.shared.didFailToRegister(error: error)
        }
    }
}

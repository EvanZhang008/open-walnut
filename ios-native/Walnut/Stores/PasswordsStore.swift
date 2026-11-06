import AuthenticationServices
import Foundation
import Observation
import UIKit

/// The app's side of Passwords on this iPhone (docs/reference/passwords.md "iPhone"): the shared
/// VaultModel over the app's own pairing, the copy of that pairing the AutoFill extension fetches
/// with, iOS's AutoFill switch for Walnut, and the lock when the app is left.
@MainActor
@Observable
final class PasswordsStore {
    static let shared = PasswordsStore()

    let model: VaultModel
    /// iOS's switch for Walnut under AutoFill & Passwords; nil until read.
    private(set) var autofillEnabled: Bool?

    /// Locked again once the app was away this long (and at once when the phone locks).
    static let lockAfterBackground: TimeInterval = 120
    private var backgroundedAt: Date?
    /// The person pressed Lock: the lock screen then waits for a tap instead of asking Face ID
    /// at once (that would undo the lock they just chose). Only that lock: after an unlock, the
    /// next lock (time away, the phone locking) asks Face ID again (2026-11-06: one press of
    /// Lock had turned the automatic Face ID off until Passwords was left).
    var lockedByHand: Bool { handLockEpoch == model.lockEpoch && model.phase != .unlocked }
    private var handLockEpoch: Int?
    private var observers: [NSObjectProtocol] = []

    init() {
        #if DEBUG
        VaultShared.useTestKeychain(KeychainHelper.namespace == .tests)
        #else
        VaultShared.useTestKeychain(false)
        #endif
        model = VaultModel(server: {
            guard let url = AppConfig.serverURL, let token = AppConfig.token, !token.isEmpty else { return nil }
            let server = VaultServer(baseURL: url, token: token)
            VaultServerMirror.save(server)
            return server
        })
        model.onItemsOpened = { items in Task { await CredentialIdentities.replace(with: items) } }
        model.load()
        model.dropExpiredFillGrace()
        let nc = NotificationCenter.default
        observers.append(nc.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.backgroundedAt = Date() }
        })
        observers.append(nc.addObserver(forName: UIApplication.protectedDataWillBecomeUnavailableNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.model.lock() }
        })
        observers.append(nc.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                if let at = self.backgroundedAt, Date().timeIntervalSince(at) >= Self.lockAfterBackground { self.model.lock() }
                self.backgroundedAt = nil
                self.model.dropExpiredFillGrace()
                Task { await self.refreshAutofillState() }
            }
        })
    }

    func lockByHand() {
        model.endFillGrace()
        model.lock()
        handLockEpoch = model.lockEpoch
    }

    /// Any other way to the lock screen (opening Passwords, coming back to it) asks Face ID.
    func clearLockedByHand() { handLockEpoch = nil }

    func refreshAutofillState() async {
        autofillEnabled = await ASCredentialIdentityStore.shared.state().isEnabled
        // Turned on since the last unlock: give iOS the list now if the items are open.
        if autofillEnabled == true, model.phase == .unlocked { await CredentialIdentities.replace(with: model.items) }
    }

    /// iOS's own "Allow Walnut to AutoFill?" prompt (iOS 18): one tap, no trip to Settings.
    func turnOnAutofill() async {
        let on = await VaultSystemPrompt.shared.during { await ASSettingsHelper.requestToTurnOnCredentialProviderExtension() }
        autofillEnabled = on
        if on, model.phase == .unlocked { await CredentialIdentities.replace(with: model.items) }
    }

    /// Settings, General, AutoFill & Passwords.
    func openAutofillSettings() {
        ASSettingsHelper.openCredentialProviderAppSettings { _ in }
    }

    /// Everything Passwords keeps on this iPhone goes; the vault on the Mac is untouched.
    func removeFromThisPhone() async {
        model.forget()
        await CredentialIdentities.removeAll()
    }

    /// This phone left its Walnut (Disconnect): the vault copy and its keys go with the pairing.
    func pairingRemoved() {
        VaultServerMirror.clear()
        Task { await removeFromThisPhone() }
    }
}

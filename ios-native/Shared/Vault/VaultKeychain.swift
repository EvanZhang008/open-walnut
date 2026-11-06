import Foundation
import LocalAuthentication
import Security

/// Where the app and its AutoFill extension keep what they share: one app group, which is also
/// the Keychain access group (iOS lets an app group name a shared Keychain group), so both read
/// the same items without a team prefix in the code.
enum VaultShared {
    static let appGroup = "group.dev.openwalnut.ios"

    /// The Keychain service. An app under test uses its own (`useTestKeychain`), so no test reads
    /// or deletes the real keys; the choice is kept in the app group, so the AutoFill extension
    /// iOS starts for that app reads the same items.
    static var keychainService: String {
        defaults.string(forKey: serviceKey) ?? "dev.openwalnut.vault"
    }
    private static let serviceKey = "walnut.vault.keychainService"

    static func useTestKeychain(_ on: Bool) {
        if on { defaults.set("dev.openwalnut.vault.tests", forKey: serviceKey) } else { defaults.removeObject(forKey: serviceKey) }
    }

    static var defaults: UserDefaults { UserDefaults(suiteName: appGroup) ?? .standard }

    /// The shared container (the cache lives here); the app's own container when the group is
    /// missing (an unsigned build), which only the app then reads.
    static var containerURL: URL {
        if let u = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup) { return u }
        return FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    }
}

/// The vault's secrets on this iPhone, in the Keychain only:
///  - the vault key, readable only after Face ID (Touch ID; the passcode where the phone has no
///    biometrics), this device only, never in a backup, and gone when Face ID changes;
///  - the Secret Key, this device only, readable while the phone is unlocked (it alone opens
///    nothing; with the master password it gives back the vault key);
///  - a copy of this phone's Walnut device token, so the extension can fetch the vault's newest
///    ciphertext by itself.
enum VaultKeychain {
    enum Failure: Error, Equatable {
        case canceled
        case notFound
        case unavailable(OSStatus)
    }

    private static func base(_ account: String) -> [String: Any] {
        var q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: VaultShared.keychainService,
            kSecAttrAccount as String: account,
        ]
        if accessGroupWorks { q[kSecAttrAccessGroup as String] = VaultShared.appGroup }
        return q
    }

    /// An unsigned build (a simulator build without the entitlement) has no access group; the
    /// items then live in the app's own Keychain, which the extension of such a build cannot read.
    private static let accessGroupWorks: Bool = {
        let probe: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "dev.openwalnut.vault.probe",
            kSecAttrAccount as String: "probe",
            kSecAttrAccessGroup as String: VaultShared.appGroup,
            kSecValueData as String: Data([1]),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        SecItemDelete(probe as CFDictionary)
        let status = SecItemAdd(probe as CFDictionary, nil)
        SecItemDelete(probe as CFDictionary)
        return status == errSecSuccess || status == errSecDuplicateItem
    }()

    static func vaultKeyAccount(_ vaultId: String) -> String { "vault-key:\(vaultId)" }
    static func secretKeyAccount(_ vaultId: String) -> String { "secret-key:\(vaultId)" }
    static let tokenAccount = "device-token"
    /// The vault key an AutoFill sheet keeps for the next one a moment later (`VaultModel.fillGrace`).
    static func graceAccount(_ vaultId: String) -> String { "vault-key-grace:\(vaultId)" }

    /// Face ID where the phone has it, else the passcode: what guards the vault key.
    static func guardFlags() -> SecAccessControlCreateFlags {
        let ctx = LAContext()
        var err: NSError?
        if ctx.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &err) { return .biometryCurrentSet }
        return .devicePasscode
    }

    static func setPlain(_ data: Data, account: String, accessible: CFString = kSecAttrAccessibleWhenUnlockedThisDeviceOnly) throws {
        let q = base(account)
        SecItemDelete(q as CFDictionary)
        var a = q
        a[kSecValueData as String] = data
        a[kSecAttrAccessible as String] = accessible
        let status = SecItemAdd(a as CFDictionary, nil)
        guard status == errSecSuccess else { throw Failure.unavailable(status) }
    }

    static func getPlain(account: String) -> Data? {
        var q = base(account)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: AnyObject?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess else { return nil }
        return out as? Data
    }

    static func setGuarded(_ data: Data, account: String) throws {
        let q = base(account)
        SecItemDelete(q as CFDictionary)
        var cfErr: Unmanaged<CFError>?
        guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly, guardFlags(), &cfErr)
                ?? SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, guardFlags(), &cfErr) else {
            throw Failure.unavailable(errSecParam)
        }
        var a = q
        a[kSecValueData as String] = data
        a[kSecAttrAccessControl as String] = access
        var status = SecItemAdd(a as CFDictionary, nil)
        if status != errSecSuccess {
            // A phone (or simulator) with no passcode cannot take "when passcode set": the same
            // guard on "when unlocked".
            if let alt = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, guardFlags(), &cfErr) {
                a[kSecAttrAccessControl as String] = alt
                status = SecItemAdd(a as CFDictionary, nil)
            }
        }
        guard status == errSecSuccess else { throw Failure.unavailable(status) }
    }

    /// Asks for Face ID (iOS draws the prompt) and returns the item. `context` lets a caller that
    /// already asked reuse the answer.
    static func getGuarded(account: String, reason: String, context: LAContext? = nil) throws -> Data {
        var q = base(account)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        let ctx = context ?? LAContext()
        ctx.localizedReason = reason
        q[kSecUseAuthenticationContext as String] = ctx
        var out: AnyObject?
        let status = SecItemCopyMatching(q as CFDictionary, &out)
        switch status {
        case errSecSuccess:
            guard let d = out as? Data else { throw Failure.notFound }
            return d
        case errSecUserCanceled, errSecAuthFailed: throw Failure.canceled
        case errSecItemNotFound: throw Failure.notFound
        default: throw Failure.unavailable(status)
        }
    }

    /// Is a guarded item there, without asking for Face ID.
    static func hasGuarded(account: String) -> Bool {
        var q = base(account)
        let ctx = LAContext()
        ctx.interactionNotAllowed = true
        q[kSecUseAuthenticationContext as String] = ctx
        q[kSecReturnAttributes as String] = true
        var out: AnyObject?
        let status = SecItemCopyMatching(q as CFDictionary, &out)
        return status == errSecSuccess || status == errSecInteractionNotAllowed
    }

    static func delete(account: String) {
        SecItemDelete(base(account) as CFDictionary)
    }

    /// Every key Passwords keeps on this iPhone, of any vault (one set up again on the Mac leaves
    /// the old vault's keys behind until then), and the token copy, which the app writes again at its
    /// next fetch.
    static func deleteAll() {
        var q = base("")
        q.removeValue(forKey: kSecAttrAccount as String)
        SecItemDelete(q as CFDictionary)
    }
}

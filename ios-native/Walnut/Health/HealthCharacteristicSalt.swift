import Foundation
import Security

/// Where the salt of the characteristic fingerprints lives (`HealthCharacteristicKey`).
/// On a phone, the Keychain (`HealthCharacteristicSalt`); in tests, memory.
protocol HealthSaltStore: AnyObject, Sendable {
    /// The salt, made the first time it is asked for and kept from then on.
    func salt() -> Data
    /// Forget it. The next `salt()` makes a new one, so every characteristic is
    /// sent once more, each with its old row id as `deleted`.
    func delete()
}

/// The per-install salt, in the Keychain: this device only, readable after the
/// first unlock, never synchronized, so it is in no backup and on no other
/// device. The sync progress file keeps only the fingerprints, so the file
/// alone cannot be tried against every birth date (gate r4, F2; r7 kept the
/// salt in the file).
///
/// No preferences fallback, unlike the token (`KeychainHelper`): a salt in the
/// preferences would sit next to nothing it protects. When the Keychain cannot
/// be read or written, the salt lives in memory for this process, and the next
/// process sends the characteristics once more. The fresh-install marker
/// removes it with the token (`InstallMarker`), and Disconnect removes it
/// (`HealthSync.eraseLocalState`).
final class HealthCharacteristicSalt: HealthSaltStore, @unchecked Sendable {
    static let shared = HealthCharacteristicSalt()

    static let defaultService = "dev.openwalnut.ios"
    static let defaultAccount = "walnut.health.characteristicSalt"

    private let service: String
    private let account: String
    private let lock = NSLock()
    private var cached: Data?

    init(service: String = HealthCharacteristicSalt.defaultService,
         account: String = HealthCharacteristicSalt.defaultAccount) {
        self.service = service
        self.account = account
    }

    enum Read: Equatable {
        case found(Data)
        case missing
        case unavailable(OSStatus)
    }

    func salt() -> Data {
        lock.withLock {
            if let cached { return cached }
            let salt: Data
            switch read() {
            case .found(let kept):
                salt = kept
            case .missing:
                salt = HealthCharacteristicKey.newSalt()
                let status = save(salt)
                if status != errSecSuccess {
                    AppLog.error("health", "characteristic salt not kept, memory only", ["status": "\(status)"])
                }
            case .unavailable(let status):
                salt = HealthCharacteristicKey.newSalt()
                AppLog.error("health", "characteristic salt unreadable, memory only", ["status": "\(status)"])
            }
            cached = salt
            return salt
        }
    }

    func delete() {
        lock.withLock {
            cached = nil
            SecItemDelete(baseQuery(synchronizable: kSecAttrSynchronizableAny) as CFDictionary)
        }
    }

    /// The Keychain item as it is now, not the copy in memory.
    func read() -> Read {
        var query = baseQuery(synchronizable: kCFBooleanFalse)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        switch status {
        case errSecSuccess:
            guard let data = result as? Data, data.count == 32 else { return .unavailable(errSecDecode) }
            return .found(data)
        case errSecItemNotFound:
            return .missing
        default:
            return .unavailable(status)
        }
    }

    /// The item's attributes, for the test that pins how it is kept.
    func attributes() -> [String: Any]? {
        var query = baseQuery(synchronizable: kSecAttrSynchronizableAny)
        query[kSecReturnAttributes as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess else { return nil }
        return result as? [String: Any]
    }

    private func save(_ salt: Data) -> OSStatus {
        SecItemDelete(baseQuery(synchronizable: kSecAttrSynchronizableAny) as CFDictionary)
        var attributes = baseQuery(synchronizable: kCFBooleanFalse)
        attributes[kSecValueData as String] = salt
        attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return SecItemAdd(attributes as CFDictionary, nil)
    }

    private func baseQuery(synchronizable: Any) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrSynchronizable as String: synchronizable,
        ]
    }
}

import Foundation
import Security
import os

/// Device-token store. Prefers the Keychain (kSecClassGenericPassword); falls
/// back to UserDefaults when the Keychain is unavailable.
///
/// Why the fallback: an unsigned build (simulator archives with no keychain
/// access group, or a stripped provisioning profile) makes `SecItemAdd` fail
/// with `errSecMissingEntitlement (-34018)`. The old code ignored that status,
/// so the token silently never persisted — every cold start bounced back to
/// setup and every authenticated request failed with "Server not configured"
/// while cached data masked it. We now check the status and degrade to
/// UserDefaults so the app keeps working; a properly signed device build still
/// uses the Keychain.
enum KeychainHelper {
    private static let service = "dev.openwalnut.ios"
    /// UserDefaults key prefix for the fallback store (namespaced to avoid
    /// colliding with the app's other prefs).
    private static let fallbackPrefix = "walnut.keychainFallback."

    static func set(_ value: String, forKey key: String) {
        let data = Data(value.utf8)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
        // Upsert: delete any existing item first, then add.
        SecItemDelete(query as CFDictionary)
        var attributes = query
        attributes[kSecValueData as String] = data
        attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        let status = SecItemAdd(attributes as CFDictionary, nil)
        if status == errSecSuccess {
            // Keychain took it — clear any stale fallback so reads prefer it.
            UserDefaults.standard.removeObject(forKey: fallbackPrefix + key)
        } else {
            // Keychain unavailable (e.g. -34018 on an unsigned build): persist
            // to UserDefaults so the token still survives a cold start.
            UserDefaults.standard.set(value, forKey: fallbackPrefix + key)
        }
    }

    #if DEBUG
    /// Keychain-read counter for LifecycleHygieneTests: proves AppConfig's
    /// in-process token cache actually spares the SecItemCopyMatching XPC.
    static let keychainReads = OSAllocatedUnfairLock(initialState: 0)
    #endif

    static func get(_ key: String) -> String? {
        #if DEBUG
        keychainReads.withLock { $0 += 1 }
        #endif
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecSuccess, let data = result as? Data, let value = String(data: data, encoding: .utf8) {
            return value
        }
        // Fall back to the UserDefaults copy written when the Keychain failed.
        return UserDefaults.standard.string(forKey: fallbackPrefix + key)
    }

    static func delete(_ key: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
        SecItemDelete(query as CFDictionary)
        UserDefaults.standard.removeObject(forKey: fallbackPrefix + key)
    }
}

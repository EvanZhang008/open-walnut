import Foundation

/// The vault's wire and item shapes (src/core/vault/types.ts, state.ts, routes/vault-sealed-v1.ts).
/// Unknown fields are ignored, so a newer Walnut that adds one (a hint, a new item field) still
/// opens here; a newer `version` does not (VaultHeader.supported).

struct VaultSealed: Codable, Equatable, Sendable {
    var iv: String
    var ct: String
}

struct VaultKdf: Codable, Equatable, Sendable {
    var name: String
    var iterations: Int
    var salt: String
}

/// What opening the vault needs: GET /api/v1/vault/sealed `vault`.
struct VaultHeader: Codable, Equatable, Sendable {
    var format: String
    var version: Int
    var id: String
    var rev: Int
    var updatedAt: String?
    var kdf: VaultKdf
    var aukSalt: String
    var wrap: VaultSealed
    var count: Int?
    var hint: String?

    static let knownFormat = "walnut-vault"
    static let knownVersion = 1
    var supported: Bool { format == Self.knownFormat && version <= Self.knownVersion }
}

/// One item as vault.json keeps it: its key under the vault key, its JSON under its key.
struct VaultStoredItem: Codable, Equatable, Sendable {
    var key: VaultSealed
    var data: VaultSealed
    var updatedAt: String?
    var tag: String?
}

struct VaultField: Codable, Equatable, Hashable, Sendable {
    var name: String
    var value: String
    var hidden: Bool?
}

struct VaultCard: Codable, Equatable, Hashable, Sendable {
    var holder: String?
    var number: String?
    var expMonth: String?
    var expYear: String?
    var code: String?
    var brand: String?
}

/// A passkey kept the way Bitwarden exports one (src/core/vault/passkey.ts): every value a string,
/// though an export may carry a number or a boolean, which reads as its text.
struct VaultPasskey: Decodable, Equatable, Hashable, Sendable {
    var values: [String: String]

    init(values: [String: String]) { self.values = values }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        var out: [String: String] = [:]
        for k in c.allKeys {
            if let s = try? c.decode(String.self, forKey: k) { out[k.stringValue] = s }
            else if let n = try? c.decode(Double.self, forKey: k) { out[k.stringValue] = n == n.rounded() && abs(n) < 9e15 ? String(Int64(n)) : String(n) }
            else if let b = try? c.decode(Bool.self, forKey: k) { out[k.stringValue] = b ? "true" : "false" }
        }
        values = out
    }

    var credentialId: String? { values["credentialId"] }
    var rpId: String? { values["rpId"]?.lowercased() }
    var rpName: String? { values["rpName"] }
    var userName: String? { values["userName"] }
    var userDisplayName: String? { values["userDisplayName"] }
    var userHandle: String? { values["userHandle"] }
    var keyValue: String? { values["keyValue"] }
    var counter: UInt32 {
        guard let raw = values["counter"], let n = Double(raw), n.isFinite, n > 0 else { return 0 }
        return UInt32(min(n, Double(UInt32.max)))
    }

    private struct AnyKey: CodingKey {
        var stringValue: String
        var intValue: Int?
        init?(stringValue: String) { self.stringValue = stringValue }
        init?(intValue: Int) { self.stringValue = String(intValue); self.intValue = intValue }
    }
}

enum VaultItemType: String, Codable, Sendable {
    case login, note, card, api_key, identity
    case other

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = VaultItemType(rawValue: raw) ?? .other
    }
}

/// Everything an item holds once opened.
struct VaultItem: Decodable, Identifiable, Equatable, Hashable, Sendable {
    var id: String
    var type: VaultItemType
    var title: String
    var username: String?
    var password: String?
    var urls: [String]?
    var totp: String?
    var notes: String?
    var fields: [VaultField]?
    var card: VaultCard?
    var envName: String?
    var passkeys: [VaultPasskey]?
    var tags: [String]?
    var favorite: Bool?
    var createdAt: String?
    var updatedAt: String?
    var usedAt: String?
    var trashedAt: String?

    var isTrashed: Bool { trashedAt != nil }
    var hasPassword: Bool { !(password ?? "").isEmpty }
    var hasTotp: Bool { TOTP.parse(totp ?? "") != nil }
    var hasUsername: Bool { !(username ?? "").isEmpty }
    /// The hosts of the item's sites (lower case), in the order saved.
    var hosts: [String] { (urls ?? []).compactMap(SiteMatch.host(of:)) }
    /// The first site's host, shown under the title when there is no username.
    var primaryHost: String? { hosts.first }
}

import CryptoKit
import Foundation

/// Signing in with a passkey kept in the vault (src/core/vault/passkey.ts): ES256 over the
/// authenticator data and the hash of the client data iOS passes in. Walnut's passkeys are synced
/// ones, backup eligible and backed up, with user presence and verification (Face ID) set.
/// This iPhone only signs in; it does not make new passkeys (the vault's writes stay on the Mac).
enum PasskeySigner {
    private static let flags: UInt8 = 0x01 | 0x04 | 0x08 | 0x10

    static func base64URLDecode(_ s: String) -> Data? {
        var t = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        t = t.trimmingCharacters(in: CharacterSet(charactersIn: "="))
        while t.count % 4 != 0 { t += "=" }
        return Data(base64Encoded: t)
    }

    /// The raw id of a stored credentialId: a GUID's 16 bytes, or "b64." + base64url.
    static func credentialIdBytes(_ stored: String) -> Data? {
        let guid = stored.replacingOccurrences(of: "-", with: "")
        if stored.count == 36, guid.count == 32, guid.allSatisfy(\.isHexDigit) {
            var out = Data()
            var i = guid.startIndex
            while i < guid.endIndex {
                let j = guid.index(i, offsetBy: 2)
                guard let b = UInt8(guid[i..<j], radix: 16) else { return nil }
                out.append(b)
                i = j
            }
            return out
        }
        if stored.hasPrefix("b64.") { return base64URLDecode(String(stored.dropFirst(4))).flatMap { $0.isEmpty ? nil : $0 } }
        return nil
    }

    static func canSign(_ pk: VaultPasskey) -> Bool {
        (pk.values["keyAlgorithm"] ?? "ECDSA") == "ECDSA" && (pk.values["keyCurve"] ?? "P-256") == "P-256" && privateKey(pk) != nil
    }

    static func privateKey(_ pk: VaultPasskey) -> P256.Signing.PrivateKey? {
        guard let raw = pk.keyValue, let der = base64URLDecode(raw) else { return nil }
        return try? P256.Signing.PrivateKey(derRepresentation: der)
    }

    /// The counter this use sends: none for a passkey that never counted, else one more than the
    /// highest it reached, the vault's or this phone's. The phone cannot write the vault, so it
    /// keeps its own last value (`seen`); sending the stored value + 1 twice would read to a site
    /// that checks counters as a cloned key.
    static func counter(_ pk: VaultPasskey, seen: UInt32 = 0) -> UInt32 {
        let n = max(pk.counter, seen)
        return n > 0 && n < UInt32.max ? n + 1 : n
    }

    /// This phone's last counter per credential, in the app group (the app and the extension share it).
    enum Counters {
        private static func key(_ credentialId: String) -> String { "walnut.vault.passkeyCounter.\(credentialId)" }
        static func seen(_ credentialId: String, in defaults: UserDefaults = VaultShared.defaults) -> UInt32 {
            UInt32(clamping: max(0, defaults.integer(forKey: key(credentialId))))
        }
        static func record(_ value: UInt32, for credentialId: String, in defaults: UserDefaults = VaultShared.defaults) {
            if value > seen(credentialId, in: defaults) { defaults.set(Int(value), forKey: key(credentialId)) }
        }
    }

    static func authenticatorData(rpId: String, counter: UInt32) -> Data {
        var out = Data(SHA256.hash(data: Data(rpId.utf8)))
        out.append(flags)
        out.append(contentsOf: withUnsafeBytes(of: counter.bigEndian, Array.init))
        return out
    }

    struct Assertion: Equatable {
        var authenticatorData: Data
        var signature: Data
        var credentialID: Data
        var userHandle: Data
    }

    static func assert(_ pk: VaultPasskey, rpId: String, clientDataHash: Data, counters: UserDefaults = VaultShared.defaults) -> Assertion? {
        guard pk.rpId == rpId.lowercased(), let cid = pk.credentialId, let idBytes = credentialIdBytes(cid), let key = privateKey(pk) else { return nil }
        let count = counter(pk, seen: Counters.seen(cid, in: counters))
        let auth = authenticatorData(rpId: rpId.lowercased(), counter: count)
        guard let sig = try? key.signature(for: auth + clientDataHash) else { return nil }
        Counters.record(count, for: cid, in: counters)
        return Assertion(authenticatorData: auth, signature: sig.derRepresentation, credentialID: idBytes,
                         userHandle: pk.userHandle.flatMap(base64URLDecode) ?? Data())
    }
}

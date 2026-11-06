import CommonCrypto
import CryptoKit
import Foundation

/// The vault's crypto, the same as the server's (src/core/vault/crypto.ts, docs/reference/passwords.md
/// "Keys"), so this iPhone opens the vault itself and nothing it reads is ever plaintext on the wire:
///
///     pwKey = PBKDF2-HMAC-SHA256(master password NFKC, kdf.salt, kdf.iterations, 32 bytes)
///     AUK   = HKDF-SHA256(ikm = pwKey || Secret Key bytes, salt = aukSalt, info = "walnut-vault-auk-v1")
///     VK    = AES-256-GCM open(AUK, wraps.password, "walnut-vault:<id>:wrap:password")
///     IK    = open(VK, item.key, "walnut-vault:<id>:item-key:<item id>")
///     item  = JSON(open(IK, item.data, "walnut-vault:<id>:item:<item id>"))
///
/// WebCrypto's AES-GCM output is the ciphertext with the 16-byte tag at its end, so a sealed value
/// is CryptoKit's combined form once the 12-byte nonce is put in front.
enum VaultCrypto {
    static let aukInfo = "walnut-vault-auk-v1"
    /// The floor the server and the browser extension hold too: a server naming a weaker KDF is
    /// refused, so nobody can make this phone derive a key that is cheap to guess.
    static let minIterations = 600_000
    /// The server's ceiling (src/core/vault/store.ts): a header asking for more is refused, not run.
    static let maxIterations = 10_000_000
    static let minSaltBytes = 16

    enum Failure: Error, Equatable {
        case weakKdf
        case unknownKdf(String)
        case badBase64
        case wrongKey
        case keyDerivation
    }

    static func checkKdf(_ kdf: VaultKdf) throws {
        guard kdf.name == "PBKDF2-SHA256" else { throw Failure.unknownKdf(kdf.name) }
        guard kdf.iterations >= minIterations, kdf.iterations <= maxIterations, let salt = Data(base64Encoded: kdf.salt), salt.count >= minSaltBytes else {
            throw Failure.weakKdf
        }
    }

    /// The master password as WebCrypto reads it: NFKC, then UTF-8.
    static func passwordKey(_ password: String, kdf: VaultKdf) throws -> Data {
        try checkKdf(kdf)
        guard let salt = Data(base64Encoded: kdf.salt) else { throw Failure.badBase64 }
        let pw = Data(password.precomposedStringWithCompatibilityMapping.utf8)
        var out = Data(count: 32)
        let status = out.withUnsafeMutableBytes { outPtr in
            salt.withUnsafeBytes { saltPtr in
                pw.withUnsafeBytes { pwPtr in
                    CCKeyDerivationPBKDF(
                        CCPBKDFAlgorithm(kCCPBKDF2),
                        pwPtr.baseAddress?.assumingMemoryBound(to: CChar.self), pw.count,
                        saltPtr.baseAddress?.assumingMemoryBound(to: UInt8.self), salt.count,
                        CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256), UInt32(kdf.iterations),
                        outPtr.baseAddress?.assumingMemoryBound(to: UInt8.self), 32)
                }
            }
        }
        guard status == kCCSuccess else { throw Failure.keyDerivation }
        return out
    }

    static func unlockKey(passwordKey: Data, secretKey: Data, aukSalt: Data) -> Data {
        let key = HKDF<SHA256>.deriveKey(
            inputKeyMaterial: SymmetricKey(data: passwordKey + secretKey),
            salt: aukSalt, info: Data(aukInfo.utf8), outputByteCount: 32)
        return key.withUnsafeBytes { Data($0) }
    }

    /// Throws `wrongKey` for a wrong key, a changed ciphertext or a different label.
    static func open(key: Data, sealed: VaultSealed, aad: String) throws -> Data {
        guard let iv = Data(base64Encoded: sealed.iv), let ct = Data(base64Encoded: sealed.ct) else { throw Failure.badBase64 }
        guard key.count == 32, iv.count == 12, ct.count >= 16 else { throw Failure.wrongKey }
        do {
            let box = try AES.GCM.SealedBox(combined: iv + ct)
            return try AES.GCM.open(box, using: SymmetricKey(data: key), authenticating: Data(aad.utf8))
        } catch {
            throw Failure.wrongKey
        }
    }

    static func aadWrap(_ vaultId: String) -> String { "walnut-vault:\(vaultId):wrap:password" }
    static func aadItemKey(_ vaultId: String, _ id: String) -> String { "walnut-vault:\(vaultId):item-key:\(id)" }
    static func aadItem(_ vaultId: String, _ id: String) -> String { "walnut-vault:\(vaultId):item:\(id)" }

    /// The vault key from the master password and the Secret Key.
    static func vaultKey(password: String, secretKey: Data, header: VaultHeader) throws -> Data {
        let pk = try passwordKey(password, kdf: header.kdf)
        guard let salt = Data(base64Encoded: header.aukSalt) else { throw Failure.badBase64 }
        let auk = unlockKey(passwordKey: pk, secretKey: secretKey, aukSalt: salt)
        return try open(key: auk, sealed: header.wrap, aad: aadWrap(header.id))
    }

    /// One item opened with the vault key.
    static func openItem(vaultKey: Data, vaultId: String, id: String, stored: VaultStoredItem) throws -> VaultItem {
        let ik = try open(key: vaultKey, sealed: stored.key, aad: aadItemKey(vaultId, id))
        let json = try open(key: ik, sealed: stored.data, aad: aadItem(vaultId, id))
        return try JSONDecoder().decode(VaultItem.self, from: json)
    }

    // MARK: - Secret Key text (W1-XXXXXX-XXXXX-XXXXX-XXXXX-XXXXX)

    /// 128 bits as 26 digits of this base-32 alphabet (no I, O, 0 or 1), the top 2 bits zero.
    private static let codeAlphabet = Array("ABCDEFGHJKLMNPQRSTUVWXYZ23456789")

    /// The Secret Key's 16 bytes, or nil when it is not well formed. Case, spaces and dashes are free.
    static func parseSecretKey(_ text: String) -> Data? {
        let t = text.uppercased().filter { !$0.isWhitespace && $0 != "-" && $0 != "\u{2010}" && $0 != "\u{2011}" && $0 != "\u{2013}" && $0 != "\u{2014}" }
        guard t.hasPrefix("W1") else { return nil }
        let digits = Array(t.dropFirst(2))
        guard digits.count == 26 else { return nil }
        // Big-endian 17-byte accumulator: shift left 5, add the digit.
        var acc = [UInt8](repeating: 0, count: 17)
        for ch in digits {
            guard let v = codeAlphabet.firstIndex(of: ch) else { return nil }
            var carry = UInt16(v)
            for i in stride(from: acc.count - 1, through: 0, by: -1) {
                let x = (UInt16(acc[i]) << 5) | carry
                acc[i] = UInt8(x & 0xFF)
                carry = x >> 8
            }
            guard carry == 0 else { return nil }
        }
        guard acc[0] == 0 else { return nil }
        return Data(acc[1...])
    }

    /// The Secret Key as Walnut writes it, for showing back.
    static func secretKeyText(_ bytes: Data) -> String {
        var acc = [UInt8](bytes)
        var digits: [Character] = []
        for _ in 0..<26 {
            // Divide the big-endian number by 32, keeping the remainder.
            var rem: UInt16 = 0
            for i in 0..<acc.count {
                let x = (rem << 8) | UInt16(acc[i])
                acc[i] = UInt8(x / 32)
                rem = x % 32
            }
            digits.insert(codeAlphabet[Int(rem)], at: 0)
        }
        let s = String(digits)
        func part(_ a: Int, _ b: Int) -> Substring { s[s.index(s.startIndex, offsetBy: a)..<s.index(s.startIndex, offsetBy: b)] }
        return "W1-\(part(0, 6))-\(part(6, 11))-\(part(11, 16))-\(part(16, 21))-\(part(21, 26))"
    }
}

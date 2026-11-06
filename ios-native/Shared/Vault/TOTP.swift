import CryptoKit
import Foundation

/// One-time codes (RFC 6238 over RFC 4226) from an otpauth:// URI or a bare base32 seed, the same
/// reading as the server's src/core/vault/totp.ts.
struct TOTP: Equatable, Sendable {
    enum Algorithm: String, Sendable { case sha1, sha256, sha512 }

    var secret: Data
    var digits: Int
    var period: Int
    var algorithm: Algorithm
    var issuer: String?
    var account: String?

    struct Code: Equatable, Sendable {
        var code: String
        var period: Int
        /// Seconds this code is still good for.
        var remaining: Int
    }

    private static let alphabet = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567")

    static func base32Decode(_ text: String) -> Data? {
        let t = text.uppercased().filter { !$0.isWhitespace && $0 != "=" && $0 != "-" }
        guard !t.isEmpty else { return nil }
        var bits = 0, value = 0
        var out = Data()
        for ch in t {
            guard let v = alphabet.firstIndex(of: ch) else { return nil }
            value = (value << 5) | v
            bits += 5
            if bits >= 8 {
                out.append(UInt8((value >> (bits - 8)) & 0xFF))
                bits -= 8
            }
            value &= 0xFFFF
        }
        return out
    }

    /// The parameters of a saved value, or nil for one that cannot make codes.
    static func parse(_ raw: String) -> TOTP? {
        let t = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return nil }
        guard t.lowercased().hasPrefix("otpauth://") else {
            guard let secret = base32Decode(t), secret.count >= 10 else { return nil }
            return TOTP(secret: secret, digits: 6, period: 30, algorithm: .sha1)
        }
        guard let u = URLComponents(string: t), u.host?.lowercased() == "totp" else { return nil }
        let q = Dictionary((u.queryItems ?? []).map { ($0.name.lowercased(), $0.value ?? "") }, uniquingKeysWith: { a, _ in a })
        guard let secret = base32Decode(q["secret"] ?? ""), secret.count >= 10 else { return nil }
        let digits = Int(q["digits"] ?? "6") ?? -1
        let period = Int(q["period"] ?? "30") ?? -1
        let alg: Algorithm?
        switch (q["algorithm"] ?? "SHA1").uppercased().replacingOccurrences(of: "-", with: "") {
        case "SHA1": alg = .sha1
        case "SHA256": alg = .sha256
        case "SHA512": alg = .sha512
        default: alg = nil
        }
        guard let algorithm = alg, [6, 7, 8].contains(digits), (10...300).contains(period) else { return nil }
        let label = (u.percentEncodedPath.removingPercentEncoding ?? u.path).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        var labelIssuer: String?
        var account: String? = label.isEmpty ? nil : label
        if let colon = label.firstIndex(of: ":") {
            labelIssuer = String(label[..<colon])
            account = String(label[label.index(after: colon)...]).trimmingCharacters(in: .whitespaces)
        }
        let issuer = q["issuer"].flatMap { $0.isEmpty ? nil : $0 } ?? labelIssuer
        return TOTP(secret: secret, digits: digits, period: period, algorithm: algorithm, issuer: issuer, account: account)
    }

    func code(at date: Date) -> Code {
        let seconds = Int64(floor(date.timeIntervalSince1970))
        var counter = UInt64(seconds / Int64(period)).bigEndian
        let msg = Data(bytes: &counter, count: 8)
        let key = SymmetricKey(data: secret)
        let mac: [UInt8]
        switch algorithm {
        case .sha1: mac = Array(HMAC<Insecure.SHA1>.authenticationCode(for: msg, using: key))
        case .sha256: mac = Array(HMAC<SHA256>.authenticationCode(for: msg, using: key))
        case .sha512: mac = Array(HMAC<SHA512>.authenticationCode(for: msg, using: key))
        }
        let off = Int(mac[mac.count - 1] & 15)
        let bin = (UInt32(mac[off] & 127) << 24) | (UInt32(mac[off + 1]) << 16) | (UInt32(mac[off + 2]) << 8) | UInt32(mac[off + 3])
        var mod: UInt32 = 1
        for _ in 0..<digits { mod *= 10 }
        var s = String(bin % mod)
        while s.count < digits { s = "0" + s }
        let remaining = period - Int(seconds % Int64(period))
        return Code(code: s, period: period, remaining: remaining)
    }
}

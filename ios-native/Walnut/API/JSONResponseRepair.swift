import Foundation

/// Two things every `/api/v1` response body needs on the way through `JSONDecoder`:
/// a repair for the one byte pattern that makes a whole page undecodable, and a
/// description of a decode failure that a field report can be diagnosed from.
///
/// WHY THE REPAIR EXISTS. `JSONDecoder` REJECTS a lone surrogate escape — a
/// `\uD800`-`\uDBFF` with no low half after it, or a `\uDC00`-`\uDFFF` with no high half
/// before it — and it rejects the WHOLE DOCUMENT, not the row. One truncated emoji
/// anywhere in a 100-row conversation page therefore blanked the entire conversation
/// (2026-09-12 gate: the transcript sat on "Your Personal AI is listening" with no
/// error, because the failure was swallowed). The server is being fixed to never emit
/// one, but the phone talks to servers of every age — the cloud replica runs weeks
/// behind — so the client degrades PER ROW instead of per page: the bad escape becomes
/// U+FFFD (the standard replacement character) and every row still arrives.
///
/// This works on the ESCAPE SEQUENCES in the JSON text, not on raw bytes, because a
/// lone surrogate cannot be UTF-8 encoded at all — a JSON producer has no way to send
/// one except as `\uXXXX`.
enum JSONResponseRepair {

    struct Result {
        let data: Data
        /// How many lone surrogate escapes were replaced (0 = the bytes are untouched).
        let repaired: Int
    }

    /// U+FFFD, spelled as a JSON escape so the replacement is exactly as long as what
    /// it replaces — the repair is then an in-place rewrite of 6 bytes, with no
    /// reallocation and no index bookkeeping.
    private static let replacement = Array("\\ufffd".utf8)

    /// The bytes as handed over, unless they carry a lone surrogate escape.
    ///
    /// ONE PASS, and only for bodies that could possibly contain one: the pre-scan
    /// looks for `\ud` / `\uD` (the only prefix a surrogate escape can have) and
    /// returns the original `Data` untouched when there is none, which is every
    /// response in practice.
    static func repairingLoneSurrogates(_ data: Data) -> Result {
        guard mayContainSurrogateEscape(data) else { return Result(data: data, repaired: 0) }
        var bytes = [UInt8](data)
        var repaired = 0
        var index = 0
        while index < bytes.count {
            // Only a backslash can start an escape. Anything else is one byte of text.
            guard bytes[index] == 0x5C else { index += 1; continue }
            // `\\u0041` is an escaped BACKSLASH followed by literal text — stepping
            // over both bytes of the pair is what keeps that from being read as an
            // escape. Same step for `\n`, `\"`, and every other two-byte escape.
            guard index + 1 < bytes.count, bytes[index + 1] == 0x75 else { index += 2; continue }
            guard let unit = escapedUnit(bytes, at: index) else { index += 2; continue }
            if (0xD800...0xDBFF).contains(unit) {
                if let low = escapedUnit(bytes, at: index + 6), (0xDC00...0xDFFF).contains(low) {
                    index += 12   // a well-formed pair: an emoji, left exactly as it came
                    continue
                }
                overwriteWithReplacement(&bytes, at: index)
                repaired += 1
            } else if (0xDC00...0xDFFF).contains(unit) {
                // A low half reached on its own: any high half before it would have
                // consumed it above, so there was none.
                overwriteWithReplacement(&bytes, at: index)
                repaired += 1
            }
            index += 6
        }
        return Result(data: repaired > 0 ? Data(bytes) : data, repaired: repaired)
    }

    /// A DecodingError as one loggable line: the case, the coding path (which row and
    /// which field), and Foundation's own `debugDescription`. Without the path a field
    /// report says only "Unexpected server response", which names nothing.
    static func describe(decodeFailure error: Error) -> String {
        guard let decoding = error as? DecodingError else { return String(describing: error) }
        func line(_ kind: String, _ context: DecodingError.Context) -> String {
            let path = context.codingPath.map(\.stringValue)
            return "\(kind) at [\(path.joined(separator: "."))]: \(context.debugDescription)"
        }
        switch decoding {
        case .dataCorrupted(let context):
            return line("dataCorrupted", context)
        case .keyNotFound(let key, let context):
            return line("keyNotFound(\(key.stringValue))", context)
        case .typeMismatch(let type, let context):
            return line("typeMismatch(\(type))", context)
        case .valueNotFound(let type, let context):
            return line("valueNotFound(\(type))", context)
        @unknown default:
            return String(describing: decoding)
        }
    }

    // MARK: - Bytes

    /// Could these bytes hold a surrogate escape at all? `\u` followed by `d`/`D` is
    /// the only prefix one can have (U+D800-U+DFFF), and no valid escape shares it.
    static func mayContainSurrogateEscape(_ data: Data) -> Bool {
        data.withUnsafeBytes { raw -> Bool in
            guard raw.count >= 6 else { return false }
            for i in 0...(raw.count - 6) where raw[i] == 0x5C && raw[i + 1] == 0x75 {
                // `| 0x20` lower-cases an ASCII letter, so `\uD` and `\ud` both hit.
                if raw[i + 2] | 0x20 == 0x64 { return true }
            }
            return false
        }
    }

    /// The code unit of the `\uXXXX` starting at `index`, or nil when that is not what
    /// is there (a short tail, a non-hex digit).
    private static func escapedUnit(_ bytes: [UInt8], at index: Int) -> UInt16? {
        guard index >= 0, index + 5 < bytes.count,
              bytes[index] == 0x5C, bytes[index + 1] == 0x75 else { return nil }
        var value: UInt16 = 0
        for offset in 2...5 {
            guard let digit = hexValue(bytes[index + offset]) else { return nil }
            value = value << 4 | UInt16(digit)
        }
        return value
    }

    private static func hexValue(_ byte: UInt8) -> UInt8? {
        switch byte {
        case 0x30...0x39: return byte - 0x30              // 0-9
        case 0x41...0x46: return byte - 0x41 + 10         // A-F
        case 0x61...0x66: return byte - 0x61 + 10         // a-f
        default: return nil
        }
    }

    private static func overwriteWithReplacement(_ bytes: inout [UInt8], at index: Int) {
        for (offset, byte) in replacement.enumerated() { bytes[index + offset] = byte }
    }
}

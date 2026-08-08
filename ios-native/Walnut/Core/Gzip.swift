import Foundation
import zlib

/// Minimal gzip deflate over zlib (bundled with iOS — no dependency added).
///
/// Used by the log uploader: full-dump client logs are highly repetitive JSON
/// (same keys, same subsystems, ISO timestamps) and compress ~8-10×, which is
/// what makes "upload everything" affordable on cellular. Express's
/// `express.json()` inflates `Content-Encoding: gzip` bodies transparently, and
/// the cloud reverse proxy passes the header through, so no server work is
/// needed — but the caller still falls back to identity if a 4xx ever suggests
/// otherwise (see AppLog.disableCompression).
///
/// `Foundation`'s own `NSData.compressed(using: .zlib)` is raw DEFLATE with a
/// zlib wrapper, NOT gzip framing, so it is not interchangeable here.
enum Gzip {
    /// nil on any zlib error — the caller then sends the body uncompressed.
    static func compress(_ data: Data, level: Int32 = Z_DEFAULT_COMPRESSION) -> Data? {
        guard !data.isEmpty else { return nil }

        var stream = z_stream()
        // windowBits 15 + 16 = zlib's "write a gzip header/trailer" mode.
        let status = deflateInit2_(
            &stream, level, Z_DEFLATED, 15 + 16, 8, Z_DEFAULT_STRATEGY,
            ZLIB_VERSION, Int32(MemoryLayout<z_stream>.size)
        )
        guard status == Z_OK else { return nil }
        defer { deflateEnd(&stream) }

        var output = Data(capacity: data.count / 4 + 64)
        let chunkSize = 32 * 1024
        var chunk = [UInt8](repeating: 0, count: chunkSize)
        var input = data

        let result: Data? = input.withUnsafeMutableBytes { rawInput -> Data? in
            stream.next_in = rawInput.bindMemory(to: UInt8.self).baseAddress
            stream.avail_in = uInt(rawInput.count)
            repeat {
                let flushResult: Int32 = chunk.withUnsafeMutableBufferPointer { buffer -> Int32 in
                    stream.next_out = buffer.baseAddress
                    stream.avail_out = uInt(chunkSize)
                    return deflate(&stream, Z_FINISH)
                }
                guard flushResult == Z_OK || flushResult == Z_STREAM_END || flushResult == Z_BUF_ERROR else {
                    return nil
                }
                let produced = chunkSize - Int(stream.avail_out)
                if produced > 0 { output.append(contentsOf: chunk[0..<produced]) }
                if flushResult == Z_STREAM_END { return output }
                // Z_BUF_ERROR with no progress and no room left = wedged.
                if flushResult == Z_BUF_ERROR, produced == 0 { return nil }
            } while true
        }
        return result
    }
}

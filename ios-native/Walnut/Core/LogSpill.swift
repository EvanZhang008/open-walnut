import Foundation

/// Disk-backed FIFO of ready-to-send log lines (one JSON object per line, the
/// exact wire shape `POST /api/v1/client-logs` expects).
///
/// WHY THIS EXISTS: AppLog's in-memory ring capped at 2000 entries and evicted
/// the OLDEST lines on overflow — silently, with no counter. In full-dump mode
/// (every level, every subsystem) that is precisely backwards: an app that spent
/// an hour offline dropped exactly the hour we wanted to read, and the log
/// arrived looking complete. This is the durable tier:
///
///  - **append is O(new bytes)** — no whole-buffer re-encode per persist (the
///    old design rewrote a 2000-element JSON array every time).
///  - **acking a batch does not rewrite the file.** A sidecar holds the byte
///    offset of the first unsent line; the log is compacted only once the
///    consumed prefix is large, so draining a 16 MB backlog is O(size), not
///    O(size²/batch).
///  - **drops are counted.** Oldest-first eviction happens only when the byte
///    cap is genuinely exceeded, and `takeDroppedCount()` lets AppLog emit a
///    "we lost n lines here" line so the server sees a labelled gap instead of
///    an unexplained one.
///
/// Crash semantics: the cursor is advanced only AFTER the server 2xx. A kill
/// between the 2xx and the cursor write re-sends that batch (duplicates on the
/// server, detectable via the monotonic `seq` field) — never loses it.
///
/// Thread-safety: every public method takes `lock`. Callers include the AppLog
/// persistence queue, the upload task, and — on a freeze — the watchdog queue,
/// so nothing here may touch the main thread.
final class LogSpill: @unchecked Sendable {
    private let fileURL: URL
    private let cursorURL: URL
    private let lock = NSLock()

    /// Byte offset of the first line that has NOT been acknowledged.
    private var cursor: UInt64 = 0
    /// Cached file size so `append` doesn't stat on every call.
    private var fileSize: UInt64 = 0
    /// Lines evicted by the cap since the last `takeDroppedCount()`.
    private var dropped = 0

    /// Unread bytes we are willing to retain. ~16 MB ≈ 60k lines ≈ several days
    /// of full-dump traffic for a heavy day (see the volume note in AppLog).
    private let maxUnreadBytes: UInt64
    /// Compact when the consumed prefix passes this — amortizes the rewrite.
    private static let compactThreshold: UInt64 = 2 * 1024 * 1024

    init(directory: URL, name: String = "walnut-applog", maxUnreadBytes: UInt64 = 16 * 1024 * 1024) {
        self.fileURL = directory.appendingPathComponent("\(name).jsonl")
        self.cursorURL = directory.appendingPathComponent("\(name).cursor")
        self.maxUnreadBytes = maxUnreadBytes
        fileSize = Self.sizeOf(fileURL)
        if let raw = try? String(contentsOf: cursorURL, encoding: .utf8),
           let saved = UInt64(raw.trimmingCharacters(in: .whitespacesAndNewlines)) {
            cursor = min(saved, fileSize)
        }
    }

    // MARK: - Write

    /// Append complete JSON lines (no trailing newline needed — added here).
    /// Enforces the byte cap afterwards.
    func append(_ lines: [String]) {
        guard !lines.isEmpty else { return }
        var blob = Data()
        for line in lines {
            blob.append(contentsOf: line.utf8)
            blob.append(UInt8(ascii: "\n"))
        }
        lock.lock()
        defer { lock.unlock() }
        appendLocked(blob)
        enforceCapLocked()
    }

    private func appendLocked(_ blob: Data) {
        let manager = FileManager.default
        if !manager.fileExists(atPath: fileURL.path) {
            try? blob.write(to: fileURL, options: .atomic)
            fileSize = UInt64(blob.count)
            cursor = 0
            writeCursorLocked()
            return
        }
        guard let handle = try? FileHandle(forWritingTo: fileURL) else {
            // Unwritable (disk full / sandbox oddity): start over rather than
            // silently accumulating nothing.
            try? blob.write(to: fileURL, options: .atomic)
            fileSize = UInt64(blob.count)
            cursor = 0
            writeCursorLocked()
            return
        }
        defer { try? handle.close() }
        do {
            try handle.seekToEnd()
            try handle.write(contentsOf: blob)
            fileSize += UInt64(blob.count)
        } catch {
            // Leave fileSize alone; a re-stat on the next cap check self-heals.
            fileSize = Self.sizeOf(fileURL)
        }
    }

    // MARK: - Read

    /// The oldest unsent lines, bounded by count AND bytes. `consumedBytes` is
    /// what to hand back to `commit` once the server has accepted them.
    func peek(maxLines: Int, maxBytes: Int) -> (lines: [String], consumedBytes: Int) {
        lock.lock()
        defer { lock.unlock() }
        guard fileSize > cursor else { return ([], 0) }
        guard let handle = try? FileHandle(forReadingFrom: fileURL) else { return ([], 0) }
        defer { try? handle.close() }
        do {
            try handle.seek(toOffset: cursor)
        } catch { return ([], 0) }
        // Read a little past maxBytes so the boundary line is complete.
        guard let chunk = try? handle.read(upToCount: maxBytes + 64 * 1024), !chunk.isEmpty else {
            return ([], 0)
        }

        var lines: [String] = []
        var consumed = 0
        var start = chunk.startIndex
        while lines.count < maxLines, consumed < maxBytes {
            guard let newline = chunk[start...].firstIndex(of: UInt8(ascii: "\n")) else { break }
            let raw = chunk[start..<newline]
            let length = chunk.distance(from: start, to: newline) + 1
            // Skip blanks/garbage but still consume their bytes — a corrupt
            // line must never wedge the queue forever.
            if !raw.isEmpty, let text = String(data: raw, encoding: .utf8), text.hasPrefix("{") {
                lines.append(text)
            }
            consumed += length
            start = chunk.index(after: newline)
        }
        return (lines, consumed)
    }

    /// Acknowledge `consumedBytes` from the head. Compacts when the consumed
    /// prefix gets big enough to be worth a rewrite.
    func commit(consumedBytes: Int) {
        guard consumedBytes > 0 else { return }
        lock.lock()
        defer { lock.unlock() }
        cursor = min(cursor + UInt64(consumedBytes), fileSize)
        if cursor >= fileSize {
            // Fully drained — truncate instead of compacting (the common case).
            try? Data().write(to: fileURL, options: .atomic)
            fileSize = 0
            cursor = 0
        } else if cursor >= Self.compactThreshold {
            compactLocked()
        }
        writeCursorLocked()
    }

    // MARK: - Introspection

    var unreadBytes: Int {
        lock.lock()
        defer { lock.unlock() }
        return Int(fileSize > cursor ? fileSize - cursor : 0)
    }

    var isEmpty: Bool { unreadBytes == 0 }

    /// Read-and-reset the eviction counter (AppLog turns it into a log line).
    func takeDroppedCount() -> Int {
        lock.lock()
        defer { lock.unlock() }
        let count = dropped
        dropped = 0
        return count
    }

    /// One-time import of the pre-spill format (a single JSON array of entries
    /// written by builds ≤35). Returns the number of lines recovered.
    /// The legacy file is deleted afterwards so this runs once.
    func importLegacyArray(at url: URL, transform: (Data) -> String?) -> Int {
        guard let data = try? Data(contentsOf: url) else { return 0 }
        defer { try? FileManager.default.removeItem(at: url) }
        guard let array = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { return 0 }
        let lines = array.compactMap { entry -> String? in
            guard let encoded = try? JSONSerialization.data(withJSONObject: entry) else { return nil }
            return transform(encoded)
        }
        append(lines)
        return lines.count
    }

    // MARK: - Internals

    /// Rewrite the file without the consumed prefix. Atomic via a sibling temp
    /// file (same directory — EXDEV otherwise).
    private func compactLocked() {
        guard let handle = try? FileHandle(forReadingFrom: fileURL) else { return }
        defer { try? handle.close() }
        guard (try? handle.seek(toOffset: cursor)) != nil,
              let tail = try? handle.readToEnd()
        else { return }
        do {
            try tail.write(to: fileURL, options: .atomic)
            fileSize = UInt64(tail.count)
            cursor = 0
        } catch { /* keep the cursor; next commit retries */ }
    }

    /// Drop the OLDEST lines until we're back under the cap. Called with the
    /// lock held, right after an append.
    private func enforceCapLocked() {
        guard fileSize - min(cursor, fileSize) > maxUnreadBytes else { return }
        // Compact first: the "overflow" may be nothing but an already-sent prefix.
        if cursor > 0 { compactLocked() }
        guard fileSize > maxUnreadBytes else { writeCursorLocked(); return }

        // Still over: shed the oldest ~25% so this doesn't run on every append.
        let target = maxUnreadBytes * 3 / 4
        let shed = Int(fileSize - target)
        guard let handle = try? FileHandle(forReadingFrom: fileURL) else { return }
        defer { try? handle.close() }
        guard (try? handle.seek(toOffset: cursor)) != nil,
              let chunk = try? handle.read(upToCount: shed + 64 * 1024), !chunk.isEmpty
        else { return }

        var consumed = 0
        var evicted = 0
        var index = chunk.startIndex
        while consumed < shed, let newline = chunk[index...].firstIndex(of: UInt8(ascii: "\n")) {
            consumed += chunk.distance(from: index, to: newline) + 1
            evicted += 1
            index = chunk.index(after: newline)
        }
        guard consumed > 0 else { return }
        cursor += UInt64(consumed)
        dropped += evicted
        compactLocked()
        writeCursorLocked()
    }

    private func writeCursorLocked() {
        try? String(cursor).data(using: .utf8)?.write(to: cursorURL, options: .atomic)
    }

    private static func sizeOf(_ url: URL) -> UInt64 {
        let attributes = try? FileManager.default.attributesOfItem(atPath: url.path)
        return (attributes?[.size] as? NSNumber)?.uint64Value ?? 0
    }
}

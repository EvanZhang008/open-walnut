import Foundation
import UIKit

/// Structured in-app logger with auto-upload — the TestFlight debugging story.
///
/// `AppLog.log("sse", "stream stalled", ["gap": "52s"])` appends to a bounded
/// in-memory buffer that persists to disk on background and uploads to the
/// server (`POST /api/v1/client-logs`) opportunistically: on foreground,
/// after errors, and whenever the buffer grows past a threshold. Uploads are
/// best-effort — failures keep the lines for the next attempt.
final class AppLog: @unchecked Sendable {
    static let shared = AppLog()

    private struct Entry: Codable {
        /// Monotonic per-process identity. Uploads are acknowledged BY SEQUENCE,
        /// never by count: `removeFirst(batch.count)` silently discarded
        /// never-uploaded lines whenever the buffer changed shape mid-flight —
        /// the `maxBuffered` trim (or a `clear`) drops from the FRONT, so after a
        /// trim the first `batch.count` entries were no longer the batch that was
        /// acknowledged, and the difference was thrown away unsent. That is
        /// exactly the crash/freeze window where losing lines hurts most.
        ///
        /// Optional for decode compatibility with buffers persisted by older
        /// builds; those entries are treated as pre-sequence and dropped by the
        /// same rule as everything below the acknowledged high-water mark.
        var seq: UInt64?
        let ts: String
        let level: String
        let subsystem: String
        let message: String
        var meta: [String: String]?
    }

    private let lock = NSLock()
    private var buffer: [Entry] = []
    /// Next sequence to hand out. Never reset within a process lifetime.
    private var nextSequence: UInt64 = 1
    private var uploading = false
    private var errorFlushWorkItem: DispatchWorkItem?
    /// While backgrounded, uploads never START (persist-only); lines stay
    /// buffered for the next foreground flush.
    private var inBackground = false
    private let persistenceQueue = DispatchQueue(label: "dev.openwalnut.applog.persist", qos: .utility)

    /// Device identity snapshot, cached at first main-thread touch. The
    /// upload path previously fetched these via `await MainActor.run` — which
    /// never returns while the main thread is FROZEN, silently hanging the
    /// very upload that was supposed to report the freeze (see
    /// MainThreadWatchdog). Cached values keep uploads main-thread-free.
    private var cachedDevice = "unknown"
    private var cachedOS = "iOS ?"

    /// Call from the main thread at startup (WalnutApp.init).
    @MainActor
    func captureDeviceIdentity() {
        let device = AppConfig.deviceName ?? UIDevice.current.name
        let os = "iOS \(UIDevice.current.systemVersion)"
        lock.lock()
        cachedDevice = device
        cachedOS = os
        lock.unlock()
    }

    private static let maxBuffered = 2000
    private static let uploadThreshold = 200
    private static let persistURL: URL = {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("walnut-applog.json")
    }()

    private init() {
        // Recover lines that didn't make it out before the last termination.
        if let data = try? Data(contentsOf: Self.persistURL),
           let saved = try? JSONDecoder().decode([Entry].self, from: data) {
            // Re-sequence recovered lines: sequences are per-process, and a
            // previous process's numbers would collide with the ones this
            // process hands out.
            buffer = saved.suffix(Self.maxBuffered).map { entry in
                var renumbered = entry
                renumbered.seq = nextSequence
                nextSequence += 1
                return renumbered
            }
        }
        NotificationCenter.default.addObserver(
            forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: nil
        ) { [weak self] _ in
            guard let self else { return }
            // Background = persist only. Also disarm any pending error-flush:
            // a 12s-old debounce firing mid-suspension would start the exact
            // background upload this batch removes.
            self.lock.lock()
            self.errorFlushWorkItem?.cancel()
            self.errorFlushWorkItem = nil
            self.inBackground = true
            self.lock.unlock()
            self.persistAsynchronously()
        }
        NotificationCenter.default.addObserver(
            forName: UIApplication.willEnterForegroundNotification, object: nil, queue: nil
        ) { [weak self] _ in
            guard let self else { return }
            self.lock.lock()
            self.inBackground = false
            self.lock.unlock()
            self.uploadIfNeeded(force: true)
        }
    }

    // MARK: - Logging

    static func info(_ subsystem: String, _ message: String, _ meta: [String: String]? = nil) {
        shared.append(level: "info", subsystem: subsystem, message: message, meta: meta)
    }

    static func error(_ subsystem: String, _ message: String, _ meta: [String: String]? = nil) {
        shared.append(level: "error", subsystem: subsystem, message: message, meta: meta)
    }

    private func append(level: String, subsystem: String, message: String, meta: [String: String]?) {
        var entry = Entry(
            ts: ISO8601DateFormatter().string(from: Date()),
            level: level, subsystem: subsystem, message: message, meta: meta
        )
        #if DEBUG
        print("[\(level)] \(subsystem): \(message) \(meta ?? [:])")
        #endif
        lock.lock()
        entry.seq = nextSequence
        nextSequence += 1
        buffer.append(entry)
        if buffer.count > Self.maxBuffered {
            buffer.removeFirst(buffer.count - Self.maxBuffered)
        }
        let count = buffer.count
        lock.unlock()
        if count >= Self.uploadThreshold {
            uploadIfNeeded(force: false)
        }
        if level == "error" { scheduleErrorFlush() }
    }

    // MARK: - Persistence + upload

    /// Public flush point for callers holding must-not-lose lines (crash
    /// diagnostics): write the buffer to disk NOW so a follow-up crash or
    /// kill can't eat them before the next background-triggered persist.
    func persistNow() {
        persist()
    }

    private func persist() {
        lock.lock()
        let snapshot = buffer
        lock.unlock()
        if let data = try? JSONEncoder().encode(snapshot) {
            try? data.write(to: Self.persistURL, options: .atomic)
        }
    }

    private func persistAsynchronously() {
        persistenceQueue.async { [weak self] in self?.persist() }
    }

    private func scheduleErrorFlush() {
        lock.lock()
        errorFlushWorkItem?.cancel()
        let item = DispatchWorkItem { [weak self] in self?.uploadIfNeeded(force: true) }
        errorFlushWorkItem = item
        lock.unlock()
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 12, execute: item)
    }

    /// Connectivity recovery is a high-value flush point: send the offline trace
    /// immediately once the network is usable again.
    func flushAfterConnectivityRecovery() {
        uploadIfNeeded(force: true)
    }

    /// Escape hatch for must-not-lose diagnostics (a main-thread freeze the user
    /// is about to force-quit). Bypasses the `inBackground` upload gate for ONE
    /// attempt and wraps it in a background task so the OS grants time even
    /// while the app is being suspended. Everything else keeps the gate: routine
    /// log traffic must not burn background execution time.
    func uploadCritical() {
        uploadIfNeeded(force: true, ignoreBackgroundGate: true, guardedByBackgroundTask: true)
    }

    /// Push buffered lines to the server. Lines are only dropped after a 2xx —
    /// any failure keeps them buffered for the next trigger.
    func uploadIfNeeded(force: Bool) {
        uploadIfNeeded(force: force, ignoreBackgroundGate: false, guardedByBackgroundTask: false)
    }

    private func uploadIfNeeded(force: Bool, ignoreBackgroundGate: Bool, guardedByBackgroundTask: Bool) {
        lock.lock()
        guard ignoreBackgroundGate || !inBackground,
              !uploading, !buffer.isEmpty, force || buffer.count >= Self.uploadThreshold,
              let base = AppConfig.serverURL, let token = AppConfig.token
        else { lock.unlock(); return }
        uploading = true
        let batch = buffer
        lock.unlock()

        // `beginBackgroundTask` is thread-safe (documented) so this is callable
        // from the watchdog queue while the main thread is stuck.
        let bgTask: UIBackgroundTaskIdentifier = guardedByBackgroundTask
            ? UIApplication.shared.beginBackgroundTask(withName: "walnut.applog.critical")
            : .invalid

        Task.detached(priority: .utility) { [weak self] in
            guard let self else { return }
            defer {
                self.finishUpload()
                if bgTask != .invalid { UIApplication.shared.endBackgroundTask(bgTask) }
            }
            guard let url = URL(string: base.absoluteString + "/api/v1/client-logs") else { return }
            var request = URLRequest(url: url)
            request.httpMethod = "POST"
            request.timeoutInterval = 15
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")

            let lines = batch.map { entry -> [String: String] in
                var line = ["ts": entry.ts, "level": entry.level, "subsystem": entry.subsystem, "message": entry.message]
                entry.meta?.forEach { line["m_\($0.key)"] = $0.value }
                return line
            }
            // Cached identity, NOT MainActor.run — a frozen main thread would
            // block that await forever and the freeze report would never send.
            let (device, os) = self.deviceIdentity()
            let payload: [String: Any] = [
                "device": device,
                "appVersion": Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "?",
                "os": os,
                "lines": lines,
            ]
            guard let body = try? JSONSerialization.data(withJSONObject: payload) else { return }
            request.httpBody = body

            guard let (_, response) = try? await URLSession.shared.data(for: request),
                  let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode)
            else { return } // keep lines buffered; next trigger retries

            // Drop exactly the lines that were uploaded, BY IDENTITY (new
            // appends and anything the buffer trim reshuffled meanwhile survive).
            self.dropUploaded(through: batch.last?.seq)
            self.persist()
        }
    }

    /// Sync helpers — NSLock lock/unlock are unavailable in async contexts.
    private func deviceIdentity() -> (String, String) {
        lock.lock()
        defer { lock.unlock() }
        return (cachedDevice, cachedOS)
    }

    private func finishUpload() {
        lock.lock(); uploading = false; lock.unlock()
    }

    /// Remove every buffered entry whose sequence the server has acknowledged.
    /// Sequence-based, not count-based — see `Entry.seq`.
    private func dropUploaded(through highWater: UInt64?) {
        guard let highWater else { return }
        lock.lock()
        buffer.removeAll { entry in
            // A nil seq can only be a pre-sequence recovered line, and those are
            // renumbered on load — treat any survivor as older than the mark.
            (entry.seq ?? 0) <= highWater
        }
        lock.unlock()
    }
}

import Foundation
import UIKit

/// Structured in-app logger with auto-upload — the TestFlight debugging story.
///
/// `AppLog.info("sse", "stream stalled", ["gap": "52s"])` stages a line in
/// memory, which a background flush moves into a durable disk queue
/// (`LogSpill`), which a batched uploader drains to
/// `POST /api/v1/client-logs`. Lines leave the disk queue only after a 2xx.
///
/// ## Full-dump mode (the TestFlight default)
///
/// EVERY level from EVERY subsystem is retained and uploaded — `debug` included.
/// The design goal is that after a field incident we can reconstruct the app's
/// minute-by-minute behavior without asking the user anything, so the pipeline
/// is built to make dropping a line hard and to make an unavoidable drop
/// VISIBLE:
///
///  - **Durable, not a ring.** The old in-memory-only buffer capped at 2000
///    entries and evicted the oldest silently; an hour offline lost exactly the
///    hour worth reading, and the uploaded log looked complete. Now the cap is
///    ~16 MB on disk (days of traffic) and eviction emits a `dropped lines`
///    line so a gap is labelled rather than invisible.
///  - **Batched, never per-line.** A 45 s timer plus a line-count threshold —
///    whichever comes first. Nothing about a log call touches the network.
///  - **Compressed when the server can take it.** Bodies go up
///    `Content-Encoding: gzip` (~8-10× on this kind of repetitive JSON). If a
///    server rejects that, the process falls back to identity for good and the
///    preference is remembered across launches, so compression can never cost
///    us a log.
///  - **Hot path is cheap.** Append = one struct into an array under an NSLock,
///    an O(1) hand-rolled timestamp (no `ISO8601DateFormatter` allocation per
///    call, which the old code paid on every line), no JSON encoding, no I/O.
///    Encoding happens on the flush queue.
///
/// ## Main-thread-free
///
/// Appending, flushing, persisting and uploading are all callable while the
/// main thread is FROZEN — that is what makes `MainThreadWatchdog`'s report
/// escape a hang. Nothing in here may `await MainActor.run`, read UIKit state
/// (device identity is cached at startup instead), or hop to the main queue.
final class AppLog: @unchecked Sendable {
    static let shared = AppLog()

    /// Severity. Ordered so a minimum-level filter is a comparison; full-dump
    /// mode sets the minimum to `.debug`, i.e. keep everything.
    enum Level: Int {
        case debug = 0, info = 1, warn = 2, error = 3

        var wire: String {
            switch self {
            case .debug: return "debug"
            case .info: return "info"
            case .warn: return "warn"
            case .error: return "error"
            }
        }
    }

    private struct Entry {
        /// Monotonic per-process identity, uploaded with the line. The server
        /// can spot the duplicate batch a kill-between-2xx-and-ack produces
        /// (the disk cursor advances only after the 2xx), and a jump in `seq`
        /// with no `dropped lines` marker means the app died holding lines.
        let seq: UInt64
        let ts: String
        let level: Level
        let subsystem: String
        let message: String
        let meta: [String: String]?
    }

    private let lock = NSLock()
    /// Lines not yet written to the disk queue. Small and short-lived: the
    /// flush timer drains it every `flushInterval`, and a threshold drains it
    /// sooner. This is NOT the retention tier — `spill` is.
    private var staged: [Entry] = []
    private var nextSequence: UInt64 = 1
    private var uploading = false
    private var errorFlushWorkItem: DispatchWorkItem?
    /// While backgrounded, uploads never START (persist-only); lines stay on
    /// disk for the next foreground flush.
    private var inBackground = false
    /// Set once a server has rejected a compressed body — identity from then on.
    private var compressionDisabled = false

    private let queue = DispatchQueue(label: "dev.openwalnut.applog", qos: .utility)
    private var flushTimer: DispatchSourceTimer?
    private var uploadTimer: DispatchSourceTimer?

    /// Durable queue. Everything that survives a relaunch lives here.
    private let spill: LogSpill

    /// Device identity snapshot, cached at first main-thread touch. The upload
    /// path previously fetched these via `await MainActor.run` — which never
    /// returns while the main thread is FROZEN, silently hanging the very
    /// upload that was supposed to report the freeze (see MainThreadWatchdog).
    private var cachedDevice = "unknown"
    private var cachedOS = "iOS ?"

    // MARK: - Tuning

    /// Full-dump default. Overridable with the `walnut.logLevel` UserDefaults
    /// key ("debug"/"info"/"warn"/"error") if a build ever needs to dial back.
    private static let defaultMinimumLevel: Level = .debug
    private static let levelKey = "walnut.logLevel"
    private static let compressionDisabledKey = "walnut.logCompressionDisabled"

    private let minimumLevel: Level

    /// Staging → disk cadence (also: every `stagedFlushLines` lines).
    private static let flushInterval: TimeInterval = 5
    private static let stagedFlushLines = 64
    /// Disk → server cadence, and the line count that beats the timer to it.
    private static let uploadInterval: TimeInterval = 45
    private static let uploadThresholdLines = 200
    /// Per-request bounds. The server accepts 5000 lines / 20 MB per device-day
    /// file, so keep a batch well inside one request while still draining a
    /// backlog in a handful of round-trips.
    private static let maxLinesPerBatch = 1000
    private static let maxBytesPerBatch = 512 * 1024

    private static let supportDirectory: URL = {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }()
    /// Pre-spill format (a single JSON array), imported once then deleted.
    private static let legacyPersistURL = supportDirectory.appendingPathComponent("walnut-applog.json")

    private init() {
        let configured = UserDefaults.standard.string(forKey: Self.levelKey)
        minimumLevel = Self.parseLevel(configured) ?? Self.defaultMinimumLevel
        compressionDisabled = UserDefaults.standard.bool(forKey: Self.compressionDisabledKey)
        spill = LogSpill(directory: Self.supportDirectory)

        // Recover lines a previous build left in the old array format — on
        // the utility queue, NOT here: AppLog.init runs on the main thread
        // before the first frame, and the import is a full read + JSON parse
        // + re-encode + write of a multi-hundred-KB file (audit TMR-3).
        // LogSpill.append takes the spill lock, so lines logged before the
        // import lands are safe (they just order after a queue hop).
        queue.async { [spill] in
            let recovered = spill.importLegacyArray(at: Self.legacyPersistURL) { data in
                String(data: data, encoding: .utf8)
            }
            if recovered > 0 {
                AppLog.info("applog", "recovered lines from a previous build", ["lines": String(recovered)])
            }
        }

        NotificationCenter.default.addObserver(
            forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: nil
        ) { [weak self] _ in
            guard let self else { return }
            // Background = persist only. Also disarm any pending error-flush: a
            // 12s-old debounce firing mid-suspension would start the exact
            // background upload this batch removes.
            self.lock.lock()
            self.errorFlushWorkItem?.cancel()
            self.errorFlushWorkItem = nil
            self.inBackground = true
            self.lock.unlock()
            AppLog.info("lifecycle", "app entered background")
            self.persistAsynchronously()
        }
        NotificationCenter.default.addObserver(
            forName: UIApplication.willEnterForegroundNotification, object: nil, queue: nil
        ) { [weak self] _ in
            guard let self else { return }
            self.lock.lock()
            self.inBackground = false
            self.lock.unlock()
            AppLog.info("lifecycle", "app will enter foreground", [
                "backlogBytes": String(self.spill.unreadBytes),
            ])
            self.uploadIfNeeded(force: true)
        }

        startTimers()

        #if DEBUG
        // Self-arming diagnostics probe. Deliberately hooked HERE rather than in
        // WalnutApp: AppLog.shared is already touched during app init, so this
        // needs no scene/app-delegate wiring at all, and the probe stays inside
        // the subsystem it proves. `-walnut.diagnosticsProbe <marker>` on the
        // launch command line (NSArgumentDomain) turns it on; absent = no-op.
        if let marker = UserDefaults.standard.string(forKey: "walnut.diagnosticsProbe"),
           !marker.isEmpty {
            Task.detached(priority: .utility) { [weak self] in
                // Let the first frame settle so the app is a realistic subject
                // (the launch/lifecycle lines are in the same batch).
                try? await Task.sleep(for: .seconds(2))
                let uploaded = await self?.runDiagnosticsProbe(marker: marker) ?? 0
                AppLog.info("diagnostics-probe", "probe finished", ["uploaded": String(uploaded)])
            }
        }
        #endif
    }

    private static func parseLevel(_ raw: String?) -> Level? {
        switch raw?.lowercased() {
        case "debug": return .debug
        case "info": return .info
        case "warn", "warning": return .warn
        case "error": return .error
        default: return nil
        }
    }

    /// Call from the main thread at startup (WalnutApp.init).
    @MainActor
    func captureDeviceIdentity() {
        let device = AppConfig.deviceName ?? UIDevice.current.name
        let os = "iOS \(UIDevice.current.systemVersion)"
        lock.lock()
        cachedDevice = device
        cachedOS = os
        lock.unlock()
        // Same reason, same moment: grab the UIApplication reference while the
        // main thread is definitely alive, so a frozen-main-thread upload can
        // still hold a background assertion.
        BackgroundAssertion.capture()
    }

    // MARK: - Logging

    static func debug(_ subsystem: String, _ message: String, _ meta: [String: String]? = nil) {
        shared.append(level: .debug, subsystem: subsystem, message: message, meta: meta)
    }

    static func info(_ subsystem: String, _ message: String, _ meta: [String: String]? = nil) {
        shared.append(level: .info, subsystem: subsystem, message: message, meta: meta)
    }

    static func warn(_ subsystem: String, _ message: String, _ meta: [String: String]? = nil) {
        shared.append(level: .warn, subsystem: subsystem, message: message, meta: meta)
    }

    static func error(_ subsystem: String, _ message: String, _ meta: [String: String]? = nil) {
        shared.append(level: .error, subsystem: subsystem, message: message, meta: meta)
    }

    private func append(level: Level, subsystem: String, message: String, meta: [String: String]?) {
        guard level.rawValue >= minimumLevel.rawValue else { return }
        #if DEBUG
        print("[\(level.wire)] \(subsystem): \(message) \(meta ?? [:])")
        #endif
        lock.lock()
        let entry = Entry(
            seq: nextSequence, ts: Self.timestamp(), level: level,
            subsystem: subsystem, message: message, meta: meta
        )
        nextSequence += 1
        staged.append(entry)
        let stagedCount = staged.count
        lock.unlock()

        if stagedCount >= Self.stagedFlushLines { flushStagedAsynchronously() }
        if level == .error { scheduleErrorFlush() }
    }

    /// O(1) UTC stamp — see `ClientLogWire.timestamp()` for why this is not
    /// `ISO8601DateFormatter` (which the previous implementation allocated per
    /// log line, unaffordable in full-dump mode).
    private static func timestamp() -> String { ClientLogWire.timestamp() }

    // MARK: - Timers

    private func startTimers() {
        let flush = DispatchSource.makeTimerSource(queue: queue)
        flush.schedule(deadline: .now() + Self.flushInterval, repeating: Self.flushInterval)
        flush.setEventHandler { [weak self] in self?.flushStaged() }
        flush.resume()
        flushTimer = flush

        let upload = DispatchSource.makeTimerSource(queue: queue)
        upload.schedule(deadline: .now() + Self.uploadInterval, repeating: Self.uploadInterval)
        upload.setEventHandler { [weak self] in
            guard let self else { return }
            self.flushStaged()
            // Timer tick = "send whatever is queued", not "only when big".
            self.uploadIfNeeded(force: !self.spill.isEmpty)
        }
        upload.resume()
        uploadTimer = upload
    }

    // MARK: - Staging → disk

    /// Move staged lines onto the durable queue. Encoding (JSON) happens here,
    /// off the append path.
    private func flushStaged() {
        lock.lock()
        guard !staged.isEmpty else { lock.unlock(); return }
        let batch = staged
        staged.removeAll(keepingCapacity: true)
        lock.unlock()

        spill.append(batch.map(Self.encode))

        // Surface eviction as data: an unexplained gap in a forensic log is
        // worse than a labelled one.
        let dropped = spill.takeDroppedCount()
        if dropped > 0 {
            lock.lock()
            let entry = Entry(
                seq: nextSequence, ts: Self.timestamp(), level: .warn,
                subsystem: "applog", message: "dropped lines (disk cap reached)",
                meta: ["lines": String(dropped)]
            )
            nextSequence += 1
            lock.unlock()
            spill.append([Self.encode(entry)])
        }

        if spill.unreadBytes > 0, spillLineEstimate() >= Self.uploadThresholdLines {
            uploadIfNeeded(force: false)
        }
    }

    private func flushStagedAsynchronously() {
        queue.async { [weak self] in self?.flushStaged() }
    }

    /// Measured mean over a realistic full-dump mix (heartbeat + crumb + network
    /// + lifecycle lines): ~194 B. Used only for "is the backlog big enough to
    /// send" and the Settings hint, so a rough figure is the right trade against
    /// counting newlines on every append.
    private static let averageLineBytes = 200

    /// Cheap "is the backlog big" proxy. Only used to decide whether to bring an
    /// upload forward — the timer sends regardless.
    private func spillLineEstimate() -> Int {
        spill.unreadBytes / Self.averageLineBytes
    }

    /// Wire encoding lives in `ClientLogWire` — the contract shared with the
    /// server's ingest route (and with every grep run against the dumped file).
    private static func encode(_ entry: Entry) -> String {
        ClientLogWire.encodeLine(
            ts: entry.ts, level: entry.level.wire, subsystem: entry.subsystem,
            message: entry.message, seq: entry.seq, meta: entry.meta
        )
    }

    // MARK: - Persistence + upload

    /// Public flush point for callers holding must-not-lose lines (crash
    /// diagnostics, a freeze report): get staged lines onto disk NOW so a
    /// follow-up crash or force-quit can't eat them. Synchronous by design —
    /// the watchdog calls this from its own queue and needs it done on return.
    func persistNow() {
        flushStaged()
    }

    private func persistAsynchronously() {
        queue.async { [weak self] in self?.flushStaged() }
    }

    private func scheduleErrorFlush() {
        lock.lock()
        errorFlushWorkItem?.cancel()
        let item = DispatchWorkItem { [weak self] in
            self?.flushStaged()
            self?.uploadIfNeeded(force: true)
        }
        errorFlushWorkItem = item
        lock.unlock()
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 12, execute: item)
    }

    /// Connectivity recovery is a high-value flush point: send the offline trace
    /// immediately once the network is usable again.
    func flushAfterConnectivityRecovery() {
        flushStaged()
        uploadIfNeeded(force: true)
    }

    /// Escape hatch for must-not-lose diagnostics (a main-thread freeze the user
    /// is about to force-quit). Bypasses the `inBackground` upload gate for ONE
    /// attempt and wraps it in a background task so the OS grants time even
    /// while the app is being suspended. Everything else keeps the gate: routine
    /// log traffic must not burn background execution time.
    func uploadCritical() {
        flushStaged()
        uploadIfNeeded(force: true, ignoreBackgroundGate: true, guardedByBackgroundTask: true)
    }

    /// Push queued lines to the server. Lines leave the disk queue only after a
    /// 2xx — any failure keeps them for the next trigger.
    func uploadIfNeeded(force: Bool) {
        uploadIfNeeded(force: force, ignoreBackgroundGate: false, guardedByBackgroundTask: false)
    }

    /// User-driven "Send diagnostics now" (Settings). Flushes everything and
    /// drains the whole backlog in as many round-trips as it takes, reporting
    /// the outcome so the UI can say something honest. Ignores the background
    /// gate and holds a background task, like a freeze report.
    /// - Returns: lines uploaded, and whether the queue is now empty.
    @discardableResult
    func sendDiagnosticsNow() async -> (uploaded: Int, drained: Bool) {
        flushStaged()
        let task = BackgroundAssertion.begin("walnut.applog.manual")
        defer { BackgroundAssertion.end(task) }

        var uploaded = 0
        // Bounded: a pathological backlog must not spin here forever.
        for _ in 0..<40 {
            let sent = await drainOneBatch()
            guard sent > 0 else { break }
            uploaded += sent
            if spill.isEmpty { break }
        }
        return (uploaded, spill.isEmpty)
    }

    private func uploadIfNeeded(force: Bool, ignoreBackgroundGate: Bool, guardedByBackgroundTask: Bool) {
        guard ignoreBackgroundGate || !isBackgrounded() else { return }
        guard !spill.isEmpty else { return }
        guard force || spillLineEstimate() >= Self.uploadThresholdLines else { return }
        // Claim the uploader last, so a rejected trigger doesn't briefly block a
        // concurrent one that WOULD have sent.
        guard beginUpload() else { return }

        // `beginBackgroundTask` is thread-safe (documented) so this is callable
        // from the watchdog queue while the main thread is stuck — see
        // BackgroundAssertion for why it isn't called on UIApplication directly.
        let bgTask: UIBackgroundTaskIdentifier = guardedByBackgroundTask
            ? BackgroundAssertion.begin("walnut.applog.critical")
            : .invalid

        Task.detached(priority: .utility) { [weak self] in
            guard let self else { return }
            defer {
                self.finishUpload()
                BackgroundAssertion.end(bgTask)
            }
            // Drain up to a few batches per trigger so a backlog shrinks
            // without waiting for N timer ticks; the timer picks up the rest.
            for _ in 0..<8 {
                let sent = await self.uploadOneBatch()
                if sent <= 0 || self.spill.isEmpty { break }
            }
        }
    }

    /// Serialized single-batch drain for `sendDiagnosticsNow`, which runs
    /// outside the `uploading` flag's normal fire-and-forget path.
    private func drainOneBatch() async -> Int {
        // Sync helper, not an inline lock/unlock — NSLock's methods are
        // unavailable from async contexts (same rule SSEClient follows).
        guard beginUpload() else { return 0 }
        defer { finishUpload() }
        return await uploadOneBatch()
    }

    /// Claim the single-uploader flag. False = someone else is already sending.
    private func beginUpload() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard !uploading else { return false }
        uploading = true
        return true
    }

    /// POST the oldest batch. Returns the number of lines accepted (0 = nothing
    /// to send, or the attempt failed and the lines are still queued).
    private func uploadOneBatch() async -> Int {
        let (lines, consumed) = spill.peek(
            maxLines: Self.maxLinesPerBatch, maxBytes: Self.maxBytesPerBatch
        )
        guard !lines.isEmpty, consumed > 0 else { return 0 }
        guard let base = AppConfig.serverURL, let token = AppConfig.token else { return 0 }
        guard let url = URL(string: base.absoluteString + "/api/v1/client-logs") else { return 0 }

        // Cached identity, NOT MainActor.run — a frozen main thread would block
        // that await forever and the freeze report would never send.
        let (device, os) = deviceIdentity()
        let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "?"
        let build = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "?"
        let body = ClientLogWire.encodeBody(
            lines: lines, device: device, appVersion: "\(version) (\(build))", os: os
        )

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 30
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        let compress = !compressionIsDisabled()
        if compress, let gzipped = Gzip.compress(body), gzipped.count < body.count {
            request.setValue("gzip", forHTTPHeaderField: "Content-Encoding")
            request.httpBody = gzipped
        } else {
            request.httpBody = body
        }

        guard let (_, response) = try? await URLSession.shared.data(for: request),
              let http = response as? HTTPURLResponse
        else { return 0 } // keep lines queued; next trigger retries

        guard (200...299).contains(http.statusCode) else {
            // A server that can't inflate our body answers 4xx forever. Give up
            // on compression permanently rather than losing every log to it.
            if compress, request.value(forHTTPHeaderField: "Content-Encoding") == "gzip",
               (400...499).contains(http.statusCode) {
                disableCompression()
            }
            return 0
        }

        // Advance the durable cursor only now. A kill between the 2xx and this
        // line re-sends the batch (duplicate `seq`s server-side) — never drops.
        spill.commit(consumedBytes: consumed)
        return lines.count
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

    private func isBackgrounded() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return inBackground
    }

    private func compressionIsDisabled() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return compressionDisabled
    }

    private func disableCompression() {
        lock.lock()
        let alreadyOff = compressionDisabled
        compressionDisabled = true
        lock.unlock()
        guard !alreadyOff else { return }
        UserDefaults.standard.set(true, forKey: Self.compressionDisabledKey)
        AppLog.warn("applog", "server rejected a compressed body — sending identity from now on")
    }

    #if DEBUG
    /// Diagnostics-pipeline probe (DEBUG only): emit one `error` line and drain
    /// the queue, reporting whether the server accepted it.
    ///
    /// Exists because the upload path had no end-to-end proof — everything up to
    /// `uploadOneBatch` is unit-tested, but "an AppLog.error on a real device
    /// becomes a line in the server's ios-client dir" was only ever verified by
    /// hand, which is how a break in that path can sit unnoticed. Driven by
    /// scripts/ios-client-log-e2e.sh via `-walnut.diagnosticsProbe 1`.
    /// - Returns: lines uploaded (0 = the server never accepted the batch).
    @discardableResult
    func runDiagnosticsProbe(marker: String) async -> Int {
        AppLog.error("diagnostics-probe", "flight recorder end-to-end probe", ["marker": marker])
        let outcome = await sendDiagnosticsNow()
        return outcome.uploaded
    }
    #endif

    // MARK: - Introspection (Settings)

    /// Bytes queued on disk awaiting upload — shown on the diagnostics row so
    /// the user can see the pipeline is alive.
    var pendingBytes: Int {
        lock.lock()
        let stagedCount = staged.count
        lock.unlock()
        // Staged lines aren't on disk yet, so they're estimated.
        return spill.unreadBytes + stagedCount * Self.averageLineBytes
    }
}

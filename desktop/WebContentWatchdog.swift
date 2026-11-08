import Cocoa
import WebKit

// MARK: - WebContent watchdog: runtime
//
// Samples the page process behind the window once a minute, reports it (the
// app's own desktop.log AND the server log, so `walnut-logs.sh desktop` shows
// the curve next to everything else), and asks WebContentPolicy whether to
// replace the process. The replacement itself is the app delegate's job
// (`recycle`): it tears the WKWebView down and builds a new one at the same
// URL, which is the only way to get a NEW WebContent process. A plain
// `reload()` keeps the process, and with it the compositor's high-water mark.

final class WebContentWatchdog {
    /// Re-read every sample so `defaults write` tunes a running app: no relaunch
    /// to lower a threshold on a small-memory Mac (or to test the swap).
    private let policyProvider: () -> WebContentPolicy
    private var state = WebContentWatchdogState()
    private var timer: Timer?
    private weak var webView: WKWebView?
    private weak var window: NSWindow?
    private var processStartedAt = Date()
    private var lastPid: pid_t = 0
    private var loadedBundle: String?
    private var servedBundle: String?
    private var recycleInFlight = false
    private var reportedNoPid = false
    /// True while the server answers but cannot serve the web app.
    private var serverPageBroken = false
    /// Page-process crashes in the last ten minutes, for reload backoff.
    private var crashTimes: [Date] = []
    /// The last full sample, so the pause check between samples can ask the
    /// policy again without reading the footprint every two seconds.
    private var lastSample: WebContentSample?
    private var lastFields: [String: String] = [:]
    private var pauseTimer: Timer?
    private var notice = MemoryNoticeState()
    private var noticeView: MemoryNoticeView?
    /// The highest level whose footprint breakdown was logged for this process.
    private var breakdownLevel: FootprintLevel?
    /// After the page said a swap would lose text, the watchdog asks again only
    /// after this (one sample), not at every pause check two seconds apart.
    private var unsavedHoldUntil: Date?

    private static var e2eNoticesShown = 0
    private let portProvider: () -> Int?
    private let recycle: (RecycleReason, WebContentSample) -> Void

    init(policyProvider: @escaping () -> WebContentPolicy,
         portProvider: @escaping () -> Int?,
         recycle: @escaping (RecycleReason, WebContentSample) -> Void) {
        self.policyProvider = policyProvider
        self.portProvider = portProvider
        self.recycle = recycle
    }

    /// Called every time the delegate creates a web view (first load and every recycle).
    func attach(webView: WKWebView, window: NSWindow) {
        self.webView = webView
        self.window = window
        processStartedAt = Date()
        lastPid = 0
        loadedBundle = nil
        recycleInFlight = false
        resetForNewProcess()
        if timer == nil && WebContentPolicy.isEnabled(UserDefaults.standard) {
            let interval = policyProvider().sampleInterval
            let t = Timer.scheduledTimer(withTimeInterval: interval, repeats: true) { [weak self] _ in
                self?.tick()
            }
            t.tolerance = interval / 6
            timer = t
        }
    }

    /// The page finished loading: remember which bundle it runs so a later
    /// deploy is detectable by comparing against what the server serves now.
    func pageDidFinishLoading() {
        guard let webView else { return }
        webView.evaluateJavaScript(
            "(() => { for (const s of document.scripts) { if (s.src) { const m = /assets\\/index-([A-Za-z0-9_-]+)\\.js/.exec(s.src); if (m) return m[1]; } } return null; })()"
        ) { [weak self, weak webView] result, _ in
            guard let self, let webView, self.webView === webView, let id = result as? String else { return }
            self.loadedBundle = id
            self.servedBundle = id
        }
    }

    /// WebKit killed or lost the page process (OOM jetsam, crash). Reload with a
    /// short backoff; a process that keeps dying is reported every time, and
    /// the server log shows the pattern instead of a silently blank window.
    func pageProcessDidTerminate() {
        guard let webView else { return }
        let now = Date()
        crashTimes = crashTimes.filter { now.timeIntervalSince($0) < 600 }
        crashTimes.append(now)
        let delay = min(60.0, pow(2.0, Double(crashTimes.count - 1)))
        let fields = [
            "crashesLast10m": String(crashTimes.count),
            "reloadInSec": String(Int(delay)),
            "processAgeMin": String(Int(now.timeIntervalSince(processStartedAt) / 60)),
            "lastFootprintMB": lastPid > 0 ? (Self.physFootprint(lastPid).map { String(megabytes($0)) } ?? "?") : "?",
        ]
        DesktopLogger.shared.log("webcontent_terminated", fields: fields)
        postToServer(level: "error", message: "page process terminated by WebKit, reloading", fields: fields)
        processStartedAt = now
        lastPid = 0
        resetForNewProcess()
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak webView] in
            webView?.reload()
        }
    }

    deinit {
        timer?.invalidate()
        pauseTimer?.invalidate()
    }

    /// A new page process: nothing measured about the old one applies to it.
    private func resetForNewProcess() {
        stopPauseCheck()
        lastSample = nil
        lastFields = [:]
        notice.reset()
        noticeView?.removeFromSuperview()
        noticeView = nil
        breakdownLevel = nil
        unsavedHoldUntil = nil
    }

    // MARK: Sampling

    private func tick() {
        guard let webView, let window, !recycleInFlight, !webView.isLoading else { return }
        guard let pid = Self.webContentPid(webView), let bytes = Self.physFootprint(pid) else {
            if !reportedNoPid {
                reportedNoPid = true
                DesktopLogger.shared.log("webcontent_sample_unavailable")
            }
            return
        }
        if pid != lastPid {
            // A pid we have not seen is a process we did not time: WebKit
            // replaced it behind our back (or this is the first sample).
            if lastPid != 0 {
                processStartedAt = Date()
                resetForNewProcess()
            }
            lastPid = pid
        }
        refreshServedBundle()

        let now = Date()
        // On screen = someone could be looking at it. Hidden app, minimized or
        // fully covered window: the swap is invisible, so the idle gate is moot.
        let visible = Self.windowVisible(window)
        let sample = WebContentSample(
            footprintBytes: bytes,
            processAge: now.timeIntervalSince(processStartedAt),
            userIdle: Self.userIdleSeconds(),
            windowVisible: visible,
            bundleStale: loadedBundle != nil && servedBundle != nil && loadedBundle != servedBundle
        )
        let policy = policyProvider()
        let level = policy.level(for: bytes)
        var fields = [
            "pid": String(pid),
            "footprintMB": String(megabytes(bytes)),
            "level": level.rawValue,
            "processAgeMin": String(Int(sample.processAge / 60)),
            "idleSec": String(Int(sample.userIdle)),
            "visible": String(sample.windowVisible),
        ]
        if let loadedBundle { fields["bundle"] = loadedBundle }
        if sample.bundleStale, let servedBundle { fields["servedBundle"] = servedBundle }

        if state.shouldReport(level: level, policy: policy) {
            DesktopLogger.shared.log("webcontent_sample", fields: fields)
            let serverLevel = level == .normal ? "info" : (level == .high ? "warn" : "error")
            postToServer(level: serverLevel, message: "page process footprint \(megabytes(bytes))MB (\(level.rawValue))", fields: fields)
        }

        lastSample = sample
        lastFields = fields
        logBreakdownIfNew(pid: pid, level: level)
        decide(sample: sample, level: level, fields: fields, policy: policy, now: now)
    }

    /// One verdict, acted on: logged when it is news, the swap started, the pause
    /// check armed while a memory swap waits for the user's next pause, and the
    /// notice shown while a critical page stays.
    private func decide(sample: WebContentSample, level: FootprintLevel, fields: [String: String],
                        policy: WebContentPolicy, now: Date) {
        var fields = fields
        var verdict = policy.verdict(for: sample, state: state, now: now)
        if case let .recycle(reason) = verdict, let until = unsavedHoldUntil, now < until {
            verdict = .suppressed(reason, why: "unsaved_work")
        }
        if state.shouldReportSuppression(verdict), case let .suppressed(reason, why) = verdict {
            fields["reason"] = reason.rawValue
            fields["why"] = why
            DesktopLogger.shared.log("webcontent_recycle_suppressed", fields: fields)
            postToServer(level: "warn", message: "page process recycle held back (\(why))", fields: fields)
        }
        if policy.wantsPauseCheck(verdict) { startPauseCheck(policy) } else { stopPauseCheck() }
        guard case let .recycle(reason) = verdict else {
            updateNotice(level: level, verdict: verdict, now: now)
            return
        }
        // The notice stays as it is until the swap either happens (it goes with
        // the old view) or is held by unsaved text (startRecycle shows it).
        startRecycle(reason, sample: sample, level: level, fields: fields, origin: "watchdog")
    }

    /// Asks the page about unsaved text, then swaps the process. `origin` is who
    /// asked: the watchdog (counted against the hourly budget, held by unsaved
    /// text) or the person's click on the notice (`notice`, already confirmed).
    private func startRecycle(_ reason: RecycleReason, sample: WebContentSample, level: FootprintLevel,
                              fields: [String: String], origin: String, ignoreUnsaved: Bool = false) {
        guard !recycleInFlight else { return }
        var fields = fields
        recycleInFlight = true
        stopPauseCheck()
        checkUnsavedWork(reload: true) { [weak self, weak webView] unsaved in
            guard let self, let webView = webView, self.webView === webView else { return }
            if unsaved && !ignoreUnsaved {
                self.recycleInFlight = false
                self.unsavedHoldUntil = Date().addingTimeInterval(self.policyProvider().sampleInterval)
                fields["reason"] = reason.rawValue
                fields["why"] = "unsaved_work"
                let held = WatchdogVerdict.suppressed(reason, why: "unsaved_work")
                if self.state.shouldReportSuppression(held) {
                    DesktopLogger.shared.log("webcontent_recycle_suppressed", fields: fields)
                }
                self.updateNotice(level: level, verdict: held, now: Date())
                return
            }
            if origin == "watchdog" { self.state.recordRecycle(at: Date()) }
            fields["reason"] = reason.rawValue
            fields["origin"] = origin
            DesktopLogger.shared.log("webcontent_recycled", fields: fields)
            self.postToServer(level: "warn", message: "page process recycled (\(reason.rawValue), \(megabytes(sample.footprintBytes))MB)", fields: fields)
            self.recycle(reason, sample)
        }
    }

    // MARK: Waiting for a pause

    private func startPauseCheck(_ policy: WebContentPolicy) {
        guard pauseTimer == nil else { return }
        let t = Timer.scheduledTimer(withTimeInterval: policy.pauseCheckInterval, repeats: true) { [weak self] _ in
            self?.pauseCheck()
        }
        t.tolerance = policy.pauseCheckInterval / 4
        pauseTimer = t
    }

    private func stopPauseCheck() {
        pauseTimer?.invalidate()
        pauseTimer = nil
    }

    /// The last sample's footprint with the user's input and the window as they
    /// are now: the moment the user pauses (or covers the window), the swap goes.
    private func pauseCheck() {
        guard let webView, let window, var sample = lastSample, !recycleInFlight, !webView.isLoading else { return }
        let now = Date()
        sample.userIdle = Self.userIdleSeconds()
        sample.windowVisible = Self.windowVisible(window)
        sample.processAge = now.timeIntervalSince(processStartedAt)
        let policy = policyProvider()
        var fields = lastFields
        fields["idleSec"] = String(Int(sample.userIdle))
        fields["visible"] = String(sample.windowVisible)
        decide(sample: sample, level: policy.level(for: sample.footprintBytes), fields: fields, policy: policy, now: now)
    }

    // MARK: The notice

    private func updateNotice(level: FootprintLevel, verdict: WatchdogVerdict, now: Date) {
        let show = notice.update(level: level, verdict: verdict, now: now)
        guard let webView else { return }
        if !show {
            noticeView?.removeFromSuperview()
            noticeView = nil
            return
        }
        let mb = lastSample.map { megabytes($0.footprintBytes) } ?? 0
        if let view = noticeView, view.superview === webView {
            view.setFootprint(mb)
            return
        }
        let view = MemoryNoticeView(footprintMB: mb,
                                    onReload: { [weak self] in self?.reloadFromNotice() },
                                    onDismiss: { [weak self] in self?.dismissNotice() })
        view.place(in: webView)
        noticeView = view
        // WALNUT_DESKTOP_E2E_NOTICE_CLICK=1,3 (a test knob, README.md; only with
        // WALNUT_DESKTOP_E2E_BACKGROUND): the notices of this run with those numbers
        // press their own Reload Page three seconds after they show, so a test copy
        // runs the click's whole path with nobody's mouse.
        Self.e2eNoticesShown += 1
        let env = ProcessInfo.processInfo.environment
        let clicks = (env["WALNUT_DESKTOP_E2E_NOTICE_CLICK"] ?? "").split(separator: ",").compactMap { Int($0) }
        if env["WALNUT_DESKTOP_E2E_BACKGROUND"] == "1", clicks.contains(Self.e2eNoticesShown) {
            DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak view] in view?.pressReload() }
        }
        var fields = lastFields
        if case let .suppressed(reason, why) = verdict {
            fields["reason"] = reason.rawValue
            fields["why"] = why
        }
        DesktopLogger.shared.log("webcontent_notice_shown", fields: fields)
        postToServer(level: "warn", message: "page memory notice shown (\(mb)MB)", fields: fields)
    }

    private func dismissNotice() {
        notice.dismiss(at: Date())
        noticeView?.removeFromSuperview()
        noticeView = nil
        DesktopLogger.shared.log("webcontent_notice_dismissed", fields: lastFields)
    }

    /// Reload Page on the notice: swap now, whatever the hourly budget says (the
    /// person asked). Text a reload would lose is named first, with a way back.
    private func reloadFromNotice() {
        guard let sample = lastSample, let webView, !recycleInFlight else { return }
        let policy = policyProvider()
        let level = policy.level(for: sample.footprintBytes)
        DesktopLogger.shared.log("webcontent_notice_reload", fields: lastFields)
        checkUnsavedWork(reload: true) { [weak self, weak webView] unsaved in
            guard let self, let webView = webView, self.webView === webView else { return }
            if !unsaved {
                self.startRecycle(.footprint, sample: sample, level: level, fields: self.lastFields, origin: "notice")
                return
            }
            self.listUnsavedWork { items in
                guard let window = webView.window, window.attachedSheet == nil else { return }
                DesktopLogger.shared.log("webcontent_notice_unsaved_alert", fields: ["items": String(items.count)])
                let alert = NSAlert()
                alert.messageText = "Reload this page and lose what is not saved?"
                let named = items.prefix(5).map { "\u{2022} \($0)" }.joined(separator: "\n")
                alert.informativeText = (named.isEmpty ? "This window has text a reload would lose." : named)
                    + "\n\nSave or send it first, then press Reload Page again."
                alert.addButton(withTitle: "Keep Working")
                alert.addButton(withTitle: "Reload Anyway")
                alert.beginSheetModal(for: window) { [weak self, weak webView] response in
                    guard response == .alertSecondButtonReturn else { return }
                    // AppKit detaches the sheet only after this returns, and a window
                    // with a sheet is not swapped (recyclePopout).
                    DispatchQueue.main.async {
                        guard let self, let webView = webView, self.webView === webView else { return }
                        self.startRecycle(.footprint, sample: sample, level: level, fields: self.lastFields,
                                          origin: "notice", ignoreUnsaved: true)
                    }
                }
            }
        }
    }

    /// The page's own list of what a reload would lose ("what · where"), empty
    /// when the page cannot say (an older bundle).
    private func listUnsavedWork(_ completion: @escaping ([String]) -> Void) {
        guard let webView else { completion([]); return }
        let js = "(() => { try { const b = window.__walnutDesktop; return b && b.listUnsavedWork ? b.listUnsavedWork() : null; } catch { return null; } })()"
        webView.evaluateJavaScript(js) { result, _ in
            let rows = (result as? [[String: Any]]) ?? []
            completion(rows.compactMap { row in
                let what = (row["what"] as? String) ?? ""
                let place = (row["where"] as? String) ?? ""
                let text = [what, place].filter { !$0.isEmpty }.joined(separator: " \u{00B7} ")
                return text.isEmpty ? nil : text
            })
        }
    }

    // MARK: What holds the memory

    /// When a process first goes high, and again when it goes critical, log what
    /// holds its memory by `footprint` category, off the main thread.
    private func logBreakdownIfNew(pid: pid_t, level: FootprintLevel) {
        guard level != .normal else { return }
        if let done = breakdownLevel, done == level || done == .critical { return }
        breakdownLevel = level
        DispatchQueue.global(qos: .utility).async { [weak self] in
            let task = Process()
            task.executableURL = URL(fileURLWithPath: "/usr/bin/footprint")
            task.arguments = ["-p", String(pid)]
            let out = Pipe()
            task.standardOutput = out
            task.standardError = FileHandle.nullDevice
            guard (try? task.run()) != nil else { return }
            let killer = DispatchWorkItem { if task.isRunning { task.terminate() } }
            DispatchQueue.global().asyncAfter(deadline: .now() + 30, execute: killer)
            let data = out.fileHandleForReading.readDataToEndOfFile()
            task.waitUntilExit()
            killer.cancel()
            let rows = footprintCategories(String(decoding: data, as: UTF8.self))
            guard !rows.isEmpty else { return }
            DispatchQueue.main.async {
                guard let self else { return }
                var fields = self.lastFields
                fields["level"] = level.rawValue
                fields["categories"] = footprintSummary(rows)
                DesktopLogger.shared.log("webcontent_breakdown", fields: fields)
                self.postToServer(level: "info", message: "page process memory by category", fields: fields)
            }
        }
    }

    /// Would replacing the page throw away something the user typed? Prefers
    /// the web app's own answer (`window.__walnutDesktop.hasUnsavedWork`, the
    /// same rule its stale-asset reload uses); falls back to a DOM scan for an
    /// older bundle. Any error answers "unsaved": the cost of a wrong yes is one
    /// minute, the cost of a wrong no is lost text.
    /// `reload`: the page loads again in place (a recycle), so a draft it keeps in storage comes
    /// back; otherwise the page goes away (a restart, a closing window).
    func checkUnsavedWork(reload: Bool = false, _ completion: @escaping (Bool) -> Void) {
        guard let webView else { completion(true); return }
        let js = """
        (() => {
          try {
            const b = window.__walnutDesktop;
            if (b && typeof b.hasUnsavedWork === 'function') return !!b.hasUnsavedWork('\(reload ? "reload" : "leave")');
            if (document.querySelector('.fv-dirty-dot')) return true;
            for (const t of document.querySelectorAll('textarea')) if (t.value && t.value.trim()) return true;
            const a = document.activeElement;
            if (a && a.tagName === 'INPUT' && a.value && a.value.trim()) return true;
            return false;
          } catch { return true; }
        })()
        """
        webView.evaluateJavaScript(js) { result, error in
            if error != nil { completion(true); return }
            completion((result as? Bool) ?? true)
        }
    }

    /// Reads the server's current index.html and remembers its entry-bundle
    /// hash. Cheap (one small GET a minute) and tolerant: any failure leaves
    /// the previous answer in place, so a deploy in progress never reads as
    /// "changed".
    private func refreshServedBundle() {
        guard let port = portProvider(), let url = URL(string: "http://localhost:\(port)/") else { return }
        var request = URLRequest(url: url)
        // 15 s, not 3: the server's event loop stalls for 1 to 26 s under load
        // (a git pull, the health monitor), and a 3 s probe read every such
        // stall as "server_page_broken status=0" (about 15 false reports in
        // four days), while the aborted request left a 400 in the server log.
        request.timeoutInterval = 15
        request.cachePolicy = .reloadIgnoringLocalCacheData
        URLSession.shared.dataTask(with: request) { [weak self] data, response, _ in
            guard let self else { return }
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            // No HTTP status at all: the server did not answer in time (a stall,
            // a restart). That is "slow or unreachable", not "up but broken"; a
            // broken page is a server that ANSWERED without the bundle.
            guard status != 0 else { return }
            guard status == 200, let data,
                  let html = String(data: data, encoding: .utf8),
                  let id = bundleId(inHTML: html) else {
                // A server whose web assets are gone still answers every API
                // call from memory, so the window keeps working on its
                // in-memory bundle while every lazy chunk and image 404s.
                // That state lasted four hours undetected on 2026-09-02
                // because nothing said it out loud. Say it, once per onset.
                self.reportServerPageBroken(status: status, body: data)
                return
            }
            DispatchQueue.main.async {
                if self.serverPageBroken {
                    self.serverPageBroken = false
                    DesktopLogger.shared.log("server_page_recovered")
                }
                self.servedBundle = id
            }
        }.resume()
    }

    private func reportServerPageBroken(status: Int, body: Data?) {
        DispatchQueue.main.async {
            guard !self.serverPageBroken else { return }
            self.serverPageBroken = true
            let snippet = body.flatMap { String(data: $0.prefix(200), encoding: .utf8) } ?? ""
            let fields = ["status": String(status), "body": snippet]
            DesktopLogger.shared.log("server_page_broken", fields: fields)
            self.postToServer(level: "error", message: "server is up but cannot serve the web app", fields: fields)
        }
    }

    // MARK: Reporting

    /// Mirrors the event into the server's structured log via the same REST
    /// fallback the browser logger uses, tagged `subsystem: desktop`. Best
    /// effort: a server that is down is exactly when the local desktop.log
    /// still has the line.
    private func postToServer(level: String, message: String, fields: [String: String]) {
        guard let port = portProvider(), let url = URL(string: "http://localhost:\(port)/api/browser-logs") else { return }
        let entry: [String: Any] = [
            "time": ISO8601DateFormatter().string(from: Date()),
            "level": level,
            "message": "[webcontent] \(message)",
            "args": (try? String(data: JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys]), encoding: .utf8)) ?? "",
            "subsystem": "desktop",
        ]
        guard let body = try? JSONSerialization.data(withJSONObject: ["entries": [entry]]) else { return }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        // Fire-and-forget off the main thread, so a generous timeout costs
        // nothing; a 3 s one hung up on a stalled server mid-body and surfaced
        // as `request aborted` 400s on the logging route.
        request.timeoutInterval = 30
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = body
        URLSession.shared.dataTask(with: request).resume()
    }

    // MARK: Probes

    /// The WebContent pid is only exposed through WebKit's private KVC key.
    /// Guarded by `responds(to:)`: an undefined key raises an ObjC exception
    /// Swift cannot catch, and a WebKit that drops the key should cost us the
    /// monitoring, not the app.
    static func webContentPid(_ webView: WKWebView) -> pid_t? {
        let selector = NSSelectorFromString("_webProcessIdentifier")
        guard webView.responds(to: selector),
              let value = webView.value(forKey: "_webProcessIdentifier") as? NSNumber else { return nil }
        let pid = pid_t(value.int32Value)
        return pid > 0 ? pid : nil
    }

    /// `phys_footprint`: the number Activity Monitor and `footprint(1)` report,
    /// including the IOSurfaces the compositor owns on the process's behalf.
    /// Verified against `footprint -v` on the live server process.
    static func physFootprint(_ pid: pid_t) -> UInt64? {
        var info = rusage_info_v4()
        let rc = withUnsafeMutablePointer(to: &info) { ptr -> Int32 in
            ptr.withMemoryRebound(to: rusage_info_t?.self, capacity: 1) { p in
                proc_pid_rusage(pid, RUSAGE_INFO_V4, p)
            }
        }
        guard rc == 0 else { return nil }
        return info.ri_phys_footprint
    }

    static func windowVisible(_ window: NSWindow) -> Bool {
        if let e2e = e2eUserState() { return e2e.visible }
        return !NSApp.isHidden && !window.isMiniaturized && window.occlusionState.contains(.visible)
    }

    /// WALNUT_DESKTOP_E2E_IDLE_FILE=<file> (a test knob, README.md; only with
    /// WALNUT_DESKTOP_E2E_BACKGROUND): `<idle seconds>` or `<idle seconds> visible`,
    /// read on every check, so a test copy behind the person's windows plays a user
    /// who works in front of it and then pauses, whatever the person at the Mac does.
    /// Without `visible` the copy's own window state counts (behind every window: hidden).
    static func e2eUserState() -> (idle: TimeInterval, visible: Bool)? {
        let env = ProcessInfo.processInfo.environment
        guard env["WALNUT_DESKTOP_E2E_BACKGROUND"] == "1", let path = env["WALNUT_DESKTOP_E2E_IDLE_FILE"], !path.isEmpty,
              let text = try? String(contentsOfFile: path, encoding: .utf8) else { return nil }
        let words = text.split(whereSeparator: { $0.isWhitespace })
        guard let first = words.first, let idle = TimeInterval(String(first)) else { return nil }
        return (idle, words.contains("visible"))
    }

    /// Seconds since the last keyboard or mouse event anywhere in the login
    /// session, so "idle" means the person stepped away, not merely that they
    /// stopped touching Walnut.
    static func userIdleSeconds() -> TimeInterval {
        if let e2e = e2eUserState() { return e2e.idle }
        let types: [CGEventType] = [.keyDown, .leftMouseDown, .rightMouseDown, .mouseMoved, .scrollWheel, .leftMouseDragged]
        return types.map { CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: $0) }.min() ?? 0
    }
}

// MARK: - The memory notice

/// A small native bar over the top of the page: "This page is using 2.4 GB of
/// memory and may stop drawing", Reload Page, Later. AppKit draws it, so it is
/// on screen even when the page process behind it has stopped painting.
final class MemoryNoticeView: NSVisualEffectView {
    private let label = NSTextField(labelWithString: "")
    private let onReload: () -> Void
    private let onDismiss: () -> Void

    init(footprintMB: Int, onReload: @escaping () -> Void, onDismiss: @escaping () -> Void) {
        self.onReload = onReload
        self.onDismiss = onDismiss
        super.init(frame: .zero)
        identifier = NSUserInterfaceItemIdentifier("walnut-memory-notice")
        material = .popover
        blendingMode = .withinWindow
        state = .active
        wantsLayer = true
        layer?.cornerRadius = 10
        layer?.masksToBounds = true
        layer?.borderWidth = 1
        layer?.borderColor = NSColor.separatorColor.cgColor
        translatesAutoresizingMaskIntoConstraints = false

        let icon = NSImageView()
        icon.image = NSImage(systemSymbolName: "memorychip", accessibilityDescription: "Memory")
        icon.contentTintColor = .systemOrange
        label.font = .systemFont(ofSize: 13)
        label.lineBreakMode = .byTruncatingTail
        let reload = NSButton(title: "Reload Page", target: self, action: #selector(reloadPressed))
        reload.bezelStyle = .rounded
        reload.keyEquivalent = ""
        reload.setAccessibilityIdentifier("walnut-memory-notice-reload")
        let later = NSButton(title: "Later", target: self, action: #selector(laterPressed))
        later.bezelStyle = .rounded
        let stack = NSStackView(views: [icon, label, reload, later])
        stack.orientation = .horizontal
        stack.spacing = 10
        stack.edgeInsets = NSEdgeInsets(top: 8, left: 12, bottom: 8, right: 10)
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor),
            stack.topAnchor.constraint(equalTo: topAnchor),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
        setFootprint(footprintMB)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    func setFootprint(_ mb: Int) {
        let size = mb >= 1_024 ? String(format: "%.1f GB", Double(mb) / 1_024) : "\(mb) MB"
        label.stringValue = "This page is using \(size) of memory and may stop drawing. Reloading keeps your place and saved drafts."
    }

    /// Top centre of the page, under the transparent title bar, never wider than the window.
    func place(in host: NSView) {
        host.addSubview(self)
        NSLayoutConstraint.activate([
            centerXAnchor.constraint(equalTo: host.centerXAnchor),
            topAnchor.constraint(equalTo: host.topAnchor, constant: 40),
            widthAnchor.constraint(lessThanOrEqualTo: host.widthAnchor, constant: -32),
        ])
    }

    @objc private func reloadPressed() { onReload() }
    func pressReload() { onReload() }
    @objc private func laterPressed() { onDismiss() }
}

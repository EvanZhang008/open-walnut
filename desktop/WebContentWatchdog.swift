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
        if timer == nil {
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
        ) { [weak self] result, _ in
            guard let self, let id = result as? String else { return }
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
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak webView] in
            webView?.reload()
        }
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
            if lastPid != 0 { processStartedAt = Date() }
            lastPid = pid
        }
        refreshServedBundle()

        let now = Date()
        // On screen = someone could be looking at it. Hidden app, minimized or
        // fully covered window: the swap is invisible, so the idle gate is moot.
        let visible = !NSApp.isHidden && !window.isMiniaturized && window.occlusionState.contains(.visible)
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

        let verdict = policy.verdict(for: sample, state: state, now: now)
        if state.shouldReportSuppression(verdict), case let .suppressed(reason, why) = verdict {
            fields["reason"] = reason.rawValue
            fields["why"] = why
            DesktopLogger.shared.log("webcontent_recycle_suppressed", fields: fields)
            postToServer(level: "warn", message: "page process recycle held back (\(why))", fields: fields)
        }
        guard case let .recycle(reason) = verdict else { return }
        recycleInFlight = true
        checkUnsavedWork { [weak self] unsaved in
            guard let self else { return }
            if unsaved {
                self.recycleInFlight = false
                fields["reason"] = reason.rawValue
                fields["why"] = "unsaved_work"
                if self.state.shouldReportSuppression(.suppressed(reason, why: "unsaved_work")) {
                    DesktopLogger.shared.log("webcontent_recycle_suppressed", fields: fields)
                }
                return
            }
            self.state.recordRecycle(at: Date())
            fields["reason"] = reason.rawValue
            DesktopLogger.shared.log("webcontent_recycled", fields: fields)
            self.postToServer(level: "warn", message: "page process recycled (\(reason.rawValue), \(megabytes(bytes))MB)", fields: fields)
            self.recycle(reason, sample)
        }
    }

    /// Would replacing the page throw away something the user typed? Prefers
    /// the web app's own answer (`window.__walnutDesktop.hasUnsavedWork`, the
    /// same rule its stale-asset reload uses); falls back to a DOM scan for an
    /// older bundle. Any error answers "unsaved": the cost of a wrong yes is one
    /// minute, the cost of a wrong no is lost text.
    private func checkUnsavedWork(_ completion: @escaping (Bool) -> Void) {
        guard let webView else { completion(true); return }
        let js = """
        (() => {
          try {
            const b = window.__walnutDesktop;
            if (b && typeof b.hasUnsavedWork === 'function') return !!b.hasUnsavedWork();
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
        request.timeoutInterval = 3
        request.cachePolicy = .reloadIgnoringLocalCacheData
        URLSession.shared.dataTask(with: request) { [weak self] data, response, _ in
            guard let self else { return }
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
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
        request.timeoutInterval = 3
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

    /// Seconds since the last keyboard or mouse event anywhere in the login
    /// session, so "idle" means the person stepped away, not merely that they
    /// stopped touching Walnut.
    static func userIdleSeconds() -> TimeInterval {
        let types: [CGEventType] = [.keyDown, .leftMouseDown, .rightMouseDown, .mouseMoved, .scrollWheel, .leftMouseDragged]
        return types.map { CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: $0) }.min() ?? 0
    }
}

import Cocoa
import WebKit

/// The WebContent process behind a web view: its pid, its memory, and the end of a page a swap
/// replaced. Shared by the Mac app (WebContentWatchdog) and the Demo app (DemoApp.swift), which
/// build from different file lists; tests/desktop/replaced-page-ends.test.ts names the callers.
enum WebContentProcess {
    /// The WebContent pid is only exposed through WebKit's private KVC key.
    /// Guarded by `responds(to:)`: an undefined key raises an ObjC exception
    /// Swift cannot catch, and a WebKit that drops the key should cost us the
    /// monitoring, not the app.
    static func pid(_ webView: WKWebView) -> pid_t? {
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

    /// When a process started, to tell it from a later one that reuses its pid.
    static func startTime(_ pid: pid_t) -> UInt64? {
        var info = proc_bsdinfo()
        let size = Int32(MemoryLayout<proc_bsdinfo>.size)
        guard pid > 1, proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size else { return nil }
        return info.pbi_start_tvsec &* 1_000_000 &+ info.pbi_start_tvusec
    }

    /// The page a swap replaced ends with it, and its graphics memory with it.
    ///
    /// 2026-11-11: the old page process of a recycle was still running its page (its timers, its
    /// socket to the server, 1.7 GB) 17 minutes after the swap, so the app held two pages.
    /// 2026-11-18: the fix for that, WebKit's `_killWebContentProcess` on the unloaded view, did not
    /// end the process either. A hidden test app (six pages of composited layers) kept every page
    /// process running with 850 MB of graphics until the app quit, and on the person's Mac such
    /// processes, logged as "ended", lived for up to 8 hours and then died in a batch, each batch
    /// leaving kernel_task about 1 GB larger. Closing the page instead (WebKit's
    /// `_close`) ended each process within 4 seconds and freed its graphics memory at once.
    ///
    /// So: the old view unloads its page at once (its drafts are written on the way out, like a
    /// reload), its page is closed once the blank page has committed (so the unload has run; at most
    /// 10 s for a page that is busy), and the view is let go. A process still serving it 12 s later
    /// (the same process by its start time, never the new page's) is ended with SIGTERM. `log` gets
    /// what really happened: "exited", "terminated", "kept" (the new page shares that process) or
    /// "unknown" (this WebKit does not say which process it was).
    static func retireReplacedPage(_ old: WKWebView, replacement: @escaping () -> WKWebView?,
                                   log: @escaping ([String: String]) -> Void = { _ in }) {
        let oldPid = pid(old)
        let started = oldPid.flatMap(startTime)
        let footprintMB = oldPid.flatMap(physFootprint).map { String($0 >> 20) } ?? "?"
        old.navigationDelegate = nil
        old.uiDelegate = nil
        old.stopLoading()
        old.loadHTMLString("", baseURL: nil)
        whenUnloaded(old, until: Date().addingTimeInterval(10)) {
            close(old)
            // Holds no reference to the view, so it is freed now; `released` says whether it was.
            // 2026-11-20: a closed page whose window was on screen still left its graphics to the
            // kernel once, so whether anything in the app kept the old view is the next fact to read.
            let view = WeakView(old)
            DispatchQueue.main.asyncAfter(deadline: .now() + 12) {
                log(["pid": oldPid.map { String($0) } ?? "?", "footprintMB": footprintMB,
                     "end": endIfStillRunning(oldPid, started: started, newPid: replacement().flatMap(pid)),
                     "released": view.value == nil ? "yes" : "no"])
            }
        }
    }

    private final class WeakView { weak var value: WKWebView?; init(_ v: WKWebView) { value = v } }

    /// Before a swap: the page empties in its own process while it is still in its window, and
    /// `then` builds the new one. A page process that dies holding its graphics leaves them charged
    /// to kernel_task until the app quits, closed and released or not (2026-11-22: a swap of a page
    /// holding 450 MB of graphics, kernel_task +450 MB), while a page loaded again in its process
    /// frees them itself (flat on every reload since 11-21). The blank page's commit starts the
    /// release, and the graphics leave over the next seconds (a test page: 554 MB, still 135 MB a
    /// second after the commit, 8 MB a second later), so `then` waits 2 s and then until the
    /// process's footprint stops falling, all within 8 s. The blank page takes the window's colour
    /// (`background`), so the wait reads as the page changing, not as a window gone white. Its
    /// drafts are written on the way out, as on any reload; the caller reads `pageURL` before this.
    /// 2026-11-23: on the person's Mac it did not help. The page's graphics were mapped by the app
    /// process, so the blank page gave back none of them (2.6 GB before and after) and the swap still
    /// left them to kernel_task; WebContentPolicy.replacesProcess now swaps only a page that freezes.
    static func emptyInPlace(_ view: WKWebView, background: NSColor? = nil, then: @escaping () -> Void) {
        let process = pid(view)
        let until = Date().addingTimeInterval(8)
        view.stopLoading()
        view.loadHTMLString("<html style=\"background:\(css(background))\"></html>", baseURL: nil)
        whenUnloaded(view, until: until) {
            let wait = min(2, until.timeIntervalSinceNow)
            guard wait > 0 else { return then() }
            DispatchQueue.main.asyncAfter(deadline: .now() + wait) {
                settle(process, last: process.flatMap(physFootprint), quiet: 0, until: until, then: then)
            }
        }
    }

    /// How many layers this process holds under `root`, and of them how many draw something
    /// (`contents` set: a page's layer backing surface) and how many show nothing (hidden or fully
    /// transparent, themselves or through an ancestor).
    /// 2026-11-25: the app held 4,487 WebKit compositing layers and 1,054 layer surfaces that only
    /// WindowServer still shared (3.4 GB), for one page of about 2,300 nodes. This census says whether
    /// they sit in the web view's own layer tree (and, by `hidden`, whether that tree still shows them).
    struct LayerCensus: Equatable { var total = 0, withContents = 0, hidden = 0, maxDepth = 0 }

    static func layerCensus(_ root: CALayer?, limit: Int = 200_000) -> LayerCensus {
        var census = LayerCensus()
        var stack: [(CALayer, Int, Bool)] = root.map { [($0, 0, false)] } ?? []
        while let (layer, depth, hiddenAbove) = stack.popLast(), census.total < limit {
            let hidden = hiddenAbove || layer.isHidden || layer.opacity == 0
            census.total += 1
            if layer.contents != nil { census.withContents += 1 }
            if hidden { census.hidden += 1 }
            census.maxDepth = max(census.maxDepth, depth)
            for sub in layer.sublayers ?? [] { stack.append((sub, depth + 1, hidden)) }
        }
        return census
    }

    /// The census as a log field: "total/withContents/hidden/maxDepth".
    static func layerCensusField(_ c: LayerCensus) -> String { "\(c.total)/\(c.withContents)/\(c.hidden)/\(c.maxDepth)" }

    /// The page a view shows, never the blank page `emptyInPlace` or a retire put there.
    static func pageURL(_ view: WKWebView) -> URL? {
        guard let url = view.url, url.scheme != "about" else { return nil }
        return url
    }

    private static func css(_ color: NSColor?) -> String {
        guard let c = color?.usingColorSpace(.sRGB) else { return "transparent" }
        return String(format: "rgb(%d,%d,%d)", Int(c.redComponent * 255), Int(c.greenComponent * 255), Int(c.blueComponent * 255))
    }

    /// Calls `then` once two reads half a second apart find the footprint no longer falling (under
    /// 1% less), or at `until`.
    private static func settle(_ process: pid_t?, last: UInt64?, quiet: Int, until: Date, then: @escaping () -> Void) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
            let now = process.flatMap(physFootprint)
            let falling = now != nil && last != nil && Double(now!) < Double(last!) * 0.99
            let quietNow = falling ? 0 : quiet + 1
            if now == nil || quietNow >= 2 || Date() >= until { return then() }
            settle(process, last: now, quiet: quietNow, until: until, then: then)
        }
    }

    /// Runs `then` once the view shows the blank page its unload navigated to (the old page's
    /// pagehide has run by then), or at `until` for a page too busy to get there.
    private static func whenUnloaded(_ view: WKWebView, until: Date, then: @escaping () -> Void) {
        if (view.url?.absoluteString == "about:blank" && !view.isLoading) || Date() >= until { return then() }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { whenUnloaded(view, until: until, then: then) }
    }

    /// WebKit's own close of the page, which ends its process when no other page uses it. Guarded
    /// like `pid`: a WebKit without the call still lets the view go, and the check after it ends
    /// a process that stays.
    static func close(_ view: WKWebView) {
        let selector = NSSelectorFromString("_close")
        if view.responds(to: selector) { view.perform(selector) }
    }

    /// The outcome for a retired page's process: gone ("exited"), shared with the new page
    /// ("kept"), still running and so ended now ("terminated"), or "unknown" when its pid or start
    /// could not be read. Only the process that served the old page is signalled: its pid with the
    /// same start time, never pid 1 or below. `send` returns false when the process was already gone.
    static func endIfStillRunning(_ oldPid: pid_t?, started: UInt64?, newPid: pid_t?,
                                  signal send: (pid_t) -> Bool = { kill($0, SIGTERM) == 0 || errno != ESRCH }) -> String {
        guard let oldPid, oldPid > 1, let started else { return "unknown" }
        guard startTime(oldPid) == started else { return "exited" }
        if oldPid == newPid { return "kept" }
        return send(oldPid) ? "terminated" : "exited"
    }
}

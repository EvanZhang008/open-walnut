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

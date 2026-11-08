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

    /// The page a swap replaced ends with it. WebKit closes a page once its view is gone, but on
    /// 2026-11-11 the old page process of a recycle was still running its page (its timers, its
    /// socket to the server, 1.7 GB) 17 minutes after the swap, so the app held two pages. The old
    /// view unloads its page at once (its drafts are written on the way out, like a reload), and
    /// once the new page has had time to load, a process still serving the old view is ended
    /// through WebKit's own call. Never the new page's process. `log` gets the outcome.
    static func retireReplacedPage(_ old: WKWebView, replacement: @escaping () -> WKWebView?,
                                   log: @escaping ([String: String]) -> Void = { _ in }) {
        let oldPid = pid(old)
        let footprintMB = oldPid.flatMap(physFootprint).map { String($0 >> 20) } ?? "?"
        old.stopLoading()
        old.loadHTMLString("", baseURL: nil)
        DispatchQueue.main.asyncAfter(deadline: .now() + 10) {
            let newPid = replacement().flatMap(pid)
            var end = "exited"
            if let oldPid, kill(oldPid, 0) == 0 {
                let killer = NSSelectorFromString("_killWebContentProcess")
                if oldPid != newPid, pid(old) == oldPid, old.responds(to: killer) {
                    old.perform(killer)
                    end = "ended"
                } else {
                    end = "kept"
                }
            }
            log([
                "pid": oldPid.map { String($0) } ?? "?",
                "footprintMB": footprintMB,
                "end": end,
            ])
        }
    }
}

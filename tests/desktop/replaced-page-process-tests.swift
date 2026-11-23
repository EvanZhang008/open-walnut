// A page the Mac app replaces really ends, with its graphics memory (WebContentProcess.retireReplacedPage).
//
// 2026-11-18: the retire used WebKit's `_killWebContentProcess`, which left every old page process
// running with its graphics (850 MB over six pages here) until the app quit, while the app logged
// it as "ended"; on the person's Mac they died hours later in a batch and kernel_task kept 1 GB.
// This test drives the real function in a hidden app: no Dock icon, never activated, a window
// that is 1% opaque, click-through and below every normal window.
//
// Run: scripts/test-desktop-replaced-page.sh (macOS: AppKit, WebKit).
import Cocoa
import WebKit

var failures = 0
func check(_ ok: Bool, _ what: String) {
    print((ok ? "ok   " : "FAIL ") + what)
    if !ok { failures += 1 }
}

func running(_ pid: pid_t, _ started: UInt64?) -> Bool {
    started != nil && WebContentProcess.startTime(pid) == started
}

/// A page of composited layers, like the console's glass panels.
let heavyPage = """
<html><body style="margin:0;background:linear-gradient(45deg,#123,#a50)"><script>
for (let i = 0; i < 60; i++) {
  const d = document.createElement('div');
  d.style.cssText = 'position:absolute;left:' + (i % 7) + 'px;top:' + (i % 5) + 'px;width:900px;height:600px;'
    + 'will-change:transform;background:rgba(' + (i * 37 % 255) + ',120,200,0.04);-webkit-backdrop-filter:blur(6px)';
  d.textContent = 'layer ' + i;
  document.body.appendChild(d);
}
document.title = 'ready';
</script></body></html>
"""

final class Tests: NSObject, NSApplicationDelegate, WKScriptMessageHandler {
    var pagehides = 0
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        if message.body as? String == "pagehide" { pagehides += 1 }
    }
    var window: NSWindow!
    var olds: [WKWebView] = []
    var replacement: WKWebView?
    var outcomes: [[String: String]] = []

    func applicationDidFinishLaunching(_ notification: Notification) {
        testEndOutcomes()
        let screen = NSScreen.main?.frame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        window = QuietKeyWindow(contentRect: NSRect(x: screen.minX + 40, y: screen.minY + 40, width: 900, height: 600),
                          styleMask: [.borderless], backing: .buffered, defer: false)
        window.alphaValue = 0.01
        window.ignoresMouseEvents = true
        window.isOpaque = false
        window.level = NSWindow.Level(rawValue: NSWindow.Level.normal.rawValue - 1)
        window.isReleasedWhenClosed = false
        let box = NSView(frame: NSRect(x: 0, y: 0, width: 900, height: 600))
        for i in 0..<3 {
            let view = makeView()
            box.addSubview(view)
            olds.append(view)
            view.loadHTMLString(heavyPage, baseURL: URL(string: "http://localhost/page\(i)"))
        }
        window.contentView = box
        window.orderFrontRegardless()
        waitUntil(deadline: Date().addingTimeInterval(60), { self.olds.allSatisfy { $0.title == "ready" } }) { ready in
            check(ready, "the three pages load")
            // Let them paint their layers before the swap.
            DispatchQueue.main.asyncAfter(deadline: .now() + 8) { self.swap() }
        }
    }

    func makeView() -> WKWebView {
        let config = WKWebViewConfiguration()
        // The unload a retire starts runs the page's pagehide, where the console writes its drafts.
        config.userContentController.add(self, name: "unload")
        config.userContentController.addUserScript(WKUserScript(
            source: "addEventListener('pagehide', () => webkit.messageHandlers.unload.postMessage('pagehide'))",
            injectionTime: .atDocumentStart, forMainFrameOnly: true))
        let view = WKWebView(frame: NSRect(x: 0, y: 0, width: 900, height: 600), configuration: config)
        if view.responds(to: NSSelectorFromString("_setWindowOcclusionDetectionEnabled:")) {
            view.setValue(false, forKey: "windowOcclusionDetectionEnabled")
        }
        return view
    }

    /// The graphics a page process owns (footprint's "Owned physical footprint (unmapped) (graphics)",
    /// dirty column), in MB: what kernel_task inherits when the process dies holding it. NaN when
    /// footprint ran and lists no graphics row at all. A Mac with no GPU of its own (GitHub's macOS
    /// runners, Nightly extra tests 45101869535: [0.0, 0.0, 0.0]) charges a drawn page no graphics,
    /// where a GPU's Mac charges each one tens of MB; nil when footprint could not be read.
    func graphicsMB(_ pid: pid_t) -> Double? {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/footprint")
        task.arguments = ["-p", String(pid)]
        let out = Pipe()
        task.standardOutput = out
        task.standardError = FileHandle.nullDevice
        guard (try? task.run()) != nil else { return nil }
        let data = out.fileHandleForReading.readDataToEndOfFile()
        task.waitUntilExit()
        let text = String(decoding: data, as: UTF8.self)
        guard let line = text.split(separator: "\n").first(where: { $0.contains("Owned physical footprint (unmapped) (graphics)") }) else { return .nan }
        let parts = line.split(separator: " ")
        guard parts.count >= 2, let n = Double(parts[0]) else { return nil }
        switch parts[1] { case "GB": return n * 1024; case "MB": return n; case "KB": return n / 1024; default: return 0 }
    }

    /// Before the swap, as the app's swaps do (WebContentProcess.emptyInPlace): each page empties in
    /// its own process while still in the window, and gives its graphics back before it is ended
    /// (2026-11-22: a swap of a page still holding 450 MB of graphics left kernel_task 450 MB larger).
    func swap() {
        let pids = olds.compactMap(WebContentProcess.pid)
        let before = pids.map { graphicsMB($0) ?? -1 }
        var emptied = 0
        for old in olds { WebContentProcess.emptyInPlace(old) { emptied += 1 } }
        waitUntil(deadline: Date().addingTimeInterval(20), { emptied == self.olds.count }) { _ in
            let after = pids.map { self.graphicsMB($0) ?? -1 }
            print("     graphics MB before emptying: \(before), when emptyInPlace calls back: \(after)")
            if !before.isEmpty && before.allSatisfy({ $0.isNaN || $0 == 0 }) {
                // Only where no page is charged any graphics; a real GPU's Mac checks both.
                print("skip each page holds graphics before the swap: this Mac lists no page graphics (no GPU of its own)")
                print("skip a page emptied in its process gives its graphics back before it is ended: nothing to give back here")
            } else {
                check(before.allSatisfy { $0 >= 20 }, "each page holds graphics before the swap (else the next check proves nothing)")
                check(zip(before, after).allSatisfy { $0.1 >= 0 && $0.1 <= max(16, $0.0 * 0.1) },
                      "a page emptied in its process gives its graphics back before it is ended")
            }
            self.swapNow()
        }
    }

    func swapNow() {
        let pids = olds.compactMap(WebContentProcess.pid)
        let starts = pids.map(WebContentProcess.startTime)
        check(pids.count == 3 && Set(pids).count == 3, "each page has its own page process")
        check(starts.allSatisfy { $0 != nil }, "reads each page process's start time (else nothing below is checked)")
        let next = makeView()
        window.contentView = next
        next.loadHTMLString("<html><body>new page</body></html>", baseURL: URL(string: "http://localhost/new"))
        replacement = next
        for old in olds {
            WebContentProcess.retireReplacedPage(old, replacement: { [weak self] in self?.replacement }) { fields in
                self.outcomes.append(fields)
            }
        }
        olds = []
        waitUntil(deadline: Date().addingTimeInterval(40), { self.outcomes.count == 3 }) { _ in
            check(self.outcomes.count == 3, "every retire reports its outcome")
            let ends = self.outcomes.map { $0["end"] ?? "?" }
            print("     outcomes: \(ends)")
            check(self.pagehides >= 3, "each old page ran its pagehide before it closed (\(self.pagehides) of 3)")
            check(ends.allSatisfy { $0 == "exited" }, "closing the page ends its process by itself (no signal needed)")
            let released = self.outcomes.map { $0["released"] ?? "?" }
            check(released.allSatisfy { $0 == "yes" }, "nothing keeps a retired view once it is closed (released: \(released))")
            let still = zip(pids, starts).filter { running($0.0, $0.1) }.map { $0.0 }
            check(still.isEmpty, "no old page process is still running (left: \(still))")
            if let newPid = self.replacement.flatMap(WebContentProcess.pid) {
                check(!pids.contains(newPid) && kill(newPid, 0) == 0, "the new page's process runs on")
            }
            print(failures == 0 ? "ReplacedPageProcessTests: all passed" : "ReplacedPageProcessTests: \(failures) failed")
            exit(failures == 0 ? 0 : 1)
        }
    }

    /// The outcome of a retire, with the signal stubbed: only the process that served the old page,
    /// by its start time, is ever signalled.
    func testEndOutcomes() {
        let child = Process()
        child.executableURL = URL(fileURLWithPath: "/bin/sleep")
        child.arguments = ["30"]
        try? child.run()
        let pid = child.processIdentifier
        let started = WebContentProcess.startTime(pid)
        var sent: [pid_t] = []
        let record: (pid_t) -> Bool = { sent.append($0); return true }
        check(started != nil, "reads a running process's start time")
        check(WebContentProcess.endIfStillRunning(pid, started: started, newPid: nil, signal: record) == "terminated" && sent == [pid],
              "a process still serving the old page is ended")
        sent = []
        check(WebContentProcess.endIfStillRunning(pid, started: started, newPid: pid, signal: record) == "kept" && sent.isEmpty,
              "a process the new page shares is kept")
        check(WebContentProcess.endIfStillRunning(pid, started: (started ?? 0) + 1, newPid: nil, signal: record) == "exited" && sent.isEmpty,
              "a pid reused by a later process is left alone")
        check(WebContentProcess.endIfStillRunning(1, started: started, newPid: nil, signal: record) == "unknown" && sent.isEmpty,
              "pid 1 is never signalled")
        check(WebContentProcess.endIfStillRunning(nil, started: nil, newPid: nil, signal: record) == "unknown" && sent.isEmpty,
              "no pid: the outcome is unknown, never \"exited\"")
        check(WebContentProcess.endIfStillRunning(pid, started: started, newPid: nil, signal: { _ in false }) == "exited",
              "a process gone by the time of the signal is reported as exited")
        child.terminate()
        child.waitUntilExit()
        check(WebContentProcess.endIfStillRunning(pid, started: started, newPid: nil, signal: record) == "exited" && sent.isEmpty,
              "a process that already exited is reported as exited")
    }

    func waitUntil(deadline: Date, _ condition: @escaping () -> Bool, then: @escaping (Bool) -> Void) {
        if condition() { return then(true) }
        if Date() > deadline { return then(false) }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { self.waitUntil(deadline: deadline, condition, then: then) }
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let tests = Tests()
app.delegate = tests
app.run()

import Cocoa
import WebKit

private final class RecentTestDelegate: AppDelegate {
    override func applicationDidFinishLaunching(_ notification: Notification) {}
    override func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
}

@main
struct RecentHumanTouchTests {
    @MainActor static func main() {
        setbuf(stdout, nil)
        let app = NSApplication.shared
        app.setActivationPolicy(.prohibited)
        Task { @MainActor in
            do { try await run(); exit(0) }
            catch { print("RecentHumanTouchTests failed: \(error)"); exit(1) }
        }
        app.run()
    }

    @MainActor static func run() async throws {
        let front = NSWorkspace.shared.frontmostApplication?.processIdentifier
        let env = ProcessInfo.processInfo.environment
        let port = Int(env["WALNUT_TEST_PORT"] ?? "0")!
        precondition(port == 3457)
        let ids = env["WALNUT_RECENT_IDS"]!.split(separator: ",").map(String.init)
        let delegate = RecentTestDelegate()
        NSApplication.shared.delegate = delegate
        delegate.serverPort = port
        delegate.commandLineToolChecked = true
        delegate.window = QuietKeyWindow(contentRect: NSRect(x: 0, y: 0, width: 1200, height: 800),
                                   styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        delegate.window.isReleasedWhenClosed = false
        delegate.loadWebUI(url: URL(string: "http://localhost:\(port)/?walnut-test-run=native-recent"))
        let web = delegate.webView!
        let silence = try String(contentsOfFile: env["WALNUT_SILENCE_FILE"]!, encoding: .utf8)
        web.configuration.userContentController.addUserScript(WKUserScript(source: silence, injectionTime: .atDocumentStart, forMainFrameOnly: false))
        web.configuration.userContentController.addUserScript(WKUserScript(source: """
        if (!sessionStorage.getItem('native-recent-initialized')) {
          localStorage.clear(); sessionStorage.setItem('native-recent-initialized','1');
          localStorage.setItem('walnut-todo-active-section','all');
          localStorage.setItem('walnut-todo-panel-design','project');
          localStorage.setItem('open-walnut-chat-visible','false');
        }
        document.addEventListener('click',e=>{window.nativeLastInputTrusted=e.isTrusted},true);
        """, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        web.reload()
        delegate.window.orderBack(nil)
        let frameDir = env["WALNUT_DESKTOP_E2E_SNAPSHOTS"]!
        Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in
            let config = WKSnapshotConfiguration(); config.snapshotWidth = 1200
            web.takeSnapshot(with: config) { image, _ in
                guard let data = image?.tiffRepresentation, let rep = NSBitmapImageRep(data: data),
                      let png = rep.representation(using: .png, properties: [:]) else { return }
                try? png.write(to: URL(fileURLWithPath: frameDir).appendingPathComponent("\(Int64(Date().timeIntervalSince1970 * 1000)).png"))
            }
        }
        let key = "walnut-todo-recent-opened"
        try await wait { (try? await js(web, "!!document.querySelector('[data-task-id=\"\(ids[0])\"]')")) as? Bool == true }
        _ = try await js(web, "window.dispatchEvent(new CustomEvent('main:locate-task',{detail:{taskId:'\(ids[2])'}}));true")
        try await Task.sleep(nanoseconds: 500_000_000)
        check(try await js(web, "JSON.parse(localStorage.getItem('\(key)')||'[]').some(e=>e.id==='\(ids[2])')") as? Bool == false)
        print("Automatic locate did not enter Recent")
        for id in ids.prefix(2) {
            try await click(web, delegate.window, ".todo-pinned-section:not(.todo-pinned-section-recent) [data-task-id=\"\(id)\"] .todo-pinned-title")
            try await wait { (try? await js(web, "JSON.parse(localStorage.getItem('\(key)')||'[]')[0]?.id==='\(id)'")) as? Bool == true }
            check(try await js(web, "window.nativeLastInputTrusted") as? Bool == true)
            print("Native mouse input recorded \(id)")
        }
        _ = try await js(web, "localStorage.setItem('walnut-todo-active-section','recent');true")
        web.reload()
        try await wait { (try? await js(web, "document.querySelectorAll('.todo-pinned-list-recent [data-task-id]').length>=2")) as? Bool == true }
        // Re-evaluate by concrete ids; JSON rather than Swift array syntax.
        let mine = try String(data: JSONSerialization.data(withJSONObject: ids), encoding: .utf8)!
        let rows = "Array.from(document.querySelectorAll('.todo-pinned-list-recent [data-task-id]')).map(e=>e.dataset.taskId).filter(id=>\(mine).includes(id))"
        check(try await js(web, "JSON.stringify(\(rows))") as? String == "[\"\(ids[1])\",\"\(ids[0])\"]")
        print("Reload restored human order, without recording another open")
        // Background update through the real route cannot change the displayed order.
        _ = try await js(web, "fetch('/api/tasks/\(ids[0])',{method:'PATCH',headers:{'Content-Type':'application/json','x-walnut-caller-kind':'automation'},body:JSON.stringify({summary:'Agent background update'})}).then(r=>{if(!r.ok)throw Error(r.status);return true})")
        try await Task.sleep(nanoseconds: 1_000_000_000)
        check(try await js(web, "JSON.stringify(\(rows))") as? String == "[\"\(ids[1])\",\"\(ids[0])\"]")
        print("Agent update kept human order")
        delegate.window.setContentSize(NSSize(width: 1000, height: 750))
        try await Task.sleep(nanoseconds: 2_000_000_000)
        precondition(NSWorkspace.shared.frontmostApplication?.processIdentifier == front)
        print("RecentHumanTouchTests: passed (native WKWebView, trusted mouse input, no focus change)")
        delegate.window.orderOut(nil)
    }

    static func check(_ condition: Bool) { precondition(condition) }

    @MainActor static func click(_ web: WKWebView, _ window: NSWindow, _ selector: String) async throws {
        let escaped = try String(data: JSONSerialization.data(withJSONObject: selector, options: .fragmentsAllowed), encoding: .utf8)!
        let point = try await js(web, "(()=>{const e=document.querySelector(\(escaped));if(!e)throw Error('missing control');e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()") as! [String: Double]
        let location = web.convert(NSPoint(x: point["x"]!, y: web.isFlipped ? point["y"]! : web.bounds.height - point["y"]!), to: nil)
        for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
            let event = NSEvent.mouseEvent(with: type, location: location, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                          windowNumber: window.windowNumber, context: nil, eventNumber: 1, clickCount: 1, pressure: 1)!
            let target = web.hitTest(web.convert(location, from: nil)) ?? web
            if type == .leftMouseDown { target.mouseDown(with: event) } else { target.mouseUp(with: event) }
        }
        try await Task.sleep(nanoseconds: 500_000_000)
    }
    @MainActor static func js(_ web: WKWebView, _ script: String) async throws -> Any? {
        try await web.callAsyncJavaScript("return await eval(source)", arguments: ["source": script], in: nil, contentWorld: .page)
    }
    @MainActor static func wait(_ check: () async throws -> Bool) async throws {
        for _ in 0..<120 { if try await check() { return }; try await Task.sleep(nanoseconds: 500_000_000) }
        throw NSError(domain: "RecentHumanTouchTests timeout", code: 1)
    }
}

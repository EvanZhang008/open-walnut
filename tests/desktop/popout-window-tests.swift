import Cocoa
import WebKit

private final class BackgroundAppDelegate: AppDelegate {
    override func applicationDidFinishLaunching(_ notification: Notification) {}
    override func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
}

@main
struct PopoutWindowTests {
    @MainActor
    static func main() {
        setbuf(stdout, nil)
        let app = NSApplication.shared
        app.setActivationPolicy(.prohibited)
        Task { @MainActor in
            do {
                try await run()
                exit(0)
            } catch {
                print("PopoutWindowTests failed: \(error)")
                exit(1)
            }
        }
        app.run()
    }

    @MainActor
    static func run() async throws {
        let frontmost = NSWorkspace.shared.frontmostApplication?.processIdentifier
        let app = NSApplication.shared
        app.setActivationPolicy(.prohibited)
        let delegate = BackgroundAppDelegate()
        app.delegate = delegate
        delegate.webContentWatchdog = WebContentWatchdog(
            policyProvider: { WebContentPolicy.fromDefaults(UserDefaults.standard) },
            portProvider: { delegate.serverPort },
            recycle: { [weak delegate] _, _ in delegate?.recycleWebContent(reason: "test") })
        let port = Int(ProcessInfo.processInfo.environment["WALNUT_TEST_PORT"] ?? "0")!
        precondition(port > 0 && port != 3456)
        delegate.serverPort = port
        delegate.commandLineToolChecked = true
        delegate.window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1200, height: 800),
            styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        delegate.window.isReleasedWhenClosed = false
        delegate.loadWebUI()
        let parent = delegate.webView!
        parent.configuration.preferences.javaScriptCanOpenWindowsAutomatically = true
        try await wait { (try? await js(parent, "!!document.querySelector('main')")) as? Bool == true }
        print("Loaded background parent")
        let sid = ProcessInfo.processInfo.environment["WALNUT_TEST_SESSION"]!
        _ = try await js(parent, "window.dispatchEvent(new CustomEvent('main:open-session',{detail:{sessionId:'\(sid)'}})); true")
        try await wait { (try? await js(parent, "!!document.querySelector('.main-page-session-column [data-session-id=\"\(sid)\"] .session-panel-popout')")) as? Bool == true }
        _ = try await js(parent, "document.querySelector('.main-page-session-column [data-session-id=\"\(sid)\"] .session-panel-popout').click(); true")
        try await wait { delegate.popoutWindows.count == 1 }
        let firstWindow = delegate.popoutWindows.values.first!
        let first = firstWindow.contentView as! WKWebView
        try await wait { (try? await js(first, "!!document.querySelector('.popout-session .session-panel-input textarea')")) as? Bool == true }
        print("Loaded native session popout")
        let composerFits = try await js(first, "(() => {const e=document.querySelector('.session-panel-input textarea');const r=e.getBoundingClientRect();return r.height>0 && r.bottom<=innerHeight})()")
        precondition(composerFits as? Bool == true)
        let tools = try await js(first, "Array.from(document.querySelectorAll('.session-panel-header button')).some(b=>b.textContent.trim()==='Files')")
        precondition(tools as? Bool == true)
        _ = try await js(first, "(() => {const e=document.querySelector('.session-panel-input textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'Native popout round trip');e.dispatchEvent(new Event('input',{bubbles:true}));return true})()")
        try await wait { (try? await js(first, "!document.querySelector('.session-panel-input .chat-send-btn-icon').disabled")) as? Bool == true }
        _ = try await js(first, "document.querySelector('.session-panel-input .chat-send-btn-icon').click(); true")
        try await wait { (try? await js(first, "Array.from(document.querySelectorAll('.session-msg-assistant')).some(e=>e.textContent.includes('Native popout round trip'))")) as? Bool == true }
        print("Native composer sent and received the CLI reply")
        precondition(first.url?.path == "/popout")
        precondition(first.configuration.userContentController !== parent.configuration.userContentController)
        _ = try await js(parent, "document.querySelector('.main-page-session-column [data-session-id=\"\(sid)\"] .session-panel-popout').click(); true")
        _ = try await js(parent, "window.open('/popout?view=session&id=\(sid)&cwd=%2Fworkspace','metadata-enriched'); true")
        precondition(delegate.popoutWindows.count == 1)
        let parentBefore = parent.url
        _ = try await js(parent, "const t=document.createElement('textarea');t.id='test-draft';t.value='unsent parent draft';document.body.append(t);true")
        let secondURL = "http://localhost:\(port)/popout?view=task&id=missing-test-task"
        _ = try await js(parent, "window.open('\(secondURL)','second-target'); true")
        try await wait { delegate.popoutWindows.count == 2 }
        precondition(parent.url == parentBefore)
        let parentDraft = try await js(parent, "document.querySelector('#test-draft').value")
        precondition(parentDraft as? String == "unsent parent draft")
        let secondWindow = delegate.popoutWindows.values.first { $0 !== firstWindow }!
        let second = secondWindow.contentView as! WKWebView
        try await wait { second.url?.absoluteString == secondURL && !second.isLoading }
        let navigatedURL = "http://localhost:\(port)/popout?view=task&id=different-task"
        _ = try await js(second, "history.pushState({},'', '\(navigatedURL)'); true")
        _ = try await js(parent, "window.open('\(secondURL)','second-target'); true")
        try await wait { delegate.popoutWindows.count == 3 }
        precondition(second.url?.absoluteString == navigatedURL)
        let thirdWindow = delegate.popoutWindows.values.first { $0 !== firstWindow && $0 !== secondWindow }!
        let third = thirdWindow.contentView as! WKWebView
        try await wait { third.url?.absoluteString == secondURL && !third.isLoading }
        _ = try await js(third, "document.querySelectorAll('textarea').forEach(t=>t.value=''); true")
        thirdWindow.performClose(nil)
        try await wait { delegate.popoutWindows.count == 2 }
        parent.configuration.userContentController.removeAllScriptMessageHandlers()
        let clipboardBridge = try await js(first, "!!window.webkit.messageHandlers.walnutClipboard")
        precondition(clipboardBridge as? Bool == true)
        let oldChild = first
        let parentPid = WebContentWatchdog.webContentPid(parent)
        let childPid = WebContentWatchdog.webContentPid(first)
        precondition(parentPid != nil && childPid != nil && parentPid != childPid)
        print("Independent WebContent PIDs: parent \(parentPid!), child \(childPid!)")
        delegate.recyclePopout(first)
        let recycled = firstWindow.contentView as! WKWebView
        precondition(recycled !== oldChild)
        precondition(delegate.popoutWindows.count == 2)
        try await wait { (try? await js(recycled, "!!document.querySelector('.popout-session .session-panel-input textarea')")) as? Bool == true }
        precondition(WebContentWatchdog.webContentPid(recycled) != childPid)
        print("Recycled WebContent PID: \(WebContentWatchdog.webContentPid(recycled) ?? 0)")
        _ = try await js(recycled, "const t=document.createElement('textarea');t.id='child-draft';t.value='unsent child draft';document.body.append(t);true")
        precondition(!delegate.windowShouldClose(firstWindow))
        try await wait { firstWindow.attachedSheet != nil }
        print("Unsaved close guard displayed without activation")
        let sheet = firstWindow.attachedSheet!
        firstWindow.endSheet(sheet, returnCode: .alertFirstButtonReturn)
        sheet.orderOut(nil)
        try await wait { firstWindow.attachedSheet == nil }
        precondition(delegate.popoutWindows.count == 2)
        let childDraft = try await js(recycled, "document.querySelector('#child-draft').value")
        precondition(childDraft as? String == "unsent child draft")
        _ = try await js(recycled, "document.querySelector('#child-draft').remove(); document.querySelectorAll('textarea').forEach(t=>t.value=''); true")
        firstWindow.performClose(nil)
        try await wait { delegate.popoutWindows.count == 1 }
        _ = try await js(parent, "document.querySelector('.main-page-session-column [data-session-id=\"\(sid)\"] .session-panel-popout').click(); true")
        try await wait { delegate.popoutWindows.count == 2 }
        let reopened = delegate.popoutWindows.values.first { ($0.contentView as? WKWebView)?.url?.absoluteString.contains("view=session") == true }
        try await wait { delegate.popoutWindows.values.contains { ($0.contentView as? WKWebView)?.url?.absoluteString.contains("view=session") == true } }
        let final = reopened ?? delegate.popoutWindows.values.first { ($0.contentView as? WKWebView)?.url?.absoluteString.contains("view=session") == true }!
        try await wait { (try? await js(final.contentView as! WKWebView, "!!document.querySelector('.popout-session .session-panel-input textarea')")) as? Bool == true }
        delegate.window.close()
        precondition(delegate.popoutWindows.count == 2)
        precondition(!final.isVisible)
        let finalView = final.contentView as! WKWebView
        try await wait { (try? await js(finalView, "!document.querySelector('.session-panel-header').textContent.includes('Loading...')")) as? Bool == true }
        let finalTitle = try await js(finalView, "document.title")
        precondition(finalTitle is String)
        if let output = ProcessInfo.processInfo.environment["WALNUT_TEST_SCREENSHOT"] {
            let image: NSImage = try await withCheckedThrowingContinuation { done in
                finalView.takeSnapshot(with: nil) { image, error in
                    if let image { done.resume(returning: image) }
                    else { done.resume(throwing: error ?? NSError(domain: "Snapshot", code: 1)) }
                }
            }
            let rep = NSBitmapImageRep(data: image.tiffRepresentation!)!
            try rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: output))
        }
        precondition(NSWorkspace.shared.frontmostApplication?.processIdentifier != ProcessInfo.processInfo.processIdentifier)
        print("Background verification: never activated; initial foreground PID \(frontmost ?? 0)")
        print("PopoutWindowTests: native open, reuse, independent bridges, draft preservation, recycle, close/cancel/reopen and parent close passed")
    }

    @MainActor
    static func js(_ view: WKWebView, _ source: String) async throws -> Any? {
        try await withCheckedThrowingContinuation { done in
            view.evaluateJavaScript(source) { value, error in
                if let error { done.resume(throwing: error) }
                else { done.resume(returning: value) }
            }
        }
    }

    @MainActor
    static func wait(_ check: () async throws -> Bool) async throws {
        let deadline = Date().addingTimeInterval(60)
        while try await !check() {
            if Date() > deadline { throw NSError(domain: "PopoutWindowTests", code: 1, userInfo: [NSLocalizedDescriptionKey: "Timed out waiting for native window state"]) }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
    }
}

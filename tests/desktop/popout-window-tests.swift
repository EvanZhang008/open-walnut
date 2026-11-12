import Cocoa
import WebKit

private final class BackgroundApplication: NSApplication {
    var testKeyWindow: NSWindow?
    override var keyWindow: NSWindow? { testKeyWindow ?? super.keyWindow }
}

extension NSWorkspace {
    @MainActor @objc func walnutTestOpen(_ url: URL) -> Bool {
        PopoutWindowTests.externalOpens.append(url)
        return true
    }
}

private final class BackgroundAppDelegate: AppDelegate {
    override func applicationDidFinishLaunching(_ notification: Notification) {}
    override func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
}

@main
struct PopoutWindowTests {
    @MainActor
    static func main() {
        setbuf(stdout, nil)
        let app = BackgroundApplication.shared
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
        delegate.setupMainMenu()
        let fileMenu = app.mainMenu?.items.compactMap { $0.submenu }.first { $0.title == "File" }
        let closeItem = fileMenu?.item(withTitle: "Close Window")
        precondition(closeItem?.keyEquivalent == "w")
        precondition(closeItem?.keyEquivalentModifierMask == .command)
        precondition(closeItem?.action == #selector(NSWindow.performClose(_:)))
        precondition(closeItem?.target == nil)
        delegate.webContentWatchdog = WebContentWatchdog(
            policyProvider: { WebContentPolicy.fromDefaults(UserDefaults.standard) },
            portProvider: { delegate.serverPort },
            recycle: { [weak delegate] _, _ in delegate?.recycleWebContent(reason: "test") })
        let port = Int(ProcessInfo.processInfo.environment["WALNUT_TEST_PORT"] ?? "0")!
        precondition(port > 0 && port != 3456)
        delegate.serverPort = port
        delegate.commandLineToolChecked = true
        delegate.window = QuietKeyWindow(contentRect: NSRect(x: 0, y: 0, width: 1200, height: 800),
            styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        delegate.window.isReleasedWhenClosed = false
        delegate.loadWebUI()
        let parent = delegate.webView!
        parent.configuration.userContentController.removeScriptMessageHandler(forName: NotificationBridge.handlerName)
        parent.configuration.preferences.javaScriptCanOpenWindowsAutomatically = true
        try await wait { (try? await js(parent, "!!document.querySelector('main')")) as? Bool == true }
        print("Loaded background parent")
        try await agentRefScenario(delegate, parent, port)
        if ProcessInfo.processInfo.environment["WALNUT_TEST_AGENT_REFS_ONLY"] == "1" {
            try expect(!NSApp.isActive && !delegate.window.isVisible, "the reference check activated or showed its window")
            print("PopoutWindowTests: native agent refs passed without showing a window or sending a session message")
            return
        }
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
        let secondURL = "http://localhost:\(port)/popout?view=note&id=missing-test-note"
        _ = try await js(parent, "window.open('\(secondURL)','second-target'); true")
        try await wait { delegate.popoutWindows.count == 2 }
        precondition(parent.url == parentBefore)
        let parentDraft = try await js(parent, "document.querySelector('#test-draft').value")
        precondition(parentDraft as? String == "unsent parent draft")
        let secondWindow = delegate.popoutWindows.values.first { $0 !== firstWindow }!
        let second = secondWindow.contentView as! WKWebView
        try await wait { second.url?.absoluteString == secondURL && !second.isLoading }
        let navigatedURL = "http://localhost:\(port)/popout?view=note&id=different-note"
        _ = try await js(second, "history.pushState({},'', '\(navigatedURL)'); true")
        _ = try await js(parent, "window.open('\(secondURL)','second-target'); true")
        try await wait { delegate.popoutWindows.count == 3 }
        precondition(second.url?.absoluteString == navigatedURL)
        let thirdWindow = delegate.popoutWindows.values.first { $0 !== firstWindow && $0 !== secondWindow }!
        let third = thirdWindow.contentView as! WKWebView
        try await wait { third.url?.absoluteString == secondURL && !third.isLoading }
        _ = try await js(third, "document.querySelectorAll('textarea').forEach(t=>t.value=''); true")
        try pressCloseKey(thirdWindow)
        try await wait { delegate.popoutWindows.count == 2 && !thirdWindow.isVisible }
        precondition(delegate.popoutWindows.values.contains { $0 === firstWindow })
        print("Command-W closed only the key window")
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
        try pressCloseKey(firstWindow)
        try pressCloseKey(firstWindow)
        try await wait { firstWindow.attachedSheet != nil }
        print("Unsaved close guard displayed without activation")
        let sheet = firstWindow.attachedSheet!
        firstWindow.endSheet(sheet, returnCode: .alertFirstButtonReturn)
        sheet.orderOut(nil)
        try await wait { firstWindow.attachedSheet == nil }
        print("Command-W cancellation dismissed the sheet")
        precondition(delegate.popoutWindows.count == 2)
        let childDraft = try await js(recycled, "document.querySelector('#child-draft').value")
        precondition(childDraft as? String == "unsent child draft")
        _ = try await js(recycled, "document.querySelector('#child-draft').remove(); document.querySelectorAll('textarea').forEach(t=>t.value=''); true")
        let clean = try await js(recycled, "!window.__walnutUnsavedSnapshot?.().dirtyEditor && Array.from(document.querySelectorAll('textarea')).every(e=>!e.value)")
        print("Command-W clean view: \(String(describing: clean))")
        try pressCloseKey(firstWindow)
        try await wait { delegate.popoutWindows.count == 1 && !firstWindow.isVisible }
        print("Command-W closed clean session after cancellation")
        _ = try await js(parent, "document.querySelector('.main-page-session-column [data-session-id=\"\(sid)\"] .session-panel-popout').click(); true")
        try await wait { delegate.popoutWindows.count == 2 }
        let reopened = delegate.popoutWindows.values.first { ($0.contentView as? WKWebView)?.url?.absoluteString.contains("view=session") == true }
        try await wait { delegate.popoutWindows.values.contains { ($0.contentView as? WKWebView)?.url?.absoluteString.contains("view=session") == true } }
        let final = reopened ?? delegate.popoutWindows.values.first { ($0.contentView as? WKWebView)?.url?.absoluteString.contains("view=session") == true }!
        try await wait { (try? await js(final.contentView as! WKWebView, "!!document.querySelector('.popout-session .session-panel-input textarea')")) as? Bool == true }
        try pressCloseKey(delegate.window)
        try await wait { !delegate.window.isVisible }
        precondition(delegate.popoutWindows.count == 2)
        print("Command-W closed parent without closing children")
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
        _ = try await js(finalView, "const t=document.createElement('textarea');t.value='discard test draft';document.body.append(t);true")
        try pressCloseKey(final)
        try await wait { final.attachedSheet != nil }
        print("Command-W discard sheet displayed")
        let discardSheet = final.attachedSheet!
        final.endSheet(discardSheet, returnCode: .alertSecondButtonReturn)
        discardSheet.orderOut(nil)
        try await wait { final.attachedSheet == nil }
        print("Command-W discard sheet dismissed; remaining windows: \(delegate.popoutWindows.count)")
        try await wait { delegate.popoutWindows.count == 1 }
        print("Command-W discard confirmation closed the selected window")
        precondition(NSWorkspace.shared.frontmostApplication?.processIdentifier != ProcessInfo.processInfo.processIdentifier)
        print("Background verification: never activated; initial foreground PID \(frontmost ?? 0)")
        print("PopoutWindowTests: native agent refs, native open, reuse, independent bridges, draft preservation, recycle, close/cancel/reopen and parent close passed")
    }

    @MainActor static var externalOpens: [URL] = []
    @MainActor static var eventNumber = 0
    @MainActor static var createdLetters: [String] = []

    struct Failure: Error, CustomStringConvertible { let description: String }

    @MainActor
    static func expect(_ ok: Bool, _ message: @autoclosure () -> String) throws {
        if !ok { throw Failure(description: message()) }
    }

    @MainActor
    static func agentRefScenario(_ delegate: AppDelegate, _ parent: WKWebView, _ port: Int) async throws {
        precondition(port != 3456)
        let original = class_getInstanceMethod(NSWorkspace.self, NSSelectorFromString("openURL:"))!
        let capture = class_getInstanceMethod(NSWorkspace.self, #selector(NSWorkspace.walnutTestOpen(_:)))!
        method_exchangeImplementations(original, capture)
        defer {
            method_exchangeImplementations(original, capture)
            externalOpens.removeAll()
        }
        do {
            try await agentRefChecks(delegate, parent, port)
        } catch {
            await archiveCreatedLetters(port)
            throw error
        }
        await archiveCreatedLetters(port)
    }

    @MainActor
    static func agentRefChecks(_ delegate: AppDelegate, _ parent: WKWebView, _ port: Int) async throws {
        let dir = FileManager.default.temporaryDirectory.resolvingSymlinksInPath()
            .appendingPathComponent("walnut-agent-ref-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let tag = UUID().uuidString.prefix(8).lowercased()
        let marker = "agent-ref-marker-\(tag)"
        let file = dir.appendingPathComponent("agent-ref-\(tag).txt")
        try "first line\n\(marker)\nthird line\n".write(to: file, atomically: true, encoding: .utf8)
        let zeros = String(repeating: "0", count: 32)
        let encodedPath = file.path.addingPercentEncoding(withAllowedCharacters: .alphanumerics)!
        let stale = "http://localhost:\(port)/open-ref#token=\(zeros)&kind=file&path=\(encodedPath)"
        let targetSubject = "Agent ref target \(tag)"
        let sourceSubject = "Agent ref source \(tag)"
        let targetId = try await postLetter(port, targetSubject, "<p>Target letter \(tag)</p>")
        let sourceHTML = "<style>a.t{position:absolute;left:0;width:300px;height:60px;display:block}</style>"
            + "<a class=\"t\" style=\"top:0\" href=\"\(file.path):2\">file</a>"
            + "<a class=\"t\" style=\"top:80px\" href=\"letter:\(targetId)\">letter</a>"
            + "<a class=\"t\" style=\"top:160px\" href=\"\(stale.replacingOccurrences(of: "&", with: "&amp;"))\">stale</a>"
        let sourceId = try await postLetter(port, sourceSubject, sourceHTML)
        print("Created agent-ref letters \(sourceId) -> \(targetId)")
        let bridge = try await js(parent, "typeof window.__walnutDesktop?.openAgentRef")
        try expect(bridge as? String == "function", "the page has no desktop openAgentRef bridge")
        let prefs = parent.configuration.preferences
        let popupsBefore = prefs.javaScriptCanOpenWindowsAutomatically
        prefs.javaScriptCanOpenWindowsAutomatically = false
        defer { prefs.javaScriptCanOpenWindowsAutomatically = popupsBefore }
        try await openLetter(parent, sourceId, sourceSubject)
        _ = try await js(parent, "const t=document.createElement('textarea');t.id='ref-draft';t.value='unsent ref draft';document.body.append(t);true")
        defer { parent.evaluateJavaScript("document.querySelector('#ref-draft')?.remove()", completionHandler: nil) }
        let urlBefore = parent.url
        let popouts = delegate.popoutWindows.count
        let webWindows = NSApp.windows.filter { $0.contentView is WKWebView }.count
        let visible = parent.window!.isVisible
        let check: @MainActor (String) async throws -> Void = { step in
            try expect(parent.url == urlBefore, "\(step): parent URL changed to \(String(describing: parent.url))")
            try expect(delegate.popoutWindows.count == popouts, "\(step): popout count changed")
            try expect(NSApp.windows.filter { $0.contentView is WKWebView }.count == webWindows, "\(step): a web window was created")
            try expect(parent.window!.isVisible == visible && !NSApp.isActive, "\(step): window shown or app activated")
            let draft = try await js(parent, "document.querySelector('#ref-draft')?.value")
            try expect(draft as? String == "unsent ref draft", "\(step): parent draft lost")
        }
        let viewerOpen = "document.querySelector('.file-viewer-full-path')?.textContent === \(AppLink.jsString(file.path))"
            + " && document.querySelector('.file-viewer-line')?.textContent === ':2'"
        let viewerContent = "(document.querySelector('.file-viewer-overlay')?.textContent ?? '').includes('\(marker)')"
        for round in ["first", "repeat"] {
            try await clickRef(parent, 0)
            try await wait { (try? await js(parent, viewerOpen)) as? Bool == true }
            try await wait { (try? await js(parent, viewerContent)) as? Bool == true }
            try expect(externalOpens.isEmpty, "file ref fell back to an external open")
            let subject = try await readerSubject(parent)
            try expect(subject == sourceSubject, "file \(round): reader left the source letter")
            try await check("file \(round)")
            if round == "first", let output = ProcessInfo.processInfo.environment["WALNUT_TEST_SCREENSHOT"] {
                let image: NSImage = try await withCheckedThrowingContinuation { done in
                    parent.takeSnapshot(with: nil) { image, error in
                        if let image { done.resume(returning: image) }
                        else { done.resume(throwing: error ?? Failure(description: "No viewer snapshot")) }
                    }
                }
                let rep = NSBitmapImageRep(data: image.tiffRepresentation!)!
                try rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: output))
            }
            print("Native agent-ref file click (\(round)) opened \(file.lastPathComponent):2 in place")
            try await clickElement(parent, ".file-viewer-close")
            try await wait { (try? await js(parent, "!document.querySelector('.file-viewer-overlay')")) as? Bool == true }
        }
        for round in ["first", "repeat"] {
            if round == "repeat" { try await openLetter(parent, sourceId, sourceSubject) }
            try await clickRef(parent, 1)
            try await wait { try await readerSubject(parent) == targetSubject }
            try expect(externalOpens.isEmpty, "letter ref fell back to an external open")
            try await check("letter \(round)")
            print("Native agent-ref letter click (\(round)) opened \(targetId) in place")
        }
        try await openLetter(parent, sourceId, sourceSubject)
        try await clickRef(parent, 2)
        try await wait { externalOpens.count == 1 }
        let fallback = externalOpens[0]
        try expect(fallback.path == "/open-ref" && fallback.fragment?.hasPrefix("token=\(zeros)&") == true,
            "unexpected fallback URL \(fallback)")
        try await Task.sleep(nanoseconds: 1_000_000_000)
        let stillClosed = try await js(parent, "!document.querySelector('.file-viewer-overlay')")
        try expect(stillClosed as? Bool == true, "an unclaimed ref opened in place")
        let subject = try await readerSubject(parent)
        try expect(subject == sourceSubject && externalOpens.count == 1, "unclaimed ref changed the reader")
        try await check("unclaimed ref")
        print("Native agent-ref with an unknown token fell back to one external open and no window")
        try await clickElement(parent, ".hib-reader-close")
        try await wait { (try? await js(parent, "!document.querySelector('.hib-reader')")) as? Bool == true }
        try await clickElement(parent, ".notification-panel-close")
        try await wait { (try? await js(parent, "!document.querySelector('.notification-panel-close')")) as? Bool == true }
    }

    @MainActor
    static func archiveCreatedLetters(_ port: Int) async {
        guard port != 3456 else { return }
        for id in createdLetters {
            var request = URLRequest(url: URL(string: "http://localhost:\(port)/api/v1/human-inbox/\(id)/archive")!)
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try? JSONSerialization.data(withJSONObject: ["archived": true])
            let status = ((try? await URLSession.shared.data(for: request))?.1 as? HTTPURLResponse)?.statusCode ?? 0
            print("Archived test letter \(id): \(status)")
        }
        createdLetters.removeAll()
    }

    @MainActor
    static func postLetter(_ port: Int, _ subject: String, _ html: String) async throws -> String {
        precondition(port != 3456)
        var request = URLRequest(url: URL(string: "http://localhost:\(port)/api/v1/human-inbox")!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["subject": subject, "type": "info", "html": html])
        let (data, response) = try await URLSession.shared.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 201, let id = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["id"] as? String else {
            throw NSError(domain: "PopoutWindowTests", code: 2, userInfo: [NSLocalizedDescriptionKey:
                "Creating a letter answered \(status): \(String(data: data, encoding: .utf8) ?? "")"])
        }
        createdLetters.append(id)
        return id
    }

    @MainActor
    static func readerSubject(_ view: WKWebView) async throws -> String? {
        try await js(view, "document.querySelector('.hib-reader-subject')?.textContent ?? null") as? String
    }

    @MainActor
    static func openLetter(_ view: WKWebView, _ id: String, _ subject: String) async throws {
        try await wait {
            if try await readerSubject(view) == subject,
               (try await js(view, "!!document.querySelector('.hib-reader-body .hib-html-frame')")) as? Bool == true { return true }
            _ = try await js(view, "window.dispatchEvent(new CustomEvent('notification:open-center',{detail:{letterId:'\(id)'}})); true")
            try await Task.sleep(nanoseconds: 900_000_000)
            return false
        }
        try await Task.sleep(nanoseconds: 1_500_000_000)
    }

    @MainActor
    static func clickRef(_ view: WKWebView, _ index: Int) async throws {
        let probe = """
        (() => {const f=document.querySelector('.hib-reader-body .hib-html-frame'); if(!f) return null;
        f.scrollIntoView({block:'start'}); const r=f.getBoundingClientRect();
        const x=r.left+1+150, y=r.top+1+30+80*\(index);
        return [x, y, r.width, r.height, document.elementFromPoint(x,y)===f ? 1 : 0, innerHeight]})()
        """
        guard let box = try await js(view, probe) as? [Double], box.count == 6 else {
            throw NSError(domain: "PopoutWindowTests", code: 3, userInfo: [NSLocalizedDescriptionKey: "Letter frame missing"])
        }
        guard box[2] >= 310, box[3] >= 225, box[4] == 1, box[1] < box[5] else {
            throw NSError(domain: "PopoutWindowTests", code: 3, userInfo: [NSLocalizedDescriptionKey: "Letter frame not hittable: \(box)"])
        }
        try await nativeClick(view, box[0], box[1])
    }

    @MainActor
    static func clickElement(_ view: WKWebView, _ selector: String) async throws {
        let probe = """
        (() => {const e=document.querySelector(\(AppLink.jsString(selector))); if(!e) return null;
        const r=e.getBoundingClientRect(); const x=r.left+r.width/2, y=r.top+r.height/2;
        const h=document.elementFromPoint(x,y); return [x, y, r.width, r.height, h && e.contains(h) ? 1 : 0]})()
        """
        guard let box = try await js(view, probe) as? [Double], box.count == 5, box[2] > 0, box[3] > 0, box[4] == 1 else {
            throw Failure(description: "\(selector) is not hittable")
        }
        try await nativeClick(view, box[0], box[1])
    }

    @MainActor
    static func nativeClick(_ view: WKWebView, _ cssX: Double, _ cssY: Double) async throws {
        let window = view.window!
        var point = NSPoint(x: cssX * view.pageZoom, y: cssY * view.pageZoom)
        if !view.isFlipped { point.y = view.bounds.height - point.y }
        let inWindow = view.convert(point, to: nil)
        let content = window.contentView!
        guard let hit = content.hitTest(content.superview?.convert(inWindow, from: nil) ?? inWindow),
              hit === view || hit.isDescendant(of: view) else {
            throw NSError(domain: "PopoutWindowTests", code: 4, userInfo: [NSLocalizedDescriptionKey: "No WebKit hit target at \(inWindow)"])
        }
        for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
            eventNumber += 1
            let event = NSEvent.mouseEvent(with: type, location: inWindow, modifierFlags: [],
                timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil,
                eventNumber: eventNumber, clickCount: 1, pressure: type == .leftMouseDown ? 1 : 0)!
            if type == .leftMouseDown { hit.mouseDown(with: event) } else { hit.mouseUp(with: event) }
            try await Task.sleep(nanoseconds: 60_000_000)
        }
    }

    @MainActor
    static func pressCloseKey(_ window: NSWindow) throws {
        let app = NSApp as! BackgroundApplication
        app.testKeyWindow = window
        defer { app.testKeyWindow = nil }
        precondition(NSApp.keyWindow === window)
        let event = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: .command,
            timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
            context: nil, characters: "w", charactersIgnoringModifiers: "w", isARepeat: false, keyCode: 13)!
        NSApp.mainMenu!.update()
        let target = NSApp.target(forAction: #selector(NSWindow.performClose(_:)))
        print("Command-W target matches: \((target as? NSWindow) === window), sheet: \(window.attachedSheet != nil)")
        precondition(NSApp.mainMenu!.performKeyEquivalent(with: event))
        // No window state here: a pop-out closes only after its page answers whether it holds
        // unsaved work (windowShouldClose in desktop/main.swift), so each caller waits for what
        // the key should do. 2026-11-11, nightly-extra-tests run 43021612722: a window the
        // discard sheet had shown was still visible right after a clean Command-W.
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
    static func wait(file: String = #fileID, line: Int = #line, _ check: () async throws -> Bool) async throws {
        let deadline = Date().addingTimeInterval(60)
        while try await !check() {
            if Date() > deadline { throw NSError(domain: "PopoutWindowTests", code: 1, userInfo: [NSLocalizedDescriptionKey: "Timed out waiting for native window state at \(file):\(line)"]) }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
    }
}

import Cocoa
import WebKit

private final class UpdateTestDelegate: AppDelegate {
    override func applicationDidFinishLaunching(_ notification: Notification) {}
    override func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
}

@main struct UpdateWindowTests {
    @MainActor static func main() {
        setbuf(stdout, nil)
        NSApplication.shared.setActivationPolicy(.prohibited)
        Task { @MainActor in
            do { try await run(); print("UpdateWindowTests: passed"); exit(0) }
            catch { print("UpdateWindowTests failed: \(error)"); exit(1) }
        }
        NSApplication.shared.run()
    }

    @MainActor static func wait(_ name: String, _ predicate: @escaping () async throws -> Bool) async throws {
        let deadline = Date().addingTimeInterval(10)
        while Date() < deadline {
            if try await predicate() { return }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        throw NSError(domain: name, code: 1)
    }

    @MainActor static func js(_ view: WKWebView, _ source: String) async throws {
        _ = try await view.evaluateJavaScript(source)
    }

    @MainActor static func run() async throws {
        let owner = UpdateTestDelegate()
        NSApplication.shared.delegate = owner
        owner.appUpdater = AppUpdater()
        owner.appUpdater!.state.downloadedVersion = "1.1.0"
        let configuration = WKWebViewConfiguration()
        configuration.userContentController.addScriptMessageHandler(owner, contentWorld: .page, name: "walnutUpdate")
        let main = WKWebView(frame: NSRect(x: 0, y: 0, width: 1000, height: 700), configuration: configuration)
        owner.window = NSWindow(contentRect: main.frame, styleMask: [.titled, .closable], backing: .buffered, defer: false)
        owner.window.isReleasedWhenClosed = false
        owner.window.contentView = main
        owner.webView = main
        owner.webContentWatchdog = watchdog(main, owner.window)
        main.loadHTMLString("<textarea id='draft'></textarea>", baseURL: nil)
        let child = WKWebView(frame: main.frame)
        let childWindow = NSWindow(contentRect: child.frame, styleMask: [.titled, .closable], backing: .buffered, defer: false)
        childWindow.isReleasedWhenClosed = false
        childWindow.contentView = child
        let childKey = ObjectIdentifier(child)
        owner.popoutWindows[childKey] = childWindow
        owner.popoutWatchdogs[childKey] = watchdog(child, childWindow)
        child.loadHTMLString("<textarea id='draft'></textarea>", baseURL: nil)
        try await wait("two live views") {
            let mainReady = (try? await main.evaluateJavaScript("!!document.querySelector('#draft')")) as? Bool == true
            let childReady = (try? await child.evaluateJavaScript("!!document.querySelector('#draft')")) as? Bool == true
            return mainReady && childReady
        }
        var clean: Bool?
        owner.checkUpdateWindows { clean = $0 }
        try await wait("clean scan") { clean != nil }
        precondition(clean == true)
        try await js(child, "document.querySelector('#draft').value='Keep the child draft'")
        var result: Bool?
        owner.confirmInstall(from: main) { result = $0 }
        try await wait("dirty refusal") { result != nil }
        precondition(result == false)
        try await dismissAlert(owner.window, response: .alertFirstButtonReturn)
        let retainedChild = try await child.evaluateJavaScript("document.querySelector('#draft').value") as? String
        precondition(retainedChild == "Keep the child draft")
        print("PASS: child dirty blocks main restart without deleting text")
        try await js(child, "document.querySelector('#draft').value=''")
        try await js(main, "document.querySelector('#draft').value='Keep the main draft'")
        result = nil
        owner.confirmInstall(from: child) { result = $0 }
        try await wait("main dirty refusal") { result != nil }
        precondition(result == false)
        try await dismissAlert(childWindow, response: .alertFirstButtonReturn)
        try await js(main, "document.querySelector('#draft').value=''")
        print("PASS: main dirty blocks child restart")
        result = nil
        owner.confirmInstall(from: child) { result = $0 }
        try await wait("child confirmation sheet") { childWindow.attachedSheet != nil }
        var duplicate: Bool?
        owner.confirmInstall(from: main) { duplicate = $0 }
        precondition(duplicate == false)
        await endSheet(childWindow, response: .alertSecondButtonReturn)
        try await wait("cancel callback") { result != nil }
        precondition(result == false)
        print("PASS: cancel and duplicate confirmation")
        result = nil
        owner.confirmInstall(from: main) { result = $0 }
        try await wait("main confirmation sheet") { owner.window.attachedSheet != nil }
        try await js(child, "document.querySelector('#draft').value='Typed while confirming'")
        await endSheet(owner.window, response: .alertFirstButtonReturn)
        try await wait("late dirty refusal") { result != nil }
        precondition(result == false)
        try await dismissAlert(owner.window, response: .alertFirstButtonReturn)
        let lateDraft = try await child.evaluateJavaScript("document.querySelector('#draft').value") as? String
        precondition(lateDraft == "Typed while confirming")
        try await js(child, "document.querySelector('#draft').value=''")
        print("PASS: input during sheet is checked again")
        result = nil
        owner.confirmInstall(from: child) { result = $0 }
        try await wait("closing source sheet") { childWindow.attachedSheet != nil }
        await endSheet(childWindow, response: .alertFirstButtonReturn)
        owner.popoutWindows.removeValue(forKey: childKey)
        owner.popoutWatchdogs.removeValue(forKey: childKey)
        childWindow.contentView = nil
        childWindow.close()
        try await wait("closed source refusal") { result != nil }
        precondition(result == false)
        print("PASS: closed source cannot approve a late callback")
        result = nil
        owner.confirmInstall(from: main) { result = $0 }
        try await wait("clean retry sheet") { owner.window.attachedSheet != nil }
        await endSheet(owner.window, response: .alertFirstButtonReturn)
        try await wait("clean retry approved") { result != nil }
        precondition(result == true)
        print("PASS: clean retry confirms once without installing")
        let detached = WKWebView(frame: main.frame)
        var detachedResult: Bool?
        owner.confirmInstall(from: detached) { detachedResult = $0 }
        precondition(detachedResult == false)
        result = nil
        owner.confirmInstall(from: main) { result = $0 }
        try await wait("new window sheet") { owner.window.attachedSheet != nil }
        let newcomer = WKWebView(frame: main.frame)
        let newWindow = NSWindow(contentRect: newcomer.frame, styleMask: [.titled], backing: .buffered, defer: false)
        newWindow.isReleasedWhenClosed = false
        newWindow.contentView = newcomer
        newcomer.loadHTMLString("<textarea>New unsaved work</textarea>", baseURL: nil)
        let newKey = ObjectIdentifier(newcomer)
        owner.popoutWindows[newKey] = newWindow
        owner.popoutWatchdogs[newKey] = watchdog(newcomer, newWindow)
        try await wait("new window draft loaded") { (try? await newcomer.evaluateJavaScript("document.querySelector('textarea')?.value")) as? String == "New unsaved work" }
        await endSheet(owner.window, response: .alertFirstButtonReturn)
        try await wait("new dirty window refusal") { result != nil }
        precondition(result == false)
        try await dismissAlert(owner.window, response: .alertFirstButtonReturn)
        owner.popoutWindows.removeValue(forKey: newKey)
        owner.popoutWatchdogs.removeValue(forKey: newKey)
        newWindow.close()
        print("PASS: detached source and new dirty windows are refused")
        try await js(main, "document.querySelector('#draft').value='Typed after approval';window.installResult=null;window.webkit.messageHandlers.walnutUpdate.postMessage({op:'install'}).then(()=>window.installResult='accepted',()=>window.installResult='refused'); true")
        try await wait("install guard refusal") { (try? await main.evaluateJavaScript("window.installResult")) as? String == "refused" }
        precondition(owner.appUpdater!.testInstallCalls == 0)
        try await js(main, "document.querySelector('#draft').value='';window.installResult=null;window.webkit.messageHandlers.walnutUpdate.postMessage({op:'install'}).then(()=>window.installResult='accepted',()=>window.installResult='refused'); true")
        try await wait("clean install boundary") { (try? await main.evaluateJavaScript("window.installResult")) as? String == "accepted" }
        precondition(owner.appUpdater!.testInstallCalls == 1)
        print("PASS: actual install bridge refuses late dirty and accepts clean through a stub")
        precondition(!NSRunningApplication.current.isActive)
        owner.window.close()
        print("PASS: all windows stayed hidden and production was untouched")
    }

    @MainActor static func watchdog(_ view: WKWebView, _ window: NSWindow) -> WebContentWatchdog {
        let watchdog = WebContentWatchdog(policyProvider: { WebContentPolicy.fromDefaults(UserDefaults.standard) }, portProvider: { nil }, recycle: { _, _ in })
        watchdog.attach(webView: view, window: window)
        return watchdog
    }

    @MainActor static func endSheet(_ window: NSWindow, response: NSApplication.ModalResponse) async {
        if let sheet = window.attachedSheet { window.endSheet(sheet, returnCode: response) }
    }

    @MainActor static func dismissAlert(_ window: NSWindow, response: NSApplication.ModalResponse) async throws {
        try await wait("save-work sheet") { window.attachedSheet != nil }
        await endSheet(window, response: response)
        try await wait("save-work sheet detached") { window.attachedSheet == nil }
    }
}

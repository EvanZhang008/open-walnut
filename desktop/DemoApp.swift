import Cocoa
import WebKit

final class DemoAppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate {
    private var window: NSWindow!
    private var page: WKWebView?
    private var busy = false
    private var pendingReset = false
    private let background = ProcessInfo.processInfo.environment["WALNUT_DESKTOP_E2E_BACKGROUND"] == "1"
    private let root: URL = {
        if let path = ProcessInfo.processInfo.environment["WALNUT_DESKTOP_E2E_DEMO_ROOT"], path.hasPrefix("/"), URL(fileURLWithPath: path).lastPathComponent == "open-walnut-demo" { return URL(fileURLWithPath: path) }
        return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".local/share/open-walnut-demo")
    }()
    private var runtime: BundledRuntime { BundledRuntime(installDir: root.appendingPathComponent("installation").path) }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        let menu = NSMenu()
        let item = NSMenuItem()
        let app = NSMenu()
        app.addItem(NSMenuItem(title: "Open Demo", action: #selector(openDemo), keyEquivalent: ""))
        app.addItem(NSMenuItem(title: "Reset Demo", action: #selector(resetDemo), keyEquivalent: ""))
        app.addItem(.separator())
        app.addItem(NSMenuItem(title: "Quit Walnut Demo", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        item.submenu = app
        menu.addItem(item)
        let editItem = NSMenuItem()
        let edit = NSMenu(title: "Edit")
        edit.addItem(NSMenuItem(title: "Undo", action: Selector(("undo:")), keyEquivalent: "z"))
        edit.addItem(NSMenuItem(title: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x"))
        edit.addItem(NSMenuItem(title: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c"))
        edit.addItem(NSMenuItem(title: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v"))
        edit.addItem(NSMenuItem(title: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a"))
        editItem.submenu = edit
        menu.addItem(editItem)
        NSApp.mainMenu = menu
        window = QuietKeyWindow(contentRect: NSRect(x: 0, y: 0, width: 1200, height: 800), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.title = "Walnut Demo"
        window.center()
        if pendingReset {
            // Launched by Reset Demo: ask before starting anything.
            pendingReset = false
            showWindow()
            showStatus("Walnut Demo")
            resetDemo()
        } else {
            openDemo()
        }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        openDemo()
        return false
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        for url in urls {
            switch DemoCommand(url: url) {
            case .open?:
                if window != nil { openDemo() }
            case .reset?:
                if window == nil { pendingReset = true } else { requestReset() }
            case nil:
                break
            }
        }
    }

    private func showWindow() {
        if background { window.orderBack(nil) } else { window.makeKeyAndOrderFront(nil) }
    }

    // A kept page holds the user's unsent drafts, so only a missing one starts Demo.
    @objc private func openDemo() {
        showWindow()
        if page == nil && !busy { run(reset: false) }
    }

    private func requestReset() {
        showWindow()
        if busy { pendingReset = true; return }
        resetDemo()
    }

    @objc private func resetDemo() {
        guard !busy, window.attachedSheet == nil else { return }
        let alert = NSAlert()
        alert.messageText = "Reset Walnut Demo?"
        alert.informativeText = "This stops Demo sessions and starts a fresh Demo. Old Demo files are kept if their background processes cannot be confirmed stopped. Your real Walnut is unchanged."
        alert.addButton(withTitle: "Cancel")
        alert.addButton(withTitle: "Reset Demo")
        alert.beginSheetModal(for: window) { [weak self] response in
            guard let self = self else { return }
            if response == .alertSecondButtonReturn { self.run(reset: true) }
            else if self.page == nil && !self.busy { self.run(reset: false) }
        }
    }

    private func showStatus(_ text: String, retry: Bool = false) {
        let content = NSView(frame: window.contentView?.bounds ?? .zero)
        let label = NSTextField(wrappingLabelWithString: text)
        label.translatesAutoresizingMaskIntoConstraints = false
        label.alignment = .center
        content.addSubview(label)
        NSLayoutConstraint.activate([label.centerXAnchor.constraint(equalTo: content.centerXAnchor), label.centerYAnchor.constraint(equalTo: content.centerYAnchor), label.widthAnchor.constraint(lessThanOrEqualToConstant: 600)])
        if retry {
            let button = NSButton(title: "Retry", target: self, action: #selector(openDemo))
            button.translatesAutoresizingMaskIntoConstraints = false
            content.addSubview(button)
            NSLayoutConstraint.activate([button.topAnchor.constraint(equalTo: label.bottomAnchor, constant: 20), button.centerXAnchor.constraint(equalTo: content.centerXAnchor)])
        }
        window.contentView = content
    }

    private func finishRun() {
        busy = false
        if pendingReset {
            pendingReset = false
            resetDemo()
        }
    }

    private func run(reset: Bool) {
        guard !busy else { return }
        busy = true
        // The page this run replaces ends with it, as the Mac app's do (tests/desktop/replaced-page-ends.test.ts).
        if let old = page { WebContentProcess.retireReplacedPage(old) { [weak self] in self?.page } }
        page = nil
        showStatus(reset ? "Stopping Demo sessions..." : "Starting Walnut Demo...")
        let rt = runtime
        let resourceDirs = DemoBundle.resourceDirs(own: Bundle.main.resourcePath, bundle: Bundle.main.bundleURL)
        DispatchQueue.global(qos: .utility).async { [weak self] in
            guard let self = self else { return }
            do {
                for directory in [self.root, self.root.appendingPathComponent("installation"), self.root.appendingPathComponent("launcher-home")] {
                    var current = directory
                    while current.path != "/" {
                        if FileManager.default.fileExists(atPath: current.path) {
                            let attributes = try FileManager.default.attributesOfItem(atPath: current.path)
                            if attributes[.type] as? FileAttributeType != .typeDirectory { throw DemoError.message("Demo requires its own plain directory, not a link.") }
                        }
                        current.deleteLastPathComponent()
                    }
                }
                try FileManager.default.createDirectory(at: self.root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
                var env: [String: String] = ["HOME": self.root.appendingPathComponent("launcher-home").path, "PATH": "/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin", "WALNUT_RUNTIME_DIR": self.root.appendingPathComponent("runtime").path]
                try FileManager.default.createDirectory(atPath: env["HOME"]!, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
                let arch = BundledRuntime.machineArch()
                let carried = resourceDirs.lazy.compactMap { BundledRuntime.carriedRelease(resources: $0, arch: arch, list: BundledRuntime.listDirectory) }.first
                let installed = rt.installedVersion(layout: rt.layout())
                if !rt.isInstalled() || DemoInstall.needsUpgrade(installed: installed, carried: carried?.version) {
                    guard let installer = resourceDirs.map({ $0 + "/install.sh" }).first(where: { FileManager.default.fileExists(atPath: $0) }) else { throw DemoError.message("The Demo installer is missing.") }
                    env["OPEN_WALNUT_INSTALL_DIR"] = rt.installDir
                    env["OPEN_WALNUT_BIN_DIR"] = self.root.appendingPathComponent("bin").path
                    env["OPEN_WALNUT_MODIFY_PATH"] = "0"
                    let installEnv = BundledRuntime.installEnvironment(base: env, home: env["HOME"]!, carried: carried)
                    let result = BundledRuntime.runInstaller(script: installer, environment: installEnv, onProgress: { progress in
                        DispatchQueue.main.async { self.showStatus(progress.status) }
                    })
                    if !result.success { throw DemoError.message("Demo installation failed. Retry to install it again.") }
                }
                let proc = Process()
                proc.executableURL = URL(fileURLWithPath: rt.link)
                proc.arguments = (reset ? ["demo", "reset", "--_headless"] : ["demo", "--_headless"]) + ["--_root", self.root.path]
                proc.environment = env
                proc.currentDirectoryURL = self.root
                let (status, tail) = try DemoOutput.run(proc) { line in
                    DispatchQueue.main.async { if self.busy { self.showStatus(line) } }
                }
                if status != 0 { throw DemoError.message(tail.isEmpty ? "Walnut Demo stopped before it started." : tail) }
                let stateData = try Data(contentsOf: self.root.appendingPathComponent("state.json"))
                guard let state = try JSONSerialization.jsonObject(with: stateData) as? [String: Any],
                      let generation = state["generation"] as? String,
                      generation.range(of: "^[a-zA-Z0-9-]{1,64}$", options: .regularExpression) != nil else { throw DemoError.message("Demo did not report its isolated HOME.") }
                let demoHome = self.root.appendingPathComponent("homes").appendingPathComponent(generation).path
                let signIns = self.root.appendingPathComponent("data").appendingPathComponent(generation).appendingPathComponent("local/demo-sign-ins/accepting").path
                DispatchQueue.main.async {
                    let config = WKWebViewConfiguration()
                    config.websiteDataStore = .nonPersistent()
                    let signIn = ClaudeSignInBridge(consoleURL: DemoLinks.console, home: demoHome, configDir: demoHome + "/.claude", demoSignInDirectory: signIns)
                    config.userContentController.addScriptMessageHandler(signIn, contentWorld: .page, name: "walnutClaudeSignIn")
                    let page = WKWebView(frame: .zero, configuration: config)
                    page.navigationDelegate = self
                    page.uiDelegate = self
                    self.page = page
                    self.window.contentView = page
                    page.load(URLRequest(url: DemoLinks.console))
                    self.finishRun()
                }
            } catch {
                DispatchQueue.main.async { self.showStatus(error.localizedDescription, retry: true); self.finishRun() }
            }
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        // createWebViewWith routes new-window requests and never makes a window.
        if navigationAction.targetFrame == nil { decisionHandler(.allow); return }
        switch DemoLinks.navigation(url, isLinkClick: navigationAction.navigationType == .linkActivated) {
        case .inPage: decisionHandler(.allow)
        case .openInBrowser: decisionHandler(.cancel); NSWorkspace.shared.open(url)
        case .ignore: decisionHandler(.cancel)
        }
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        guard let url = navigationAction.request.url else { return nil }
        switch DemoLinks.newWindow(url) {
        case .inPage: webView.load(URLRequest(url: url))
        case .openInBrowser: NSWorkspace.shared.open(url)
        case .ignore: break
        }
        return nil
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        let failure = error as NSError
        guard webView === page, failure.domain == NSURLErrorDomain,
              [NSURLErrorCannotConnectToHost, NSURLErrorNetworkConnectionLost, NSURLErrorTimedOut].contains(failure.code) else { return }
        WebContentProcess.retireReplacedPage(webView) { [weak self] in self?.page }
        page = nil
        showStatus("Walnut Demo is not running. Retry to start it again.", retry: true)
    }

    // A sheet on Demo's own window: it never activates the app, so a background Demo stays behind.
    private func panelSheet(_ webView: WKWebView, _ frame: WKFrameInfo) -> NSWindow? {
        let origin = frame.securityOrigin
        guard webView === page, origin.protocol == "http", origin.host == "127.0.0.1", origin.port == DemoLinks.port,
              window.attachedSheet == nil else { return nil }
        return window
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        guard let sheet = panelSheet(webView, frame) else { completionHandler(); return }
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.beginSheetModal(for: sheet) { _ in completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        guard let sheet = panelSheet(webView, frame) else { completionHandler(false); return }
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        alert.beginSheetModal(for: sheet) { response in completionHandler(response == .alertFirstButtonReturn) }
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        guard let sheet = panelSheet(webView, frame) else { completionHandler(nil); return }
        let alert = NSAlert()
        alert.messageText = prompt
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 300, height: 24))
        field.stringValue = defaultText ?? ""
        alert.accessoryView = field
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        alert.beginSheetModal(for: sheet) { response in completionHandler(response == .alertFirstButtonReturn ? field.stringValue : nil) }
        alert.window.initialFirstResponder = field
    }
}

enum DemoInstall {
    // Only forward: an older Walnut.app must not move a newer Demo install back.
    static func needsUpgrade(installed: String?, carried: String?) -> Bool {
        guard let installed = installed, let carried = carried, carried != installed else { return false }
        return BundledRuntime.versionAtLeast(carried, installed)
    }
}

enum DemoOutput {
    static let tailLimit = 2000
    static let lineLimit = 200

    // Reads as it prints, keeping only a bounded tail; the server it starts may keep the pipe open.
    static func run(_ proc: Process, onLine: @escaping (String) -> Void) throws -> (status: Int32, tail: String) {
        let pipe = Pipe()
        proc.standardInput = FileHandle.nullDevice
        proc.standardOutput = pipe
        proc.standardError = pipe
        let lock = NSLock()
        var tail = ""
        var partial = ""
        let eof = DispatchSemaphore(value: 0)
        pipe.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            if data.isEmpty { handle.readabilityHandler = nil; eof.signal(); return }
            let text = String(decoding: data, as: UTF8.self)
            lock.lock()
            let (lines, rest) = splitLines(partial + text)
            partial = String(rest.suffix(lineLimit))
            tail = String((tail + text).suffix(tailLimit))
            lock.unlock()
            if let line = lines.last(where: { !$0.isEmpty }) { onLine(line) }
        }
        do { try proc.run() } catch {
            pipe.fileHandleForReading.readabilityHandler = nil
            throw error
        }
        proc.waitUntilExit()
        _ = eof.wait(timeout: .now() + 2)
        pipe.fileHandleForReading.readabilityHandler = nil
        lock.lock()
        let result = tail
        lock.unlock()
        return (proc.terminationStatus, result.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    // Complete lines, trimmed and capped, plus the unfinished rest; a carriage return ends a line too.
    static func splitLines(_ text: String) -> (lines: [String], rest: String) {
        let parts = text.split(omittingEmptySubsequences: false, whereSeparator: { $0 == "\n" || $0 == "\r" || $0 == "\r\n" })
        guard let rest = parts.last else { return ([], "") }
        let lines = parts.dropLast().map { part -> String in
            let plain = String(part).replacingOccurrences(of: "\u{1B}\\[[0-9;?]*[A-Za-z]", with: "", options: .regularExpression)
            return String(plain.trimmingCharacters(in: .whitespaces).prefix(lineLimit))
        }
        return (lines, String(rest))
    }
}

enum DemoLinkRoute: Equatable {
    case inPage
    case openInBrowser
    case ignore
}

enum DemoLinks {
    static let port = 3458
    static let console = URL(string: "http://127.0.0.1:3458")!

    static func isOwn(_ url: URL) -> Bool {
        return url.scheme?.lowercased() == "http" && url.host == "127.0.0.1" && url.port == port
    }

    static func isWeb(_ url: URL) -> Bool {
        let scheme = url.scheme?.lowercased() ?? ""
        return (scheme == "http" || scheme == "https") && !(url.host ?? "").isEmpty
    }

    static func navigation(_ url: URL, isLinkClick: Bool) -> DemoLinkRoute {
        if isOwn(url) { return .inPage }
        return isLinkClick && isWeb(url) ? .openInBrowser : .ignore
    }

    // Demo has one window, so its own routes replace the page instead of opening another.
    static func newWindow(_ url: URL) -> DemoLinkRoute {
        if isOwn(url) { return .inPage }
        return isWeb(url) ? .openInBrowser : .ignore
    }
}

// Demo's own scheme: open-walnut links belong to the real Walnut.
enum DemoCommand: Equatable {
    case open
    case reset

    static let scheme = "walnut-demo"

    init?(url: URL) {
        guard url.scheme?.lowercased() == DemoCommand.scheme, url.path.isEmpty || url.path == "/",
              url.query == nil, url.fragment == nil, url.user == nil else { return nil }
        switch url.host?.lowercased() {
        case "open": self = .open
        case "reset": self = .reset
        default: return nil
        }
    }
}

enum DemoBundle {
    static func enclosingResources(of bundle: URL) -> URL? {
        let helpers = bundle.standardizedFileURL.deletingLastPathComponent()
        let contents = helpers.deletingLastPathComponent()
        guard bundle.pathExtension == "app", helpers.lastPathComponent == "Helpers", contents.lastPathComponent == "Contents",
              contents.deletingLastPathComponent().pathExtension == "app" else { return nil }
        return contents.appendingPathComponent("Resources")
    }

    // The copy inside Walnut.app carries no release, so it installs the one its Walnut.app carries.
    static func resourceDirs(own: String?, bundle: URL) -> [String] {
        var dirs: [String] = []
        if let own = own { dirs.append(own) }
        if let enclosing = enclosingResources(of: bundle)?.path, !dirs.contains(enclosing) { dirs.append(enclosing) }
        return dirs
    }
}

enum DemoError: LocalizedError {
    case message(String)
    var errorDescription: String? { if case .message(let text) = self { return text }; return nil }
}

#if !WALNUT_DEMO_TESTS
@main
struct DemoMain {
    static func main() {
        let app = NSApplication.shared
        let delegate = DemoAppDelegate()
        app.delegate = delegate
        app.run()
    }
}
#endif

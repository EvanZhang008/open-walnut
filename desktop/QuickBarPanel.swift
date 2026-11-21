/**
 * The quick bar from any app (experimental `quick_bar`): Control-Option-Command-Space opens a
 * floating panel over whatever app is in front, without bringing Walnut forward. The panel holds
 * Walnut's own /quickbar page (web/src/components/quickbar/QuickBarPanelPage.tsx): it listens,
 * shows the words as they are said, picks who gets them and sends them; after a send it shrinks
 * to the receipts in the bottom left corner, which never take the keyboard, so the person keeps
 * typing where they were.
 *
 * The main window's page tells the app whether the experiment is on ({type:'flag'}), and only
 * then is the key registered, through Carbon's RegisterEventHotKey: like the dictation key
 * (GlobalDictation.swift) it needs no Accessibility permission. The microphone is the app's own
 * (the panel's web view asks the same way the main window does), and the panel is silent: no
 * sound on open, send or capture (`screencapture -x`).
 *
 * The page sizes the panel ({type:'layout', mode, height}); the app only places it: `bar` in the
 * upper part of the screen with the pointer, `receipts` in its bottom left corner, `hidden` off
 * screen. A panel unused for ten minutes lets its page go, and the next press loads it again.
 */

import Cocoa
import WebKit
import Carbon.HIToolbox

private let quickBarHotKeyID: UInt32 = 0x574E_5142 // 'WNQB'
private weak var activeQuickBar: QuickBarPanel?

/// A panel that can take the keyboard while another app stays in front, and gives it up for the
/// receipts. Swallows a key nobody handles, as QuietKeyWindow does: no alert sound.
final class QuickBarWindow: NSPanel {
    var takesKeys = true
    override var canBecomeKey: Bool { takesKeys }
    override var canBecomeMain: Bool { false }
    override func noResponder(for eventSelector: Selector) {
        if eventSelector == #selector(NSResponder.keyDown(with:)) { return }
        super.noResponder(for: eventSelector)
    }
}

final class QuickBarPanel: NSObject {
    static let handlerName = "walnutQuickBar"
    private static let barWidth: CGFloat = 680
    private static let receiptsWidth: CGFloat = 360
    private static let releaseAfter: TimeInterval = 10 * 60

    private let portProvider: () -> Int?
    private let openLink: (URL) -> Void
    private var hotKeyRef: EventHotKeyRef?
    private var eventHandler: EventHandlerRef?
    private var panel: QuickBarWindow?
    private var effect: NSVisualEffectView?
    private var webView: WKWebView?
    private var loadedPort: Int?
    /// The page announced itself (its first layout message): calls made before wait here.
    private var pageReady = false
    private var pending: [String] = []
    private var mode = "hidden"
    private var releaseWork: DispatchWorkItem?
    private var resignObserver: NSObjectProtocol?
    /// A screenshot is being dragged out or a file chosen: the bar is out of the way, not closed.
    fileprivate var capturing = false

    init(portProvider: @escaping () -> Int?, openLink: @escaping (URL) -> Void) {
        self.portProvider = portProvider
        self.openLink = openLink
    }

    var isRegistered: Bool { hotKeyRef != nil }

    /// The experiment's switch, as the main window's page reports it.
    func setEnabled(_ on: Bool) {
        if on { register() } else { unregister() }
    }

    // MARK: - The key

    private func register() {
        guard hotKeyRef == nil else { return }
        activeQuickBar = self
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        let installed = InstallEventHandler(GetApplicationEventTarget(), { _, event, _ -> OSStatus in
            var hkID = EventHotKeyID()
            let err = GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID),
                                        nil, MemoryLayout<EventHotKeyID>.size, nil, &hkID)
            // Another key of this app (the dictation key) goes on to its own handler.
            guard err == noErr, hkID.id == quickBarHotKeyID else { return OSStatus(eventNotHandledErr) }
            DispatchQueue.main.async { activeQuickBar?.pressed() }
            return noErr
        }, 1, &spec, nil, &eventHandler)
        guard installed == noErr else {
            DesktopLogger.shared.log("quickbar_handler_failed", fields: ["status": String(installed)])
            return
        }
        let hkID = EventHotKeyID(signature: OSType(quickBarHotKeyID), id: quickBarHotKeyID)
        let status = RegisterEventHotKey(UInt32(kVK_Space), UInt32(controlKey | optionKey | cmdKey), hkID,
                                         GetApplicationEventTarget(), 0, &hotKeyRef)
        if status == noErr {
            DesktopLogger.shared.log("quickbar_hotkey_registered", fields: ["keys": "ctrl-opt-cmd-space"])
        } else {
            // Another app owns the combination: the page's own key still works in Walnut's window.
            // The handler goes too, so the next page load's try installs one, never a second.
            hotKeyRef = nil
            if let handler = eventHandler { RemoveEventHandler(handler); eventHandler = nil }
            DesktopLogger.shared.log("quickbar_hotkey_failed", fields: ["status": String(status)])
        }
    }

    private func unregister() {
        if let ref = hotKeyRef { UnregisterEventHotKey(ref); hotKeyRef = nil }
        if let handler = eventHandler { RemoveEventHandler(handler); eventHandler = nil }
        tearDown()
        if activeQuickBar === self { activeQuickBar = nil }
    }

    private func pressed() {
        guard portProvider() != nil else {
            DesktopLogger.shared.log("quickbar_press_before_server", fields: [:])
            return
        }
        buildIfNeeded()
        call(mode == "bar" ? "hotkey()" : "open()")
    }

    // MARK: - The panel

    private func buildIfNeeded() {
        let port = portProvider() ?? 3456
        if panel != nil, loadedPort == port { return }
        tearDown()
        let p = QuickBarWindow(contentRect: NSRect(x: 0, y: 0, width: Self.barWidth, height: 72),
                               styleMask: [.borderless, .nonactivatingPanel, .fullSizeContentView],
                               backing: .buffered, defer: false)
        p.isFloatingPanel = true
        p.level = .floating
        p.hidesOnDeactivate = false
        p.isOpaque = false
        p.backgroundColor = .clear
        p.hasShadow = true
        p.isMovableByWindowBackground = false
        p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient]
        p.animationBehavior = .utilityWindow

        let glass = NSVisualEffectView(frame: p.contentView!.bounds)
        glass.autoresizingMask = [.width, .height]
        glass.material = .popover
        glass.blendingMode = .behindWindow
        glass.state = .active
        glass.wantsLayer = true
        glass.layer?.cornerRadius = 18
        glass.layer?.masksToBounds = true

        let config = WKWebViewConfiguration()
        config.userContentController.add(WeakScriptHandler(self), name: Self.handlerName)
        config.mediaTypesRequiringUserActionForPlayback = []
        let web = WKWebView(frame: glass.bounds, configuration: config)
        web.autoresizingMask = [.width, .height]
        web.setValue(false, forKey: "drawsBackground")
        if #available(macOS 12.0, *) { web.underPageBackgroundColor = .clear }
        web.uiDelegate = self
        glass.addSubview(web)
        p.contentView = glass

        panel = p
        effect = glass
        webView = web
        loadedPort = port
        pageReady = false
        mode = "hidden"
        resignObserver = NotificationCenter.default.addObserver(forName: NSWindow.didResignKeyNotification, object: p, queue: .main) { [weak self] _ in
            // A click in another app while the bar is open closes it, as Spotlight does (the words stay).
            guard let self, self.mode == "bar", !self.capturing else { return }
            self.call("close()")
        }
        if let url = URL(string: "http://localhost:\(port)/quickbar") { web.load(URLRequest(url: url)) }
        DesktopLogger.shared.log("quickbar_panel_built", fields: ["port": String(port)])
    }

    private func tearDown() {
        releaseWork?.cancel()
        releaseWork = nil
        if let o = resignObserver { NotificationCenter.default.removeObserver(o); resignObserver = nil }
        webView?.configuration.userContentController.removeScriptMessageHandler(forName: Self.handlerName)
        webView?.stopLoading()
        // Closed, not just dropped: a page left to die later hands its graphics to the kernel.
        if let web = webView { WebContentProcess.close(web) }
        panel?.orderOut(nil)
        panel = nil
        effect = nil
        webView = nil
        pageReady = false
        pending = []
        mode = "hidden"
    }

    private func call(_ js: String) {
        let script = "window.__walnutQuickBar && window.__walnutQuickBar.\(js)"
        guard pageReady, let web = webView else { pending.append(script); return }
        web.evaluateJavaScript(script, completionHandler: nil)
    }

    /// The screen the person is working on: the one with the pointer.
    private func activeScreen() -> NSScreen? {
        let mouse = NSEvent.mouseLocation
        return NSScreen.screens.first { NSMouseInRect(mouse, $0.frame, false) } ?? NSScreen.main
    }

    private func place(mode next: String, height: CGFloat) {
        guard let p = panel, let screen = activeScreen() else { return }
        let area = screen.visibleFrame
        let was = mode
        mode = next
        releaseWork?.cancel()
        switch next {
        case "bar":
            let h = max(56, min(height, area.height * 0.7))
            // The top edge stays put while the bar grows (the people list opens downward).
            let top = was == "bar" ? p.frame.maxY : area.maxY - area.height * 0.18
            let x = was == "bar" ? p.frame.minX : area.midX - Self.barWidth / 2
            effect?.layer?.cornerRadius = 18
            effect?.layer?.borderWidth = 0
            effect?.material = .popover
            p.takesKeys = true
            p.setFrame(NSRect(x: x, y: top - h, width: Self.barWidth, height: h), display: true)
            if !p.isKeyWindow {
                p.makeKeyAndOrderFront(nil)
                if let web = webView { p.makeFirstResponder(web) }
            }
        case "receipts":
            let h = max(40, min(height, area.height * 0.8))
            if p.isKeyWindow || was == "bar" {
                // Hand the keyboard back to the app in front: out, then in again unable to take it.
                p.orderOut(nil)
            }
            p.takesKeys = false
            // The notice card's frame (web/src/styles/notice-card.css): a 14 pt radius and one
            // hairline all round. And its place: the bottom left, where every Walnut notice shows
            // (2026-11-20, the user: "所有的 notification 都应该在左下角").
            effect?.layer?.cornerRadius = 14
            effect?.layer?.borderWidth = 1
            // The receipts are a notice: the notice card's clearer material (NoticeCardView.swift),
            // not the bar's near-white popover (2026-11-20, the user: "not glass, I want glass").
            effect?.material = .menu
            effect?.layer?.borderColor = NSColor.separatorColor.cgColor
            p.setFrame(NSRect(x: area.minX + 16, y: area.minY + 16, width: Self.receiptsWidth, height: h), display: true)
            p.orderFrontRegardless()
        default:
            p.orderOut(nil)
            let work = DispatchWorkItem { [weak self] in
                guard let self, self.mode == "hidden" else { return }
                DesktopLogger.shared.log("quickbar_panel_released", fields: [:])
                self.tearDown()
            }
            releaseWork = work
            DispatchQueue.main.asyncAfter(deadline: .now() + Self.releaseAfter, execute: work)
        }
    }

    /// Cmd-Shift-S in the bar: the person drags out an area (macOS's own crosshair, silent with
    /// -x), and the picture goes into the bar as a PNG.
    private func capture() {
        capturing = true
        panel?.orderOut(nil)
        let path = (NSTemporaryDirectory() as NSString).appendingPathComponent("walnut-quickbar-\(UUID().uuidString).png")
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
        task.arguments = ["-i", "-x", path]
        task.terminationHandler = { [weak self] _ in
            DispatchQueue.main.async {
                guard let self else { return }
                let data = FileManager.default.contents(atPath: path)
                try? FileManager.default.removeItem(atPath: path)
                self.endCapture()
                // The bar never closed (its take and words are as they were): the picture joins it.
                if let data, !data.isEmpty { self.call("attach(\(AppLink.jsString(data.base64EncodedString())))") }
            }
        }
        do { try task.run() } catch {
            DesktopLogger.shared.log("quickbar_capture_failed", fields: ["error": String(describing: error)])
            endCapture()
        }
    }

    /// The area is taken (or the person pressed Esc): the bar comes back with the keyboard.
    fileprivate func endCapture() {
        capturing = false
        guard let p = panel, mode == "bar" else { return }
        p.makeKeyAndOrderFront(nil)
        if let web = webView { p.makeFirstResponder(web) }
    }

    fileprivate func received(_ body: Any) {
        guard let msg = body as? [String: Any], let type = msg["type"] as? String else { return }
        switch type {
        case "layout":
            if !pageReady {
                pageReady = true
                let calls = pending
                pending = []
                for js in calls { webView?.evaluateJavaScript(js, completionHandler: nil) }
            }
            let height = (msg["height"] as? NSNumber).map { CGFloat(truncating: $0) } ?? 72
            place(mode: (msg["mode"] as? String) ?? "hidden", height: height)
        case "open":
            // A task's chat by its id, or any app path the page names (a note: /notes?path=...).
            let path = (msg["to"] as? String).flatMap { $0.hasPrefix("/") ? $0 : nil }
                ?? (msg["taskId"] as? String).map { "/tasks/\($0)" }
            var allowed = CharacterSet.urlQueryAllowed
            allowed.remove(charactersIn: "&=?#")
            guard let path, let to = path.addingPercentEncoding(withAllowedCharacters: allowed),
                  let url = URL(string: "\(AppLink.scheme)://open?to=\(to)") else { return }
            openLink(url)
        case "capture":
            capture()
        default:
            return
        }
    }
}

extension QuickBarPanel: WKUIDelegate {
    /// The microphone and the camera, for Walnut's own page only, as the main window grants them.
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        let local = origin.host == "localhost" || origin.host == "127.0.0.1"
        decisionHandler(local && origin.port == (loadedPort ?? 3456) && captureGranted(type, frame: frame) ? .grant : .deny)
    }

    /// The bar's attach button: pictures from a file. The chooser takes the keyboard, so the bar
    /// steps aside as for a capture and comes back with its words when it closes.
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping ([URL]?) -> Void) {
        let chooser = NSOpenPanel()
        chooser.canChooseFiles = true
        chooser.canChooseDirectories = false
        chooser.allowsMultipleSelection = parameters.allowsMultipleSelection
        chooser.resolvesAliases = true
        capturing = true
        let picked = chooser.runModal() == .OK ? chooser.urls : nil
        completionHandler(picked)
        endCapture()
    }
}

/// The content controller keeps its handler alive: through this, the panel can still go away.
private final class WeakScriptHandler: NSObject, WKScriptMessageHandler {
    weak var target: QuickBarPanel?
    init(_ target: QuickBarPanel) { self.target = target }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.received(message.body)
    }
}

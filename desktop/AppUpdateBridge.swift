import Cocoa
import WebKit

private var pendingUpdateConfirmations: Set<ObjectIdentifier> = []

// Where the app's update meets the person: the web console's rail item (through
// the `walnutUpdate` message handler and the `walnut:app-update` event), the app
// menu's update item, and the confirmation before a restart. The updater itself
// is AppUpdater.swift; the state and its rules are AppUpdateMachine.swift.

extension AppDelegate: WKScriptMessageHandlerWithReply {
    func startAppUpdater() {
        let updater = AppUpdater()
        updater.onStateChange = { [weak self] state in
            self?.pushAppUpdateState(state)
        }
        updater.stopServerAndQuit = { [weak self] timeout in
            self?.stopServerForUpdate(timeout: timeout) { NSApp.terminate(nil) }
        }
        appUpdater = updater
        updater.configure()
        refreshUpdateMenuItem(updater.state)
    }

    func pushAppUpdateState(_ state: AppUpdateState) {
        refreshUpdateMenuItem(state)
        let views = [webView].compactMap { $0 } + popoutWindows.values.compactMap { $0.contentView as? WKWebView }
        for view in views {
            view.evaluateJavaScript(
                "window.dispatchEvent(new CustomEvent('walnut:app-update', { detail: \(state.json()) }))",
                completionHandler: nil)
        }
    }

    // MARK: - The page's requests (T3's desktopBridge: getState / check / download / install)

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        guard message.name == "walnutUpdate", let updater = appUpdater else { replyHandler(nil, "no updater"); return }
        let body = message.body as? [String: Any] ?? [:]
        let op = body["op"] as? String ?? ""
        let reply: ([String: Any]) -> Void = { fields in
            var out = fields
            out["state"] = Self.jsonObject(updater.state.json())
            replyHandler(out, nil)
        }
        switch op {
        case "getState":
            reply([:])
        case "check":
            updater.check(reason: "web") { checked in reply(["checked": checked]) }
        case "download":
            updater.download { accepted, completed in reply(["accepted": accepted, "completed": completed]) }
        case "confirmInstall":
            confirmInstall(from: message.webView) { ok in replyHandler(ok, nil) }
        case "install":
            let source = message.webView
            // force: the page listed every window's unsent work and the person chose to restart anyway.
            let force = body["force"] as? Bool == true
            checkUpdateWindows { [weak self] clean in
                guard let self, clean || force, let source, self.updateWindowViews().contains(where: { $0 === source }) else {
                    replyHandler(nil, "Save edits and send or clear unsent messages in every Walnut window before restarting.")
                    return
                }
                updater.install { accepted, failed in reply(["accepted": accepted, "completed": false, "failed": failed]) }
            }
        case "unsavedWindows":
            listUnsavedWindows(source: message.webView) { windows in replyHandler(["windows": windows], nil) }
        case "revealUnsaved":
            let id = body["window"] as? String ?? ""
            let index = (body["index"] as? NSNumber)?.intValue ?? -1
            replyHandler(revealUnsaved(window: id, index: index), nil)
        case "openRelease":
            let version = body["version"] as? String ?? ""
            if let url = updater.releaseURL(version: version) { NSWorkspace.shared.open(url); replyHandler(true, nil) }
            else { replyHandler(false, nil) }
        default:
            replyHandler(nil, "unknown op \(op)")
        }
    }

    static func jsonObject(_ text: String) -> Any {
        return (try? JSONSerialization.jsonObject(with: Data(text.utf8))) ?? NSNull()
    }

    // MARK: - End-to-end test hook

    /// WALNUT_DESKTOP_E2E_UPDATE_CLICKS=1 (scripts/desktop-update-e2e.mjs only):
    /// the page clicks its own update item when it offers a download and again
    /// when it offers the restart, and the confirmation answers yes, so a test
    /// runs the real page, bridge and updater without anyone's mouse.
    static var e2eClicks: Bool { ProcessInfo.processInfo.environment["WALNUT_DESKTOP_E2E_UPDATE_CLICKS"] == "1" }

    func addAppUpdateTestScript(to controller: WKUserContentController) {
        // WALNUT_DESKTOP_E2E_SCRIPT=<file> (a test knob, README.md): a test's own steps in the
        // console page, such as typing a draft before a restart. No new power: the test that
        // sets it could point WALNUT_DESKTOP_PORTS at a page of its own anyway.
        if let path = ProcessInfo.processInfo.environment["WALNUT_DESKTOP_E2E_SCRIPT"], !path.isEmpty,
           let source = try? String(contentsOfFile: path, encoding: .utf8) {
            controller.addUserScript(WKUserScript(source: source, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
        }
        guard Self.e2eClicks else { return }
        let script = """
        (() => {
          // Once per arrival at a step, so a failed download is retried once more.
          let last = null;
          const tick = () => {
            const el = document.querySelector('.stale-build-pill-action');
            const status = el ? el.getAttribute('data-status') : null;
            if (el && status !== last && (status === 'available' || status === 'downloaded')) {
              // The restart waits a moment, so the downloaded state can be seen first.
              setTimeout(() => {
                console.log('[app-update-e2e] clicking the update item at ' + status);
                el.click();
              }, status === 'downloaded' ? 4000 : 1500);
            }
            last = status;
          };
          setInterval(tick, 300);
          // A step can pass between two ticks (a download that fails at once): the
          // shell's own events say it happened, so the next arrival is clicked too.
          window.addEventListener('walnut:app-update', (e) => {
            const s = e.detail && e.detail.status;
            if (s && s !== 'available' && s !== 'downloaded') last = s;
          });
        })();
        """
        controller.addUserScript(WKUserScript(source: script, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
    }

    // MARK: - Restart to update

    func updateWindowViews() -> [WKWebView] {
        ([webView].compactMap { $0 } + popoutWindows.values.compactMap { $0.contentView as? WKWebView })
            .filter { $0.window?.contentView === $0 }
    }

    func checkUpdateWindows(_ done: @escaping (Bool) -> Void) {
        let views = updateWindowViews()
        let identities = Set(views.map { ObjectIdentifier($0) })
        guard !views.isEmpty else { done(false); return }
        let group = DispatchGroup()
        var clean = true
        for view in views {
            let watchdog = view === webView ? webContentWatchdog : popoutWatchdogs[ObjectIdentifier(view)]
            guard let watchdog else { clean = false; continue }
            group.enter()
            watchdog.checkUnsavedWork { unsaved in
                if unsaved || view.window?.contentView !== view { clean = false }
                group.leave()
            }
        }
        var finished = false
        let finish: (Bool) -> Void = { result in
            guard !finished else { return }
            finished = true
            done(result)
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { finish(false) }
        group.notify(queue: .main) { [weak self] in
            guard let self else { finish(false); return }
            finish(clean && identities == Set(self.updateWindowViews().map { ObjectIdentifier($0) }))
        }
    }

    /// Every window's answer to "what would a restart lose here?", for the page that asks before
    /// it restarts. A window whose page cannot list its work (an older bundle) answers with the
    /// shell's own yes/no check; one that cannot be checked at all answers `items: null`.
    func listUnsavedWindows(source: WKWebView?, _ done: @escaping ([[String: Any]]) -> Void) {
        let views = updateWindowViews()
        guard !views.isEmpty else { done([]); return }
        var answers = [Int: [String: Any]]()
        let group = DispatchGroup()
        for (i, view) in views.enumerated() {
            let base: [String: Any] = ["id": String(UInt(bitPattern: ObjectIdentifier(view).hashValue)),
                                       "title": view.window?.title ?? "", "isSource": view === source]
            answers[i] = base.merging(["items": NSNull()]) { $1 }
            group.enter()
            let js = "(() => { try { const b = window.__walnutDesktop; return b && typeof b.listUnsavedWork === 'function' ? JSON.stringify(b.listUnsavedWork()) : null; } catch { return null; } })()"
            view.evaluateJavaScript(js) { [weak self] result, _ in
                if let text = result as? String, let items = Self.jsonObject(text) as? [[String: Any]] {
                    answers[i] = base.merging(["items": items]) { $1 }
                    group.leave()
                    return
                }
                let watchdog = view === self?.webView ? self?.webContentWatchdog : self?.popoutWatchdogs[ObjectIdentifier(view)]
                guard let watchdog else { group.leave(); return }
                watchdog.checkUnsavedWork { unsaved in
                    let items: [[String: Any]] = unsaved ? [["what": "Unsaved work", "where": ""]] : []
                    answers[i] = base.merging(["items": items]) { $1 }
                    group.leave()
                }
            }
        }
        var finished = false
        let finish = {
            guard !finished else { return }
            finished = true
            done(views.indices.compactMap { answers[$0] })
        }
        // A window that does not answer in time stays "could not be checked".
        DispatchQueue.main.asyncAfter(deadline: .now() + 3, execute: finish)
        group.notify(queue: .main, execute: finish)
    }

    /// Bring a window forward and ask its page to show item `index` (-1: the window only).
    func revealUnsaved(window id: String, index: Int) -> Bool {
        guard let view = updateWindowViews().first(where: { String(UInt(bitPattern: ObjectIdentifier($0).hashValue)) == id }),
              let window = view.window else { return false }
        window.makeKeyAndOrderFront(nil)
        if index >= 0 {
            view.evaluateJavaScript("(() => { const b = window.__walnutDesktop; return !!(b && b.revealUnsavedWork && b.revealUnsavedWork(\(index))); })()", completionHandler: nil)
        }
        return true
    }

    func confirmInstall(from source: WKWebView? = nil, _ done: @escaping (Bool) -> Void) {
        guard let window = source?.window ?? NSApp.keyWindow ?? window, let view = window.contentView as? WKWebView,
              source == nil || source === view,
              let version = appUpdater?.state.downloadedVersion ?? appUpdater?.state.availableVersion,
              window.attachedSheet == nil, !pendingUpdateConfirmations.contains(ObjectIdentifier(self)) else {
            done(false); return
        }
        let key = ObjectIdentifier(self)
        pendingUpdateConfirmations.insert(key)
        let finish: (Bool) -> Void = { result in
            pendingUpdateConfirmations.remove(key)
            done(result)
        }
        let isCurrent = { [weak self, weak window, weak view] in
            guard let self, let window, let view else { return false }
            return window.contentView === view && self.updateWindowViews().contains { $0 === view }
                && (self.appUpdater?.state.downloadedVersion ?? self.appUpdater?.state.availableVersion) == version
        }
        checkUpdateWindows { [weak self, weak window] clean in
            guard let self, let window, isCurrent(), window.attachedSheet == nil else { finish(false); return }
            if !clean {
                self.showUpdateAlert("Save your work before restarting", "Save edits and send or clear unsent messages in every Walnut window, then try again.", in: window)
                finish(false)
                return
            }
            let confirm = {
                guard isCurrent() else { finish(false); return }
                self.checkUpdateWindows { clean in
                    finish(clean && isCurrent())
                    if !clean && isCurrent() {
                        self.showUpdateAlert("Save your work before restarting", "New unsaved work was found. Save edits and send or clear unsent messages in every Walnut window, then try again.", in: window)
                    }
                }
            }
            if Self.e2eClicks { confirm(); return }
            let alert = NSAlert()
            alert.messageText = "Install Walnut \(version) and restart?"
            alert.informativeText = "Walnut closes for a few seconds and opens again. Running sessions keep going."
            alert.addButton(withTitle: "Restart to Update")
            alert.addButton(withTitle: "Cancel")
            alert.beginSheetModal(for: window) { response in
                // The confirmation sheet detaches after its completion returns.
                DispatchQueue.main.async {
                    if response == .alertFirstButtonReturn { confirm() }
                    else { finish(false) }
                }
            }
        }
    }

    /// T3 stops every backend with a 5 s budget before quitAndInstall. A server
    /// still running after that keeps its pid on record, so the new app reclaims
    /// it as its own orphan instead of attaching to it.
    func stopServerForUpdate(timeout: TimeInterval, then: @escaping () -> Void) {
        let proc = ownsServer ? serverProcess : nil
        DesktopLogger.shared.log("app_update_stopping_server", fields: ["owned": String(proc != nil)])
        stopServer()
        guard let server = proc else { then(); return }
        DispatchQueue.global(qos: .userInitiated).async {
            let deadline = Date().addingTimeInterval(timeout)
            while server.isRunning && Date() < deadline { usleep(50_000) }
            let stillRunning = server.isRunning
            DispatchQueue.main.async {
                if stillRunning {
                    recordSpawnedServerPid(server.processIdentifier)
                    DesktopLogger.shared.log("app_update_server_still_running", fields: ["pid": String(server.processIdentifier)])
                }
                DesktopLogger.shared.flush()
                then()
            }
        }
    }

    // MARK: - App menu: the same flow without the page

    func refreshUpdateMenuItem(_ state: AppUpdateState) {
        guard let item = updateMenuItem else { return }
        item.isEnabled = true
        switch state.status {
        case .checking:
            item.title = "Checking for Updates…"
            item.isEnabled = false
        case .available:
            item.title = "Download Walnut \(state.availableVersion ?? "")…"
        case .downloading:
            let pct = state.downloadPercent.map { " \(Int($0))%" } ?? ""
            item.title = "Downloading Update…\(pct)"
            item.isEnabled = false
        case .downloaded:
            item.title = "Restart to Update to \(state.downloadedVersion ?? "")…"
        case .error where AppUpdateMachine.isInstallable(state):
            item.title = "Restart to Update to \(state.downloadedVersion ?? "")…"
        default:
            item.title = "Check for Updates…"
        }
    }

    @objc func updateMenuAction() {
        guard let updater = appUpdater else { return }
        let state = updater.state
        if !state.enabled {
            showUpdateAlert("Updates are off for this copy of Walnut", state.disabledReason ?? "")
            return
        }
        if AppUpdateMachine.isInstallable(state) {
            confirmInstall { ok in if ok { updater.install { _, _ in } } }
            return
        }
        if state.status == .available {
            updater.download { _, _ in }
            return
        }
        // A check from the menu answers, as a Mac app's does.
        updater.check(reason: "menu") { [weak self] checked in
            guard checked, let self = self else { return }
            let now = updater.state
            switch now.status {
            case .upToDate:
                self.showUpdateAlert("You’re up to date", "Walnut \(now.currentVersion) is the newest version.")
            case .error:
                self.showUpdateAlert("Could not check for updates", now.message ?? "")
            case .available:
                let alert = NSAlert()
                alert.messageText = "Walnut \(now.availableVersion ?? "") is available"
                alert.informativeText = "You have \(now.currentVersion). Download it now? Walnut keeps running while it downloads."
                alert.addButton(withTitle: "Download")
                alert.addButton(withTitle: "Later")
                if let window = self.window {
                    alert.beginSheetModal(for: window) { r in if r == .alertFirstButtonReturn { updater.download { _, _ in } } }
                }
            default:
                break
            }
        }
    }

    func showUpdateAlert(_ title: String, _ text: String, in target: NSWindow? = nil) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = text
        alert.addButton(withTitle: "OK")
        if let window = target ?? window { alert.beginSheetModal(for: window, completionHandler: nil) } else { alert.runModal() }
    }
}

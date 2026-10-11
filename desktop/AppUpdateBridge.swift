import Cocoa
import WebKit

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
        webView?.evaluateJavaScript(
            "window.dispatchEvent(new CustomEvent('walnut:app-update', { detail: \(state.json()) }))",
            completionHandler: nil)
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
            confirmInstall { ok in replyHandler(ok, nil) }
        case "install":
            updater.install { accepted, failed in reply(["accepted": accepted, "completed": false, "failed": failed]) }
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
        guard Self.e2eClicks else { return }
        let script = """
        (() => {
          // Once per arrival at a step, so a failed download is retried once more.
          let last = null;
          const tick = () => {
            const el = document.querySelector('[data-testid="sidebar-app-update"]');
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

    /// T3's confirmation, in Walnut's words: sessions run in the session daemon,
    /// so a restart closes the console for a few seconds and stops no work.
    func confirmInstall(_ done: @escaping (Bool) -> Void) {
        guard let window = window, let version = appUpdater?.state.downloadedVersion ?? appUpdater?.state.availableVersion else {
            done(false); return
        }
        if Self.e2eClicks { done(true); return }
        let alert = NSAlert()
        alert.messageText = "Install Walnut \(version) and restart?"
        alert.informativeText = "Walnut closes for a few seconds and opens again. Running sessions keep going."
        alert.addButton(withTitle: "Restart to Update")
        alert.addButton(withTitle: "Cancel")
        alert.beginSheetModal(for: window) { response in done(response == .alertFirstButtonReturn) }
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

    func showUpdateAlert(_ title: String, _ text: String) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = text
        alert.addButton(withTitle: "OK")
        if let window = window { alert.beginSheetModal(for: window, completionHandler: nil) } else { alert.runModal() }
    }
}

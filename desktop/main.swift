import Cocoa
import WebKit
import ApplicationServices

// MARK: - Configuration

struct WalnutConfig: Codable {
    var walnutHome: String
    var walnutSourceDir: String
    /// Set when the app runs the self-contained Walnut (BundledRuntime.swift):
    /// its install dir. `walnutSourceDir` is then that dir too (or, in a config
    /// from the archive's time, the archive's package root), and unused.
    /// Absent in every config written before it, which keeps meaning "source".
    var runtimeDir: String? = nil
    /// The checkout an older version of this app built (`<data home>/source`)
    /// that this setup moved off: removed once the self-contained Walnut has
    /// served, kept until then so the user can go back (AppBuiltCheckout.swift).
    var appBuiltCheckout: String? = nil
}

func configFilePath() -> URL {
    let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
    let dir = appSupport.appendingPathComponent("Walnut")
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir.appendingPathComponent("config.json")
}

func loadConfig() -> WalnutConfig? {
    let path = configFilePath()
    guard let data = try? Data(contentsOf: path) else { return nil }
    return try? JSONDecoder().decode(WalnutConfig.self, from: data)
}

func saveConfig(_ config: WalnutConfig) {
    let path = configFilePath()
    if let data = try? JSONEncoder().encode(config) {
        try? data.write(to: path)
    }
}

/// PID of the server *this app* spawned, persisted across app crashes. Used to
/// tell "our own orphan" (safe to reclaim) apart from a server the user started
/// themselves (e.g. a dev checkout's `bun run dev:prod`: NEVER kill that).
func serverPidFilePath() -> URL {
    return configFilePath().deletingLastPathComponent().appendingPathComponent("server.pid")
}

func recordSpawnedServerPid(_ pid: Int32) {
    try? String(pid).write(to: serverPidFilePath(), atomically: true, encoding: .utf8)
}

func clearSpawnedServerPid() {
    try? FileManager.default.removeItem(at: serverPidFilePath())
}

func recordedSpawnedServerPid() -> Int32? {
    guard let raw = try? String(contentsOf: serverPidFilePath(), encoding: .utf8) else { return nil }
    return Int32(raw.trimmingCharacters(in: .whitespacesAndNewlines))
}

// MARK: - App Delegate

class AppDelegate: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    var popoutWindows: [ObjectIdentifier: NSWindow] = [:]
    var popoutTitles: [ObjectIdentifier: NSKeyValueObservation] = [:]
    var popoutURLs: [ObjectIdentifier: URL] = [:]
    var popoutWatchdogs: [ObjectIdentifier: WebContentWatchdog] = [:]
    var pendingWindowCloses: Set<ObjectIdentifier> = []
    var approvedWindowCloses: Set<ObjectIdentifier> = []
    var activeWebView: WKWebView? { (NSApp.keyWindow?.contentView as? WKWebView) ?? webView }
    var serverProcess: Process?
    var serverPort: Int?
    // Last captured stdout/stderr from a server child that died before confirming
    // its port — surfaced in error messages so a startup crash isn't misreported
    // as "ports are all in use".
    var lastServerOutput: String = ""
    var walnutHome: String?
    var walnutSourceDir: String?
    /// The self-contained runtime this app runs, when it is not a source checkout.
    var runtime: BundledRuntime?
    /// The old app's checkout this setup moved off, until it is removed
    /// (WalnutConfig.appBuiltCheckout), and whether that removal is running.
    var appBuiltCheckout: String?
    var removingAppBuiltCheckout = false
    /// What Retry does while nothing is set up yet (a first download or build
    /// that failed): that setup again. Retry used to restart a server there was
    /// none of, and sat on the loading screen forever.
    var retrySetup: (() -> Void)?
    var statusLabel: NSTextField?
    /// The setup screen's spinner and its download bar (shown once the size is known).
    var setupSpinner: NSProgressIndicator?
    var setupProgressBar: NSProgressIndicator?
    /// The first-launch install.sh, and which setup is current: one the user
    /// left for another (an existing folder) has its result ignored.
    var installerProcess: Process?
    var setupGeneration = 0
    var retryTimer: Timer?
    var bootstrapProcess: Process?
    var serverOutputReader: ProcessOutputReader?
    var serverRestartPolicy = ServerRestartPolicy()
    var serverRestartWorkItem: DispatchWorkItem?
    var serverReadyAt: Date?
    var isRecoveringServer = false
    var isTerminating = false
    // System-wide dictation hotkey. Lives in the app because only a signed bundle
    // gets a microphone permission prompt (see GlobalDictation.swift).
    var dictation: GlobalDictation?
    // Measures the page process and replaces it when it is bloated and nobody
    // is looking (see WebContentPolicy.swift for why a long-lived WKWebView
    // needs this and a browser tab does not).
    var webContentWatchdog: WebContentWatchdog?
    // The app's own update (AppUpdater.swift, T3 Code's flow): checks quietly,
    // the user downloads it from the rail or the app menu, it installs on restart.
    var appUpdater: AppUpdater?
    var updateMenuItem: NSMenuItem?
    /// `open-walnut://` links that arrived before the console could take them
    /// (AppLink.swift); handed over once a page finishes loading.
    var pendingAppLinks: [URL] = []
    var consolePageLoaded = false
    /// The `walnut` command check runs once per launch (CommandLineTool.swift).
    var commandLineToolChecked = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        DesktopLogger.shared.log("app_launched", fields: [
            "pid": String(ProcessInfo.processInfo.processIdentifier)
        ])
        NSApp.setActivationPolicy(.regular)

        setupMainMenu()
        startAppUpdater()

        if WebContentPolicy.isEnabled(UserDefaults.standard) {
            webContentWatchdog = WebContentWatchdog(
                policyProvider: { WebContentPolicy.fromDefaults(UserDefaults.standard) },
                portProvider: { [weak self] in self?.serverPort },
                recycle: { [weak self] reason, _ in self?.recycleWebContent(reason: reason.rawValue) })
        } else {
            DesktopLogger.shared.log("webcontent_watchdog_disabled")
        }

        // Register before the server is up: the hotkey reads the port lazily and
        // tells the user to wait if it is not listening yet.
        dictation = GlobalDictation(portProvider: { [weak self] in self?.serverPort })
        dictation?.registerHotKey()
        // Only listens if the user opted in and Input Monitoring is granted.
        dictation?.startFnMonitorIfEnabled()

        let windowRect = NSRect(x: 0, y: 0, width: 1200, height: 800)
        window = NSWindow(
            contentRect: windowRect,
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.isReleasedWhenClosed = false
        window.title = "Walnut"
        applyWindowChrome()
        window.center()
        // WALNUT_DESKTOP_E2E_BACKGROUND=1 (a test knob, README.md): a test copy opens behind
        // every window and never takes focus from the person using this Mac.
        if ProcessInfo.processInfo.environment["WALNUT_DESKTOP_E2E_BACKGROUND"] == "1" {
            window.orderBack(nil)
        } else {
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
        }

        if let config = loadConfig(),
           FileManager.default.fileExists(atPath: config.walnutHome),
           config.runtimeDir == nil,
           AppBuiltCheckout.isOldAppLocation(walnutHome: config.walnutHome, sourceDir: config.walnutSourceDir) {
            // <data home>/source, where an older version of this app built a
            // checkout with npm: that one moves to the self-contained Walnut, one
            // the user keeps there runs as it is.
            adoptOldAppLocation(home: config.walnutHome)
        } else if let config = loadConfig(),
           FileManager.default.fileExists(atPath: config.walnutHome),
           BundledRuntime.setupRuns(runtimeDir: config.runtimeDir, sourceDir: config.walnutSourceDir) {
            walnutHome = config.walnutHome
            walnutSourceDir = config.walnutSourceDir
            runtime = config.runtimeDir.map { BundledRuntime(installDir: $0) }
            appBuiltCheckout = config.appBuiltCheckout
            showLoadingScreen()
            // An updated app carries a newer Walnut than the one installed: put it
            // in first (offline, seconds), so the update brings both.
            if let rt = runtime, let carried = carriedReleaseForThisMac(),
               RuntimeUpgrade.shouldInstallCarried(carried: carried.version, installed: installedRuntimeVersion(rt)) {
                upgradeRuntime(rt, to: carried)
            } else {
                startServer()
            }
        } else {
            // A first launch starts by itself, like any app: it installs the
            // self-contained Walnut (or finds the one install.sh put here) and
            // opens the console. The other ways to run it (an existing folder, a
            // source checkout) are a click away on that screen, and Reset Setup...
            // brings back the choice.
            startFreshSetup()
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return true
    }

    // MARK: - open-walnut:// links

    /// A link clicked anywhere on this Mac (AppLink.swift). Brings the window up
    /// and hands the link to the console; the console decides what it means.
    func application(_ application: NSApplication, open urls: [URL]) {
        for url in urls where AppLink.accepts(url) {
            DesktopLogger.shared.log("app_link_received", fields: ["action": url.host ?? ""])
            pendingAppLinks.append(url)
        }
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        deliverAppLinks()
    }

    func deliverAppLinks() {
        guard consolePageLoaded, let webView = webView, !pendingAppLinks.isEmpty else { return }
        let links = pendingAppLinks
        pendingAppLinks = []
        for url in links {
            guard let script = AppLink.bridgeScript(for: url) else { continue }
            webView.evaluateJavaScript(script) { result, error in
                DesktopLogger.shared.log("app_link_delivered", fields: [
                    "action": url.host ?? "",
                    "via": (result as? String) ?? "",
                    "error": error.map { String(describing: $0) } ?? "",
                ])
            }
        }
    }

    // MARK: - The walnut command

    /// Puts `walnut` on PATH for a Mac that has only the app (CommandLineTool.swift).
    /// Quiet unless asked from the menu, where the result is shown.
    func checkCommandLineTool(showResult: Bool) {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let runtimeCommand = runtime.flatMap { rt in rt.layout().map { rt.command(layout: $0) } }
        guard let target = CommandLineTool.target(runtimeCommand: runtimeCommand, sourceDir: runtime == nil ? walnutSourceDir : nil) else {
            if showResult { showCommandLineToolResult("Walnut is not set up yet.") }
            return
        }
        let shell = ProcessInfo.processInfo.environment["SHELL"].flatMap { $0.isEmpty ? nil : $0 } ?? "/bin/zsh"
        let tool = CommandLineTool(home: home)
        // On launch, nothing to decide when the name is already ours or someone else's
        // file: skip asking the login shell (it runs the user's profile).
        if !showResult {
            switch tool.existing() {
            case .linkTo(let dest, let ok) where dest == target && ok: return
            case .otherFile: return
            default: break
            }
        }
        DispatchQueue.global(qos: .utility).async {
            let view = CommandLineTool.probeShell(shell)
            let outcome = tool.install(target: target, shell: shell, view: view)
            DesktopLogger.shared.log("walnut_command_checked", fields: [
                "linked": String(outcome.linked),
                "already": String(outcome.alreadyLinked),
                "left": outcome.left ?? "",
                "profile": outcome.profileEdited ?? "",
                "shellAnswered": String(view != nil),
                "error": outcome.error ?? "",
            ])
            if showResult {
                DispatchQueue.main.async { self.showCommandLineToolResult(outcome.summary) }
            }
        }
    }

    func showCommandLineToolResult(_ text: String) {
        let alert = NSAlert()
        alert.messageText = "The walnut command"
        alert.informativeText = text
        alert.addButton(withTitle: "OK")
        if let window = window { alert.beginSheetModal(for: window) } else { alert.runModal() }
    }

    @objc func installCommandLineTool() {
        checkCommandLineTool(showResult: true)
    }

    // MARK: - Window chrome

    /// macOS 26 lays the window title out at the LEADING edge of a plain `.titled`
    /// window and reserves no room for the traffic lights, so "Walnut — localhost:…"
    /// rendered at x=0 truncated underneath the three buttons, on the old grey
    /// gradient. A content-first app has no use for that strip of chrome: hide the
    /// title, make the bar transparent, drop the hairline, and let the window
    /// background (kept in step with the web app's `--bg`) run edge to edge so the
    /// buttons float over the app's own header.
    func applyWindowChrome(to target: NSWindow? = nil) {
        guard let window = target ?? window else { return }
        window.titleVisibility = .hidden          // title still shows in the Window menu
        window.titlebarAppearsTransparent = true
        window.titlebarSeparatorStyle = .none
        // Every native screen (setup / loading / error) paints this cream; the web
        // view reports its real colour once it loads.
        window.backgroundColor = NSColor(red: 0.98, green: 0.97, blue: 0.95, alpha: 1)
    }

    /// Applies a CSS colour reported by the web app (`--bg`) to the window
    /// background, which is all that's visible in the transparent titlebar.
    func setChromeBackground(css: String, in target: NSWindow?) {
        guard let color = NSColor(cssHex: css) else { return }
        target?.backgroundColor = color
    }

    func applicationWillTerminate(_ notification: Notification) {
        isTerminating = true
        DesktopLogger.shared.log("app_terminating")
        dictation?.unregisterHotKey()
        bootstrapProcess?.terminate()
        installerProcess?.terminate()
        stopServer()
        DesktopLogger.shared.flush()
    }

    // MARK: - Setup Screen

    func showSetupScreen() {
        let container = NSView(frame: window.contentView!.bounds)
        container.autoresizingMask = [.width, .height]
        // These screens paint a fixed light cream; in Dark Mode the system's
        // button and label colours would be white on it (Retry was invisible).
        container.appearance = NSAppearance(named: .aqua)
        container.wantsLayer = true
        container.layer?.backgroundColor = NSColor(red: 0.98, green: 0.97, blue: 0.95, alpha: 1).cgColor

        let stack = NSStackView()
        stack.orientation = .vertical
        stack.spacing = 16
        stack.alignment = .centerX
        stack.translatesAutoresizingMaskIntoConstraints = false

        let title = NSTextField(labelWithString: "🌰 Welcome to Walnut")
        title.font = NSFont.systemFont(ofSize: 28, weight: .bold)
        title.textColor = NSColor(red: 0.45, green: 0.33, blue: 0.15, alpha: 1)
        stack.addArrangedSubview(title)

        let subtitle = NSTextField(labelWithString: "Personal AI")
        subtitle.font = NSFont.systemFont(ofSize: 14)
        subtitle.textColor = NSColor(white: 0.4, alpha: 1)
        stack.addArrangedSubview(subtitle)

        let spacer1 = NSView()
        spacer1.heightAnchor.constraint(equalToConstant: 20).isActive = true
        stack.addArrangedSubview(spacer1)

        // Option 1: Get Started (the self-contained Walnut, BundledRuntime.swift)
        let freshBtn = makeButton(
            title: "Get Started",
            subtitle: "Download Walnut, one file with everything it needs",
            action: #selector(startFreshSetup)
        )
        stack.addArrangedSubview(freshBtn)

        // Option 2: Use existing
        let existingBtn = makeButton(
            title: "Use Existing Installation",
            subtitle: "Point to an existing .open-walnut directory or a source checkout",
            action: #selector(chooseExistingFolder)
        )
        stack.addArrangedSubview(existingBtn)

        let spacer2 = NSView()
        spacer2.heightAnchor.constraint(equalToConstant: 20).isActive = true
        stack.addArrangedSubview(spacer2)

        let reqNote = NSTextField(wrappingLabelWithString: "Get Started needs nothing else installed. Running from a source checkout needs Bun.")
        reqNote.font = NSFont.systemFont(ofSize: 12)
        reqNote.textColor = NSColor(white: 0.55, alpha: 1)
        reqNote.preferredMaxLayoutWidth = 400
        stack.addArrangedSubview(reqNote)

        container.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: container.centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: container.centerYAnchor),
            stack.widthAnchor.constraint(lessThanOrEqualToConstant: 500)
        ])

        window.contentView = container
    }

    func makeButton(title: String, subtitle: String, action: Selector) -> NSView {
        let btn = NSButton(title: "", target: self, action: action)
        btn.bezelStyle = .rounded
        btn.isBordered = false
        btn.wantsLayer = true
        btn.layer?.backgroundColor = NSColor.white.cgColor
        btn.layer?.cornerRadius = 10
        btn.layer?.borderWidth = 1
        btn.layer?.borderColor = NSColor(red: 0.85, green: 0.8, blue: 0.72, alpha: 1).cgColor
        btn.layer?.shadowColor = NSColor.black.cgColor
        btn.layer?.shadowOpacity = 0.06
        btn.layer?.shadowRadius = 4
        btn.layer?.shadowOffset = CGSize(width: 0, height: -1)

        let titleLabel = NSTextField(labelWithString: title)
        titleLabel.font = NSFont.systemFont(ofSize: 16, weight: .semibold)
        titleLabel.textColor = NSColor(red: 0.2, green: 0.15, blue: 0.08, alpha: 1)

        let subtitleLabel = NSTextField(labelWithString: subtitle)
        subtitleLabel.font = NSFont.systemFont(ofSize: 12)
        subtitleLabel.textColor = NSColor(white: 0.45, alpha: 1)

        let stack = NSStackView(views: [titleLabel, subtitleLabel])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 4
        stack.translatesAutoresizingMaskIntoConstraints = false

        btn.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: btn.leadingAnchor, constant: 20),
            stack.trailingAnchor.constraint(equalTo: btn.trailingAnchor, constant: -20),
            stack.topAnchor.constraint(equalTo: btn.topAnchor, constant: 14),
            stack.bottomAnchor.constraint(equalTo: btn.bottomAnchor, constant: -14),
            btn.widthAnchor.constraint(equalToConstant: 400)
        ])

        return btn
    }

    // MARK: - Fresh Setup (Auto-Bootstrap)

    /// Get Started: the self-contained Walnut, installed by the install.sh this
    /// app carries, with its data in ~/.open-walnut (an existing one is kept and
    /// used as it is). A Mac where install.sh already ran uses that copy.
    @objc func startFreshSetup() {
        installRuntime(dataHome: NSHomeDirectory() + "/.open-walnut", offerExisting: true)
    }

    /// The self-contained Walnut with its data in `dataHome`: Get Started, Set Up
    /// Now for a folder the user picked, and the move of an app-built checkout.
    /// The install is the one `curl -fsSL .../install.sh | sh` makes, by the
    /// install.sh this app carries; nothing is built and no Node or npm is needed.
    func installRuntime(dataHome: String, offerExisting: Bool) {
        let home = NSHomeDirectory()
        // A release build carries this Mac's file: installed from the app, offline.
        let carried = carriedReleaseForThisMac()
        let env = BundledRuntime.installEnvironment(base: ProcessInfo.processInfo.environment, home: home, carried: carried)
        let bundled = BundledRuntime(installDir: env["OPEN_WALNUT_INSTALL_DIR"]!)
        try? FileManager.default.createDirectory(atPath: dataHome, withIntermediateDirectories: true)

        if bundled.isInstalled() {
            DesktopLogger.shared.log("runtime_found", fields: ["dir": bundled.installDir])
            useRuntime(bundled, home: dataHome)
            return
        }
        guard let script = Bundle.main.path(forResource: "install", ofType: "sh") else {
            showError("This copy of Walnut.app is missing its installer (Contents/Resources/install.sh). Download it again from https://github.com/EvanZhang008/open-walnut/releases/latest")
            return
        }

        retrySetup = { [weak self] in self?.installRuntime(dataHome: dataHome, offerExisting: offerExisting) }
        showBootstrapScreen(
            detail: carried != nil
                ? "This takes a few seconds, the first time only."
                : "Walnut downloads itself once. After that it opens at once.",
            offerExisting: offerExisting)
        statusLabel?.stringValue = "Getting Walnut..."
        try? FileManager.default.removeItem(at: bootstrapLogPath())
        DesktopLogger.shared.log("runtime_install_started", fields: [
            "dir": bundled.installDir, "from": carried.map { "carried " + $0.version } ?? "download",
        ])
        setupGeneration += 1
        let generation = setupGeneration
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let result = BundledRuntime.runInstaller(script: script, environment: env, onStart: { proc in
                DispatchQueue.main.async { if self?.setupGeneration == generation { self?.installerProcess = proc } }
            }) { progress in
                DispatchQueue.main.async { if self?.setupGeneration == generation { self?.showSetupProgress(progress) } }
            }
            DispatchQueue.main.async {
                guard let self = self, self.setupGeneration == generation else { return }
                self.installerProcess = nil
                self.appendToBootstrapLog("install.sh", result.output)
                DesktopLogger.shared.log("runtime_install_finished", fields: ["ok": String(result.success)])
                if result.success, bundled.isInstalled() {
                    self.useRuntime(bundled, home: dataHome)
                } else if result.success {
                    self.showError("The download finished, but Walnut is not in \(bundled.installDir) where this app looks for it.", details: result.output)
                } else if carried != nil {
                    self.showError("Walnut could not set itself up from this copy of the app. Download Walnut again from https://github.com/EvanZhang008/open-walnut/releases/latest", details: result.output)
                } else {
                    self.showError("Walnut could not be downloaded. Check the internet connection and try again.", details: result.output)
                }
            }
        }
    }

    func carriedReleaseForThisMac() -> BundledRuntime.CarriedRelease? {
        return Bundle.main.resourcePath.flatMap {
            BundledRuntime.carriedRelease(resources: $0, arch: BundledRuntime.machineArch(), list: BundledRuntime.listDirectory)
        }
    }

    func installedRuntimeVersion(_ rt: BundledRuntime) -> String? {
        return rt.installedVersion(layout: rt.layout())
    }

    /// The relaunch after an app update: install the Walnut this app carries over
    /// the older one with the same install.sh (it swaps only a copy that runs, so a
    /// failure leaves the old one), then start the server either way.
    func upgradeRuntime(_ rt: BundledRuntime, to carried: BundledRuntime.CarriedRelease) {
        guard let script = Bundle.main.path(forResource: "install", ofType: "sh") else { startServer(); return }
        var base = ProcessInfo.processInfo.environment
        base["OPEN_WALNUT_INSTALL_DIR"] = rt.installDir
        let env = BundledRuntime.installEnvironment(base: base, home: NSHomeDirectory(), carried: carried)
        let from = installedRuntimeVersion(rt) ?? "unknown"
        statusLabel?.stringValue = "Updating Walnut to \(carried.version)..."
        DesktopLogger.shared.log("runtime_upgrade_started", fields: ["from": from, "to": carried.version, "dir": rt.installDir])
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let result = BundledRuntime.runInstaller(script: script, environment: env, onProgress: { _ in })
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.appendToBootstrapLog("install.sh (upgrade \(from) -> \(carried.version))", result.output)
                DesktopLogger.shared.log("runtime_upgrade_finished", fields: [
                    "ok": String(result.success), "installed": self.installedRuntimeVersion(rt) ?? "unknown",
                ])
                self.statusLabel?.stringValue = "Starting Walnut server..."
                self.startServer()
            }
        }
    }

    /// A setup on `<home>/source`, where an older version of this app built a
    /// checkout (AppBuiltCheckout.swift). Decided off the main thread, since it
    /// reads git: the old app's checkout moves to the self-contained Walnut with
    /// the same data, after the old app's Node server is stopped (it would hold
    /// the port, and this app would attach to it), and is removed once the new
    /// Walnut has served. A checkout the user keeps there runs as it is, on bun.
    func adoptOldAppLocation(home: String) {
        let source = AppBuiltCheckout.location(walnutHome: home)
        let recorded = recordedSpawnedServerPid()
        let ports = portsToTry
        setupGeneration += 1
        let generation = setupGeneration
        retrySetup = { [weak self] in self?.adoptOldAppLocation(home: home) }
        showLoadingScreen()
        statusLabel?.stringValue = "Checking this Walnut setup..."
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let runnable = FileManager.default.fileExists(atPath: source + "/dist/cli.js")
            let verdict = AppBuiltCheckout.check(sourceDir: source)
            let moves = AppBuiltCheckout.movesToRuntime(runnable: runnable, verdict: verdict)
            let stopped = moves
                ? AppBuiltCheckout.stopOldServers(sourceDir: source, recordedPid: recorded, ports: ports, checkoutIsAppBuilt: verdict == .appBuilt)
                : []
            DispatchQueue.main.async {
                guard let self = self, self.setupGeneration == generation else { return }
                var fields = ["home": home, "verdict": verdict.logValue, "runnable": String(runnable)]
                if !stopped.isEmpty { fields["stopped_old_server"] = stopped.map(String.init).joined(separator: ",") }
                if let pid = recorded, stopped.contains(pid) { clearSpawnedServerPid() }
                if moves {
                    self.appBuiltCheckout = AppBuiltCheckout.queuesRemoval(verdict) ? source : nil
                    DesktopLogger.shared.log("app_built_checkout_migrated", fields: fields)
                    self.installRuntime(dataHome: home, offerExisting: false)
                } else {
                    DesktopLogger.shared.log("user_checkout_kept", fields: fields)
                    self.runtime = nil
                    self.appBuiltCheckout = nil
                    self.walnutHome = home
                    self.walnutSourceDir = source
                    self.finishSetup()
                }
            }
        }
    }

    /// Once the self-contained Walnut this app started has served: the old app's
    /// checkout goes (about 1 GB), when it is still provably the old app's. Until
    /// then it stays, so a setup whose new Walnut never starts can go back.
    func removeAppBuiltCheckoutIfServed() {
        guard let dir = appBuiltCheckout, let home = walnutHome, let rt = runtime, ownsServer, !removingAppBuiltCheckout else { return }
        removingAppBuiltCheckout = true
        let began = Date()
        DispatchQueue.global(qos: .utility).async { [weak self] in
            let outcome = AppBuiltCheckout.removeIfServed(sourceDir: dir, walnutHome: home, runtimeDir: rt.installDir, runtimeServed: true)
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.removingAppBuiltCheckout = false
                var fields = ["dir": dir, "seconds": String(format: "%.1f", Date().timeIntervalSince(began))]
                switch outcome {
                case .removed: DesktopLogger.shared.log("app_built_checkout_removed", fields: fields)
                case .kept(let why): fields["reason"] = why; DesktopLogger.shared.log("app_built_checkout_kept", fields: fields)
                case .notYet(let why): fields["reason"] = why; DesktopLogger.shared.log("app_built_checkout_removal_deferred", fields: fields)
                }
                guard outcome.settled, self.appBuiltCheckout == dir else { return }
                self.appBuiltCheckout = nil
                if var config = loadConfig(), config.appBuiltCheckout == dir {
                    config.appBuiltCheckout = nil
                    saveConfig(config)
                }
            }
        }
    }

    func useRuntime(_ bundled: BundledRuntime, home: String) {
        runtime = bundled
        walnutHome = home
        // No checkout: the server starts from the runtime (tryStartServerOnPort).
        walnutSourceDir = bundled.installDir
        finishSetup()
    }

    /// The setup screen's step, and the download's share as a bar once curl knows the size.
    func showSetupProgress(_ progress: BundledRuntime.Progress) {
        guard let label = statusLabel else { return }
        if let fraction = progress.fraction {
            label.stringValue = "\(progress.status) \(Int((fraction * 100).rounded()))%"
            setupProgressBar?.doubleValue = fraction * 100
            setupProgressBar?.isHidden = false
            setupSpinner?.isHidden = true
        } else {
            label.stringValue = progress.status
            setupProgressBar?.isHidden = true
            setupSpinner?.isHidden = false
        }
    }

    func showBootstrapScreen(
        detail: String = "This may take a couple of minutes on the first run.",
        offerExisting: Bool = false
    ) {
        let container = NSView(frame: window.contentView!.bounds)
        container.autoresizingMask = [.width, .height]
        // These screens paint a fixed light cream; in Dark Mode the system's
        // button and label colours would be white on it (Retry was invisible).
        container.appearance = NSAppearance(named: .aqua)
        container.wantsLayer = true
        container.layer?.backgroundColor = NSColor(red: 0.98, green: 0.97, blue: 0.95, alpha: 1).cgColor

        let stack = NSStackView()
        stack.orientation = .vertical
        stack.spacing = 12
        stack.alignment = .centerX
        stack.translatesAutoresizingMaskIntoConstraints = false

        let title = NSTextField(labelWithString: "Welcome to Walnut")
        title.font = NSFont.systemFont(ofSize: 24, weight: .bold)
        title.textColor = NSColor(red: 0.45, green: 0.33, blue: 0.15, alpha: 1)
        stack.addArrangedSubview(title)
        stack.setCustomSpacing(20, after: title)

        let spinner = NSProgressIndicator()
        spinner.style = .spinning
        spinner.startAnimation(nil)
        stack.addArrangedSubview(spinner)
        self.setupSpinner = spinner

        let bar = NSProgressIndicator()
        bar.style = .bar
        bar.isIndeterminate = false
        bar.minValue = 0
        bar.maxValue = 100
        bar.isHidden = true
        bar.widthAnchor.constraint(equalToConstant: 320).isActive = true
        stack.addArrangedSubview(bar)
        self.setupProgressBar = bar

        let label = NSTextField(labelWithString: "Setting up Walnut...")
        label.font = NSFont.systemFont(ofSize: 14)
        label.textColor = NSColor(white: 0.35, alpha: 1)
        stack.addArrangedSubview(label)
        self.statusLabel = label

        let detailLabel = NSTextField(wrappingLabelWithString: detail)
        detailLabel.font = NSFont.systemFont(ofSize: 12)
        detailLabel.textColor = NSColor(white: 0.55, alpha: 1)
        detailLabel.alignment = .center
        detailLabel.preferredMaxLayoutWidth = 400
        stack.addArrangedSubview(detailLabel)

        if offerExisting {
            let other = NSButton(title: "Use an existing installation instead…", target: self, action: #selector(chooseExistingFolderInsteadOfDownload))
            other.isBordered = false
            other.font = NSFont.systemFont(ofSize: 12)
            other.contentTintColor = NSColor(red: 0.45, green: 0.33, blue: 0.15, alpha: 1)
            stack.setCustomSpacing(24, after: detailLabel)
            stack.addArrangedSubview(other)
        }

        container.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: container.centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: container.centerYAnchor)
        ])

        window.contentView = container
    }

    func runProcess(_ executable: String, args: [String], cwd: String, prependToPath: String? = nil) -> (success: Bool, output: String) {
        let proc = Process()
        let pipe = Pipe()
        proc.executableURL = URL(fileURLWithPath: executable)
        proc.arguments = args
        proc.currentDirectoryURL = URL(fileURLWithPath: cwd)
        proc.standardOutput = pipe
        proc.standardError = pipe

        var env = ProcessInfo.processInfo.environment
        let extraPaths = [
            "/opt/homebrew/bin",
            "/usr/local/bin",
            NSHomeDirectory() + "/.nvm/current/bin",
            NSHomeDirectory() + "/.fnm/current/bin"
        ]
        let currentPath = env["PATH"] ?? "/usr/bin:/bin"
        var pathComponents: [String] = []
        // Put the resolved node's directory first so child processes (postinstall scripts)
        // use the same node version, not whatever a version manager shim resolves to
        if let prepend = prependToPath {
            pathComponents.append(prepend)
        }
        pathComponents.append(contentsOf: extraPaths)
        pathComponents.append(currentPath)
        env["PATH"] = pathComponents.joined(separator: ":")
        proc.environment = env

        self.bootstrapProcess = proc

        do {
            try proc.run()
        } catch {
            return (false, "Failed to launch \(executable): \(error.localizedDescription)")
        }

        // Drain the pipe BEFORE waitUntilExit: a chatty child fills the 64KB
        // pipe buffer and blocks forever if nobody reads until after it exits.
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        proc.waitUntilExit()
        let output = String(data: data, encoding: .utf8) ?? ""
        return (proc.terminationStatus == 0, output)
    }

    // MARK: - Use Existing Folder

    @objc func chooseExistingFolder() { pickExistingFolder(beforeUse: nil) }

    /// From the first-launch screen: the download keeps going until a folder is
    /// picked, so Cancel leaves the install as it was.
    @objc func chooseExistingFolderInsteadOfDownload() {
        pickExistingFolder(beforeUse: { [weak self] in self?.abandonInstall() })
    }

    /// Stops the first-launch install: its process, and its result when it ends.
    func abandonInstall() {
        setupGeneration += 1
        installerProcess?.terminate()
        installerProcess = nil
    }

    func pickExistingFolder(beforeUse: (() -> Void)?) {
        let defaultPath = NSHomeDirectory() + "/.open-walnut"

        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.message = "Select your .open-walnut directory, or a built open-walnut dev checkout"
        panel.prompt = "Use This Folder"

        if FileManager.default.fileExists(atPath: defaultPath) {
            panel.directoryURL = URL(fileURLWithPath: defaultPath)
        }

        panel.beginSheetModal(for: window) { [weak self] response in
            guard response == .OK, let url = panel.url else { return }
            let home = url.path
            let fm = FileManager.default

            // A dev checkout itself (package.json and a built dist/cli.js at the
            // root): run straight from it on bun. Data still lives in the
            // standard ~/.open-walnut home.
            if BundledRuntime.isBuiltCheckout(home) {
                beforeUse?()
                self?.runtime = nil
                let dataHome = NSHomeDirectory() + "/.open-walnut"
                try? fm.createDirectory(atPath: dataHome, withIntermediateDirectories: true)
                self?.walnutHome = dataHome
                self?.walnutSourceDir = home
                self?.finishSetup()
            // A data home with a built source/ checkout, the place an older version
            // of this app built one: decided as a saved setup there is.
            } else if fm.fileExists(atPath: AppBuiltCheckout.location(walnutHome: home) + "/dist/cli.js") {
                beforeUse?()
                self?.adoptOldAppLocation(home: home)
            // A data home (config.yaml): the self-contained Walnut with its data here.
            } else if fm.fileExists(atPath: home + "/config.yaml") {
                beforeUse?()
                self?.installRuntime(dataHome: home, offerExisting: false)
            } else {
                let alert = NSAlert()
                alert.messageText = "No Walnut Here Yet"
                alert.informativeText = "This folder has no Walnut data and is not a built checkout. Set Walnut up with its data in this folder? It installs the self-contained Walnut, one file, with nothing else to install."
                alert.addButton(withTitle: "Set Up Now")
                alert.addButton(withTitle: "Cancel")

                alert.beginSheetModal(for: self!.window) { alertResponse in
                    // Cancel leaves whatever was running (a first-launch download) as it was.
                    if alertResponse == .alertFirstButtonReturn {
                        beforeUse?()
                        self?.installRuntime(dataHome: home, offerExisting: false)
                    }
                }
            }
        }
    }

    // MARK: - Finish Setup

    func finishSetup() {
        guard let home = walnutHome, let source = walnutSourceDir else { return }
        saveConfig(WalnutConfig(walnutHome: home, walnutSourceDir: source, runtimeDir: runtime?.installDir, appBuiltCheckout: runtime != nil ? appBuiltCheckout : nil))
        showLoadingScreen()
        startServer()
    }

    // MARK: - Loading Screen

    func showLoadingScreen() {
        let container = NSView(frame: window.contentView!.bounds)
        container.autoresizingMask = [.width, .height]
        // These screens paint a fixed light cream; in Dark Mode the system's
        // button and label colours would be white on it (Retry was invisible).
        container.appearance = NSAppearance(named: .aqua)
        container.wantsLayer = true
        container.layer?.backgroundColor = NSColor(red: 0.98, green: 0.97, blue: 0.95, alpha: 1).cgColor

        let stack = NSStackView()
        stack.orientation = .vertical
        stack.spacing = 12
        stack.alignment = .centerX
        stack.translatesAutoresizingMaskIntoConstraints = false

        let spinner = NSProgressIndicator()
        spinner.style = .spinning
        spinner.startAnimation(nil)
        stack.addArrangedSubview(spinner)

        let label = NSTextField(labelWithString: "Starting Walnut server...")
        label.font = NSFont.systemFont(ofSize: 14)
        label.textColor = NSColor(white: 0.35, alpha: 1)
        stack.addArrangedSubview(label)
        self.statusLabel = label

        container.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: container.centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: container.centerYAnchor)
        ])

        window.contentView = container
    }

    // MARK: - Server Management

    /// WALNUT_DESKTOP_PORTS (comma-separated) moves a test copy off the real ports,
    /// where it would otherwise attach to the server already running there.
    let portsToTry: [Int] = {
        let custom = (ProcessInfo.processInfo.environment["WALNUT_DESKTOP_PORTS"] ?? "")
            .split(separator: ",").compactMap { Int($0.trimmingCharacters(in: .whitespaces)) }
        return custom.isEmpty ? [3456, 4567] : custom
    }()
    var ownsServer = false
    /// The background update runs once per launch (updateRuntimeInBackground).
    var runtimeUpdateStarted = false

    func startServer() {
        DesktopLogger.shared.log("server_discovery_started")
        checkExistingServer(index: 0)
    }

    func checkExistingServer(index: Int) {
        guard index < portsToTry.count else {
            tryStartServerOnPort(index: 0)
            return
        }

        let port = portsToTry[index]
        statusLabel?.stringValue = "Checking port \(port)..."

        let url = URL(string: "http://localhost:\(port)")!
        var request = URLRequest(url: url)
        request.timeoutInterval = 2

        let task = URLSession.shared.dataTask(with: request) { [weak self] _, response, error in
            DispatchQueue.main.async {
                guard let self = self else { return }
                if let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 {
                    // A server is already listening. If it's an ORPHANED Walnut server
                    // (a previous run whose parent app died uncleanly — reparented to
                    // PID 1), reclaim the port by killing it and starting a fresh owned
                    // server. Otherwise (a legitimate owner: another app instance or a
                    // shell-launched dev server, ppid != 1) attach without killing it.
                    if let orphanPid = self.orphanedWalnutServerPid(onPort: port) {
                        DesktopLogger.shared.log("orphaned_server_reclaimed", fields: [
                            "pid": String(orphanPid),
                            "port": String(port)
                        ])
                        self.statusLabel?.stringValue = "Reclaiming orphaned server on port \(port)..."
                        // SIGTERM, its own few seconds to exit, then SIGKILL; then start our own.
                        DispatchQueue.global(qos: .userInitiated).async {
                            let gone = LocalProcess.stop(pid: orphanPid, grace: 8)
                            DispatchQueue.main.async {
                                if gone, recordedSpawnedServerPid() == orphanPid { clearSpawnedServerPid() }
                                self.tryStartServerOnPort(index: index)
                            }
                        }
                    } else {
                        DesktopLogger.shared.log("existing_server_attached", fields: [
                            "port": String(port)
                        ])
                        self.serverRestartPolicy.reset()
                        self.isRecoveringServer = false
                        self.ownsServer = false
                        self.serverPort = port
                        self.serverReadyAt = nil
                        self.loadWebUI()
                    }
                } else {
                    self.checkExistingServer(index: index + 1)
                }
            }
        }
        task.resume()
    }

    /// Returns the PID of an orphaned Walnut server listening on `port`, or nil.
    /// "Orphaned" = the exact server process THIS app spawned on a previous run
    /// (PID recorded in server.pid) that outlived the app. We only reclaim our
    /// own orphan — never a server started by someone else. A ppid==1 heuristic
    /// alone is NOT enough: a dev server launched from a shell that later exits
    /// also reparents to PID 1, and killing it torpedoes the user's own setup.
    func orphanedWalnutServerPid(onPort port: Int) -> pid_t? {
        guard let recordedPid = recordedSpawnedServerPid() else { return nil }
        // 1. Find the PID listening on the TCP port.
        guard let lsof = runShellRaw("lsof -nP -iTCP:\(port) -sTCP:LISTEN -t 2>/dev/null | head -1"),
              let pid = Int32(lsof.trimmingCharacters(in: .whitespacesAndNewlines)) else {
            return nil
        }
        // 2. Only our own recorded child counts (guards against PID reuse by
        //    also confirming it still looks like a Walnut server).
        guard pid == recordedPid else { return nil }
        guard let psOut = runShellRaw("ps -o command= -p \(pid) 2>/dev/null"),
              isOwnServerCommand(psOut.trimmingCharacters(in: .whitespacesAndNewlines)) else {
            // Recorded PID no longer a Walnut server (reused) — stale record.
            clearSpawnedServerPid()
            return nil
        }
        return pid
    }

    /// The self-contained Walnut's own update, once per launch, while its server
    /// runs: `walnut update --auto` keeps updates.auto and the versions held back,
    /// downloads beside the version in use and swaps the link. The server keeps
    /// its file; the next start runs the new one.
    func updateRuntimeInBackground() {
        guard !runtimeUpdateStarted, let rt = runtime, let home = walnutHome, case .file? = rt.layout() else { return }
        runtimeUpdateStarted = true
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: rt.link)
        proc.arguments = ["update", "--auto"]
        proc.currentDirectoryURL = URL(fileURLWithPath: rt.installDir)
        var env = ProcessInfo.processInfo.environment
        env["OPEN_WALNUT_HOME"] = home
        proc.environment = env
        let pipe = Pipe()
        proc.standardOutput = pipe
        proc.standardError = pipe
        proc.standardInput = FileHandle.nullDevice
        let reader = ProcessOutputReader(handle: pipe.fileHandleForReading, maxBufferCharacters: 8_192, logger: { _, _ in })
        reader.start(onText: { _ in }, onEOF: {})
        proc.terminationHandler = { finished in
            reader.stop(reason: "process_exited")
            DesktopLogger.shared.log("runtime_update_finished", fields: [
                "status": String(finished.terminationStatus),
                "output": String(reader.outputSnapshot().suffix(2_000))
            ])
        }
        do {
            try proc.run()
            DesktopLogger.shared.log("runtime_update_started", fields: ["pid": String(proc.processIdentifier)])
        } catch {
            DesktopLogger.shared.log("runtime_update_failed", fields: ["error": error.localizedDescription])
        }
    }

    /// Whether `ps`'s line is a server this app starts: the self-contained Walnut's,
    /// or the checkout's; or the Node server an older version of this app started
    /// on the checkout it built, which this setup moved off and has not removed yet.
    func isOwnServerCommand(_ command: String) -> Bool {
        if let old = appBuiltCheckout, AppBuiltCheckout.isOldAppServerCommand(command, sourceDir: old) { return true }
        if let rt = runtime { return rt.isServerCommand(command) }
        guard let source = walnutSourceDir else { return false }
        return BundledRuntime.isCheckoutServerCommand(command, sourceDir: source)
    }

    func tryStartServerOnPort(index: Int) {
        guard let home = walnutHome, let source = walnutSourceDir else { return }
        guard index < portsToTry.count else {
            let tail = lastServerOutput.isEmpty ? "" : "\n\nLast server output:\n\(lastServerOutput)"
            handleServerStartupFailure(
                "Could not start the Walnut server on ports \(portsToTry.map(String.init).joined(separator: ", ")).\(tail)"
            )
            return
        }

        let port = portsToTry[index]
        statusLabel?.stringValue = "Starting server on port \(port)..."

        let process = Process()
        // The self-contained Walnut starts from what install.sh left (the file, or
        // an older archive); a checkout runs on a bun found on this Mac.
        let launch: BundledRuntime.Launch
        var runtimeLayout: BundledRuntime.Layout?
        if let rt = runtime {
            guard let layout = rt.layout() else {
                handleServerStartupFailure("Walnut is no longer installed in \(rt.installDir). Choose Reset Setup... from the Walnut menu to install it again.")
                return
            }
            runtimeLayout = layout
            launch = rt.serverLaunch(port: port, layout: layout)
        } else {
            guard let bun = findBunOrNil(sourceDir: source) else {
                handleServerStartupFailure("Running Walnut from the checkout at \(source) needs Bun \(checkoutBunPin(source) ?? "") or newer, and none was found.\n\nInstall it:\n  curl -fsSL https://bun.sh/install | bash\n\nor choose Reset Setup... from the Walnut menu to use the self-contained Walnut instead.")
                return
            }
            launch = BundledRuntime.checkoutLaunch(bun: bun, sourceDir: source, port: port)
        }
        DesktopLogger.shared.log("server_spawn_attempted", fields: [
            "port": String(port),
            "runtime": launch.executable
        ])
        let nodeDir = (launch.executable as NSString).deletingLastPathComponent
        process.executableURL = URL(fileURLWithPath: launch.executable)
        process.arguments = launch.arguments
        process.currentDirectoryURL = URL(fileURLWithPath: launch.directory)
        var env = ProcessInfo.processInfo.environment
        env["OPEN_WALNUT_HOME"] = home
        env["NODE_NO_WARNINGS"] = "1"
        // Parent-death watchdog: tell the server to self-terminate if we (its
        // parent) die without a clean shutdown (force-quit, crash, logout). Without
        // this the server orphans onto PID 1 and holds the port forever. See the
        // OPEN_WALNUT_EXIT_ON_ORPHAN handling in open-walnut's src/commands/web.ts.
        env["OPEN_WALNUT_EXIT_ON_ORPHAN"] = "1"
        // Permission Doctor: authoritative "who launched me" signal. macOS TCC
        // attributes every permission request from the server (and the agent
        // sessions under it) to THIS app bundle as the responsible process, so
        // fix instructions must say "grant to Walnut.app" — not to node or to
        // whatever terminal the user last used. See src/core/permissions/.
        env["WALNUT_LAUNCHER"] = "mac-app"
        // The self-contained Walnut updates while its server runs (updateRuntimeInBackground),
        // never before it listens: that download would count against the startup deadline,
        // and the restart after it would be a process this app does not know.
        if runtime != nil {
            env["WALNUT_LAUNCHER_UPDATES"] = "1"
        }
        let extraPaths = [
            "/opt/homebrew/bin",
            "/usr/local/bin",
            NSHomeDirectory() + "/.nvm/current/bin",
            NSHomeDirectory() + "/.fnm/current/bin"
        ]
        let currentPath = env["PATH"] ?? "/usr/bin:/bin"
        if let runtime = runtime, let layout = runtimeLayout {
            env["PATH"] = runtime.serverPath(current: currentPath, extra: extraPaths, layout: layout)
        } else {
            env["PATH"] = ([nodeDir] + extraPaths + [currentPath]).joined(separator: ":")
        }
        process.environment = env

        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe

        serverProcess = process

        let handle = pipe.fileHandleForReading
        var outputBuffer = ""
        var portConfirmed = false
        // Guards the two failure paths (child death vs startup timeout) so exactly one
        // acts. Mutated only on the main queue, so no locking is needed.
        var settled = false

        let outputReader = ProcessOutputReader(
            handle: handle,
            logger: { event, fields in
                var details = fields
                details["port"] = String(port)
                DesktopLogger.shared.log(event, fields: details)
            }
        )
        serverOutputReader = outputReader
        outputReader.start(onText: { [weak self] snapshot in
            outputBuffer = snapshot

            if outputBuffer.contains("listening on http://localhost:\(port)") && !portConfirmed {
                portConfirmed = true
                DispatchQueue.main.async {
                    DesktopLogger.shared.log("server_port_confirmed", fields: [
                        "port": String(port)
                    ])
                    self?.ownsServer = true
                    self?.serverPort = port
                    self?.serverReadyAt = Date()
                    self?.isRecoveringServer = false
                    self?.pollForServer()
                    self?.updateRuntimeInBackground()
                }
            }
        }, onEOF: {
            DesktopLogger.shared.log("server_output_eof", fields: ["port": String(port)])
        })

        do {
            try process.run()
            // Persist the child's PID so a future launch (after an app crash)
            // can recognize this exact process as OUR orphan and reclaim it.
            recordSpawnedServerPid(process.processIdentifier)
            DesktopLogger.shared.log("server_process_started", fields: [
                "pid": String(process.processIdentifier),
                "port": String(port)
            ])
        } catch {
            outputReader.stop(reason: "spawn_failed")
            serverOutputReader = nil
            DesktopLogger.shared.log("server_spawn_failed", fields: [
                "error": error.localizedDescription,
                "port": String(port)
            ])
            DispatchQueue.main.async { [weak self] in
                self?.handleServerStartupFailure(
                    "Failed to start server: \(error.localizedDescription)"
                )
            }
            return
        }

        process.terminationHandler = { [weak self] proc in
            outputReader.stop(reason: "process_exited")
            DesktopLogger.shared.log("server_process_exited", fields: [
                "port": String(port),
                "status": String(proc.terminationStatus)
            ])
            DispatchQueue.main.async {
                guard let self = self else { return }
                let isCurrentProcess = self.serverProcess === process
                if recordedSpawnedServerPid() == proc.processIdentifier {
                    clearSpawnedServerPid()
                }
                if self.serverOutputReader === outputReader {
                    self.serverOutputReader = nil
                }
                if shouldAutomaticallyRestartServer(
                    portConfirmed: portConfirmed,
                    ownsServer: self.ownsServer,
                    isTerminating: self.isTerminating,
                    isCurrentProcess: isCurrentProcess
                ) {
                    let healthyFor = self.serverReadyAt.map { Date().timeIntervalSince($0) }
                    self.serverProcess = nil
                    self.serverPort = nil
                    self.serverReadyAt = nil
                    self.ownsServer = false
                    self.scheduleServerRecovery(
                        reason: "owned_process_exited",
                        healthyFor: healthyFor,
                        detail: "The Walnut server exited with code \(proc.terminationStatus)."
                    )
                    return
                }
                guard !portConfirmed, !settled else { return }
                settled = true
                if isCurrentProcess {
                    self.serverProcess = nil
                }

                // Keep the tail of the child's output for diagnostics.
                let trimmed = outputBuffer.trimmingCharacters(in: .whitespacesAndNewlines)
                let lines = trimmed.split(separator: "\n", omittingEmptySubsequences: false)
                self.lastServerOutput = lines.suffix(15).joined(separator: "\n")

                // Only a genuine port conflict justifies trying the next port. A
                // crash (stale dist/, bad Node, missing dep) will recur identically
                // on every port, so retrying just delays a misleading "ports in
                // use" error — surface the real crash output immediately instead.
                let lower = trimmed.lowercased()
                let portInUse = lower.contains("eaddrinuse") || lower.contains("address already in use")
                if portInUse {
                    self.tryStartServerOnPort(index: index + 1)
                } else {
                    let detail = self.lastServerOutput.isEmpty ? "No output was captured." : self.lastServerOutput
                    self.handleServerStartupFailure(
                        "The Walnut server exited during startup (exit code \(proc.terminationStatus)).\n\n"
                        + "\(detail)\n\n"
                        + (self.runtime != nil
                            ? "Reset Setup... and Get Started again downloads a fresh copy (your data stays)."
                            : "This is usually a stale build. In the source directory run:\n    bun run web:build"))
                }
            }
        }

        // High machine load can delay startup well beyond 15 seconds: a finite
        // three-minute ceiling.
        let startupBeganAt = Date()
        func armStartupDeadline() {
            DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in
                guard let self = self, !portConfirmed, !settled, self.serverProcess === process else { return }
                let timeout = ServerRestartPolicy.ordinaryStartupTimeout
                if Date().timeIntervalSince(startupBeganAt) < timeout {
                    armStartupDeadline()
                    return
                }
                settled = true
                outputReader.stop(reason: "startup_timeout")
                DesktopLogger.shared.log("server_startup_timed_out", fields: [
                    "port": String(port)
                ])
                // A hang (never printed "listening"), not a port conflict. Terminate
                // and report or recover; terminationHandler bails on `settled`.
                if process.isRunning {
                    process.terminate()
                }
                self.serverProcess = nil
                let trimmed = outputBuffer.trimmingCharacters(in: .whitespacesAndNewlines)
                self.lastServerOutput = trimmed.split(separator: "\n", omittingEmptySubsequences: false)
                    .suffix(15).joined(separator: "\n")
                let detail = self.lastServerOutput.isEmpty ? "No output was captured." : self.lastServerOutput
                self.handleServerStartupFailure(
                    "The Walnut server did not become ready within \(Int(timeout)) seconds.\n\n\(detail)"
                )
            }
        }
        armStartupDeadline()
    }

    func handleServerStartupFailure(_ message: String) {
        if isRecoveringServer {
            scheduleServerRecovery(
                reason: "recovery_start_failed",
                healthyFor: nil,
                detail: message
            )
        } else {
            showError(message)
        }
    }

    func scheduleServerRecovery(
        reason: String,
        healthyFor: TimeInterval?,
        detail: String
    ) {
        guard !isTerminating else { return }
        serverRestartWorkItem?.cancel()
        serverRestartWorkItem = nil
        retryTimer?.invalidate()
        retryTimer = nil

        guard let delay = serverRestartPolicy.nextDelay(healthyFor: healthyFor) else {
            isRecoveringServer = false
            DesktopLogger.shared.log("server_auto_restart_exhausted", fields: [
                "reason": reason,
                "attempts": String(serverRestartPolicy.attemptCount)
            ])
            showError(
                "Walnut could not keep the server running after "
                + "\(serverRestartPolicy.attemptCount) automatic restart attempts.\n\n"
                + detail
            )
            return
        }

        isRecoveringServer = true
        showLoadingScreen()
        statusLabel?.stringValue = "Server stopped. Restarting in \(Int(delay)) second\(delay == 1 ? "" : "s")..."
        DesktopLogger.shared.log("server_auto_restart_scheduled", fields: [
            "reason": reason,
            "attempt": String(serverRestartPolicy.attemptCount),
            "delay_seconds": String(Int(delay))
        ])

        let workItem = DispatchWorkItem { [weak self] in
            guard let self = self, !self.isTerminating else { return }
            self.serverRestartWorkItem = nil
            self.serverPort = nil
            self.startServer()
        }
        serverRestartWorkItem = workItem
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: workItem)
    }

    func pollForServer() {
        guard let port = serverPort else { return }
        let url = URL(string: "http://localhost:\(port)")!

        statusLabel?.stringValue = "Server found on port \(port), waiting for it to be ready..."

        var attempts = 0
        retryTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] timer in
            attempts += 1
            var request = URLRequest(url: url)
            request.timeoutInterval = 2
            let task = URLSession.shared.dataTask(with: request) { _, response, error in
                if let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 {
                    DispatchQueue.main.async {
                        timer.invalidate()
                        self?.retryTimer = nil
                        self?.loadWebUI()
                        self?.removeAppBuiltCheckoutIfServed()
                    }
                }
            }
            task.resume()

            if attempts > 60 {
                timer.invalidate()
                self?.retryTimer = nil
                // Through the recovery router, not showError: during auto-recovery a
                // dead-end alert here would strand the restart loop (every other
                // startup-failure edge already routes through this).
                self?.handleServerStartupFailure("Server started on port \(port) but never became ready.")
            }
        }
    }

    /// Builds the web view and loads the console. `url` defaults to the server
    /// root; a recycle passes the page the user was on so the swap lands them
    /// back where they were.
    func loadWebUI(url initialURL: URL? = nil) {
        guard let port = serverPort else { return }
        let url = initialURL ?? URL(string: "http://localhost:\(port)")!

        let config = WKWebViewConfiguration()
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")
        // Native clipboard bridge: WKWebView refuses navigator.clipboard writes
        // once the triggering user-gesture has expired (async capture-then-copy
        // flows). The web console prefers this handler when present.
        config.userContentController.add(self, name: "walnutClipboard")
        // Titlebar colour bridge: the titlebar is transparent, so the window
        // background is what shows behind the traffic lights. Report the web app's
        // resolved `--bg` on load and whenever the theme flips (explicit
        // data-theme or the OS switching under 'system') so the strip never
        // disagrees with the page under it.
        config.userContentController.add(self, name: "walnutChrome")
        // The app's update (AppUpdater.swift): the page asks with
        // webkit.messageHandlers.walnutUpdate.postMessage({op}) and gets a promise;
        // every state change arrives as a `walnut:app-update` event.
        config.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "walnutUpdate")
        addAppUpdateTestScript(to: config.userContentController)
        let reportChrome = """
        (() => {
          const send = () => {
            try {
              const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg');
              if (bg) window.webkit.messageHandlers.walnutChrome.postMessage(bg.trim());
            } catch {}
          };
          send();
          requestAnimationFrame(send);   // after React applies the stored theme
          new MutationObserver(send).observe(document.documentElement,
            { attributes: true, attributeFilter: ['data-theme'] });
          matchMedia('(prefers-color-scheme: dark)').addEventListener('change', send);
        })();
        """
        config.userContentController.addUserScript(WKUserScript(
            source: reportChrome, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
        // Kill macOS autocorrect/spellcheck inside the app: the system's
        // black suggestion bubble ("Flash ×") pops over search fields and the
        // composer. Web content can't opt out globally, so tag every editable
        // element at the focus boundary (covers dynamically-created ones too).
        let disableAutocorrect = """
        document.addEventListener('focusin', (e) => {
          const el = e.target;
          if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) {
            el.setAttribute('autocorrect', 'off');
            el.setAttribute('autocapitalize', 'off');
            el.spellcheck = false;
          }
        }, true);
        """
        config.userContentController.addUserScript(WKUserScript(
            source: disableAutocorrect, injectionTime: .atDocumentEnd, forMainFrameOnly: false))
        // Reduce-transparency test switch (View menu / `defaults write
        // com.local.walnut-desktop walnutReduceGlass -bool YES`). Injected as a
        // stylesheet rather than a class the web CSS reacts to, so it works against
        // any bundle version, including one built before this existed. The glass
        // backgrounds are already 88% opaque, so dropping the blur is a mild visual
        // change and a large change in what WindowServer is asked to do per frame.
        if WebContentPolicy.reduceGlass(UserDefaults.standard) {
            let reduceGlass = """
            (() => {
              const s = document.createElement('style');
              s.id = 'walnut-reduce-glass';
              s.textContent = '*, *::before, *::after { backdrop-filter: none !important;'
                + ' -webkit-backdrop-filter: none !important; }';
              (document.head || document.documentElement).appendChild(s);
            })();
            """
            config.userContentController.addUserScript(WKUserScript(
                source: reduceGlass, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }
        DesktopLogger.shared.log("webview_appearance", fields: [
            "reduceGlass": WebContentPolicy.reduceGlass(UserDefaults.standard) ? "yes" : "no",
        ])

        webView = WKWebView(frame: window.contentView!.bounds, configuration: config)
        // A test copy opened behind other windows (WALNUT_DESKTOP_E2E_BACKGROUND) is covered,
        // and WebKit treats a covered page as hidden and all but stops it. Let it run.
        if ProcessInfo.processInfo.environment["WALNUT_DESKTOP_E2E_BACKGROUND"] == "1",
           webView.responds(to: NSSelectorFromString("_setWindowOcclusionDetectionEnabled:")) {
            webView.setValue(false, forKey: "windowOcclusionDetectionEnabled")
        }
        consolePageLoaded = false
        webView.autoresizingMask = [.width, .height]
        webView.navigationDelegate = self
        webView.uiDelegate = self
        // Restore the user's page zoom (⌘+ / ⌘-) from the previous launch.
        let savedZoom = UserDefaults.standard.double(forKey: Self.zoomDefaultsKey)
        if savedZoom > 0 { webView.pageZoom = savedZoom }

        window.contentView = webView
        window.title = "Walnut — localhost:\(port)"
        webContentWatchdog?.attach(webView: webView, window: window)

        let request = URLRequest(url: url)
        webView.load(request)
    }

    /// Replaces the WKWebView (and with it the WebContent process) at the page
    /// the user is on. `reload()` would keep the same process, and the whole
    /// point is a fresh compositor: the old process exits once its view is gone.
    func recycleWebContent(reason: String) {
        guard let old = webView, let port = serverPort else { return }
        let current = old.url ?? URL(string: "http://localhost:\(port)")!
        DesktopLogger.shared.log("webcontent_recycle_started", fields: [
            "reason": reason,
            "path": current.path + (current.query.map { "?\($0)" } ?? ""),
        ])
        old.stopLoading()
        old.navigationDelegate = nil
        old.uiDelegate = nil
        old.configuration.userContentController.removeAllScriptMessageHandlers()
        webView = nil
        consolePageLoaded = false
        loadWebUI(url: current)
    }

    /// View → Restart Page Process: the manual path for the same swap the
    /// watchdog does on its own, for when the app feels slow right now.
    @objc func recycleWebContentManually() {
        if let active = activeWebView, active !== webView { recyclePopout(active) }
        else { recycleWebContent(reason: "manual") }
    }

    /// View → Reduce Transparency: flips the glass off (or back on) and rebuilds
    /// the web view so it takes effect immediately. A/B it against the same
    /// interaction that feels slow; whichever wins, the answer is in the log.
    @objc func toggleReduceGlass(_ sender: NSMenuItem) {
        let wanted = sender.state != .on
        UserDefaults.standard.set(wanted, forKey: WebContentPolicy.reduceGlassKey)
        sender.state = wanted ? .on : .off
        recycleWebContent(reason: wanted ? "reduce_glass_on" : "reduce_glass_off")
    }

    func stopServer() {
        DesktopLogger.shared.log("server_stop_requested", fields: [
            "owned": String(ownsServer),
            "port": serverPort.map(String.init) ?? "none"
        ])
        serverRestartWorkItem?.cancel()
        serverRestartWorkItem = nil
        isRecoveringServer = false
        retryTimer?.invalidate()
        retryTimer = nil
        serverOutputReader?.stop(reason: "app_stop")
        serverOutputReader = nil

        let shouldTerminateOwnedServer = ownsServer
        ownsServer = false
        serverReadyAt = nil
        if shouldTerminateOwnedServer, let proc = serverProcess, proc.isRunning {
            proc.terminate()
            clearSpawnedServerPid() // clean shutdown — no orphan to reclaim later
            DispatchQueue.global().asyncAfter(deadline: .now() + 3) {
                if proc.isRunning {
                    proc.interrupt()
                }
            }
        }
        serverProcess = nil
    }

    // MARK: - Find Executables

    /// The bun version the checkout pins (package.json packageManager), or nil.
    func checkoutBunPin(_ sourceDir: String) -> String? {
        return BundledRuntime.bunPin(packageJson: FileManager.default.contents(atPath: sourceDir + "/package.json"))
    }

    /// A bun for a checkout's server: at least the version the checkout pins.
    /// Looks on PATH, in bun's own install place and Homebrew's, then asks the
    /// login shell (a version manager may put it elsewhere).
    func findBunOrNil(sourceDir: String) -> String? {
        let pin = checkoutBunPin(sourceDir)
        var candidates = BundledRuntime.bunCandidates(home: NSHomeDirectory(), pathEnv: ProcessInfo.processInfo.environment["PATH"])
        let version: (String) -> String? = { [weak self] path in
            guard let r = self?.runProcess(path, args: ["--version"], cwd: "/tmp"), r.success else { return nil }
            return r.output
        }
        if let found = BundledRuntime.pickBun(candidates: candidates, pin: pin, fileExists: FileManager.default.isExecutableFile(atPath:), version: version) {
            return found
        }
        if let shell = runShellCommand("command -v bun 2>/dev/null"), !candidates.contains(shell) {
            candidates = [shell]
            return BundledRuntime.pickBun(candidates: candidates, pin: pin, fileExists: FileManager.default.isExecutableFile(atPath:), version: version)
        }
        return nil
    }

    func runShellCommand(_ command: String) -> String? {
        let proc = Process()
        let pipe = Pipe()
        proc.executableURL = URL(fileURLWithPath: "/bin/zsh")
        proc.arguments = ["-l", "-c", command]
        proc.standardOutput = pipe
        proc.standardError = FileHandle.nullDevice
        proc.environment = ProcessInfo.processInfo.environment
        do {
            try proc.run()
            proc.waitUntilExit()
        } catch {
            return nil
        }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        guard let output = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines),
              !output.isEmpty,
              output.hasPrefix("/") else {
            return nil
        }
        return output
    }

    /// Like runShellCommand but returns raw output (not restricted to paths).
    /// Used for lsof/ps queries whose output is a PID or process line.
    func runShellRaw(_ command: String) -> String? {
        let proc = Process()
        let pipe = Pipe()
        proc.executableURL = URL(fileURLWithPath: "/bin/zsh")
        proc.arguments = ["-l", "-c", command]
        proc.standardOutput = pipe
        proc.standardError = FileHandle.nullDevice
        proc.environment = ProcessInfo.processInfo.environment
        do {
            try proc.run()
            proc.waitUntilExit()
        } catch {
            return nil
        }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        guard let output = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines),
              !output.isEmpty else {
            return nil
        }
        return output
    }

    // MARK: - Error Display

    func bootstrapLogPath() -> URL {
        let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        let dir = appSupport.appendingPathComponent("Walnut")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("bootstrap.log")
    }

    func appendToBootstrapLog(_ step: String, _ output: String) {
        let entry = "\n===== \(step) =====\n\(output)\n"
        let url = bootstrapLogPath()
        if let handle = try? FileHandle(forWritingTo: url) {
            handle.seekToEndOfFile()
            handle.write(entry.data(using: .utf8)!)
            try? handle.close()
        } else {
            try? entry.data(using: .utf8)?.write(to: url)
        }
    }

    func showError(_ message: String, details: String? = nil) {
        let container = NSView(frame: window.contentView!.bounds)
        container.autoresizingMask = [.width, .height]
        // These screens paint a fixed light cream; in Dark Mode the system's
        // button and label colours would be white on it (Retry was invisible).
        container.appearance = NSAppearance(named: .aqua)
        container.wantsLayer = true
        container.layer?.backgroundColor = NSColor(red: 0.98, green: 0.97, blue: 0.95, alpha: 1).cgColor

        let stack = NSStackView()
        stack.orientation = .vertical
        stack.spacing = 12
        stack.alignment = .centerX
        stack.translatesAutoresizingMaskIntoConstraints = false

        let icon = NSTextField(labelWithString: "⚠️")
        icon.font = NSFont.systemFont(ofSize: 40)
        stack.addArrangedSubview(icon)

        let title = NSTextField(labelWithString: "Failed to Start")
        title.font = NSFont.systemFont(ofSize: 18, weight: .bold)
        title.textColor = NSColor(red: 0.6, green: 0.2, blue: 0.15, alpha: 1)
        stack.addArrangedSubview(title)

        let msgLabel = NSTextField(wrappingLabelWithString: message)
        msgLabel.font = NSFont.systemFont(ofSize: 13)
        msgLabel.textColor = NSColor(white: 0.3, alpha: 1)
        msgLabel.preferredMaxLayoutWidth = 450
        stack.addArrangedSubview(msgLabel)

        // Show the actual child-process output (install.sh, the server) so failures are
        // diagnosable instead of a vague one-liner.
        if let details = details, !details.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            let tail = String(details.suffix(4000))
            let textView = NSTextView()
            textView.string = tail
            textView.isEditable = false
            textView.font = NSFont.monospacedSystemFont(ofSize: 11, weight: .regular)
            textView.backgroundColor = NSColor(white: 0.12, alpha: 1)
            textView.textColor = NSColor(white: 0.9, alpha: 1)
            textView.textContainerInset = NSSize(width: 8, height: 8)

            let scroll = NSScrollView()
            scroll.documentView = textView
            scroll.hasVerticalScroller = true
            scroll.borderType = .bezelBorder
            scroll.translatesAutoresizingMaskIntoConstraints = false
            scroll.widthAnchor.constraint(equalToConstant: 560).isActive = true
            scroll.heightAnchor.constraint(equalToConstant: 220).isActive = true
            textView.autoresizingMask = [.width]
            textView.minSize = NSSize(width: 0, height: 220)
            textView.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
            textView.isVerticallyResizable = true
            textView.textContainer?.widthTracksTextView = true
            stack.addArrangedSubview(scroll)
            textView.scrollToEndOfDocument(nil)

            let logNote = NSTextField(labelWithString: "Full log: \(bootstrapLogPath().path)")
            logNote.font = NSFont.systemFont(ofSize: 11)
            logNote.textColor = NSColor(white: 0.55, alpha: 1)
            logNote.isSelectable = true
            stack.addArrangedSubview(logNote)
        }

        let spacer = NSView()
        spacer.heightAnchor.constraint(equalToConstant: 16).isActive = true
        stack.addArrangedSubview(spacer)

        let buttonRow = NSStackView()
        buttonRow.orientation = .horizontal
        buttonRow.spacing = 12

        let retryBtn = NSButton(title: "Retry", target: self, action: #selector(retryStart))
        retryBtn.bezelStyle = .rounded
        buttonRow.addArrangedSubview(retryBtn)

        let resetBtn = NSButton(title: "Reset Setup...", target: self, action: #selector(resetConfig))
        resetBtn.bezelStyle = .rounded
        buttonRow.addArrangedSubview(resetBtn)

        if details != nil {
            let logBtn = NSButton(title: "Open Full Log", target: self, action: #selector(openBootstrapLog))
            logBtn.bezelStyle = .rounded
            buttonRow.addArrangedSubview(logBtn)
        }
        stack.addArrangedSubview(buttonRow)

        container.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: container.centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: container.centerYAnchor),
            stack.widthAnchor.constraint(lessThanOrEqualToConstant: 620)
        ])

        window.contentView = container
    }

    @objc func openBootstrapLog() {
        NSWorkspace.shared.open(bootstrapLogPath())
    }

    @objc func retryStart() {
        if walnutHome == nil || walnutSourceDir == nil {
            if let again = retrySetup { again() } else { showSetupScreen() }
            return
        }
        stopServer()
        serverRestartPolicy.reset()
        serverPort = nil
        showLoadingScreen()
        startServer()
    }

    @objc func openSettings() {
        guard let webView = webView, let port = serverPort else { return }
        webView.load(URLRequest(url: URL(string: "http://localhost:\(port)/settings")!))
    }

    /// Same toggle the global hotkey drives: first call records, second transcribes
    /// and copies. Exposed in the menu so the feature is discoverable and still
    /// reachable when another app has claimed the key combination.
    /// The checkmark follows what is actually listening, not just the stored
    /// preference, so a missing Input Monitoring grant is visible rather than
    /// looking enabled and silently doing nothing.
    @objc func toggleDoubleTapFn(_ sender: NSMenuItem) {
        let wanted = sender.state != .on
        let active = dictation?.setDoubleTapFn(wanted) ?? false
        sender.state = active ? .on : .off
    }

    @objc func toggleDictation() {
        dictation?.toggle()
    }

    /// Delivery preferences (see GlobalDictation for the semantics: clipboard
    /// silently wins when both are off, so the result is never dropped).
    @objc func toggleInsertIntoApp(_ sender: NSMenuItem) {
        let wanted = sender.state != .on
        GlobalDictation.typeIntoAppEnabled = wanted
        sender.state = wanted ? .on : .off
        // Inserting text synthesizes keyboard events, which needs Accessibility.
        // Ask now, at the moment the user opts in, not mid-dictation.
        if wanted && !AXIsProcessTrusted() {
            let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
            AXIsProcessTrustedWithOptions(opts)
        }
    }

    @objc func toggleCopyClipboard(_ sender: NSMenuItem) {
        let wanted = sender.state != .on
        GlobalDictation.copyToClipboardEnabled = wanted
        sender.state = wanted ? .on : .off
    }

    @objc func togglePolish(_ sender: NSMenuItem) {
        let wanted = sender.state != .on
        GlobalDictation.polishEnabled = wanted
        sender.state = wanted ? .on : .off
    }

    @objc func resetConfig() {
        // Destructive (forgets which installation this app points to) — always
        // confirm. This used to run bare off ⌘, and wiped the config silently.
        let alert = NSAlert()
        alert.messageText = "Reset Setup?"
        alert.informativeText = "Walnut will forget which installation it points to and show the setup screen again. Your data in ~/.open-walnut is not touched."
        alert.addButton(withTitle: "Cancel")
        alert.addButton(withTitle: "Reset Setup")
        alert.alertStyle = .warning
        alert.beginSheetModal(for: window) { [weak self] response in
            guard response == .alertSecondButtonReturn, let self = self else { return }
            self.stopServer()
            self.serverRestartPolicy.reset()
            self.serverPort = nil
            try? FileManager.default.removeItem(at: configFilePath())
            self.walnutHome = nil
            self.walnutSourceDir = nil
            self.runtime = nil
            self.appBuiltCheckout = nil
            self.showSetupScreen()
        }
    }

    // MARK: - Menu

    func setupMainMenu() {
        let mainMenu = NSMenu()

        let appMenuItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(NSMenuItem(title: "About Walnut", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: ""))
        let updateItem = NSMenuItem(title: "Check for Updates…", action: #selector(updateMenuAction), keyEquivalent: "")
        appMenu.addItem(updateItem)
        updateMenuItem = updateItem
        appMenu.addItem(NSMenuItem.separator())
        // ⌘, follows the macOS convention: open Settings (the web UI's settings
        // page). It must NEVER be a destructive action — it used to trigger
        // Reset Setup, so a muscle-memory ⌘, silently wiped the app config.
        appMenu.addItem(NSMenuItem(title: "Settings…", action: #selector(openSettings), keyEquivalent: ","))
        appMenu.addItem(NSMenuItem(title: "Install 'walnut' Command", action: #selector(installCommandLineTool), keyEquivalent: ""))
        appMenu.addItem(NSMenuItem(title: "Reset Setup...", action: #selector(resetConfig), keyEquivalent: ""))
        appMenu.addItem(NSMenuItem.separator())
        // Dictation gets its own submenu: two triggers plus three delivery
        // preferences is too much to inline in the app menu.
        let dictationMenuItem = NSMenuItem(title: "Dictation", action: nil, keyEquivalent: "")
        let dictationMenu = NSMenu(title: "Dictation")
        // Discoverability for the global hotkey, and a way to dictate without it
        // (another app may already own the key combination).
        let dictateItem = NSMenuItem(title: "Start Dictation", action: #selector(toggleDictation), keyEquivalent: "d")
        dictateItem.keyEquivalentModifierMask = [.control, .option, .command]
        dictationMenu.addItem(dictateItem)
        // Off by default: it needs an Input Monitoring grant, and the app should
        // not ask for one nobody requested.
        let fnItem = NSMenuItem(title: "Double-tap Fn to Dictate", action: #selector(toggleDoubleTapFn), keyEquivalent: "")
        fnItem.state = GlobalDictation.doubleTapFnEnabled ? .on : .off
        dictationMenu.addItem(fnItem)
        dictationMenu.addItem(NSMenuItem.separator())
        let insertItem = NSMenuItem(title: "Insert into Active App", action: #selector(toggleInsertIntoApp), keyEquivalent: "")
        insertItem.state = GlobalDictation.typeIntoAppEnabled ? .on : .off
        dictationMenu.addItem(insertItem)
        let clipboardItem = NSMenuItem(title: "Copy to Clipboard", action: #selector(toggleCopyClipboard), keyEquivalent: "")
        clipboardItem.state = GlobalDictation.copyToClipboardEnabled ? .on : .off
        dictationMenu.addItem(clipboardItem)
        let polishItem = NSMenuItem(title: "Polish Transcript (Local AI)", action: #selector(togglePolish), keyEquivalent: "")
        polishItem.state = GlobalDictation.polishEnabled ? .on : .off
        dictationMenu.addItem(polishItem)
        dictationMenuItem.submenu = dictationMenu
        appMenu.addItem(dictationMenuItem)
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(NSMenuItem(title: "Quit Walnut", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        appMenuItem.submenu = appMenu
        mainMenu.addItem(appMenuItem)

        let fileMenuItem = NSMenuItem()
        let fileMenu = NSMenu(title: "File")
        fileMenu.addItem(NSMenuItem(title: "Close Window", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w"))
        fileMenuItem.submenu = fileMenu
        mainMenu.addItem(fileMenuItem)

        let editMenuItem = NSMenuItem()
        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(NSMenuItem(title: "Undo", action: Selector(("undo:")), keyEquivalent: "z"))
        editMenu.addItem(NSMenuItem(title: "Redo", action: Selector(("redo:")), keyEquivalent: "Z"))
        editMenu.addItem(NSMenuItem.separator())
        editMenu.addItem(NSMenuItem(title: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x"))
        editMenu.addItem(NSMenuItem(title: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c"))
        editMenu.addItem(NSMenuItem(title: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v"))
        editMenu.addItem(NSMenuItem(title: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a"))
        editMenuItem.submenu = editMenu
        mainMenu.addItem(editMenuItem)

        let viewMenuItem = NSMenuItem()
        let viewMenu = NSMenu(title: "View")
        viewMenu.addItem(NSMenuItem(title: "Reload", action: #selector(reloadPage), keyEquivalent: "r"))
        // ⇧⌘R: Reload keeps the page process; this replaces it (fresh memory).
        let recycleItem = NSMenuItem(title: "Restart Page Process", action: #selector(recycleWebContentManually), keyEquivalent: "R")
        recycleItem.keyEquivalentModifierMask = [.command, .shift]
        viewMenu.addItem(recycleItem)
        let glassItem = NSMenuItem(title: "Reduce Transparency", action: #selector(toggleReduceGlass), keyEquivalent: "")
        glassItem.state = WebContentPolicy.reduceGlass(UserDefaults.standard) ? .on : .off
        viewMenu.addItem(glassItem)
        viewMenu.addItem(NSMenuItem(title: "Open in Browser", action: #selector(openInBrowser), keyEquivalent: "b"))
        viewMenu.addItem(NSMenuItem.separator())
        // Browser-style page zoom. "+" is the unshifted "=" key, so bind "="
        // (with Cmd) — macOS renders it as ⌘+ and both keys work.
        viewMenu.addItem(NSMenuItem(title: "Zoom In", action: #selector(zoomIn), keyEquivalent: "="))
        viewMenu.addItem(NSMenuItem(title: "Zoom Out", action: #selector(zoomOut), keyEquivalent: "-"))
        viewMenu.addItem(NSMenuItem(title: "Actual Size", action: #selector(zoomReset), keyEquivalent: "0"))
        viewMenuItem.submenu = viewMenu
        mainMenu.addItem(viewMenuItem)

        let windowMenuItem = NSMenuItem()
        let windowMenu = NSMenu(title: "Window")
        windowMenu.addItem(NSMenuItem(title: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m"))
        windowMenu.addItem(NSMenuItem(title: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: ""))
        windowMenuItem.submenu = windowMenu
        mainMenu.addItem(windowMenuItem)

        NSApp.mainMenu = mainMenu
    }

    @objc func reloadPage() {
        activeWebView?.reload()
    }

    // MARK: - Page zoom (⌘+ / ⌘- / ⌘0), persisted across launches

    static let zoomDefaultsKey = "walnutPageZoom"
    static let zoomLevels: [Double] = [0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0]

    func applyZoom(_ zoom: Double) {
        activeWebView?.pageZoom = zoom
        UserDefaults.standard.set(zoom, forKey: Self.zoomDefaultsKey)
    }

    func stepZoom(by step: Int) {
        guard let webView = activeWebView else { return }
        let current = webView.pageZoom
        // Nearest level, then step — keeps repeated ⌘+/⌘- on the ladder even
        // if the stored value drifts.
        let idx = Self.zoomLevels.enumerated().min(by: { abs($0.1 - current) < abs($1.1 - current) })!.0
        let next = min(max(idx + step, 0), Self.zoomLevels.count - 1)
        applyZoom(Self.zoomLevels[next])
    }

    @objc func zoomIn() { stepZoom(by: 1) }
    @objc func zoomOut() { stepZoom(by: -1) }
    @objc func zoomReset() { applyZoom(1.0) }

    @objc func openInBrowser() {
        guard let port = serverPort else { return }
        NSWorkspace.shared.open(URL(string: "http://localhost:\(port)")!)
    }
}

// MARK: - CSS colours

extension NSColor {
    /// Parses the handful of forms the web app's `--bg` can take: `#rgb`, `#rrggbb`,
    /// `#rrggbbaa`, `rgb()`, `rgba()`. Returns nil on anything else so the caller
    /// keeps its current colour rather than flashing black.
    convenience init?(cssHex: String) {
        let s = cssHex.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if s.hasPrefix("rgb") {
            let nums = s.drop(while: { $0 != "(" }).dropFirst().prefix(while: { $0 != ")" })
                .split(whereSeparator: { ",/ ".contains($0) })
                .compactMap { Double($0) }
            guard nums.count >= 3 else { return nil }
            self.init(srgbRed: nums[0] / 255, green: nums[1] / 255, blue: nums[2] / 255,
                      alpha: nums.count > 3 ? nums[3] : 1)
            return
        }
        var hex = s.hasPrefix("#") ? String(s.dropFirst()) : s
        if hex.count == 3 { hex = hex.map { "\($0)\($0)" }.joined() }
        guard hex.count == 6 || hex.count == 8, let v = UInt32(hex, radix: 16) else { return nil }
        let shift = hex.count == 8 ? 8 : 0
        self.init(srgbRed: CGFloat((v >> (16 + shift)) & 0xFF) / 255,
                  green: CGFloat((v >> (8 + shift)) & 0xFF) / 255,
                  blue: CGFloat((v >> shift) & 0xFF) / 255,
                  alpha: hex.count == 8 ? CGFloat(v & 0xFF) / 255 : 1)
    }
}

// MARK: - Web ↔ native bridges

extension AppDelegate: WKScriptMessageHandler {
    // window.webkit.messageHandlers.walnutClipboard.postMessage("text")
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        switch message.name {
        case "walnutClipboard":
            guard let text = message.body as? String else { return }
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(text, forType: .string)
        case "walnutChrome":
            guard let bg = message.body as? String else { return }
            setChromeBackground(css: bg, in: message.webView?.window)
        default:
            return
        }
    }
}

extension AppDelegate: WKUIDelegate {
    // Voice input: our own localhost UI is the only origin — grant the mic
    // without the per-site prompt (macOS still shows its one-time system prompt).
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(linkPolicy.isLoopback(origin.host) && origin.port == (serverPort ?? 3456) && type == .microphone ? .grant : .deny)
    }
}

// MARK: - WKNavigationDelegate

extension AppDelegate: WKNavigationDelegate {
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if serverProcess?.isRunning == false {
            showError("The Walnut server has stopped unexpectedly.")
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if webView !== self.webView {
            popoutWatchdogs[ObjectIdentifier(webView)]?.pageDidFinishLoading()
            return
        }
        webContentWatchdog?.pageDidFinishLoading()
        if let state = appUpdater?.state { pushAppUpdateState(state) }
        consolePageLoaded = true
        deliverAppLinks()
        if !commandLineToolChecked {
            commandLineToolChecked = true
            checkCommandLineTool(showResult: false)
        }
    }

    /// Without this a killed page process leaves a blank white window that only
    /// ⌘R fixes; with it the watchdog logs the death (footprint, age, how many
    /// in the last ten minutes) and reloads with backoff.
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        if webView === self.webView, let watchdog = webContentWatchdog {
            watchdog.pageProcessDidTerminate()
        } else if let watchdog = popoutWatchdogs[ObjectIdentifier(webView)] {
            watchdog.pageProcessDidTerminate()
        } else {
            DesktopLogger.shared.log("webcontent_terminated")
            webView.reload()
        }
    }

    /// Where a navigation goes is decided by LinkPolicy (pure, tested); this only
    /// translates WebKit's action into that policy's terms and carries out the
    /// verdict. `targetFrame == nil` is how a `target="_blank"` click arrives.
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.allow)
            return
        }
        let request = LinkRequest(
            url: url,
            isLinkClick: navigationAction.navigationType == .linkActivated,
            targetsNewWindow: navigationAction.targetFrame == nil,
            isMainFrame: navigationAction.targetFrame?.isMainFrame ?? true)
        switch linkPolicy.verdict(for: request) {
        case .inPage, .openInAppWindow:
            decisionHandler(.allow)
        case .openExternally:
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
        case .ignore:
            decisionHandler(.cancel)
        }
    }

    private var linkPolicy: LinkPolicy {
        LinkPolicy(appPort: serverPort ?? 3456)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        guard let url = navigationAction.request.url else { return nil }
        let request = LinkRequest(url: url, isLinkClick: false, targetsNewWindow: true, isMainFrame: true)
        switch linkPolicy.verdict(for: request) {
        case .openInAppWindow:
            if let target = popoutWindows.first(where: { key, target in
                let child = target.contentView as? WKWebView
                guard let current = child?.url ?? popoutURLs[key] else { return false }
                return linkPolicy.isSameWindowTarget(current, url)
            })?.value {
                presentPopout(target)
                return nil
            }
            // A separately loaded view is not tied to the opener's page process.
            let childConfig = WKWebViewConfiguration()
            childConfig.websiteDataStore = configuration.websiteDataStore
            childConfig.preferences = configuration.preferences
            let controller = childConfig.userContentController
            for script in configuration.userContentController.userScripts { controller.addUserScript(script) }
            controller.add(self, name: "walnutClipboard")
            controller.add(self, name: "walnutChrome")
            controller.addScriptMessageHandler(self, contentWorld: .page, name: "walnutUpdate")
            let child = WKWebView(frame: NSRect(x: 0, y: 0, width: 1000, height: 760), configuration: childConfig)
            child.navigationDelegate = self
            child.uiDelegate = self
            child.autoresizingMask = [.width, .height]
            child.pageZoom = webView.pageZoom
            let target = NSWindow(contentRect: child.frame,
                styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
            target.isReleasedWhenClosed = false
            target.delegate = self
            target.title = "Walnut"
            applyWindowChrome(to: target)
            target.contentView = child
            let key = ObjectIdentifier(child)
            popoutWindows[key] = target
            popoutURLs[key] = url
            let watchdog = WebContentWatchdog(
                policyProvider: { WebContentPolicy.fromDefaults(UserDefaults.standard) },
                portProvider: { [weak self] in self?.serverPort },
                recycle: { [weak self, weak target] _, _ in
                    guard let child = target?.contentView as? WKWebView else { return }
                    self?.recyclePopout(child)
                })
            popoutWatchdogs[key] = watchdog
            watchdog.attach(webView: child, window: target)
            popoutTitles[key] = child.observe(\.title, options: [.new]) { [weak target] view, _ in
                target?.title = view.title ?? "Walnut"
            }
            target.center()
            if let source = webView.window { target.cascadeTopLeft(from: NSPoint(x: source.frame.minX, y: source.frame.maxY)) }
            presentPopout(target)
            child.load(navigationAction.request)
            return nil
        case .openExternally:
            NSWorkspace.shared.open(url)
        case .inPage, .ignore:
            break
        }
        return nil
    }

    func presentPopout(_ target: NSWindow) {
        #if WALNUT_DESKTOP_TEST
        target.orderOut(nil)
        return
        #else
        if NSApp.isActive { target.makeKeyAndOrderFront(nil) }
        else { target.orderBack(nil) }
        #endif
    }

    func recyclePopout(_ old: WKWebView) {
        let key = ObjectIdentifier(old)
        guard let target = popoutWindows[key], let url = old.url ?? popoutURLs[key] else { return }
        if target.attachedSheet != nil || pendingWindowCloses.contains(key) {
            popoutWatchdogs[key]?.attach(webView: old, window: target)
            return
        }
        let child = WKWebView(frame: old.frame, configuration: old.configuration)
        child.navigationDelegate = self
        child.uiDelegate = self
        child.autoresizingMask = [.width, .height]
        child.pageZoom = old.pageZoom
        let next = ObjectIdentifier(child)
        popoutWindows[next] = target
        popoutURLs[next] = popoutURLs.removeValue(forKey: key)
        let watchdog = popoutWatchdogs.removeValue(forKey: key)
        popoutWatchdogs[next] = watchdog
        popoutTitles.removeValue(forKey: key)
        popoutTitles[next] = child.observe(\.title, options: [.new]) { [weak target] view, _ in
            target?.title = view.title ?? "Walnut"
        }
        old.stopLoading()
        old.navigationDelegate = nil
        old.uiDelegate = nil
        popoutWindows.removeValue(forKey: key)
        target.contentView = child
        watchdog?.attach(webView: child, window: target)
        child.load(URLRequest(url: url))
    }

    func webViewDidClose(_ webView: WKWebView) {
        popoutWindows[ObjectIdentifier(webView)]?.performClose(nil)
    }
}

extension AppDelegate: NSWindowDelegate {
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        guard sender.attachedSheet == nil else { return false }
        guard let child = sender.contentView as? WKWebView else { return true }
        let key = ObjectIdentifier(child)
        if approvedWindowCloses.remove(key) != nil { return true }
        guard !pendingWindowCloses.contains(key), let watchdog = popoutWatchdogs[key] else { return false }
        pendingWindowCloses.insert(key)
        watchdog.checkUnsavedWork { [weak self, weak sender, weak child] unsaved in
            guard let self, let sender, let child,
                  self.popoutWindows[key] === sender, sender.contentView === child else { return }
            self.pendingWindowCloses.remove(key)
            if !unsaved {
                self.approvedWindowCloses.insert(key)
                sender.performClose(nil)
                return
            }
            let alert = NSAlert()
            alert.messageText = "Close this window and discard unsaved work?"
            alert.addButton(withTitle: "Keep Open")
            alert.addButton(withTitle: "Discard and Close")
            alert.beginSheetModal(for: sender) { [weak self, weak sender, weak child] response in
                guard response == .alertSecondButtonReturn else { return }
                // AppKit detaches the sheet only after this completion returns.
                DispatchQueue.main.async {
                    guard let self, let sender, let child,
                          self.popoutWindows[key] === sender, sender.contentView === child else { return }
                    self.approvedWindowCloses.insert(key)
                    sender.performClose(nil)
                }
            }
        }
        return false
    }

    func windowWillClose(_ notification: Notification) {
        guard let target = notification.object as? NSWindow,
              let child = target.contentView as? WKWebView else { return }
        let key = ObjectIdentifier(child)
        popoutTitles.removeValue(forKey: key)
        popoutURLs.removeValue(forKey: key)
        popoutWatchdogs.removeValue(forKey: key)
        pendingWindowCloses.remove(key)
        approvedWindowCloses.remove(key)
        popoutWindows.removeValue(forKey: key)
        child.stopLoading()
        child.navigationDelegate = nil
        child.uiDelegate = nil
        child.configuration.userContentController.removeAllScriptMessageHandlers()
    }
}

// MARK: - Entry Point

// `Walnut --session-host -- <program> …` supervises that program instead of
// starting the app, so macOS attributes the session daemon (and every CLI and
// tool under it) to Walnut rather than to whichever `node` started the server.
// FIRST, before NSApplication exists: a supervised launch must never become a
// visible app instance. Returns immediately on a normal launch. See
// desktop/SessionHost.swift.
runSessionHostIfRequested()
// `Walnut --calendar-bridge <subcommand> …` answers one calendar request, for the
// same reason and under the same rule: see desktop/CalendarBridge.swift.
runCalendarBridgeIfRequested()
// `Walnut --reader-bridge read|probe <path>` reads one Full Disk Access file, so
// that grant is Walnut's too: see desktop/ReaderBridge.swift.
runReaderBridgeIfRequested()
runDesktopUpdateBridgeIfRequested()

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()

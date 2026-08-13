import Cocoa
import WebKit

// MARK: - Configuration

struct WalnutConfig: Codable {
    var walnutHome: String
    var walnutSourceDir: String
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

let REPO_URL = "https://github.com/EvanZhang008/open-walnut.git"

// Printed by the server when it recompiles a native addon for the running Node.
// Keep in sync with REBUILD_MARKER in src/core/native-abi-preflight.ts.
let REBUILD_MARKER = "rebuilding native module"

// MARK: - App Delegate

class AppDelegate: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    var serverProcess: Process?
    var serverPort: Int?
    // Last captured stdout/stderr from a server child that died before confirming
    // its port — surfaced in error messages so a startup crash isn't misreported
    // as "ports are all in use".
    var lastServerOutput: String = ""
    var walnutHome: String?
    var walnutSourceDir: String?
    var statusLabel: NSTextField?
    var retryTimer: Timer?
    var bootstrapProcess: Process?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)

        setupMainMenu()

        let windowRect = NSRect(x: 0, y: 0, width: 1200, height: 800)
        window = NSWindow(
            contentRect: windowRect,
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Walnut"
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        if let config = loadConfig(),
           FileManager.default.fileExists(atPath: config.walnutHome),
           FileManager.default.fileExists(atPath: config.walnutSourceDir + "/dist/cli.js") {
            walnutHome = config.walnutHome
            walnutSourceDir = config.walnutSourceDir
            showLoadingScreen()
            startServer()
        } else {
            showSetupScreen()
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return true
    }

    func applicationWillTerminate(_ notification: Notification) {
        bootstrapProcess?.terminate()
        stopServer()
    }

    // MARK: - Setup Screen

    func showSetupScreen() {
        let container = NSView(frame: window.contentView!.bounds)
        container.autoresizingMask = [.width, .height]
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

        let subtitle = NSTextField(labelWithString: "Personal AI Butler")
        subtitle.font = NSFont.systemFont(ofSize: 14)
        subtitle.textColor = NSColor(white: 0.4, alpha: 1)
        stack.addArrangedSubview(subtitle)

        let spacer1 = NSView()
        spacer1.heightAnchor.constraint(equalToConstant: 20).isActive = true
        stack.addArrangedSubview(spacer1)

        // Option 1: Get Started (auto-bootstrap)
        let freshBtn = makeButton(
            title: "Get Started",
            subtitle: "Download and set up Walnut automatically (~2 min)",
            action: #selector(startFreshSetup)
        )
        stack.addArrangedSubview(freshBtn)

        // Option 2: Use existing
        let existingBtn = makeButton(
            title: "Use Existing Installation",
            subtitle: "Point to an existing .open-walnut directory",
            action: #selector(chooseExistingFolder)
        )
        stack.addArrangedSubview(existingBtn)

        let spacer2 = NSView()
        spacer2.heightAnchor.constraint(equalToConstant: 20).isActive = true
        stack.addArrangedSubview(spacer2)

        let reqNote = NSTextField(wrappingLabelWithString: "Requires: Node.js 20+ and Git installed on your Mac.")
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

    @objc func startFreshSetup() {
        let defaultHome = NSHomeDirectory() + "/.open-walnut"
        let sourceDir = defaultHome + "/source"

        // Check if .open-walnut already exists
        if FileManager.default.fileExists(atPath: defaultHome) {
            let alert = NSAlert()
            alert.messageText = "Folder Already Exists"
            alert.informativeText = "~/.open-walnut already exists. What would you like to do?"
            alert.addButton(withTitle: "Use Existing")
            alert.addButton(withTitle: "Delete and Start Fresh")
            alert.addButton(withTitle: "Cancel")
            alert.alertStyle = .warning

            alert.beginSheetModal(for: window) { [weak self] response in
                switch response {
                case .alertFirstButtonReturn:
                    if FileManager.default.fileExists(atPath: sourceDir + "/dist/cli.js") {
                        self?.walnutHome = defaultHome
                        self?.walnutSourceDir = sourceDir
                        self?.finishSetup()
                    } else {
                        self?.runBootstrap(walnutHome: defaultHome)
                    }
                case .alertSecondButtonReturn:
                    try? FileManager.default.removeItem(atPath: defaultHome)
                    self?.runBootstrap(walnutHome: defaultHome)
                default:
                    break
                }
            }
            return
        }

        runBootstrap(walnutHome: defaultHome)
    }

    func runBootstrap(walnutHome home: String) {
        // Verify prerequisites
        guard let nodePath = findNodeOrNil() else {
            showError("Node.js 20+ not found.\n\nInstall Node.js from https://nodejs.org or via Homebrew:\n  brew install node")
            return
        }

        // open-walnut needs Node 20+ (deps use the /v regex flag and engines: >=20).
        // Don't proceed with an older node — npm install fails deep in a postinstall
        // script with a confusing SyntaxError.
        guard nodeVersionMeetsMinimum(nodePath, major: 20) else {
            showError("Node.js 20+ is required, but the newest Node found is older:\n\(nodePath)\n\nInstall a newer Node, e.g.:\n  mise install node@22   (or brew install node)")
            return
        }

        guard let gitPath = findGitOrNil() else {
            showError("Git not found.\n\nInstall Git via Xcode Command Line Tools:\n  xcode-select --install")
            return
        }

        let sourceDir = home + "/source"

        // Show progress screen
        showBootstrapScreen()

        // Run the bootstrap in background
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            self?.doBootstrap(home: home, sourceDir: sourceDir, nodePath: nodePath, gitPath: gitPath)
        }
    }

    func showBootstrapScreen() {
        let container = NSView(frame: window.contentView!.bounds)
        container.autoresizingMask = [.width, .height]
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

        let label = NSTextField(labelWithString: "Setting up Walnut...")
        label.font = NSFont.systemFont(ofSize: 14)
        label.textColor = NSColor(white: 0.35, alpha: 1)
        stack.addArrangedSubview(label)
        self.statusLabel = label

        let detailLabel = NSTextField(wrappingLabelWithString: "This may take a couple of minutes on the first run.")
        detailLabel.font = NSFont.systemFont(ofSize: 12)
        detailLabel.textColor = NSColor(white: 0.55, alpha: 1)
        detailLabel.preferredMaxLayoutWidth = 400
        stack.addArrangedSubview(detailLabel)

        container.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: container.centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: container.centerYAnchor)
        ])

        window.contentView = container
    }

    func doBootstrap(home: String, sourceDir: String, nodePath: String, gitPath: String) {
        // Start a fresh log for this bootstrap run
        try? FileManager.default.removeItem(at: bootstrapLogPath())
        appendToBootstrapLog("bootstrap start", "node: \(nodePath)\ngit: \(gitPath)\nhome: \(home)")

        // Step 1: Create home directory
        try? FileManager.default.createDirectory(atPath: home, withIntermediateDirectories: true)

        // Step 2: Clone the repo (or pull if already exists)
        if FileManager.default.fileExists(atPath: sourceDir + "/.git") {
            updateStatus("Updating source code...")
            let pullResult = runProcess(gitPath, args: ["-C", sourceDir, "pull", "--ff-only"], cwd: sourceDir)
            appendToBootstrapLog("git pull", pullResult.output)
            if !pullResult.success {
                // Pull failed — not fatal, continue with existing code
            }
        } else {
            // Remove any partial/non-git source dir
            if FileManager.default.fileExists(atPath: sourceDir) {
                try? FileManager.default.removeItem(atPath: sourceDir)
            }
            updateStatus("Cloning open-walnut repository...")
            let cloneResult = runProcess(gitPath, args: ["clone", "--depth", "1", REPO_URL, sourceDir], cwd: home)
            appendToBootstrapLog("git clone", cloneResult.output)
            if !cloneResult.success {
                DispatchQueue.main.async { [weak self] in
                    self?.showError("Failed to clone repository. Make sure you have internet access and git is configured.", details: cloneResult.output)
                }
                return
            }
        }

        // Step 3: npm install
        updateStatus("Installing dependencies (npm install)...")
        guard let npmCliJs = findNpmCliJs(near: nodePath) else {
            DispatchQueue.main.async { [weak self] in
                self?.showError("Could not find npm-cli.js.\n\nnpm may not be installed correctly alongside node at:\n\(nodePath)\n\nTry reinstalling Node.js.")
            }
            return
        }
        // Ensure child processes (postinstall scripts) find the same node version
        let nodeDir = (nodePath as NSString).deletingLastPathComponent
        let installResult = runProcess(nodePath, args: [npmCliJs, "install", "--production=false"], cwd: sourceDir, prependToPath: nodeDir)
        appendToBootstrapLog("npm install (node: \(nodePath))", installResult.output)
        if !installResult.success {
            DispatchQueue.main.async { [weak self] in
                self?.showError("npm install failed (using node at \(nodePath)).", details: installResult.output)
            }
            return
        }

        // Step 4: Build (tsup + copy data/manifests)
        // The full `npm run build` requires bun for cross-compiling daemon binaries.
        // The desktop app only needs the CLI/web server, so run tsup directly.
        updateStatus("Building Walnut...")
        let tsupBin = sourceDir + "/node_modules/.bin/tsup"
        let buildResult: (success: Bool, output: String)
        if FileManager.default.fileExists(atPath: tsupBin) {
            buildResult = runProcess(nodePath, args: [tsupBin], cwd: sourceDir, prependToPath: nodeDir)
        } else {
            // Fallback: try npm run build (requires bun)
            buildResult = runProcess(nodePath, args: [npmCliJs, "run", "build"], cwd: sourceDir, prependToPath: nodeDir)
        }
        appendToBootstrapLog("build (tsup)", buildResult.output)
        if !buildResult.success {
            DispatchQueue.main.async { [weak self] in
                self?.showError("Build failed.", details: buildResult.output)
            }
            return
        }
        // Copy data directory and integration manifests (mirrors the npm build script)
        let dataResult = runProcess("/bin/cp", args: ["-r", sourceDir + "/src/data", sourceDir + "/dist/"], cwd: sourceDir)
        if !dataResult.success {
            // Non-fatal: some data files may be missing
        }
        // Copy integration manifests
        let integrationsDir = sourceDir + "/src/integrations"
        if let integrations = try? FileManager.default.contentsOfDirectory(atPath: integrationsDir) {
            for integration in integrations {
                let manifest = integrationsDir + "/\(integration)/manifest.json"
                let destDir = sourceDir + "/dist/integrations/\(integration)"
                if FileManager.default.fileExists(atPath: manifest) {
                    try? FileManager.default.createDirectory(atPath: destDir, withIntermediateDirectories: true)
                    try? FileManager.default.copyItem(atPath: manifest, toPath: destDir + "/manifest.json")
                }
            }
        }

        // Remove daemon source marker so the runtime daemon-version-check skips the
        // bun-based rebuild (the desktop app doesn't use remote daemon sessions).
        let daemonMarker = sourceDir + "/src/providers/daemon-standalone.ts"
        try? FileManager.default.removeItem(atPath: daemonMarker)

        // Step 5: Build the web frontend
        updateStatus("Building web interface...")
        let webDir = sourceDir + "/web"
        if FileManager.default.fileExists(atPath: webDir + "/package.json") {
            // Run vite build directly — the upstream npm build script runs tsc first
            // which may fail on type errors that don't affect the runtime bundle.
            let viteBin = webDir + "/node_modules/.bin/vite"
            if FileManager.default.fileExists(atPath: viteBin) {
                let webBuildResult = runProcess(nodePath, args: [viteBin, "build"], cwd: webDir, prependToPath: nodeDir)
                appendToBootstrapLog("web build (vite)", webBuildResult.output)
                if !webBuildResult.success {
                    // Non-fatal — server might still work without web assets
                }
            } else {
                let webBuildResult = runProcess(nodePath, args: [npmCliJs, "run", "build"], cwd: webDir, prependToPath: nodeDir)
                appendToBootstrapLog("web build (npm run build)", webBuildResult.output)
                if !webBuildResult.success {
                    // Non-fatal
                }
            }
        }

        // Done — save config and start
        DispatchQueue.main.async { [weak self] in
            self?.walnutHome = home
            self?.walnutSourceDir = sourceDir
            self?.finishSetup()
        }
    }

    func updateStatus(_ message: String) {
        DispatchQueue.main.async { [weak self] in
            self?.statusLabel?.stringValue = message
        }
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

        // Drain the pipe BEFORE waitUntilExit: a chatty child (npm) fills the 64KB
        // pipe buffer and blocks forever if nobody reads until after it exits.
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        proc.waitUntilExit()
        let output = String(data: data, encoding: .utf8) ?? ""
        return (proc.terminationStatus == 0, output)
    }

    func findNpmCliJs(near nodePath: String) -> String? {
        // The npm binary in mise/nvm/fnm installs is a bash wrapper script, NOT a JS file.
        // We need the actual npm-cli.js that node can execute directly.
        // Pattern: <prefix>/lib/node_modules/npm/bin/npm-cli.js
        let nodeDir = (nodePath as NSString).deletingLastPathComponent
        let prefix = (nodeDir as NSString).deletingLastPathComponent
        let npmCliJs = prefix + "/lib/node_modules/npm/bin/npm-cli.js"
        if FileManager.default.fileExists(atPath: npmCliJs) {
            return npmCliJs
        }

        // Some installs (Homebrew linked, system) put npm-cli.js at a different prefix
        // Try resolving symlinks on the npm binary to find the real location
        let npmBin = nodeDir + "/npm"
        if FileManager.default.fileExists(atPath: npmBin) {
            // Check if it's a symlink pointing to npm-cli.js
            if let dest = try? FileManager.default.destinationOfSymbolicLink(atPath: npmBin) {
                let resolved = dest.hasPrefix("/") ? dest : nodeDir + "/" + dest
                if resolved.hasSuffix("npm-cli.js"), FileManager.default.fileExists(atPath: resolved) {
                    return resolved
                }
            }
            // Check if it's already a JS file (starts with #!/usr/bin/env node)
            if let data = FileManager.default.contents(atPath: npmBin),
               let firstLine = String(data: data.prefix(64), encoding: .utf8),
               firstLine.contains("node") && !firstLine.contains("bash") {
                return npmBin
            }
        }

        return nil
    }

    // MARK: - Use Existing Folder

    @objc func chooseExistingFolder() {
        let defaultPath = NSHomeDirectory() + "/.open-walnut"

        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.message = "Select your .open-walnut directory"
        panel.prompt = "Use This Folder"

        if FileManager.default.fileExists(atPath: defaultPath) {
            panel.directoryURL = URL(fileURLWithPath: defaultPath)
        }

        panel.beginSheetModal(for: window) { [weak self] response in
            guard response == .OK, let url = panel.url else { return }
            let home = url.path
            let sourceDir = home + "/source"

            // Check if source/dist/cli.js exists
            if FileManager.default.fileExists(atPath: sourceDir + "/dist/cli.js") {
                self?.walnutHome = home
                self?.walnutSourceDir = sourceDir
                self?.finishSetup()
            } else {
                // Maybe they have source elsewhere in the folder or it needs bootstrap
                let alert = NSAlert()
                alert.messageText = "Source Not Found"
                alert.informativeText = "This folder doesn't have a built copy of open-walnut yet. Would you like to download and set it up now?"
                alert.addButton(withTitle: "Set Up Now")
                alert.addButton(withTitle: "Cancel")

                alert.beginSheetModal(for: self!.window) { alertResponse in
                    if alertResponse == .alertFirstButtonReturn {
                        self?.runBootstrap(walnutHome: home)
                    }
                }
            }
        }
    }

    // MARK: - Finish Setup

    func finishSetup() {
        guard let home = walnutHome, let source = walnutSourceDir else { return }
        saveConfig(WalnutConfig(walnutHome: home, walnutSourceDir: source))
        showLoadingScreen()
        startServer()
    }

    // MARK: - Loading Screen

    func showLoadingScreen() {
        let container = NSView(frame: window.contentView!.bounds)
        container.autoresizingMask = [.width, .height]
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

    let portsToTry = [3456, 4567]
    var ownsServer = false

    func startServer() {
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
                        self.statusLabel?.stringValue = "Reclaiming orphaned server on port \(port)..."
                        kill(orphanPid, SIGTERM)
                        // Give it a moment to release the port, then start our own.
                        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
                            self.tryStartServerOnPort(index: index)
                        }
                    } else {
                        self.ownsServer = false
                        self.serverPort = port
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
    /// "Orphaned" = a `cli.js web` process whose parent is PID 1 (its launching
    /// app died without cleanly terminating it). We only reclaim orphans so we
    /// never kill a legitimately-owned server (another app instance or a
    /// shell-launched dev server, whose parent is still alive).
    func orphanedWalnutServerPid(onPort port: Int) -> pid_t? {
        // 1. Find the PID listening on the TCP port.
        guard let lsof = runShellRaw("lsof -nP -iTCP:\(port) -sTCP:LISTEN -t 2>/dev/null | head -1"),
              let pid = Int32(lsof.trimmingCharacters(in: .whitespacesAndNewlines)) else {
            return nil
        }
        // 2. Confirm it's a Walnut server (cli.js web) and read its parent PID.
        guard let psOut = runShellRaw("ps -o ppid=,command= -p \(pid) 2>/dev/null") else {
            return nil
        }
        let trimmed = psOut.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.contains("cli.js") && trimmed.contains("web") else { return nil }
        let ppid = trimmed.split(separator: " ", maxSplits: 1).first.flatMap { Int32($0) }
        return ppid == 1 ? pid : nil
    }

    func tryStartServerOnPort(index: Int) {
        guard let home = walnutHome, let source = walnutSourceDir else { return }
        guard index < portsToTry.count else {
            let tail = lastServerOutput.isEmpty ? "" : "\n\nLast server output:\n\(lastServerOutput)"
            showError("Could not start the Walnut server on ports \(portsToTry.map(String.init).joined(separator: ", ")).\(tail)")
            return
        }

        let port = portsToTry[index]
        statusLabel?.stringValue = "Starting server on port \(port)..."

        let process = Process()
        let nodePath = findNode()
        let nodeDir = (nodePath as NSString).deletingLastPathComponent
        process.executableURL = URL(fileURLWithPath: nodePath)
        process.arguments = [source + "/dist/cli.js", "web", "--port", String(port)]
        process.currentDirectoryURL = URL(fileURLWithPath: source)
        var env = ProcessInfo.processInfo.environment
        env["OPEN_WALNUT_HOME"] = home
        env["NODE_NO_WARNINGS"] = "1"
        // Parent-death watchdog: tell the server to self-terminate if we (its
        // parent) die without a clean shutdown (force-quit, crash, logout). Without
        // this the server orphans onto PID 1 and holds the port forever. See the
        // OPEN_WALNUT_EXIT_ON_ORPHAN handling in open-walnut's src/commands/web.ts.
        env["OPEN_WALNUT_EXIT_ON_ORPHAN"] = "1"
        let extraPaths = [
            "/opt/homebrew/bin",
            "/usr/local/bin",
            NSHomeDirectory() + "/.nvm/current/bin",
            NSHomeDirectory() + "/.fnm/current/bin"
        ]
        let currentPath = env["PATH"] ?? "/usr/bin:/bin"
        env["PATH"] = ([nodeDir] + extraPaths + [currentPath]).joined(separator: ":")
        process.environment = env

        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe

        serverProcess = process

        let handle = pipe.fileHandleForReading
        var outputBuffer = ""
        var portConfirmed = false
        // Guards the two failure paths (child death vs 15s timeout) so exactly one
        // acts. Mutated only on the main queue, so no locking is needed.
        var settled = false
        // Set when the server reports it is recompiling a native addon; the startup
        // deadline is then re-armed instead of firing (a from-source build easily
        // exceeds 15s, and killing it mid-compile corrupts the module).
        var rebuildingNativeModule = false

        handle.readabilityHandler = { [weak self] fileHandle in
            let data = fileHandle.availableData
            guard !data.isEmpty, let str = String(data: data, encoding: .utf8) else { return }
            outputBuffer += str

            // The server may recompile a native addon whose ABI doesn't match this
            // Node (see src/core/native-abi-preflight.ts). That takes far longer
            // than a normal boot, so stop counting against the startup deadline —
            // otherwise we'd kill the rebuild partway and leave it broken.
            if outputBuffer.contains(REBUILD_MARKER) {
                DispatchQueue.main.async {
                    self?.statusLabel?.stringValue = "Rebuilding native module (first run after a Node change)…"
                    rebuildingNativeModule = true
                }
            }

            if outputBuffer.contains("listening on http://localhost:\(port)") && !portConfirmed {
                portConfirmed = true
                DispatchQueue.main.async {
                    self?.ownsServer = true
                    self?.serverPort = port
                    self?.pollForServer()
                }
            }
        }

        do {
            try process.run()
        } catch {
            DispatchQueue.main.async { [weak self] in
                self?.showError("Failed to start server: \(error.localizedDescription)")
            }
            return
        }

        process.terminationHandler = { [weak self] proc in
            DispatchQueue.main.async {
                guard let self = self, !portConfirmed, !settled else { return }
                settled = true
                self.serverProcess = nil

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
                    self.showError(
                        "The Walnut server exited during startup (exit code \(proc.terminationStatus)).\n\n"
                        + "\(detail)\n\n"
                        + "This is usually a stale build. In the source directory run:\n"
                        + "    npm run web:build")
                }
            }
        }

        // Startup deadline. Re-arms itself while a native-module rebuild is running,
        // up to a hard ceiling, so a slow compile isn't mistaken for a hang.
        func armStartupDeadline(secondsRemaining: Int) {
            DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in
                guard let self = self, !portConfirmed, !settled, self.serverProcess === process else { return }
                let remaining = rebuildingNativeModule ? max(secondsRemaining, 300) - 5 : secondsRemaining - 5
                if remaining > 0 {
                    armStartupDeadline(secondsRemaining: remaining)
                    return
                }
                settled = true
                // A hang (never printed "listening"), not a crash — terminate and try
                // the next port. terminationHandler fires but bails on `settled`.
                if process.isRunning {
                    process.terminate()
                }
                self.serverProcess = nil
                let trimmed = outputBuffer.trimmingCharacters(in: .whitespacesAndNewlines)
                self.lastServerOutput = trimmed.split(separator: "\n", omittingEmptySubsequences: false)
                    .suffix(15).joined(separator: "\n")
                self.tryStartServerOnPort(index: index + 1)
            }
        }
        armStartupDeadline(secondsRemaining: 15)
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
                    }
                }
            }
            task.resume()

            if attempts > 60 {
                timer.invalidate()
                self?.showError("Server started on port \(port) but never became ready.")
            }
        }
    }

    func loadWebUI() {
        guard let port = serverPort else { return }
        let url = URL(string: "http://localhost:\(port)")!

        let config = WKWebViewConfiguration()
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")

        webView = WKWebView(frame: window.contentView!.bounds, configuration: config)
        webView.autoresizingMask = [.width, .height]
        webView.navigationDelegate = self

        window.contentView = webView
        window.title = "Walnut — localhost:\(port)"

        let request = URLRequest(url: url)
        webView.load(request)
    }

    func stopServer() {
        retryTimer?.invalidate()
        retryTimer = nil

        if ownsServer, let proc = serverProcess, proc.isRunning {
            proc.terminate()
            DispatchQueue.global().asyncAfter(deadline: .now() + 3) {
                if proc.isRunning {
                    proc.interrupt()
                }
            }
        }
        serverProcess = nil
    }

    // MARK: - Find Executables

    func findNode() -> String {
        return findNodeOrNil() ?? "/usr/local/bin/node"
    }

    func findNodeOrNil() -> String? {
        var allCandidates: [String] = []

        // 1. Mise installs (sorted newest-first — likely to meet version requirements)
        let miseDir = NSHomeDirectory() + "/.local/share/mise/installs/node"
        if let versions = try? FileManager.default.contentsOfDirectory(atPath: miseDir) {
            // Filter to real version directories (e.g. "22.12.0"), skip symlinks like "lts"
            let realVersions = versions.filter { $0.first?.isNumber == true && $0.contains(".") && $0.filter({ $0 == "." }).count >= 1 }
            let sorted = realVersions.sorted { $0.compare($1, options: .numeric) == .orderedDescending }
            for version in sorted {
                let candidate = miseDir + "/\(version)/bin/node"
                if FileManager.default.fileExists(atPath: candidate) {
                    allCandidates.append(candidate)
                }
            }
        }

        // 2. nvm versions (sorted newest-first)
        let nvmDir = NSHomeDirectory() + "/.nvm/versions/node"
        if let versions = try? FileManager.default.contentsOfDirectory(atPath: nvmDir) {
            let sorted = versions.sorted { $0.compare($1, options: .numeric) == .orderedDescending }
            for version in sorted {
                let candidate = nvmDir + "/\(version)/bin/node"
                if FileManager.default.fileExists(atPath: candidate) {
                    allCandidates.append(candidate)
                }
            }
        }

        // 3. Well-known locations
        let wellKnown = [
            "/opt/homebrew/bin/node",
            "/usr/local/bin/node",
            NSHomeDirectory() + "/.nvm/current/bin/node",
            NSHomeDirectory() + "/.fnm/current/bin/node"
        ]
        for candidate in wellKnown {
            if FileManager.default.fileExists(atPath: candidate) {
                allCandidates.append(candidate)
            }
        }

        // 4. Login shell resolution (mise activate, etc.)
        let shellResult = runShellCommand("eval \"$(mise activate zsh 2>/dev/null)\"; which node 2>/dev/null || command -v node 2>/dev/null")
        if let path = shellResult, FileManager.default.fileExists(atPath: path) {
            allCandidates.append(path)
        }

        // 5. Last resort
        let fallback = runShellCommand("which node 2>/dev/null")
        if let path = fallback, FileManager.default.fileExists(atPath: path) {
            allCandidates.append(path)
        }

        // Deduplicate (resolve symlinks for comparison)
        var seen = Set<String>()
        var unique: [String] = []
        for candidate in allCandidates {
            let resolved = (try? FileManager.default.destinationOfSymbolicLink(atPath: candidate)) ?? candidate
            let key = resolved.hasPrefix("/") ? resolved : (candidate as NSString).deletingLastPathComponent + "/" + resolved
            if !seen.contains(key) {
                seen.insert(key)
                unique.append(candidate)
            }
        }

        // Node >= 22 matches package.json "engines". (Below 20, ora's string-width
        // dependency uses the `v` regex flag and can't even load.)
        let supported = unique.filter { nodeVersionMeetsMinimum($0, major: 22) }

        // Version alone can't tell us a runtime WORKS: better-sqlite3 is compiled
        // against one Node ABI, so the newest Node is often the wrong one. Prefer a
        // candidate that can actually load the compiled addons. Falling back to the
        // newest supported Node is safe — the server's native-module preflight
        // recompiles for whatever it's run under (native-abi-preflight.ts); this
        // probe just avoids paying for a rebuild when a matching runtime exists.
        if let source = walnutSourceDir,
           FileManager.default.fileExists(atPath: source + "/node_modules/better-sqlite3") {
            for candidate in supported where nodeCanLoadNativeModules(candidate, sourceDir: source) {
                return candidate
            }
        }

        if let newest = supported.first { return newest }

        // Fall back to any available node (user will see engine warnings but might still work)
        return unique.first
    }

    /// True when `nodePath` can actually load the compiled native addons in
    /// `sourceDir` — i.e. its ABI matches what `npm install` compiled against.
    /// better-sqlite3 resolves its `.node` lazily on first Database construction,
    /// so the probe must construct one; a bare require() passes even on a mismatch.
    func nodeCanLoadNativeModules(_ nodePath: String, sourceDir: String) -> Bool {
        let script = "const D=require('better-sqlite3'); new D(':memory:').close()"
        return runProcess(nodePath, args: ["-e", script], cwd: sourceDir).success
    }

    func nodeVersionMeetsMinimum(_ nodePath: String, major minimum: Int) -> Bool {
        // Try to extract version from path (e.g. .../node/22.12.0/bin/node)
        let components = nodePath.split(separator: "/")
        for (i, component) in components.enumerated() {
            if component == "node" && i + 1 < components.count {
                let next = String(components[i + 1])
                if let dotIndex = next.firstIndex(of: ".") {
                    let majorStr = String(next[next.startIndex..<dotIndex])
                    if let majorVersion = Int(majorStr) {
                        return majorVersion >= minimum
                    }
                }
            }
        }
        // Path doesn't contain version — run the binary to check
        let result = runProcess(nodePath, args: ["--version"], cwd: "/tmp")
        // Output like "v22.12.0"
        let version = result.output.trimmingCharacters(in: .whitespacesAndNewlines)
        if version.hasPrefix("v"), let dotIndex = version.firstIndex(of: ".") {
            let majorStr = String(version[version.index(after: version.startIndex)..<dotIndex])
            if let majorVersion = Int(majorStr) {
                return majorVersion >= minimum
            }
        }
        return false
    }

    func findGitOrNil() -> String? {
        let candidates = [
            "/usr/bin/git",
            "/opt/homebrew/bin/git",
            "/usr/local/bin/git"
        ]
        for candidate in candidates {
            if FileManager.default.fileExists(atPath: candidate) {
                return candidate
            }
        }
        let fallback = runShellCommand("which git 2>/dev/null")
        if let path = fallback, FileManager.default.fileExists(atPath: path) {
            return path
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

        // Show the actual child-process output (git/npm stderr) so failures are
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
        stopServer()
        serverPort = nil
        showLoadingScreen()
        startServer()
    }

    @objc func resetConfig() {
        stopServer()
        serverPort = nil
        try? FileManager.default.removeItem(at: configFilePath())
        walnutHome = nil
        walnutSourceDir = nil
        showSetupScreen()
    }

    // MARK: - Menu

    func setupMainMenu() {
        let mainMenu = NSMenu()

        let appMenuItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(NSMenuItem(title: "About Walnut", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: ""))
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(NSMenuItem(title: "Reset Setup...", action: #selector(resetConfig), keyEquivalent: ","))
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(NSMenuItem(title: "Quit Walnut", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        appMenuItem.submenu = appMenu
        mainMenu.addItem(appMenuItem)

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
        viewMenu.addItem(NSMenuItem(title: "Open in Browser", action: #selector(openInBrowser), keyEquivalent: "b"))
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
        webView?.reload()
    }

    @objc func openInBrowser() {
        guard let port = serverPort else { return }
        NSWorkspace.shared.open(URL(string: "http://localhost:\(port)")!)
    }
}

// MARK: - WKNavigationDelegate

extension AppDelegate: WKNavigationDelegate {
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if serverProcess?.isRunning == false {
            showError("The Walnut server has stopped unexpectedly.")
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let url = navigationAction.request.url,
           navigationAction.navigationType == .linkActivated,
           url.host != "localhost" {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }
}

// MARK: - Entry Point

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()

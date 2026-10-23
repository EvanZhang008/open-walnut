import Foundation

// The self-contained Walnut the app runs when the user has no checkout of their
// own: the compiled Walnut, one file (scripts/build-binary.mjs), installed by the
// install.sh that ships inside Walnut.app (Contents/Resources/install.sh) into
// its versions layout, the one `curl -fsSL .../install.sh | sh` makes:
//
//   ~/.local/share/open-walnut/versions/<version>/walnut
//   ~/.local/share/open-walnut/bin/walnut -> ../versions/<version>/walnut
//
// A release's app carries this Mac's file (Contents/Resources/release/v<version>/,
// beside its SHA256SUMS; desktop/build-release.sh), signed with the app's
// Developer ID, one DMG per Mac architecture: the first launch installs it from
// there with no network, checked as a download is. install.sh copies it out of
// the bundle, so the app stays a signed shell that is never modified, nothing is
// quarantined, and the file updates itself in place (`walnut update`, and on
// start). An app without a file for this Mac (an Intel DMG on Apple silicon, a
// dev build) downloads it from the release. A Mac that already ran install.sh
// shares the same copy (and `walnut` on PATH).
//
// Before the compiled file, install.sh installed a Node archive into app/
// (scripts/runtime-bundle/build.mjs). A Mac that has one keeps running it
// (Layout.archive) until the next install replaces it: the first app update
// that carries a file does. REMOVE the archive case with the archives
// (.github/workflows/release-archives.yml).
//
// Foundation only, so tests/desktop/bundled-runtime-tests.swift compiles it alone.

struct BundledRuntime {
    /// Where install.sh puts it (its OPEN_WALNUT_INSTALL_DIR default).
    let installDir: String

    static func defaultInstallDir(home: String) -> String { home + "/.local/share/open-walnut" }
    /// Where install.sh links `walnut` (its OPEN_WALNUT_BIN_DIR default).
    static func binDir(home: String) -> String { home + "/.local/bin" }

    /// The link install.sh points at the version in use (`walnut` on PATH links here).
    var link: String { installDir + "/bin/walnut" }

    /// What install.sh left in installDir.
    enum Layout: Equatable {
        /// The compiled file, at this version.
        case file(version: String)
        /// The Node archive of the releases before it.
        case archive
    }

    /// The archive unpacked (install.sh's layout before the file).
    var appDir: String { installDir + "/app" }
    // The archive's layout (build.mjs): the official Node used as an npm prefix.
    var nodeBinDir: String { appDir + "/runtime/bin" }
    var node: String { nodeBinDir + "/node" }
    var packageRoot: String { appDir + "/runtime/lib/node_modules/open-walnut" }
    var cli: String { packageRoot + "/dist/cli.js" }

    static func readLink(_ path: String) -> String? {
        return try? FileManager.default.destinationOfSymbolicLink(atPath: path)
    }

    /// The version in install.sh's link, `../versions/<version>/walnut`, or nil. A link
    /// made by hand (a rollback) may name that file by its full path under `installDir`.
    static func linkedVersion(_ destination: String?, installDir: String? = nil) -> String? {
        guard var dest = destination else { return nil }
        if let dir = installDir, dest.hasPrefix(dir + "/versions/") {
            dest = "../" + dest.dropFirst(dir.count + 1)
        }
        let parts = dest.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        guard parts.count == 4, parts[0] == "..", parts[1] == "versions", parts[3] == "walnut",
              !parts[2].isEmpty, !parts[2].hasPrefix(".") else { return nil }
        return parts[2]
    }

    func layout(
        readLink: (String) -> String? = BundledRuntime.readLink,
        fileExists: (String) -> Bool = FileManager.default.fileExists(atPath:)
    ) -> Layout? {
        if let version = BundledRuntime.linkedVersion(readLink(link), installDir: installDir),
           fileExists(installDir + "/versions/" + version + "/walnut") {
            return .file(version: version)
        }
        // Both the Node and the package: a half-unpacked archive is not installed.
        if fileExists(node) && fileExists(cli) { return .archive }
        return nil
    }

    func isInstalled(
        readLink: (String) -> String? = BundledRuntime.readLink,
        fileExists: (String) -> Bool = FileManager.default.fileExists(atPath:)
    ) -> Bool {
        return layout(readLink: readLink, fileExists: fileExists) != nil
    }

    /// Whether a saved setup can still start: its runtime is installed, or its checkout is built.
    static func setupRuns(
        runtimeDir: String?, sourceDir: String,
        readLink: (String) -> String? = BundledRuntime.readLink,
        fileExists: (String) -> Bool = FileManager.default.fileExists(atPath:)
    ) -> Bool {
        if let dir = runtimeDir { return BundledRuntime(installDir: dir).isInstalled(readLink: readLink, fileExists: fileExists) }
        return fileExists(sourceDir + "/dist/cli.js")
    }

    /// The installed version: the file's, from its link; the archive's, from its package.json.
    func installedVersion(layout: Layout?, readFile: (String) -> Data? = { FileManager.default.contents(atPath: $0) }) -> String? {
        switch layout {
        case .file(let version)?:
            return version
        case .archive?:
            guard let data = readFile(packageRoot + "/package.json"),
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let version = obj["version"] as? String, !version.isEmpty else { return nil }
            return version
        case nil:
            return nil
        }
    }

    /// How the app starts the server.
    struct Launch: Equatable {
        let executable: String
        let arguments: [String]
        let directory: String
    }

    /// The file through its link, so the restart after an update runs the new
    /// version; the archive's Node on its package.
    func serverLaunch(port: Int, layout: Layout) -> Launch {
        switch layout {
        case .file:
            return Launch(executable: link, arguments: ["web", "--port", String(port)], directory: installDir)
        case .archive:
            return Launch(executable: node, arguments: [cli, "web", "--port", String(port)], directory: packageRoot)
        }
    }

    /// The `walnut` command for ~/.local/bin (CommandLineTool.swift).
    func command(layout: Layout) -> String {
        return layout == .archive ? appDir + "/bin/walnut" : link
    }

    /// Whether `ps`'s command line is a Walnut server this install starts: its
    /// link or one of its versions' files, or the archive's Node on its package,
    /// then `web`. `ps` joins the arguments with spaces and a path may hold one,
    /// so the line is matched against those known paths, never split into words.
    func isServerCommand(_ command: String) -> Bool {
        if BundledRuntime.startsCommand(command, with: link + " web") || BundledRuntime.startsCommand(command, with: node + " " + cli + " web") {
            return true
        }
        let versions = installDir + "/versions/"
        guard command.hasPrefix(versions) else { return false }
        let rest = command.dropFirst(versions.count)
        guard let slash = rest.firstIndex(of: "/") else { return false }
        let version = rest[..<slash]
        guard !version.isEmpty, !version.hasPrefix("."), !version.contains(" ") else { return false }
        return BundledRuntime.startsCommand(String(rest[slash...]), with: "/walnut web")
    }

    /// The same for a checkout's server: any Node on `<sourceDir>/dist/cli.js web`.
    static func isCheckoutServerCommand(_ command: String, sourceDir: String) -> Bool {
        let script = " " + sourceDir + "/dist/cli.js web"
        guard let found = command.range(of: script) else { return false }
        return found.upperBound == command.endIndex || command[found.upperBound] == " "
    }

    /// `command` is `start` exactly, or `start` and then more arguments.
    static func startsCommand(_ command: String, with start: String) -> Bool {
        return command == start || command.hasPrefix(start + " ")
    }

    /// The release this app carries for this Mac: a directory laid out like the
    /// releases (`v<version>/SHA256SUMS` and `walnut-<version>-darwin-<arch>`,
    /// or its .gz).
    struct CarriedRelease: Equatable {
        let version: String
        /// The release directory, given to install.sh as a file:// base by path.
        let root: String
    }

    /// Contents/Resources/release in a release build (absent in a dev build).
    static func carriedRelease(resources: String, arch: String, list: (String) -> [String]) -> CarriedRelease? {
        let root = resources + "/release"
        let versions = list(root).filter { $0.hasPrefix("v") && $0.count > 1 }.map { String($0.dropFirst()) }
        for version in versions.sorted(by: >) {
            let files = Set(list(root + "/v" + version))
            let file = "walnut-\(version)-darwin-\(arch)"
            if files.contains("SHA256SUMS") && (files.contains(file) || files.contains(file + ".gz")) {
                return CarriedRelease(version: version, root: root)
            }
        }
        return nil
    }

    static func listDirectory(_ path: String) -> [String] {
        return (try? FileManager.default.contentsOfDirectory(atPath: path)) ?? []
    }

    /// This Mac's own architecture in install.sh's words, also when the app runs
    /// under Rosetta: an Apple silicon Mac wants the arm64 build.
    static func machineArch(arm64Capable: Bool = sysctlFlag("hw.optional.arm64")) -> String {
        return arm64Capable ? "arm64" : "x64"
    }

    static func sysctlFlag(_ name: String) -> Bool {
        var value: Int32 = 0
        var size = MemoryLayout<Int32>.size
        return sysctlbyname(name, &value, &size, nil, 0) == 0 && value == 1
    }

    /// The environment install.sh runs in: the app's own, with the two places
    /// pinned so the app knows where to look afterwards whatever the user's shell
    /// exports. A carried release is installed from this disk (its version and
    /// directory win over any knob); otherwise every OPEN_WALNUT_* knob the
    /// caller set (a test's release mirror, a pinned version) passes through.
    static func installEnvironment(base: [String: String], home: String, carried: CarriedRelease? = nil) -> [String: String] {
        var env = base
        env["OPEN_WALNUT_INSTALL_DIR"] = base["OPEN_WALNUT_INSTALL_DIR"] ?? defaultInstallDir(home: home)
        env["OPEN_WALNUT_BIN_DIR"] = base["OPEN_WALNUT_BIN_DIR"] ?? binDir(home: home)
        if let carried = carried {
            env["OPEN_WALNUT_RELEASE_BASE_URL"] = "file://" + carried.root
            env["OPEN_WALNUT_VERSION"] = carried.version
        }
        // curl's progress bar, which the setup screen reads its percentage off.
        env["OPEN_WALNUT_PROGRESS"] = "1"
        // curl, tar, shasum: the system's own, whatever the user's PATH holds.
        env["PATH"] = "/usr/bin:/bin:/usr/sbin:/sbin" + (base["PATH"].map { ":" + $0 } ?? "")
        return env
    }

    /// The server's PATH: what the user has first. An archive's Node goes last
    /// (its launcher does the same), so a tool that asks for `node` by name finds
    /// one on a Mac without Node, and a Node the user installed wins.
    func serverPath(current: String, extra: [String], layout: Layout) -> String {
        return (extra + [current] + (layout == .archive ? [nodeBinDir] : [])).joined(separator: ":")
    }

    /// The one line of install.sh's output that names its step: the last one
    /// ("Downloading walnut-<version>-darwin-<arch>.gz..."), trimmed, never the progress bar.
    static func statusLine(from output: String) -> String? {
        for raw in output.split(separator: "\n").reversed() {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if line.isEmpty || line.hasPrefix("#") || line.contains("%") { continue }
            return line
        }
        return nil
    }

    /// What the setup screen says for one of install.sh's steps: the user did not
    /// run a script, so its file names and PATH hints are not theirs to read.
    static func friendlyStatus(_ line: String) -> String {
        if line.hasPrefix("Finding the newest release") { return "Finding the latest Walnut..." }
        // A release the app carries: "Installing the walnut-<version>-darwin-<arch> it came with...".
        if line.hasPrefix("Installing the ") { return "Installing Walnut..." }
        if line.hasPrefix("Installing Open Walnut ") {
            let version = line.dropFirst("Installing Open Walnut ".count).split(separator: " ").first.map(String.init) ?? ""
            return version.isEmpty ? "Getting Walnut..." : "Getting Walnut \(version)..."
        }
        if line.hasPrefix("Downloading ") { return "Downloading Walnut..." }
        if line.hasPrefix("Unpacking") { return "Unpacking..." }
        return "Starting Walnut..."
    }

    /// How far the download is (0...1), read off curl's progress bar (install.sh
    /// draws it with OPEN_WALNUT_PROGRESS=1). nil before the download starts,
    /// once it is unpacking, and while curl does not know the size.
    static func downloadFraction(from output: String) -> Double? {
        guard let start = output.range(of: "Downloading ", options: .backwards) else { return nil }
        let tail = output[start.upperBound...]
        if tail.contains("Unpacking") { return nil }
        // The bar redraws itself after a carriage return: the newest figure is the last one.
        var newest: Double?
        var digits = ""
        for ch in tail {
            if ch.isASCII && (ch.isNumber || ch == ".") { digits.append(ch); continue }
            if ch == "%", let value = Double(digits), value >= 0, value <= 100 { newest = value }
            digits = ""
        }
        return newest.map { $0 / 100 }
    }

    /// One look at the installer's progress: the step it is on, and the download's share.
    struct Progress: Equatable {
        let status: String
        let fraction: Double?
    }

    static func progress(from output: String) -> Progress? {
        guard let line = statusLine(from: output) else { return nil }
        return Progress(status: friendlyStatus(line), fraction: downloadFraction(from: output))
    }

    /// Runs install.sh, reporting its progress as it prints. Blocks; call it
    /// off the main thread. Returns success and everything it printed.
    static func runInstaller(
        script: String,
        environment: [String: String],
        onStart: ((Process) -> Void)? = nil,
        onProgress: @escaping (Progress) -> Void
    ) -> (success: Bool, output: String) {
        let proc = Process()
        let pipe = Pipe()
        proc.executableURL = URL(fileURLWithPath: "/bin/sh")
        proc.arguments = [script]
        proc.environment = environment
        proc.currentDirectoryURL = URL(fileURLWithPath: NSTemporaryDirectory())
        proc.standardOutput = pipe
        proc.standardError = pipe
        let lock = NSLock()
        var output = ""
        pipe.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            guard !data.isEmpty, let text = String(data: data, encoding: .utf8) else { return }
            lock.lock()
            output += text
            let snapshot = output
            lock.unlock()
            if let now = progress(from: snapshot) { onProgress(now) }
        }
        do {
            try proc.run()
            onStart?(proc)
        } catch {
            pipe.fileHandleForReading.readabilityHandler = nil
            return (false, "Failed to run \(script): \(error.localizedDescription)")
        }
        proc.waitUntilExit()
        pipe.fileHandleForReading.readabilityHandler = nil
        // Whatever arrived after the last callback.
        let rest = pipe.fileHandleForReading.readDataToEndOfFile()
        lock.lock()
        if let text = String(data: rest, encoding: .utf8) { output += text }
        let all = output
        lock.unlock()
        return (proc.terminationStatus == 0, all)
    }
}

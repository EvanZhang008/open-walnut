import Foundation

// The self-contained Walnut the app runs when the user has no checkout of their
// own: the archive `curl -fsSL …/install.sh | sh` installs
// (scripts/runtime-bundle/build.mjs), installed by that same install.sh, which
// ships inside Walnut.app (Contents/Resources/install.sh).
//
// Why install it at first launch rather than ship it inside the bundle: the
// archive is ~1,000 Mach-O files (Node and every native module), and a signed,
// notarized app must sign every one of them and could then never update them
// in place. Downloaded by curl, nothing is quarantined, the runtime updates
// itself with its own npm (`walnut update`, and on start), and the app stays a
// small signed shell that is never modified. A Mac that already ran install.sh
// shares the same copy (and the same `walnut` on PATH).
//
// Foundation only, so tests/desktop/bundled-runtime-tests.swift compiles it alone.

struct BundledRuntime {
    /// Where install.sh puts it (its OPEN_WALNUT_INSTALL_DIR default).
    let installDir: String

    static func defaultInstallDir(home: String) -> String { home + "/.local/share/open-walnut" }
    /// Where install.sh links `walnut` (its OPEN_WALNUT_BIN_DIR default).
    static func binDir(home: String) -> String { home + "/.local/bin" }

    /// install.sh unpacks the archive here (and swaps a new copy in at the same path).
    var appDir: String { installDir + "/app" }
    // The archive's layout (build.mjs): the official Node used as an npm prefix.
    var nodeBinDir: String { appDir + "/runtime/bin" }
    var node: String { nodeBinDir + "/node" }
    var packageRoot: String { appDir + "/runtime/lib/node_modules/open-walnut" }
    var cli: String { packageRoot + "/dist/cli.js" }

    func isInstalled(fileExists: (String) -> Bool = FileManager.default.fileExists(atPath:)) -> Bool {
        return fileExists(node) && fileExists(cli)
    }

    /// The environment install.sh runs in: the app's own, with the two places
    /// pinned so the app knows where to look afterwards whatever the user's shell
    /// exports. Every OPEN_WALNUT_* knob the caller set (a test's release mirror,
    /// a pinned version) passes through.
    static func installEnvironment(base: [String: String], home: String) -> [String: String] {
        var env = base
        env["OPEN_WALNUT_INSTALL_DIR"] = base["OPEN_WALNUT_INSTALL_DIR"] ?? defaultInstallDir(home: home)
        env["OPEN_WALNUT_BIN_DIR"] = base["OPEN_WALNUT_BIN_DIR"] ?? binDir(home: home)
        // curl's progress bar, which the setup screen reads its percentage off.
        env["OPEN_WALNUT_PROGRESS"] = "1"
        // curl, tar, shasum: the system's own, whatever the user's PATH holds.
        env["PATH"] = "/usr/bin:/bin:/usr/sbin:/sbin" + (base["PATH"].map { ":" + $0 } ?? "")
        return env
    }

    /// The server's PATH: what the user has first, this runtime's Node last.
    /// The archive's launcher does the same, so a tool that asks for `node` by
    /// name finds one on a Mac without Node, and a Node the user installed wins.
    func serverPath(current: String, extra: [String]) -> String {
        return (extra + [current, nodeBinDir]).joined(separator: ":")
    }

    /// The one line of install.sh's output that names its step: the last one
    /// ("Downloading open-walnut-….tar.gz..."), trimmed, never the progress bar.
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

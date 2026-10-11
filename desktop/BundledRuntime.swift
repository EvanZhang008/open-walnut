import Foundation

// The self-contained Walnut the app runs when the user has no checkout of their
// own: the archive `curl -fsSL …/install.sh | sh` installs
// (scripts/runtime-bundle/build.mjs), installed by that same install.sh, which
// ships inside Walnut.app (Contents/Resources/install.sh).
//
// A release's app carries its own archive (Contents/Resources/release/v<version>/,
// beside the release's SHA256SUMS; desktop/build-release.sh), one DMG per Mac
// architecture: the first launch installs it from there with no network, checked
// as a download is. It stays an archive inside the bundle, not unpacked code:
// the runtime is ~1,000 Mach-O files (Node and every native module) that a signed,
// notarized app would have to sign one by one and could then never update in
// place. Unpacked by install.sh, nothing is quarantined, the runtime updates
// itself with its own npm (`walnut update`, and on start), and the app stays a
// signed shell that is never modified. An app without an archive for this Mac
// (an Intel DMG on Apple silicon, a dev build) downloads it from the release.
// A Mac that already ran install.sh shares the same copy (and `walnut` on PATH).
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

    /// The release this app carries for this Mac: a directory laid out like the
    /// releases (`v<version>/SHA256SUMS` and `open-walnut-<version>-darwin-<arch>.tar.gz`).
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
            if files.contains("SHA256SUMS") && files.contains("open-walnut-\(version)-darwin-\(arch).tar.gz") {
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

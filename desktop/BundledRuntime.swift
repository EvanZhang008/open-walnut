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

    /// The one line of install.sh's output worth showing under the spinner: its
    /// last step ("Downloading open-walnut-….tar.gz..."), trimmed.
    static func statusLine(from output: String) -> String? {
        for raw in output.split(separator: "\n").reversed() {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if line.isEmpty || line.hasPrefix("#") || line.contains("%") { continue }
            return line
        }
        return nil
    }

    /// Runs install.sh, reporting each status line as it is printed. Blocks;
    /// call it off the main thread. Returns success and everything it printed.
    static func runInstaller(
        script: String,
        environment: [String: String],
        onStatus: @escaping (String) -> Void
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
            if let line = statusLine(from: snapshot) { onStatus(line) }
        }
        do {
            try proc.run()
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

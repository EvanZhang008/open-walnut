import Foundation

/// BundledRuntime (desktop/BundledRuntime.swift): where the Mac app finds the
/// self-contained Walnut its first launch installs, how it runs install.sh, and
/// what the server it starts sees on PATH. The layout must match what
/// scripts/runtime-bundle/build.mjs builds and scripts/install.sh installs
/// (tests/scripts/release-archives.test.ts checks those two sides).
@main
struct BundledRuntimeTests {
    static func main() {
        let home = "/Users/someone"
        let rt = BundledRuntime(installDir: BundledRuntime.defaultInstallDir(home: home))

        // install.sh's defaults, and the archive's layout under them.
        precondition(rt.installDir == "/Users/someone/.local/share/open-walnut")
        precondition(BundledRuntime.binDir(home: home) == "/Users/someone/.local/bin")
        precondition(rt.node == "/Users/someone/.local/share/open-walnut/app/runtime/bin/node")
        precondition(rt.cli == "/Users/someone/.local/share/open-walnut/app/runtime/lib/node_modules/open-walnut/dist/cli.js")
        precondition(rt.packageRoot + "/dist/cli.js" == rt.cli)

        // Installed means both the Node and the package: a half-unpacked copy is not.
        precondition(rt.isInstalled(fileExists: { _ in true }))
        precondition(!rt.isInstalled(fileExists: { $0 == rt.node }))
        precondition(!rt.isInstalled(fileExists: { $0 == rt.cli }))

        // The installer is told where to put it, and the system's own tools come first.
        let env = BundledRuntime.installEnvironment(base: ["PATH": "/opt/homebrew/bin:/usr/bin", "HOME": home], home: home)
        precondition(env["OPEN_WALNUT_INSTALL_DIR"] == rt.installDir)
        precondition(env["OPEN_WALNUT_BIN_DIR"] == "/Users/someone/.local/bin")
        precondition(env["PATH"]!.hasPrefix("/usr/bin:/bin:/usr/sbin:/sbin:"))
        precondition(env["HOME"] == home)
        // And asked for the download's progress bar, which the setup screen reads.
        precondition(env["OPEN_WALNUT_PROGRESS"] == "1")
        // A caller's knobs pass through: a test's mirror, a pinned version, another dir.
        let pinned = BundledRuntime.installEnvironment(base: [
            "OPEN_WALNUT_INSTALL_DIR": "/tmp/rt", "OPEN_WALNUT_VERSION": "0.7.0",
            "OPEN_WALNUT_RELEASE_BASE_URL": "http://127.0.0.1:9/r",
        ], home: home)
        precondition(pinned["OPEN_WALNUT_INSTALL_DIR"] == "/tmp/rt")
        precondition(pinned["OPEN_WALNUT_VERSION"] == "0.7.0")
        precondition(pinned["OPEN_WALNUT_RELEASE_BASE_URL"] == "http://127.0.0.1:9/r")
        precondition(pinned["PATH"] == "/usr/bin:/bin:/usr/sbin:/sbin")

        // The server: the user's tools first, this runtime's Node last (the launcher's rule).
        let path = rt.serverPath(current: "/usr/bin:/bin", extra: ["/opt/homebrew/bin"])
        precondition(path == "/opt/homebrew/bin:/usr/bin:/bin:/Users/someone/.local/share/open-walnut/app/runtime/bin")

        // The spinner shows install.sh's latest step, not its blank lines.
        let out = "\n  Finding the newest release...\n  Installing Open Walnut 0.7.0 (darwin-arm64)...\n  Downloading open-walnut-0.7.0-darwin-arm64.tar.gz...\n\n"
        precondition(BundledRuntime.statusLine(from: out) == "Downloading open-walnut-0.7.0-darwin-arm64.tar.gz...")
        precondition(BundledRuntime.statusLine(from: "") == nil)

        // The setup screen speaks of Walnut, not of install.sh's files and PATH hints.
        precondition(BundledRuntime.friendlyStatus("Finding the newest release...") == "Finding the latest Walnut...")
        precondition(BundledRuntime.friendlyStatus("Installing Open Walnut 0.7.0 (darwin-arm64)...") == "Getting Walnut 0.7.0...")
        precondition(BundledRuntime.friendlyStatus("Downloading open-walnut-0.7.0-darwin-arm64.tar.gz...") == "Downloading Walnut...")
        precondition(BundledRuntime.friendlyStatus("Unpacking...") == "Unpacking...")
        precondition(BundledRuntime.friendlyStatus("Add /Users/someone/.local/bin to your PATH, then start it with:  walnut web") == "Starting Walnut...")

        // The download's share, off curl's bar: the newest figure after the last redraw.
        let started = out + "##                                   3.1%\r########                        24.7%\r###############             47.3%"
        precondition(BundledRuntime.downloadFraction(from: started) == 0.473)
        precondition(BundledRuntime.downloadFraction(from: started + "\r" + String(repeating: "#", count: 60) + " 100.0%\n") == 1.0)
        // None before the download, none while curl does not know the size, none once unpacking.
        precondition(BundledRuntime.downloadFraction(from: "  Finding the newest release...\n") == nil)
        precondition(BundledRuntime.downloadFraction(from: out + "#=#=#  ##O#- #\r") == nil)
        precondition(BundledRuntime.downloadFraction(from: started + "\r 100.0%\n  Unpacking...\n") == nil)
        // The version in the file name is not a percentage.
        precondition(BundledRuntime.downloadFraction(from: out) == nil)
        let now = BundledRuntime.progress(from: started)
        precondition(now == BundledRuntime.Progress(status: "Downloading Walnut...", fraction: 0.473))
        precondition(BundledRuntime.progress(from: "") == nil)

        // A real run: output streams to the callback, the exit status is kept.
        let dir = NSTemporaryDirectory() + "walnut-bundled-runtime-tests-\(getpid())"
        try! FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(atPath: dir) }
        let ok = dir + "/ok.sh"
        try! "printf '  Downloading x...\\n' >&2\nprintf '  Unpacking...\\n'\n[ \"$OPEN_WALNUT_INSTALL_DIR\" = /tmp/rt ]\n".write(toFile: ok, atomically: true, encoding: .utf8)
        var seen: [String] = []
        let lock = NSLock()
        let result = BundledRuntime.runInstaller(script: ok, environment: pinned) { progress in
            lock.lock(); seen.append(progress.status); lock.unlock()
        }
        precondition(result.success, result.output)
        precondition(result.output.contains("Downloading x...") && result.output.contains("Unpacking..."))
        lock.lock(); precondition(!seen.isEmpty); lock.unlock()

        let bad = dir + "/bad.sh"
        try! "printf '\\nopen-walnut install: no release\\n' >&2\nexit 3\n".write(toFile: bad, atomically: true, encoding: .utf8)
        let failed = BundledRuntime.runInstaller(script: bad, environment: pinned) { _ in }
        precondition(!failed.success)
        precondition(failed.output.contains("open-walnut install: no release"))

        print("bundled-runtime-tests: ok")
    }
}

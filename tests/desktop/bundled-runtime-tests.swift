import Foundation

/// BundledRuntime (desktop/BundledRuntime.swift): where the Mac app finds the
/// self-contained Walnut that Get Started installs, how it runs install.sh, and
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

        // A real run: output streams to the callback, the exit status is kept.
        let dir = NSTemporaryDirectory() + "walnut-bundled-runtime-tests-\(getpid())"
        try! FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(atPath: dir) }
        let ok = dir + "/ok.sh"
        try! "printf '  Downloading x...\\n' >&2\nprintf '  Unpacking...\\n'\n[ \"$OPEN_WALNUT_INSTALL_DIR\" = /tmp/rt ]\n".write(toFile: ok, atomically: true, encoding: .utf8)
        var seen: [String] = []
        let lock = NSLock()
        let result = BundledRuntime.runInstaller(script: ok, environment: pinned) { line in
            lock.lock(); seen.append(line); lock.unlock()
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

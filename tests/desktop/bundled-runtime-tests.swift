import Foundation

/// BundledRuntime (desktop/BundledRuntime.swift): where the Mac app finds the
/// self-contained Walnut its first launch installs, how it runs install.sh, how
/// it starts the server and what that server sees on PATH. The layout must match
/// what scripts/install.sh installs (tests/scripts/install-sh.test.ts) and, for
/// the older archive, what scripts/runtime-bundle/build.mjs builds
/// (tests/scripts/release-archives.test.ts checks those sides).
@main
struct BundledRuntimeTests {
    static func main() {
        let home = "/Users/someone"
        let rt = BundledRuntime(installDir: BundledRuntime.defaultInstallDir(home: home))

        // install.sh's defaults, the file's layout under them, and the archive's before it.
        precondition(rt.installDir == "/Users/someone/.local/share/open-walnut")
        precondition(BundledRuntime.binDir(home: home) == "/Users/someone/.local/bin")
        precondition(rt.link == "/Users/someone/.local/share/open-walnut/bin/walnut")
        precondition(rt.node == "/Users/someone/.local/share/open-walnut/app/runtime/bin/node")
        precondition(rt.cli == "/Users/someone/.local/share/open-walnut/app/runtime/lib/node_modules/open-walnut/dist/cli.js")
        precondition(rt.packageRoot + "/dist/cli.js" == rt.cli)

        // The file: install.sh's link names the version in use, and that version's file is there.
        let file = rt.installDir + "/versions/0.7.0/walnut"
        let linked: (String) -> String? = { $0 == rt.link ? "../versions/0.7.0/walnut" : nil }
        precondition(rt.layout(readLink: linked, fileExists: { $0 == file }) == .file(version: "0.7.0"))
        precondition(rt.isInstalled(readLink: linked, fileExists: { $0 == file }))
        // A link to a version that is not there, or not install.sh's shape, is no install.
        precondition(rt.layout(readLink: linked, fileExists: { _ in false }) == nil)
        for odd in ["../app/bin/walnut", "/abs/versions/0.7.0/walnut", "../versions/.download-0.7.0-ab12/walnut", "../versions//walnut", "versions/0.7.0/walnut"] {
            precondition(BundledRuntime.linkedVersion(odd) == nil, odd)
        }
        precondition(BundledRuntime.linkedVersion("../versions/0.7.1-nightly.20261022.1/walnut") == "0.7.1-nightly.20261022.1")
        // A rollback link made by hand names the file by its full path: only under this install.
        precondition(BundledRuntime.linkedVersion("/abs/versions/0.7.0/walnut", installDir: "/abs") == "0.7.0")
        precondition(BundledRuntime.linkedVersion("/other/versions/0.7.0/walnut", installDir: "/abs") == nil)
        precondition(BundledRuntime.linkedVersion("/abs/versions/../x/walnut", installDir: "/abs") == nil)
        let absolute: (String) -> String? = { $0 == rt.link ? file : nil }
        precondition(rt.layout(readLink: absolute, fileExists: { $0 == file }) == .file(version: "0.7.0"))
        // The archive install.sh made before (its link goes to app/): both the Node and the package.
        let toApp: (String) -> String? = { $0 == rt.link ? "../app/bin/walnut" : nil }
        precondition(rt.layout(readLink: toApp, fileExists: { _ in true }) == .archive)
        precondition(rt.layout(readLink: { _ in nil }, fileExists: { $0 == rt.node || $0 == rt.cli }) == .archive)
        precondition(!rt.isInstalled(readLink: toApp, fileExists: { $0 == rt.node }))
        precondition(!rt.isInstalled(readLink: toApp, fileExists: { $0 == rt.cli }))
        // The file wins over an archive left beside it (install.sh keeps the one it replaced).
        precondition(rt.layout(readLink: linked, fileExists: { _ in true }) == .file(version: "0.7.0"))

        // A saved setup still runs while its runtime is installed, or its checkout is built.
        precondition(BundledRuntime.setupRuns(runtimeDir: rt.installDir, sourceDir: rt.installDir, readLink: linked, fileExists: { $0 == file }))
        // An archive-era config named the archive's package root: the runtime dir decides.
        precondition(BundledRuntime.setupRuns(runtimeDir: rt.installDir, sourceDir: rt.packageRoot, readLink: linked, fileExists: { $0 == file }))
        precondition(!BundledRuntime.setupRuns(runtimeDir: rt.installDir, sourceDir: rt.installDir, readLink: { _ in nil }, fileExists: { _ in false }))
        precondition(BundledRuntime.setupRuns(runtimeDir: nil, sourceDir: "/src", readLink: { _ in nil }, fileExists: { $0 == "/src/dist/cli.js" }))
        precondition(!BundledRuntime.setupRuns(runtimeDir: nil, sourceDir: "/src", readLink: { _ in nil }, fileExists: { _ in false }))

        // The installed version: the file's from its link, the archive's from its package.json.
        precondition(rt.installedVersion(layout: .file(version: "0.7.0")) == "0.7.0")
        precondition(rt.installedVersion(layout: .archive, readFile: { $0 == rt.packageRoot + "/package.json" ? Data(#"{"name":"open-walnut","version":"0.6.8"}"#.utf8) : nil }) == "0.6.8")
        precondition(rt.installedVersion(layout: .archive, readFile: { _ in Data("not json".utf8) }) == nil)
        precondition(rt.installedVersion(layout: .archive, readFile: { _ in nil }) == nil)
        precondition(rt.installedVersion(layout: nil) == nil)

        // The server: the file through its link (a restart after an update runs the new
        // one), the archive's Node on its package.
        precondition(rt.serverLaunch(port: 3456, layout: .file(version: "0.7.0")) == BundledRuntime.Launch(executable: rt.link, arguments: ["web", "--port", "3456"], directory: rt.installDir))
        precondition(rt.serverLaunch(port: 3457, layout: .archive) == BundledRuntime.Launch(executable: rt.node, arguments: [rt.cli, "web", "--port", "3457"], directory: rt.packageRoot))
        precondition(rt.command(layout: .file(version: "0.7.0")) == rt.link)
        precondition(rt.command(layout: .archive) == rt.appDir + "/bin/walnut")
        // No server updates before it listens: the file knows WALNUT_LAUNCHER_UPDATES, an
        // archive's 0.6.x code only WALNUT_NO_AUTO_UPDATE (its npm outlasted the 180 s wait).
        precondition(BundledRuntime.serverUpdateEnv(.file(version: "0.7.0")) == ["WALNUT_LAUNCHER_UPDATES": "1"])
        precondition(BundledRuntime.serverUpdateEnv(.archive) == ["WALNUT_LAUNCHER_UPDATES": "1", "WALNUT_NO_AUTO_UPDATE": "1"])
        // The app updates them while the server runs: the file itself, the archive to the
        // newest file; an archive on a prerelease waits for an app that carries a newer file.
        precondition(BundledRuntime.servingUpdate(.file(version: "0.7.0"), installed: "0.7.0") == .selfUpdate)
        precondition(BundledRuntime.servingUpdate(.archive, installed: "0.6.17") == .moveArchive)
        precondition(BundledRuntime.servingUpdate(.archive, installed: "0.7.0") == .moveArchive)
        precondition(BundledRuntime.servingUpdate(.archive, installed: nil) == .moveArchive)
        precondition(BundledRuntime.servingUpdate(.archive, installed: "0.6.18-nightly.20261020.1") == .none)
        // What `ps` shows for each, and what it never takes for a Walnut server.
        precondition(rt.isServerCommand(rt.link + " web --port 3456"))
        precondition(rt.isServerCommand(rt.link + " web"))
        precondition(rt.isServerCommand(rt.installDir + "/versions/0.7.0/walnut web --port 3456"))
        precondition(rt.isServerCommand(rt.node + " " + rt.cli + " web --port 3456"))
        precondition(!rt.isServerCommand(rt.link + " update"))
        precondition(!rt.isServerCommand(rt.link + " webhook"))
        precondition(!rt.isServerCommand(rt.installDir + "/versions/.download-0.7.0-ab12/walnut web"))
        precondition(!rt.isServerCommand("/usr/bin/python3 -m http.server web"))
        precondition(!rt.isServerCommand("/somewhere/else/walnut web --port 3456"))
        precondition(!rt.isServerCommand(""))
        // A home with a space: the line still matches its own paths, and only those.
        let spaced = BundledRuntime(installDir: "/Users/some one/Library/Application Support/open-walnut")
        precondition(spaced.isServerCommand(spaced.link + " web --port 3456"))
        precondition(spaced.isServerCommand(spaced.installDir + "/versions/0.7.0/walnut web --port 3456"))
        precondition(spaced.isServerCommand(spaced.node + " " + spaced.cli + " web --port 3456"))
        precondition(!spaced.isServerCommand(rt.link + " web --port 3456"))
        precondition(!spaced.isServerCommand("/Users/some one/Library/Application Support/other/walnut web"))
        // A checkout's server, run by whichever Node the app found.
        let checkout = "/Users/some one/src/open-walnut"
        precondition(BundledRuntime.isCheckoutServerCommand("/opt/homebrew/bin/node " + checkout + "/dist/cli.js web --port 3456", sourceDir: checkout))
        precondition(BundledRuntime.isCheckoutServerCommand("/a b/node " + checkout + "/dist/cli.js web", sourceDir: checkout))
        precondition(!BundledRuntime.isCheckoutServerCommand("/opt/homebrew/bin/node " + checkout + "/dist/cli.js update", sourceDir: checkout))
        precondition(!BundledRuntime.isCheckoutServerCommand("/opt/homebrew/bin/node /elsewhere/dist/cli.js web", sourceDir: checkout))
        // A checkout runs on bun now: its server is bun on dist/cli.js, and the check sees that too.
        let co = BundledRuntime.checkoutLaunch(bun: "/Users/someone/.bun/bin/bun", sourceDir: checkout, port: 3456)
        precondition(co == BundledRuntime.Launch(executable: "/Users/someone/.bun/bin/bun", arguments: [checkout + "/dist/cli.js", "web", "--port", "3456"], directory: checkout))
        precondition(BundledRuntime.isCheckoutServerCommand(co.executable + " " + co.arguments.joined(separator: " "), sourceDir: checkout))

        // Which bun a checkout runs on: PATH first, then bun's and Homebrew's places, each once.
        let cands = BundledRuntime.bunCandidates(home: home, pathEnv: "/opt/homebrew/bin:relative/bin:/usr/bin")
        precondition(cands == ["/opt/homebrew/bin/bun", "/usr/bin/bun", "/Users/someone/.bun/bin/bun", "/usr/local/bin/bun"], "\(cands)")
        precondition(BundledRuntime.bunCandidates(home: home, pathEnv: nil) == ["/Users/someone/.bun/bin/bun", "/opt/homebrew/bin/bun", "/usr/local/bin/bun"])
        // The pin is package.json's packageManager; a non-bun manager or a malformed one pins nothing.
        let pinJson: (String) -> Data = { Data($0.utf8) }
        precondition(BundledRuntime.bunPin(packageJson: pinJson(#"{"packageManager":"bun@1.4.4"}"#)) == "1.4.4")
        precondition(BundledRuntime.bunPin(packageJson: pinJson(#"{"packageManager":"npm@10.0.0"}"#)) == nil)
        precondition(BundledRuntime.bunPin(packageJson: pinJson(#"{"packageManager":"bun@1.4"}"#)) == nil)
        precondition(BundledRuntime.bunPin(packageJson: nil) == nil)
        precondition(BundledRuntime.versionAtLeast("1.4.4", "1.4.4"))
        precondition(BundledRuntime.versionAtLeast("1.10.0", "1.4.4"))
        precondition(!BundledRuntime.versionAtLeast("1.3.9", "1.4.4"))
        precondition(!BundledRuntime.versionAtLeast("garbage", "1.4.4"))
        // An older bun (1.3.9 at ~/.bun) is passed over for a new enough one; a canary counts by its release part.
        let versions = ["/a/bun": "1.3.9\n", "/b/bun": "1.5.0-canary.2", "/c/bun": "1.4.4"]
        let exists: (String) -> Bool = { versions[$0] != nil }
        precondition(BundledRuntime.pickBun(candidates: ["/missing/bun", "/a/bun", "/b/bun", "/c/bun"], pin: "1.4.4", fileExists: exists, version: { versions[$0] }) == "/b/bun")
        precondition(BundledRuntime.pickBun(candidates: ["/a/bun"], pin: "1.4.4", fileExists: exists, version: { versions[$0] }) == nil)
        precondition(BundledRuntime.pickBun(candidates: ["/a/bun"], pin: nil, fileExists: exists, version: { versions[$0] }) == "/a/bun")
        precondition(BundledRuntime.pickBun(candidates: ["/a/bun"], pin: nil, fileExists: exists, version: { _ in nil }) == nil)

        // (The checkout an older app built in <data>/source: tests/desktop/app-built-checkout-tests.swift.)
        // A folder is a checkout to run from only with its own package.json and a built dist/cli.js.
        precondition(BundledRuntime.isBuiltCheckout(checkout, fileExists: { [checkout + "/package.json", checkout + "/dist/cli.js"].contains($0) }))
        precondition(!BundledRuntime.isBuiltCheckout(checkout, fileExists: { $0 == checkout + "/dist/cli.js" }))
        precondition(!BundledRuntime.isBuiltCheckout(checkout, fileExists: { $0 == checkout + "/package.json" }))

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

        // A release build carries this Mac's file: install.sh takes it from this
        // disk, whatever release mirror or version the caller's knobs name.
        let res = "/Applications/My Apps/Walnut.app/Contents/Resources"
        let tree: [String: [String]] = [
            res + "/release": ["v0.9.1", ".DS_Store"],
            res + "/release/v0.9.1": ["SHA256SUMS", "walnut-0.9.1-darwin-arm64"],
        ]
        let list: (String) -> [String] = { tree[$0] ?? [] }
        let carried = BundledRuntime.carriedRelease(resources: res, arch: "arm64", list: list)
        precondition(carried == BundledRuntime.CarriedRelease(version: "0.9.1", root: res + "/release"))
        let offline = BundledRuntime.installEnvironment(base: [
            "OPEN_WALNUT_VERSION": "0.7.0", "OPEN_WALNUT_RELEASE_BASE_URL": "http://127.0.0.1:9/r",
        ], home: home, carried: carried)
        precondition(offline["OPEN_WALNUT_RELEASE_BASE_URL"] == "file://" + res + "/release")
        precondition(offline["OPEN_WALNUT_VERSION"] == "0.9.1")
        precondition(offline["OPEN_WALNUT_INSTALL_DIR"] == rt.installDir)
        // The Intel DMG on Apple silicon, or the other way round: download this Mac's build.
        precondition(BundledRuntime.carriedRelease(resources: res, arch: "x64", list: list) == nil)
        // A dev build carries nothing; nor does a release missing its checksums.
        precondition(BundledRuntime.carriedRelease(resources: "/nowhere", arch: "arm64", list: list) == nil)
        let noSums: (String) -> [String] = { $0.hasSuffix("/v0.9.1") ? ["walnut-0.9.1-darwin-arm64"] : list($0) }
        precondition(BundledRuntime.carriedRelease(resources: res, arch: "arm64", list: noSums) == nil)
        // Its .gz counts too; an archive (an app built before the file) does not.
        let gz: (String) -> [String] = { $0.hasSuffix("/v0.9.1") ? ["SHA256SUMS", "walnut-0.9.1-darwin-x64.gz"] : list($0) }
        precondition(BundledRuntime.carriedRelease(resources: res, arch: "x64", list: gz) == BundledRuntime.CarriedRelease(version: "0.9.1", root: res + "/release"))
        let archive: (String) -> [String] = { $0.hasSuffix("/v0.9.1") ? ["SHA256SUMS", "open-walnut-0.9.1-darwin-arm64.tar.gz"] : list($0) }
        precondition(BundledRuntime.carriedRelease(resources: res, arch: "arm64", list: archive) == nil)
        // Rosetta never turns an Apple silicon Mac into an Intel one.
        precondition(BundledRuntime.machineArch(arm64Capable: true) == "arm64")
        precondition(BundledRuntime.machineArch(arm64Capable: false) == "x64")
        #if arch(arm64)
        precondition(BundledRuntime.machineArch() == "arm64")
        #endif

        // The server: the user's tools first; an archive's Node last (its launcher's rule).
        let path = rt.serverPath(current: "/usr/bin:/bin", extra: ["/opt/homebrew/bin"], layout: .archive)
        precondition(path == "/opt/homebrew/bin:/usr/bin:/bin:/Users/someone/.local/share/open-walnut/app/runtime/bin")
        precondition(rt.serverPath(current: "/usr/bin:/bin", extra: ["/opt/homebrew/bin"], layout: .file(version: "0.7.0")) == "/opt/homebrew/bin:/usr/bin:/bin")

        // The spinner shows install.sh's latest step, not its blank lines.
        let out = "\n  Finding the newest release...\n  Installing Open Walnut 0.7.0 (darwin-arm64)...\n  Downloading walnut-0.7.0-darwin-arm64.gz...\n\n"
        precondition(BundledRuntime.statusLine(from: out) == "Downloading walnut-0.7.0-darwin-arm64.gz...")
        precondition(BundledRuntime.statusLine(from: "") == nil)

        // The setup screen speaks of Walnut, not of install.sh's files and PATH hints.
        precondition(BundledRuntime.friendlyStatus("Finding the newest release...") == "Finding the latest Walnut...")
        precondition(BundledRuntime.friendlyStatus("Installing Open Walnut 0.7.0 (darwin-arm64)...") == "Getting Walnut 0.7.0...")
        precondition(BundledRuntime.friendlyStatus("Downloading walnut-0.7.0-darwin-arm64.gz...") == "Downloading Walnut...")
        precondition(BundledRuntime.friendlyStatus("Unpacking...") == "Unpacking...")
        precondition(BundledRuntime.friendlyStatus("Unpacking the walnut-0.9.1-darwin-arm64.gz it came with...") == "Unpacking...")
        precondition(BundledRuntime.friendlyStatus("Installing the walnut-0.9.1-darwin-arm64 it came with...") == "Installing Walnut...")
        precondition(BundledRuntime.downloadFraction(from: "  Installing Open Walnut 0.9.1 (darwin-arm64)...\n  Installing the walnut-0.9.1-darwin-arm64 it came with...\n") == nil)
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

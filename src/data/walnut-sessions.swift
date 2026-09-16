// walnut-sessions — the macOS execution identity for Walnut's agent sessions.
//
// WHY THIS EXISTS
//
// macOS attributes a file access to the RESPONSIBLE process, which is inherited
// at spawn time from the top of the launcher chain. Walnut's server is
// `node dist/cli.js web`, so the daemon it spawns, the `claude` CLI under that,
// and every tool the CLI runs all inherited `…/bin/node` as their responsible
// process. Three consequences the user actually saw:
//
//   - the dialog says `"node" would like to access data from other apps`, naming
//     a shared runtime instead of the thing that is asking;
//   - the grant belongs to that node build, so a Homebrew node upgrade throws it
//     away, and every other node program on the machine shares it;
//   - the automatic app-container permission lasts only while the granted app is
//     running (WWDC23 session 10053), so the chain's short-lived processes kept
//     re-asking.
//
// This binary is a stable, signed bundle that sits ABOVE the daemon: it makes
// itself the responsible process, then launches the daemon. Everything the
// daemon starts is then attributed to `Walnut Sessions` — one long-lived identity
// the user can grant to once, independent of which node is installed and of
// whether Walnut was started from a terminal or from Walnut.app.
//
// WHAT IT MUST NOT DO
//
// Be visible in any other way. It is a transparent supervisor: same argv, same
// environment, same file descriptors, exit status mirrored bit for bit, signals
// forwarded. The daemon's exit status is load-bearing — it exits non-zero on
// purpose so launchd restarts it to finish a service update — so swallowing or
// normalising it would silently break daemon updates. It also must not call
// setsid() or change the process group: the LaunchAgent sets AbandonProcessGroup,
// and the daemon reaps sessions through the process groups it makes itself.
//
// WHAT THE MANIFEST IS AND IS NOT
//
// A tool that runs anything handed to it under a granted identity would be a
// permission bypass for every other program on the machine, so this one runs only
// a command listed in a user-private manifest beside the bundle, and re-verifies
// the payload's hash before exec. Be precise about the limit: the manifest is
// owned by the same user, so code running AS THAT USER can rewrite it. This
// guards against other software casually reusing the host, and against a payload
// swapped after it was approved. It is NOT a sandbox and NOT a defence against
// same-user malware — macOS offers no user-level mechanism that would be.
//
// Built, signed and installed on demand by src/providers/session-host.ts.

import CryptoKit
import Darwin
import Foundation

// MARK: - Private responsibility API

/// `responsibility_spawnattrs_setdisclaim` (libsystem, private): marks a spawn as
/// disclaiming the parent's responsibility, so the child becomes its own TCC
/// subject. The same call Chromium and OBS use, and the same one Walnut's
/// calendar/reader helpers already depend on.
private typealias DisclaimFunction = @convention(c) (UnsafeMutablePointer<posix_spawnattr_t?>?, Int32) -> Int32
private typealias ResponsibleForFunction = @convention(c) (pid_t) -> pid_t

private let dynamicDefault = UnsafeMutableRawPointer(bitPattern: -2)

private func responsiblePid(for pid: pid_t) -> pid_t {
    guard let symbol = dlsym(dynamicDefault, "responsibility_get_pid_responsible_for_pid") else { return -1 }
    return unsafeBitCast(symbol, to: ResponsibleForFunction.self)(pid)
}

// MARK: - Exit paths

/// Reserved for the host's OWN refusals, so a Walnut-side caller can tell "the
/// host would not run this" from any status the payload chose for itself.
private let refusalStatus: Int32 = 125

private func refuse(_ message: String) -> Never {
    FileHandle.standardError.write(Data(("walnut-sessions: " + message + "\n").utf8))
    exit(refusalStatus)
}

// MARK: - Path checks

/// Ours: the manifest and the directory holding it. Rejects anything another
/// account could have influenced. lstat, so a symlink is a refusal rather than
/// something we follow elsewhere.
private func checkPrivate(_ path: String, expectDirectory: Bool) {
    var info = stat()
    guard lstat(path, &info) == 0 else { refuse("cannot read \(path)") }
    let kind = info.st_mode & S_IFMT
    guard kind == (expectDirectory ? S_IFDIR : S_IFREG) else {
        refuse("\(path) is not \(expectDirectory ? "a directory" : "a regular file")")
    }
    guard info.st_uid == geteuid() else { refuse("\(path) is owned by uid \(info.st_uid)") }
    // A directory of ours may be readable by others but never writable. The
    // manifest must not even be readable: it names what this identity will run.
    let forbidden: mode_t = expectDirectory ? 0o022 : 0o077
    guard (info.st_mode & forbidden) == 0 else {
        refuse("\(path) is mode \(String(info.st_mode & 0o777, radix: 8)), which is too permissive")
    }
}

/// A payload file (the daemon binary, the interpreter, the script).
///
/// Deliberately NOT the check above. These live wherever the machine put them —
/// `/usr/bin`, a root-owned Homebrew prefix, a symlink farm — and demanding that
/// we own the directory would refuse to run on ordinary installs while adding
/// nothing: root-owned is MORE trustworthy, not less. The hash is the integrity
/// statement here; the only thing worth refusing is a payload that anyone on the
/// machine could rewrite between approval and exec.
private func checkPayload(_ path: String) {
    var info = stat()
    guard stat(path, &info) == 0 else { refuse("cannot read \(path)") }
    guard (info.st_mode & S_IFMT) == S_IFREG else { refuse("\(path) is not a regular file") }
    guard (info.st_mode & 0o022) == 0 else {
        refuse("\(path) is mode \(String(info.st_mode & 0o777, radix: 8)); it is writable by others")
    }
}

private func sha256(ofFile path: String) -> String {
    guard let handle = FileHandle(forReadingAtPath: path) else { refuse("cannot open \(path)") }
    defer { try? handle.close() }
    var hasher = SHA256()
    while true {
        let chunk: Data?
        do { chunk = try handle.read(upToCount: 1 << 20) } catch { refuse("cannot read \(path)") }
        guard let chunk, !chunk.isEmpty else { break }
        hasher.update(data: chunk)
    }
    return hasher.finalize().map { String(format: "%02x", $0) }.joined()
}

// MARK: - Manifest

private struct LaunchEntry {
    let argv: [String]
    let files: [(path: String, sha256: String)]
}

/// Beside the bundle, resolved from OUR OWN bundle path — never from an argument
/// or an environment variable, so what this identity may run cannot be redirected
/// by whoever starts it.
private func manifestPath() -> String {
    (Bundle.main.bundleURL.path as NSString).deletingLastPathComponent + "/session-host-launch.json"
}

private func loadEntries() -> [LaunchEntry] {
    let manifest = manifestPath()
    checkPrivate((manifest as NSString).deletingLastPathComponent, expectDirectory: true)
    checkPrivate(manifest, expectDirectory: false)
    guard let data = FileManager.default.contents(atPath: manifest),
          let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
        refuse("\(manifest) is not readable JSON")
    }
    guard (root["version"] as? Int) == 1 else { refuse("unsupported manifest version") }
    guard let commands = root["commands"] as? [[String: Any]], !commands.isEmpty else {
        refuse("\(manifest) lists no commands")
    }
    return commands.map { command in
        guard let argv = command["argv"] as? [String], let program = argv.first, program.hasPrefix("/") else {
            refuse("a manifest command has no absolute argv")
        }
        let files = (command["files"] as? [[String: String]] ?? []).map { file -> (String, String) in
            guard let path = file["path"], path.hasPrefix("/"),
                  let sha = file["sha256"], sha.count == 64 else {
                refuse("a manifest file entry is incomplete")
            }
            return (path, sha)
        }
        return LaunchEntry(argv: argv, files: files)
    }
}

private func authorize(_ requested: [String]) -> [String] {
    guard let match = loadEntries().first(where: { $0.argv == requested }) else {
        refuse("this command is not approved in \(manifestPath())")
    }
    for file in match.files {
        checkPayload(file.path)
        let actual = sha256(ofFile: file.path)
        guard actual == file.sha256 else {
            refuse("\(file.path) hashes \(actual) but was approved as \(file.sha256)")
        }
    }
    return match.argv
}

// MARK: - Spawning and supervision

private func spawn(_ argv: [String], environment: [String: String], disclaimed: Bool) -> pid_t {
    var attributes: posix_spawnattr_t?
    guard posix_spawnattr_init(&attributes) == 0 else { refuse("posix_spawnattr_init failed") }
    defer { posix_spawnattr_destroy(&attributes) }
    if disclaimed {
        guard let symbol = dlsym(dynamicDefault, "responsibility_spawnattrs_setdisclaim") else {
            // Without this call the entire point is lost, and continuing would
            // report a separate identity that macOS does not agree with.
            refuse("responsibility_spawnattrs_setdisclaim is unavailable on this macOS")
        }
        guard unsafeBitCast(symbol, to: DisclaimFunction.self)(&attributes, 1) == 0 else {
            refuse("could not disclaim the parent's responsibility")
        }
    }
    var argvC = argv.map { strdup($0) }
    var envC = environment.map { strdup("\($0.key)=\($0.value)") }
    defer { argvC.forEach { free($0) }; envC.forEach { free($0) } }
    argvC.append(nil)
    envC.append(nil)
    var child: pid_t = 0
    let code = posix_spawn(&child, argv[0], nil, &attributes, argvC, envC)
    guard code == 0 else { refuse("could not start \(argv[0]): \(String(cString: strerror(code)))") }
    return child
}

private var pendingSignal: sig_atomic_t = 0
private let forwardedSignals: [Int32] = [SIGTERM, SIGINT, SIGHUP, SIGQUIT]

private func forwardSignals() {
    for value in forwardedSignals {
        signal(value) { received in pendingSignal = received }
        // Let waitpid() return EINTR so a forwarded signal is delivered promptly
        // instead of after the child happens to exit.
        siginterrupt(value, 1)
    }
}

/// Wait for the child and BECOME its exit status. A signalled death is re-raised
/// rather than turned into a number, so our own parent sees what really happened.
private func supervise(_ child: pid_t) -> Never {
    var status: Int32 = 0
    while true {
        if pendingSignal != 0 {
            let forwarded = pendingSignal
            pendingSignal = 0
            _ = kill(child, forwarded)
        }
        let result = waitpid(child, &status, 0)
        if result == child { break }
        if result == -1 && errno == EINTR { continue }
        refuse("waitpid failed: \(String(cString: strerror(errno)))")
    }
    let terminatingSignal = status & 0x7f
    if terminatingSignal == 0 { exit((status >> 8) & 0xff) }
    signal(terminatingSignal, SIG_DFL)
    raise(terminatingSignal)
    exit(128 + terminatingSignal)
}

// MARK: - Entry point

/// Marks the re-exec'd (already disclaimed) generation. Removed from the
/// payload's environment so it can never be mistaken for a Walnut setting.
private let disclaimedMarker = "WALNUT_SESSION_HOST_DISCLAIMED"

let arguments = Array(CommandLine.arguments.dropFirst())

// `--identity`: what this process is, for Walnut's reporting and for tests. The
// only mode that produces stdout — proof of the responsible process has to come
// from the running program, not from an assumption about it.
if arguments.first == "--identity" {
    let mine = getpid()
    let payload: [String: Any] = [
        "pid": mine,
        "parentPid": getppid(),
        "responsiblePid": responsiblePid(for: mine),
        "selfResponsible": responsiblePid(for: mine) == mine,
        "bundlePath": Bundle.main.bundleURL.path,
        "bundleIdentifier": Bundle.main.bundleIdentifier ?? "",
        "executablePath": Bundle.main.executablePath ?? "",
        "disclaimed": ProcessInfo.processInfo.environment[disclaimedMarker] == "1",
        "manifestPath": manifestPath(),
    ]
    if let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]) {
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([0x0a]))
    }
    exit(0)
}

guard arguments.count >= 2, arguments[0] == "--" else {
    refuse("usage: WalnutSessionsHost -- /absolute/program [args...]")
}
let requested = Array(arguments.dropFirst())

var environment = ProcessInfo.processInfo.environment
if environment[disclaimedMarker] != "1" {
    // First generation. Nothing is validated yet on purpose: re-exec as our own
    // TCC subject first, so the process that reads the manifest and runs the
    // payload is the one macOS holds responsible.
    guard let executable = Bundle.main.executablePath else { refuse("no executable path") }
    environment[disclaimedMarker] = "1"
    forwardSignals()
    supervise(spawn([executable] + arguments, environment: environment, disclaimed: true))
}

// Second generation: this process is the identity macOS attributes the daemon's
// file access to. Authorise, then get out of the way.
let approved = authorize(requested)
environment.removeValue(forKey: disclaimedMarker)
forwardSignals()
supervise(spawn(approved, environment: environment, disclaimed: false))

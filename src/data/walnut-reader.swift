// walnut-reader — read one file that TCC keeps from the rest of Walnut, and write
// its bytes to stdout. That is the entire program.
//
//   walnut-reader read <absolute-path>   → bytes on stdout, exit 0
//                                          exit 2: bad arguments / not a file
//                                          exit 3: Full Disk Access missing
//                                          exit 4: read failed for another reason
//   walnut-reader probe <absolute-path>  → exit code only, no bytes (permission check)
//
// ── Where it runs: inside Walnut.app first ──
//
// The SAME file is compiled into Walnut.app (desktop/build.sh, with -D WALNUT_APP),
// where `Walnut --reader-bridge read|probe <path>` runs walnutReaderMain. That is
// the preferred route, for the reason the calendar bridge exists: Full Disk Access
// then belongs to Walnut itself, the name the user knows and one certificate-signed
// identity that survives every rebuild, and it is the SAME grant that stops the
// "would like to access data from other apps" popups in agent sessions (those run
// under `Walnut --session-host`). One row in System Settings, one grant, every
// feature. The standalone helper below remains for installs with no Walnut.app
// (src/core/protected-reader.ts picks the route).
//
// An earlier version of this comment argued the opposite: that FDA should go to
// this tiny program rather than to the app that runs agent sessions. The user
// decided otherwise, deliberately: sessions already run as Walnut, so Walnut is
// the one program the user is choosing to trust, and a second, differently named
// grant for the same machine only reads as Walnut asking twice.
//
// FDA is unlike every other permission Walnut uses. There is no API to request it
// and no dialog: a process either has it or gets a bare "Operation not permitted".
// The only way to grant it is for a human to open System Settings, Privacy &
// Security, Full Disk Access, press PLUS (which requires Touch ID), and add the
// program. Nothing here can ever put a dialog on screen.
//
// Whether the grant survives updates: an ad-hoc signed binary's TCC identity
// includes its content hash, so ANY change makes macOS treat it as a different
// program and the grant stops applying — silently, with the stale row still shown
// as enabled in System Settings (recovering needs MINUS then PLUS on the same
// path; toggling does nothing). src/core/helper-build.ts signs the helper with a
// certificate when the machine has one, and this program is deliberately so
// simple that it almost never needs to change: all the logic that does change
// (SQL, schema, folding, UI) lives in TypeScript and operates on bytes this
// program handed over.
//
// Keep it that way. Do not add a feature here. If a caller needs something parsed,
// parse it in TypeScript.
//
// ── The safety properties, and how they are enforced rather than intended ──
//
// 1. It cannot write anything. There is no file-writing code path at all: output
//    goes to stdout only. "This helper never modifies the file it reads" is a
//    structural fact, not a rule someone has to remember. Callers that need a
//    copy (e.g. a SQLite database, which must be read from a copy so that sqlite
//    never opens the protected original) redirect stdout into their own temp file.
// 2. It reads only regular files, resolved through realpath first, so a symlink
//    cannot aim it somewhere unintended, and it refuses directories and devices.
// 3. It never executes anything, never opens a network connection, and takes no
//    input other than one path argument.
//
// ── TCC self-responsibility ──
//
// TCC attributes a file access to the RESPONSIBLE process, which is normally the
// top of the parent chain: Walnut.app, a terminal, or a launchd job, depending on
// how the user happened to start the server. That would make the grant target
// depend on the launcher, so the same machine would work when launched one way and
// silently fail the other. Re-exec with responsibility DISCLAIMED so this binary
// is its own TCC subject and the grant always belongs to it (inside Walnut.app,
// that subject is Walnut). Same mechanism as walnut-activity, minus the signal
// forwarding: this process is short-lived, so the wrapper just waits and mirrors
// the child's exit status.
//
// Everything at file scope is `private`: in the app build this file shares a
// module with desktop/*.swift, and only walnutReaderMain is meant to be seen.

import Foundation

private let HELPER_VERSION = "v1"

private let EXIT_BAD_INPUT: Int32 = 2
private let EXIT_NO_PERMISSION: Int32 = 3
private let EXIT_READ_FAILED: Int32 = 4

/// Bytes per write to stdout. Large enough to be cheap on a multi-megabyte
/// database, small enough that memory stays flat on any input size.
private let CHUNK = 1 << 20

// ── responsibility ──────────────────────────────────────────────────────────

private func reexecDisclaimedIfNeeded() {
    guard ProcessInfo.processInfo.environment["WALNUT_READER_DISCLAIMED"] != "1" else { return }
    typealias DisclaimFn = @convention(c) (UnsafeMutablePointer<posix_spawnattr_t?>?, Int32) -> Int32
    let RTLD_DEFAULT = UnsafeMutableRawPointer(bitPattern: -2)
    // Private symbol: if it ever disappears, fall through and run inline. The
    // caller then sees whatever the launcher's own grant allows, which is strictly
    // better than refusing to run.
    guard let sym = dlsym(RTLD_DEFAULT, "responsibility_spawnattrs_setdisclaim") else { return }
    let setDisclaim = unsafeBitCast(sym, to: DisclaimFn.self)

    var attr: posix_spawnattr_t?
    guard posix_spawnattr_init(&attr) == 0 else { return }
    defer { posix_spawnattr_destroy(&attr) }
    guard setDisclaim(&attr, 1) == 0 else { return }

    let exePath = Bundle.main.executablePath ?? CommandLine.arguments[0]
    var argv: [UnsafeMutablePointer<CChar>?] = CommandLine.arguments.map { strdup($0) }
    argv.append(nil)
    var env = ProcessInfo.processInfo.environment
    env["WALNUT_READER_DISCLAIMED"] = "1"
    var envp: [UnsafeMutablePointer<CChar>?] = env.map { strdup("\($0.key)=\($0.value)") }
    envp.append(nil)

    var pid: pid_t = 0
    guard posix_spawn(&pid, exePath, nil, &attr, argv, envp) == 0 else { return } // run inline
    var status: Int32 = 0
    while waitpid(pid, &status, 0) == -1 && errno == EINTR {}
    // Mirror the inner exit faithfully: the caller distinguishes "no permission"
    // from "read failed" by exit code, so collapsing them would hide the one
    // failure that has a user-facing fix.
    if status & 0x7f == 0 {
        exit((status >> 8) & 0xff)
    }
    exit(EXIT_READ_FAILED)
}

// ── path validation ─────────────────────────────────────────────────────────

/// Resolve and vet the path. Returns nil after printing why, so a caller never
/// has to guess whether an empty stdout meant "empty file" or "rejected input".
private func resolvedRegularFile(_ raw: String) -> String? {
    guard raw.hasPrefix("/") else {
        FileHandle.standardError.write(Data("walnut-reader: path must be absolute\n".utf8))
        return nil
    }
    // realpath BEFORE any check, so a symlink cannot make the checks describe one
    // file while the read opens another.
    guard let real = realpath(raw, nil) else {
        // ENOENT here is the ordinary "no such file" answer AND what a missing FDA
        // grant looks like for a path inside a protected directory, so the errno
        // has to be forwarded rather than flattened.
        let err = errno
        FileHandle.standardError.write(Data("walnut-reader: \(String(cString: strerror(err)))\n".utf8))
        exit(err == EPERM || err == EACCES ? EXIT_NO_PERMISSION : EXIT_BAD_INPUT)
    }
    defer { free(real) }
    let path = String(cString: real)

    var st = stat()
    guard stat(path, &st) == 0 else {
        let err = errno
        FileHandle.standardError.write(Data("walnut-reader: \(String(cString: strerror(err)))\n".utf8))
        exit(err == EPERM || err == EACCES ? EXIT_NO_PERMISSION : EXIT_BAD_INPUT)
    }
    guard st.st_mode & S_IFMT == S_IFREG else {
        FileHandle.standardError.write(Data("walnut-reader: not a regular file\n".utf8))
        return nil
    }
    return path
}

// ── read ────────────────────────────────────────────────────────────────────

/// Open read-only and stream to stdout. `probeOnly` opens and closes without
/// emitting anything, which is how the caller asks "do I have permission yet"
/// without moving megabytes.
private func emit(_ path: String, probeOnly: Bool) -> Never {
    let fd = open(path, O_RDONLY)
    if fd < 0 {
        let err = errno
        FileHandle.standardError.write(Data("walnut-reader: \(String(cString: strerror(err)))\n".utf8))
        // EPERM is what TCC returns for a protected path. EACCES is ordinary file
        // permissions. Both are "a human must change something", so both map to
        // the exit code whose message offers the Full Disk Access fix.
        exit(err == EPERM || err == EACCES ? EXIT_NO_PERMISSION : EXIT_READ_FAILED)
    }
    defer { close(fd) }
    if probeOnly { exit(0) }

    var buf = [UInt8](repeating: 0, count: CHUNK)
    while true {
        let n = buf.withUnsafeMutableBytes { read(fd, $0.baseAddress, CHUNK) }
        if n < 0 {
            if errno == EINTR { continue }
            let err = errno
            FileHandle.standardError.write(Data("walnut-reader: \(String(cString: strerror(err)))\n".utf8))
            exit(EXIT_READ_FAILED)
        }
        if n == 0 { break }
        var off = 0
        while off < n {
            let w = buf.withUnsafeBytes { write(1, $0.baseAddress!.advanced(by: off), n - off) }
            if w < 0 {
                if errno == EINTR { continue }
                // A closed pipe is the caller giving up, not an error worth noise.
                exit(errno == EPIPE ? 0 : EXIT_READ_FAILED)
            }
            off += w
        }
    }
    exit(0)
}

// ── main ────────────────────────────────────────────────────────────────────

/// One request, then exit. `args` is argv-shaped: args[0] is the program, args[1]
/// the subcommand. Walnut.app passes its own argv with `--reader-bridge` removed.
func walnutReaderMain(_ args: [String]) -> Never {
    reexecDisclaimedIfNeeded()
    if args.count == 2, args[1] == "--version" {
        print(HELPER_VERSION)
        exit(0)
    }
    guard args.count == 3, args[1] == "read" || args[1] == "probe" else {
        FileHandle.standardError.write(Data("usage: walnut-reader read|probe <absolute-path>\n".utf8))
        exit(EXIT_BAD_INPUT)
    }
    guard let path = resolvedRegularFile(args[2]) else { exit(EXIT_BAD_INPUT) }
    emit(path, probeOnly: args[1] == "probe")
}

// The helper's entry point. `@main` rather than a bare call because Swift rejects a
// top-level expression in a non-main file even inside an INACTIVE #if, and in the
// app build this file is not main.swift. Needs -parse-as-library when compiled on
// its own (READER_SPEC.parseAsLibrary in src/core/protected-reader.ts).
#if !WALNUT_APP
@main
struct WalnutReaderHelper {
    static func main() { walnutReaderMain(CommandLine.arguments) }
}
#endif

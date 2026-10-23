import Foundation

// The checkout an older version of this app built, before the compiled file.
// Its "Set Up Now" ran, for a data home <home>:
//
//   git clone --depth 1 https://github.com/EvanZhang008/open-walnut.git <home>/source
//     (with a clone already there: git -C <home>/source pull --ff-only)
//   npm install, then tsup and vite into dist/ (git ignores node_modules/ and dist/)
//   rm <home>/source/src/providers/daemon-standalone.ts
//
// and started `<node> <home>/source/dist/cli.js web --port <port>`, its pid in
// server.pid. That checkout runs on neither runtime now (its packages were built
// for Node), so the setup moves to the self-contained Walnut and keeps its data:
// the old server is stopped first, and the checkout (about 1 GB) is removed once
// the new Walnut has served. A checkout at the same place that the user keeps
// (their own commits, edits, branch or remote) is never taken for that one: it
// keeps running as a checkout, on bun, and is never removed.
//
// Everything is read from files and one `git status`, with no network.
// Foundation only, so tests/desktop/app-built-checkout-tests.swift compiles it alone.

enum AppBuiltCheckout {
    /// What the old app cloned, and the branch that clone checked out.
    static let repoURL = "https://github.com/EvanZhang008/open-walnut.git"
    static let branch = "main"
    /// The tracked file the old build deleted: the mark it left on its checkout.
    static let buildMark = "src/providers/daemon-standalone.ts"
    /// npm rewrites a tracked lockfile, or writes its own beside bun's, by itself.
    static let npmLockfiles: Set<String> = ["package-lock.json", "web/package-lock.json"]

    /// Where the old app put it: `<data home>/source`.
    static func location(walnutHome: String) -> String {
        let home = walnutHome.hasSuffix("/") ? String(walnutHome.dropLast()) : walnutHome
        return home + "/source"
    }

    /// A saved setup that runs `<data home>/source`, the place the old app built in.
    static func isOldAppLocation(walnutHome: String, sourceDir: String) -> Bool {
        return !walnutHome.isEmpty && walnutHome != "/" && sourceDir == location(walnutHome: walnutHome)
    }

    enum Verdict: Equatable {
        /// Provably the old app's own clone and build, with nothing of the user's in it.
        case appBuilt
        /// Something in it is not the old app's (the reason, for the log).
        case notAppBuilt(String)
        /// The files say the old app's, but git could not confirm the work tree.
        case undetermined(String)

        var logValue: String {
            switch self {
            case .appBuilt: return "app_built"
            case .notAppBuilt(let why): return "not_app_built: " + why
            case .undetermined(let why): return "undetermined: " + why
            }
        }
    }

    // MARK: What counts as app-built

    /// The remotes in `.git/config`: name to its urls.
    static func remotes(gitConfig: String) -> [String: [String]] {
        var out: [String: [String]] = [:]
        var current: String?
        for raw in gitConfig.split(whereSeparator: \.isNewline) {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if line.hasPrefix("[") {
                current = nil
                let inner = line.dropFirst().prefix { $0 != "]" }
                if inner.hasPrefix("remote \""), inner.hasSuffix("\""), inner.count > 9 {
                    let name = String(inner.dropFirst(8).dropLast())
                    current = name
                    out[name, default: []] += []
                }
                continue
            }
            guard let remote = current, let eq = line.firstIndex(of: "=") else { continue }
            let key = line[..<eq].trimmingCharacters(in: .whitespaces).lowercased()
            if key == "url" {
                out[remote, default: []].append(line[line.index(after: eq)...].trimmingCharacters(in: .whitespaces))
            }
        }
        return out
    }

    /// The messages of a reflog (`.git/logs/HEAD`): what follows each line's tab.
    static func reflogMessages(_ reflog: String) -> [String] {
        return reflog.split(whereSeparator: \.isNewline).map { line in
            guard let tab = line.firstIndex(of: "\t") else { return "" }
            return String(line[line.index(after: tab)...])
        }
    }

    /// The checks on the clone itself, from files only. nil: all of them pass.
    /// A reflog git was told not to keep proves nothing either way; one it kept
    /// must hold the clone and the old app's pulls and nothing else.
    static func checkClone(isGitDirectory: Bool, isShallow: Bool, gitConfig: String?, headReflog: String?, repoURL: String = repoURL) -> Verdict? {
        guard isGitDirectory else { return .notAppBuilt("no .git directory") }
        guard isShallow else { return .notAppBuilt("not a shallow clone") }
        guard let config = gitConfig else { return .notAppBuilt("no .git/config") }
        let found = remotes(gitConfig: config)
        guard found == ["origin": [repoURL]] else { return .notAppBuilt("remotes are not the app's clone") }
        if let reflog = headReflog, !reflog.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            let messages = reflogMessages(reflog)
            guard messages.first == "clone: from " + repoURL else { return .notAppBuilt("not cloned from " + repoURL) }
            if let other = messages.dropFirst().first(where: { !$0.hasPrefix("pull --ff-only: ") }) {
                return .notAppBuilt("git history has other work: " + other)
            }
        }
        return nil
    }

    /// The check on the work tree: `git status --porcelain=v2 --branch -z`. On the
    /// app's branch, tracking its upstream, no commit of its own, and no change but
    /// the old build's: its mark deleted (required) and npm's lockfiles.
    static func checkStatus(_ status: String?) -> Verdict {
        guard let status = status else { return .undetermined("git status did not answer") }
        var head: String?
        var upstream: String?
        var ahead: Int?
        var sawMark = false
        for entry in status.split(separator: "\0", omittingEmptySubsequences: true).map(String.init) {
            if entry.hasPrefix("# branch.head ") {
                head = String(entry.dropFirst("# branch.head ".count))
            } else if entry.hasPrefix("# branch.upstream ") {
                upstream = String(entry.dropFirst("# branch.upstream ".count))
            } else if entry.hasPrefix("# branch.ab ") {
                let ab = entry.dropFirst("# branch.ab ".count).split(separator: " ")
                if ab.count == 2, ab[0].hasPrefix("+") { ahead = Int(ab[0].dropFirst()) }
            } else if entry.hasPrefix("# ") {
                continue
            } else if entry.hasPrefix("1 ") {
                // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
                let parts = entry.split(separator: " ", maxSplits: 8, omittingEmptySubsequences: false).map(String.init)
                guard parts.count == 9 else { return .notAppBuilt("unreadable status line") }
                let (xy, path) = (parts[1], parts[8])
                if xy == ".D" && path == buildMark {
                    sawMark = true
                } else if xy == ".M" && npmLockfiles.contains(path) {
                    continue
                } else {
                    return .notAppBuilt("changed: " + path)
                }
            } else if entry.hasPrefix("? ") {
                let path = String(entry.dropFirst(2))
                if !npmLockfiles.contains(path) { return .notAppBuilt("untracked: " + path) }
            } else {
                // A rename, a conflict, anything else: not something the old build did.
                return .notAppBuilt("status: " + String(entry.prefix(40)))
            }
        }
        guard head == branch else { return .notAppBuilt("branch is " + (head ?? "detached")) }
        guard upstream == "origin/" + branch else { return .notAppBuilt("upstream is " + (upstream ?? "none")) }
        guard let a = ahead, a == 0 else { return .notAppBuilt("commits not on its upstream") }
        guard sawMark else { return .notAppBuilt(buildMark + " is still there") }
        return .appBuilt
    }

    /// Whether the setup moves to the self-contained Walnut. The old app's checkout
    /// does, and so does one the files say is the old app's when git cannot look
    /// (a Mac without a usable git): moving removes nothing until it is proven. A
    /// checkout the user keeps goes on running as it is, unless it cannot run.
    static func movesToRuntime(runnable: Bool, verdict: Verdict) -> Bool {
        if case .notAppBuilt = verdict { return !runnable }
        return true
    }

    /// Whether a setup that moved off the checkout keeps it pending removal. The
    /// removal proves it again first (`mayRemove`), so an undetermined one waits
    /// for a launch where git can look; one with the user's work in it is never queued.
    static func queuesRemoval(_ verdict: Verdict) -> Bool {
        if case .notAppBuilt = verdict { return false }
        return true
    }

    // MARK: The old app's server

    /// The old app's server on that checkout: a Node on `<sourceDir>/dist/cli.js
    /// web --port <port>`, as `ps` prints it. Not a checkout's bun, and not any
    /// other command or extra argument.
    static func isOldAppServerCommand(_ command: String, sourceDir: String) -> Bool {
        let script = " " + sourceDir + "/dist/cli.js web"
        guard let found = command.range(of: script) else { return false }
        let exe = command[..<found.lowerBound]
        guard exe == "node" || exe.hasSuffix("/node") else { return false }
        let rest = command[found.upperBound...]
        if rest.isEmpty { return true }
        guard rest.hasPrefix(" --port ") else { return false }
        let port = rest.dropFirst(" --port ".count)
        return !port.isEmpty && port.allSatisfy { $0.isASCII && $0.isNumber }
    }

    /// May the app stop this process? Only the old app's server on that checkout,
    /// and only with proof it is the old app's: its pid is the one the app
    /// recorded, or nothing owns it any more (its parent is launchd) and the
    /// checkout it runs is provably the old app's, which nobody runs by hand.
    static func mayStopOldServer(pid: Int32, ppid: Int32, command: String, recordedPid: Int32?, sourceDir: String, checkoutIsAppBuilt: Bool) -> Bool {
        guard pid > 1, isOldAppServerCommand(command, sourceDir: sourceDir) else { return false }
        if let recorded = recordedPid, recorded == pid { return true }
        return checkoutIsAppBuilt && ppid == 1
    }

    // MARK: When the checkout may be removed

    /// Only `<data home>/source`, only once the self-contained Walnut this app
    /// started has served, only when it is provably the old app's, and never the
    /// runtime's own install.
    static func mayRemove(dir: String, walnutHome: String, runtimeDir: String?, runtimeServed: Bool, verdict: Verdict) -> Bool {
        guard runtimeServed, verdict == .appBuilt, isOldAppLocation(walnutHome: walnutHome, sourceDir: dir) else { return false }
        guard let installed = runtimeDir else { return false }
        return installed != dir && !installed.hasPrefix(dir + "/")
    }

    /// Where a removal moves the checkout first (one rename, so a removal cut short
    /// never leaves a half checkout at `source`); only this app makes that name.
    static func removalStaging(sourceDir: String) -> String {
        return (sourceDir as NSString).deletingLastPathComponent + "/.walnut-app-removing-source"
    }

    // MARK: Reading a checkout (blocks: off the main thread)

    /// A git that runs without asking to install anything: /usr/bin/git is a shim
    /// that pops up the Command Line Tools installer on a Mac without them.
    static func findGit(developerDir: String?, isExecutable: (String) -> Bool = FileManager.default.isExecutableFile(atPath:)) -> String? {
        var candidates = ["/opt/homebrew/bin/git", "/usr/local/bin/git"]
        if let dir = developerDir, dir.hasPrefix("/") { candidates.append(dir + "/usr/bin/git") }
        candidates += ["/Library/Developer/CommandLineTools/usr/bin/git", "/Applications/Xcode.app/Contents/Developer/usr/bin/git"]
        return candidates.first(where: isExecutable)
    }

    static func developerDir() -> String? {
        guard let r = LocalProcess.run("/usr/bin/xcode-select", ["-p"], timeout: 5), r.status == 0 else { return nil }
        let dir = r.output.trimmingCharacters(in: .whitespacesAndNewlines)
        return dir.isEmpty ? nil : dir
    }

    /// The verdict on `sourceDir`: the files first, and `git status` only when they pass.
    static func check(sourceDir: String, repoURL: String = repoURL, git: String? = nil, timeout: TimeInterval = 15) -> Verdict {
        let fm = FileManager.default
        var isDir: ObjCBool = false
        let gitDir = sourceDir + "/.git"
        let isGitDirectory = fm.fileExists(atPath: gitDir, isDirectory: &isDir) && isDir.boolValue
        if let early = checkClone(
            isGitDirectory: isGitDirectory,
            isShallow: fm.fileExists(atPath: gitDir + "/shallow"),
            gitConfig: try? String(contentsOfFile: gitDir + "/config", encoding: .utf8),
            headReflog: try? String(contentsOfFile: gitDir + "/logs/HEAD", encoding: .utf8),
            repoURL: repoURL) {
            return early
        }
        guard let gitPath = git ?? findGit(developerDir: developerDir()) else { return .undetermined("no git on this Mac") }
        var env = ProcessInfo.processInfo.environment.filter { !$0.key.hasPrefix("GIT_") }
        env["GIT_OPTIONAL_LOCKS"] = "0"
        env["GIT_TERMINAL_PROMPT"] = "0"
        env["LC_ALL"] = "C"
        let r = LocalProcess.run(gitPath, [
            "-C", sourceDir, "--no-optional-locks", "-c", "core.fsmonitor=false",
            "status", "--porcelain=v2", "--branch", "-z", "--untracked-files=normal",
        ], environment: env, timeout: timeout)
        guard let result = r, result.status == 0 else { return .undetermined("git status failed") }
        return checkStatus(result.output)
    }

    /// Stops the old app's servers on `sourceDir`: the recorded pid and whatever
    /// listens on `ports`, each only when `mayStopOldServer` says so. Returns the
    /// pids that are gone.
    static func stopOldServers(sourceDir: String, recordedPid: Int32?, ports: [Int], checkoutIsAppBuilt: Bool, grace: TimeInterval = 8) -> [Int32] {
        var candidates: [Int32] = recordedPid.map { [$0] } ?? []
        for port in ports { candidates += LocalProcess.listeners(port: port) }
        var seen = Set<Int32>()
        var stopped: [Int32] = []
        for pid in candidates where seen.insert(pid).inserted && pid != getpid() {
            guard let line = LocalProcess.psLine(pid: pid), let ps = LocalProcess.parsePsLine(line) else { continue }
            guard mayStopOldServer(pid: pid, ppid: ps.ppid, command: ps.command, recordedPid: recordedPid, sourceDir: sourceDir, checkoutIsAppBuilt: checkoutIsAppBuilt) else { continue }
            if LocalProcess.stop(pid: pid, grace: grace) { stopped.append(pid) }
        }
        return stopped
    }

    enum Removal: Equatable {
        case removed
        /// Not provably the old app's any more: left as it is, and never tried again.
        case kept(String)
        /// Git could not look, or the removal failed: tried again on a later launch.
        case notYet(String)

        /// Whether the app may forget the pending removal.
        var settled: Bool {
            if case .notYet = self { return false }
            return true
        }
    }

    /// Removes the old app's checkout once `mayRemove` allows it, and the staging
    /// copy an earlier removal left when the app quit partway.
    static func removeIfServed(sourceDir: String, walnutHome: String, runtimeDir: String?, runtimeServed: Bool, repoURL: String = repoURL) -> Removal {
        guard isOldAppLocation(walnutHome: walnutHome, sourceDir: sourceDir) else { return .kept("not this setup's <data home>/source") }
        let fm = FileManager.default
        let staging = removalStaging(sourceDir: sourceDir)
        if fm.fileExists(atPath: staging) { try? fm.removeItem(atPath: staging) }
        guard fm.fileExists(atPath: sourceDir) else { return .removed }
        let verdict = check(sourceDir: sourceDir, repoURL: repoURL)
        if case .notAppBuilt(let why) = verdict { return .kept(why) }
        guard mayRemove(dir: sourceDir, walnutHome: walnutHome, runtimeDir: runtimeDir, runtimeServed: runtimeServed, verdict: verdict) else {
            return .notYet(verdict.logValue)
        }
        do {
            try fm.moveItem(atPath: sourceDir, toPath: staging)
            try fm.removeItem(atPath: staging)
            return .removed
        } catch {
            return .notYet(error.localizedDescription)
        }
    }
}

/// Small process tools for the checks above and the server reaper: run a tool
/// with a deadline, read `ps`, find a port's listener, stop a process.
enum LocalProcess {
    /// Runs `exe` and returns its status and stdout, or nil when it could not
    /// start or ran past `timeout` (then it is stopped: it is this app's child).
    static func run(_ exe: String, _ args: [String], cwd: String? = nil, environment: [String: String]? = nil, timeout: TimeInterval) -> (status: Int32, output: String)? {
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: exe)
        proc.arguments = args
        if let cwd = cwd { proc.currentDirectoryURL = URL(fileURLWithPath: cwd) }
        if let environment = environment { proc.environment = environment }
        let pipe = Pipe()
        proc.standardOutput = pipe
        proc.standardError = FileHandle.nullDevice
        proc.standardInput = FileHandle.nullDevice
        let exited = DispatchSemaphore(value: 0)
        proc.terminationHandler = { _ in exited.signal() }
        do { try proc.run() } catch { return nil }
        // Drain while it runs: a child that fills the pipe never exits otherwise.
        let box = OutputBox()
        let drained = DispatchSemaphore(value: 0)
        DispatchQueue.global(qos: .utility).async {
            box.set(pipe.fileHandleForReading.readDataToEndOfFile())
            drained.signal()
        }
        if exited.wait(timeout: .now() + timeout) == .timedOut {
            proc.terminate()
            if exited.wait(timeout: .now() + 2) == .timedOut { kill(proc.processIdentifier, SIGKILL) }
            _ = drained.wait(timeout: .now() + 2)
            return nil
        }
        _ = drained.wait(timeout: .now() + 2)
        return (proc.terminationStatus, String(decoding: box.get(), as: UTF8.self))
    }

    private final class OutputBox: @unchecked Sendable {
        private let lock = NSLock()
        private var data = Data()
        func set(_ d: Data) { lock.lock(); data = d; lock.unlock() }
        func get() -> Data { lock.lock(); defer { lock.unlock() }; return data }
    }

    /// The pids listening on a TCP port on this Mac.
    static func listeners(port: Int) -> [Int32] {
        guard let r = run("/usr/sbin/lsof", ["-nP", "-iTCP:\(port)", "-sTCP:LISTEN", "-t"], timeout: 10) else { return [] }
        return r.output.split(whereSeparator: \.isNewline).compactMap { Int32($0.trimmingCharacters(in: .whitespaces)) }
    }

    /// `ps -o ppid=,command=` for one pid, full width.
    static func psLine(pid: Int32) -> String? {
        guard let r = run("/bin/ps", ["-ww", "-o", "ppid=,command=", "-p", String(pid)], timeout: 5), r.status == 0 else { return nil }
        let line = r.output.trimmingCharacters(in: .whitespacesAndNewlines)
        return line.isEmpty ? nil : line
    }

    /// `"    1 /path/node /x/dist/cli.js web"` into its parent pid and command.
    static func parsePsLine(_ line: String) -> (ppid: Int32, command: String)? {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        guard let space = trimmed.firstIndex(of: " "), let ppid = Int32(trimmed[..<space]) else { return nil }
        let command = trimmed[space...].trimmingCharacters(in: .whitespaces)
        return command.isEmpty ? nil : (ppid, command)
    }

    static func isAlive(_ pid: Int32) -> Bool {
        return kill(pid, 0) == 0 || errno == EPERM
    }

    /// SIGTERM, up to `grace` seconds to exit on its own (a Walnut server bails
    /// within 4s of it), then SIGKILL. True when the process is gone.
    @discardableResult
    static func stop(pid: Int32, grace: TimeInterval) -> Bool {
        guard pid > 1 else { return false }
        if kill(pid, SIGTERM) != 0 { return errno == ESRCH }
        if waitGone(pid, seconds: grace) { return true }
        _ = kill(pid, SIGKILL)
        return waitGone(pid, seconds: 3)
    }

    static func waitGone(_ pid: Int32, seconds: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(seconds)
        while isAlive(pid) {
            if Date() >= deadline { return false }
            usleep(100_000)
        }
        return true
    }
}

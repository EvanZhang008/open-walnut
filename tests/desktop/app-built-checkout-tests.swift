import Foundation

/// AppBuiltCheckout (desktop/AppBuiltCheckout.swift): how the Mac app tells the
/// checkout an older version of it built in `<data home>/source` (a shallow
/// clone, npm-built, its daemon source deleted) from one the user keeps there,
/// which server it may stop on the way to the self-contained Walnut, and when
/// it may remove that checkout. The first half is pure; the second runs the
/// same checks against real git clones and a real listening process, all made
/// by this test under its own temp dir.
@main
struct AppBuiltCheckoutTests {
    static func main() {
        // Re-run by the stop test below as a stand-in server (see dummyServer).
        let argv = CommandLine.arguments
        if argv.count >= 3, argv[1].hasSuffix("/dist/cli.js"), argv[2] == "web" { dummyServer(argv) }

        pureChecks()
        realClones()
        realServer()
        print("AppBuiltCheckoutTests: all passed")
    }

    static let repo = AppBuiltCheckout.repoURL
    static let home = "/Users/someone/.open-walnut"
    static let source = "/Users/someone/.open-walnut/source"

    static func notAppBuilt(_ v: AppBuiltCheckout.Verdict) -> Bool {
        if case .notAppBuilt = v { return true }
        return false
    }

    static func pureChecks() {
        // Where the old app built: <data home>/source of the saved home, and nothing else.
        precondition(AppBuiltCheckout.location(walnutHome: home + "/") == source)
        precondition(AppBuiltCheckout.isOldAppLocation(walnutHome: home, sourceDir: source))
        precondition(AppBuiltCheckout.isOldAppLocation(walnutHome: home + "/", sourceDir: source))
        precondition(!AppBuiltCheckout.isOldAppLocation(walnutHome: home, sourceDir: "/Users/someone/src/open-walnut"))
        precondition(!AppBuiltCheckout.isOldAppLocation(walnutHome: "", sourceDir: "/source"))
        precondition(!AppBuiltCheckout.isOldAppLocation(walnutHome: "/", sourceDir: "/source"))

        // .git/config: the one remote the clone made, with the app's URL.
        let appConfig = """
        [core]
        \trepositoryformatversion = 0
        \tbare = false
        \thooksPath = .husky/_
        [remote "origin"]
        \turl = \(repo)
        \tfetch = +refs/heads/main:refs/remotes/origin/main
        [branch "main"]
        \tremote = origin
        \tmerge = refs/heads/main
        """
        precondition(AppBuiltCheckout.remotes(gitConfig: appConfig) == ["origin": [repo]])
        let forked = appConfig.replacingOccurrences(of: repo, with: "git@github.com:someone/open-walnut.git")
        let twoRemotes = appConfig + "\n[remote \"upstream\"]\n\turl = https://example.com/x.git\n"

        let clone = "0000000000000000000000000000000000000000 eb51 Some One <s@example.com> 1792787351 -0700\tclone: from \(repo)\n"
        let pulled = clone + "eb51 3f9e Some One <s@example.com> 1792787999 -0700\tpull --ff-only: Fast-forward\n"
        func files(git: Bool = true, shallow: Bool = true, config: String? = appConfig, reflog: String? = clone) -> AppBuiltCheckout.Verdict? {
            return AppBuiltCheckout.checkClone(isGitDirectory: git, isShallow: shallow, gitConfig: config, headReflog: reflog)
        }
        precondition(files() == nil)
        precondition(files(reflog: pulled) == nil, "the old app's own re-run pulls with --ff-only")
        precondition(files(reflog: nil) == nil, "a reflog git keeps none of proves nothing either way")
        precondition(notAppBuilt(files(git: false)!), "no .git, or a .git file (a worktree)")
        precondition(notAppBuilt(files(shallow: false)!), "the app cloned with --depth 1; a full clone is the user's")
        precondition(notAppBuilt(files(config: nil)!))
        precondition(notAppBuilt(files(config: forked)!), "a different remote")
        precondition(notAppBuilt(files(config: twoRemotes)!), "a second remote")
        precondition(notAppBuilt(files(reflog: clone + "a b U <u@x> 1 +0000\tcommit: my change\n")!), "a local commit")
        precondition(notAppBuilt(files(reflog: clone + "a b U <u@x> 1 +0000\tcheckout: moving from main to mine\n")!), "a branch switch")
        precondition(notAppBuilt(files(reflog: clone + "a b U <u@x> 1 +0000\tpull: Fast-forward\n")!), "a pull the user ran")
        precondition(notAppBuilt(files(reflog: "0 a U <u@x> 1 +0000\tclone: from https://example.com/fork.git\n")!), "cloned from elsewhere")

        // The work tree, as `git status --porcelain=v2 --branch -z` prints it.
        func status(head: String = "main", upstream: String? = "origin/main", ab: String? = "+0 -0", _ entries: [String]) -> String {
            var lines = ["# branch.oid eb5199ccb6e65cd468bbe7fcc4e933a467bd4ac2", "# branch.head " + head]
            if let u = upstream { lines.append("# branch.upstream " + u) }
            if let ab = ab { lines.append("# branch.ab " + ab) }
            return (lines + entries).map { $0 + "\0" }.joined()
        }
        let h = "100644 100644 000000 7898192261 7898192261"
        let mark = "1 .D N... \(h) src/providers/daemon-standalone.ts"
        let lock = "1 .M N... 100644 100644 100644 0967ef42 0967ef42 package-lock.json"
        precondition(AppBuiltCheckout.checkStatus(status([mark])) == .appBuilt)
        precondition(AppBuiltCheckout.checkStatus(status([lock, mark, "? web/package-lock.json"])) == .appBuilt, "npm's lockfiles")
        precondition(AppBuiltCheckout.checkStatus(status(ab: "+0 -3", [mark])) == .appBuilt, "behind its upstream is not the user's work")
        precondition(AppBuiltCheckout.checkStatus(status(ab: "+1 -0", [mark])) == .notAppBuilt("commits not on its upstream"))
        precondition(AppBuiltCheckout.checkStatus(status(head: "mine", [mark])) == .notAppBuilt("branch is mine"))
        precondition(AppBuiltCheckout.checkStatus(status(head: "(detached)", [mark])) == .notAppBuilt("branch is (detached)"))
        precondition(notAppBuilt(AppBuiltCheckout.checkStatus(status(upstream: nil, ab: nil, [mark]))), "no upstream")
        precondition(AppBuiltCheckout.checkStatus(status([mark, "1 .M N... \(h) src/my file.ts"])) == .notAppBuilt("changed: src/my file.ts"))
        precondition(AppBuiltCheckout.checkStatus(status([mark, "? notes.md"])) == .notAppBuilt("untracked: notes.md"))
        precondition(AppBuiltCheckout.checkStatus(status([])) == .notAppBuilt(AppBuiltCheckout.buildMark + " is still there"), "the old build's mark is required")
        precondition(notAppBuilt(AppBuiltCheckout.checkStatus(status(["1 D. N... \(h) src/providers/daemon-standalone.ts"]))), "a deletion the user staged")
        precondition(notAppBuilt(AppBuiltCheckout.checkStatus(status([mark, "2 R. N... \(h) R100 b.ts", "a.ts"]))), "a rename")
        precondition(notAppBuilt(AppBuiltCheckout.checkStatus(status([mark, "u UU N... 1 2 3 4 a b c x.ts"]))), "a conflict")
        precondition(AppBuiltCheckout.checkStatus(nil) == .undetermined("git status did not answer"))

        // Which verdict moves the setup, and which queues the checkout's removal.
        let user = AppBuiltCheckout.Verdict.notAppBuilt("x"), unknown = AppBuiltCheckout.Verdict.undetermined("x")
        precondition(AppBuiltCheckout.movesToRuntime(runnable: true, verdict: .appBuilt))
        precondition(AppBuiltCheckout.movesToRuntime(runnable: true, verdict: unknown), "the files say the app's; moving removes nothing")
        precondition(!AppBuiltCheckout.movesToRuntime(runnable: true, verdict: user), "the user's checkout keeps running as it is")
        precondition(AppBuiltCheckout.movesToRuntime(runnable: false, verdict: user), "a checkout that cannot run keeps nobody working")
        precondition(AppBuiltCheckout.queuesRemoval(.appBuilt) && AppBuiltCheckout.queuesRemoval(unknown) && !AppBuiltCheckout.queuesRemoval(user))

        // The old app's server: its Node on this checkout's dist/cli.js, `web`, and an optional port.
        let node = "/opt/homebrew/bin/node " + source + "/dist/cli.js web"
        precondition(AppBuiltCheckout.isOldAppServerCommand(node + " --port 3456", sourceDir: source))
        precondition(AppBuiltCheckout.isOldAppServerCommand(node, sourceDir: source))
        precondition(AppBuiltCheckout.isOldAppServerCommand("/Users/someone/.nvm/versions/node/v22.12.0/bin/node " + source + "/dist/cli.js web --port 4567", sourceDir: source))
        let spaced = "/Users/some one/Walnut data/source"
        precondition(AppBuiltCheckout.isOldAppServerCommand("/opt/homebrew/bin/node " + spaced + "/dist/cli.js web --port 3456", sourceDir: spaced))
        precondition(!AppBuiltCheckout.isOldAppServerCommand("/Users/someone/.bun/bin/bun " + source + "/dist/cli.js web --port 3456", sourceDir: source), "a checkout this app runs on bun")
        precondition(!AppBuiltCheckout.isOldAppServerCommand("/Users/someone/.local/share/open-walnut/bin/walnut web --port 3456", sourceDir: source), "the self-contained Walnut")
        precondition(!AppBuiltCheckout.isOldAppServerCommand("/opt/homebrew/bin/node " + source + "/dist/cli.js update", sourceDir: source))
        precondition(!AppBuiltCheckout.isOldAppServerCommand("/opt/homebrew/bin/node " + source + "/dist/cli.js webx", sourceDir: source))
        precondition(!AppBuiltCheckout.isOldAppServerCommand(node + " --port 3456 --debug", sourceDir: source), "not the arguments the old app passed")
        precondition(!AppBuiltCheckout.isOldAppServerCommand(node + " --port ", sourceDir: source))
        precondition(!AppBuiltCheckout.isOldAppServerCommand("/opt/homebrew/bin/node --inspect " + source + "/dist/cli.js web", sourceDir: source), "someone's own Node flags")
        precondition(!AppBuiltCheckout.isOldAppServerCommand("/opt/homebrew/bin/node /elsewhere/source/dist/cli.js web", sourceDir: source))
        precondition(!AppBuiltCheckout.isOldAppServerCommand("/opt/homebrew/bin/node /x" + source + "/dist/cli.js web", sourceDir: source))

        // Stopping it needs proof it is the old app's: the recorded pid, or an
        // orphan (parent launchd) on a checkout that is provably the old app's.
        let cmd = node + " --port 3456"
        func may(_ pid: Int32 = 900, ppid: Int32 = 1, _ command: String = cmd, recorded: Int32? = nil, built: Bool = true) -> Bool {
            return AppBuiltCheckout.mayStopOldServer(pid: pid, ppid: ppid, command: command, recordedPid: recorded, sourceDir: source, checkoutIsAppBuilt: built)
        }
        precondition(may(ppid: 4321, recorded: 900), "the pid the old app recorded")
        precondition(may(recorded: 900, built: false), "the recorded pid, whatever the checkout")
        precondition(may(), "an orphan on the app's checkout")
        precondition(!may(built: false), "an orphan on a checkout that is not provably the app's")
        precondition(!may(ppid: 4321), "a live parent (a terminal) and no record")
        precondition(!may(ppid: 4321, recorded: 901), "a record of another pid")
        precondition(!may(ppid: 1, "/Users/someone/.bun/bin/bun " + source + "/dist/cli.js web --port 3456", recorded: 900), "never a bun server")
        precondition(!may(1, recorded: 1) && !may(0, recorded: 0))

        let orphan = LocalProcess.parsePsLine("    1 " + cmd)!
        precondition(orphan.ppid == 1 && orphan.command == cmd)
        let owned = LocalProcess.parsePsLine("4321 /a b/node x")!
        precondition(owned.ppid == 4321 && owned.command == "/a b/node x")
        precondition(LocalProcess.parsePsLine("garbage") == nil && LocalProcess.parsePsLine("  42 ") == nil && LocalProcess.parsePsLine("") == nil)

        // Removal: <data home>/source only, after the self-contained Walnut served, proven, never its install.
        let rtDir = "/Users/someone/.local/share/open-walnut"
        func rm(_ dir: String = source, home h: String = home, rt: String? = rtDir, served: Bool = true, verdict v: AppBuiltCheckout.Verdict = .appBuilt) -> Bool {
            return AppBuiltCheckout.mayRemove(dir: dir, walnutHome: h, runtimeDir: rt, runtimeServed: served, verdict: v)
        }
        precondition(rm())
        precondition(!rm(served: false), "not before the new Walnut served: the user may go back")
        precondition(!rm(verdict: user) && !rm(verdict: unknown))
        precondition(!rm("/Users/someone/src/open-walnut"), "only <data home>/source")
        precondition(!rm(home: "/Users/someone/other"), "another setup's")
        precondition(!rm(rt: nil), "no self-contained Walnut")
        precondition(!rm(rt: source) && !rm(rt: source + "/runtime"), "never the runtime's own install")
        precondition(AppBuiltCheckout.removalStaging(sourceDir: source) == home + "/.walnut-app-removing-source")
        precondition(AppBuiltCheckout.Removal.removed.settled && AppBuiltCheckout.Removal.kept("x").settled && !AppBuiltCheckout.Removal.notYet("x").settled)

        // A git that never asks to install the Command Line Tools: never /usr/bin/git.
        let have: Set<String> = ["/Applications/Xcode-beta.app/Contents/Developer/usr/bin/git", "/usr/bin/git"]
        precondition(AppBuiltCheckout.findGit(developerDir: "/Applications/Xcode-beta.app/Contents/Developer", isExecutable: have.contains) == "/Applications/Xcode-beta.app/Contents/Developer/usr/bin/git")
        precondition(AppBuiltCheckout.findGit(developerDir: nil, isExecutable: have.contains) == nil)
        precondition(AppBuiltCheckout.findGit(developerDir: nil, isExecutable: { $0 == "/opt/homebrew/bin/git" }) == "/opt/homebrew/bin/git")
    }

    // MARK: Real clones

    static let root: String = {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("walnut-app-built-checkout-tests-\(getpid())").path
        try? FileManager.default.removeItem(atPath: dir)
        try! FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        return dir
    }()

    /// git for building the fixtures: no GIT_* from the caller (an inherited
    /// GIT_DIR outranks -C), and no user or system config.
    @discardableResult
    static func git(_ args: [String], _ git: String) -> String {
        var env = ProcessInfo.processInfo.environment.filter { !$0.key.hasPrefix("GIT_") }
        env["GIT_CONFIG_NOSYSTEM"] = "1"
        env["GIT_CONFIG_GLOBAL"] = "/dev/null"
        env["GIT_TERMINAL_PROMPT"] = "0"
        let all = ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "init.defaultBranch=main"] + args
        guard let r = LocalProcess.run(git, all, environment: env, timeout: 60), r.status == 0 else {
            preconditionFailure("git \(args.joined(separator: " ")) failed")
        }
        return r.output
    }

    static func write(_ path: String, _ text: String) {
        try! FileManager.default.createDirectory(atPath: (path as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
        try! text.write(toFile: path, atomically: true, encoding: .utf8)
    }

    static func realClones() {
        guard let gitPath = AppBuiltCheckout.findGit(developerDir: AppBuiltCheckout.developerDir()) else {
            print("AppBuiltCheckoutTests: no git here, real clone checks skipped")
            return
        }
        let fm = FileManager.default
        let up = root + "/upstream"
        let url = "file://" + up
        for (file, text) in [
            "README.md": "# Walnut\n", "package.json": "{}\n", "package-lock.json": "{}\n",
            "web/package-lock.json": "{}\n", AppBuiltCheckout.buildMark: "// daemon\n", ".gitignore": "node_modules/\ndist/\n",
        ] { write(up + "/" + file, text) }
        git(["-C", up, "init", "-q"], gitPath)
        git(["-C", up, "add", "-A"], gitPath)
        git(["-C", up, "commit", "-qm", "one"], gitPath)

        // What the old app's Set Up Now left: the shallow clone, its build, its mark.
        func appBuilt(_ name: String, depth: Bool = true) -> (home: String, source: String) {
            let h = root + "/" + name + "/.open-walnut"
            let s = AppBuiltCheckout.location(walnutHome: h)
            git(["clone", "-q"] + (depth ? ["--depth", "1"] : []) + [url, s], gitPath)
            try! fm.removeItem(atPath: s + "/" + AppBuiltCheckout.buildMark)
            write(s + "/dist/cli.js", "// built\n")
            write(s + "/node_modules/x/index.js", "// dep\n")
            write(h + "/config.yaml", "{}\n")
            return (h, s)
        }
        func check(_ s: String) -> AppBuiltCheckout.Verdict {
            return AppBuiltCheckout.check(sourceDir: s, repoURL: url, git: gitPath)
        }

        let a = appBuilt("pristine")
        precondition(check(a.source) == .appBuilt, "\(check(a.source))")
        write(a.source + "/package-lock.json", "{\"npm\":true}\n")
        write(a.source + "/web/package-lock.json", "{\"npm\":true}\n")
        precondition(check(a.source) == .appBuilt, "npm's lockfile churn")
        precondition(notAppBuilt(AppBuiltCheckout.check(sourceDir: a.source, git: gitPath)), "the real URL for a file:// clone")
        // Not before the new Walnut served; then removed, through the staging name, data home untouched.
        precondition(AppBuiltCheckout.removeIfServed(sourceDir: a.source, walnutHome: a.home, runtimeDir: root + "/rt", runtimeServed: false, repoURL: url) == .notYet("app_built"))
        precondition(fm.fileExists(atPath: a.source + "/dist/cli.js"))
        write(AppBuiltCheckout.removalStaging(sourceDir: a.source) + "/left/from/before", "x")
        precondition(AppBuiltCheckout.removeIfServed(sourceDir: a.source, walnutHome: a.home, runtimeDir: root + "/rt", runtimeServed: true, repoURL: url) == .removed)
        precondition(!fm.fileExists(atPath: a.source) && !fm.fileExists(atPath: AppBuiltCheckout.removalStaging(sourceDir: a.source)))
        precondition(fm.fileExists(atPath: a.home + "/config.yaml"), "the data home stays")

        // The old app's own re-run: git pull --ff-only over the same clone.
        let p = appBuilt("pulled")
        write(up + "/CHANGELOG.md", "two\n")
        git(["-C", up, "add", "-A"], gitPath)
        git(["-C", up, "commit", "-qm", "two"], gitPath)
        git(["-C", p.source, "pull", "--ff-only"], gitPath)
        precondition(check(p.source) == .appBuilt, "\(check(p.source))")

        // The user's work in it: kept, never removed.
        let e = appBuilt("edited")
        write(e.source + "/README.md", "# mine\n")
        precondition(check(e.source) == .notAppBuilt("changed: README.md"))
        precondition(AppBuiltCheckout.removeIfServed(sourceDir: e.source, walnutHome: e.home, runtimeDir: root + "/rt", runtimeServed: true, repoURL: url) == .kept("changed: README.md"))
        precondition(fm.fileExists(atPath: e.source + "/README.md"))

        let u = appBuilt("untracked")
        write(u.source + "/notes.md", "mine\n")
        precondition(check(u.source) == .notAppBuilt("untracked: notes.md"))

        let c = appBuilt("committed")
        write(c.source + "/mine.ts", "export {}\n")
        git(["-C", c.source, "add", "mine.ts"], gitPath)
        git(["-C", c.source, "commit", "-qm", "mine"], gitPath)
        precondition(notAppBuilt(check(c.source)), "a local commit")

        let b = appBuilt("branched")
        git(["-C", b.source, "checkout", "-qb", "mine"], gitPath)
        precondition(notAppBuilt(check(b.source)), "another branch")

        let f = appBuilt("full", depth: false)
        precondition(check(f.source) == .notAppBuilt("not a shallow clone"))

        let r = appBuilt("remote")
        git(["-C", r.source, "remote", "set-url", "origin", "https://example.com/fork.git"], gitPath)
        precondition(check(r.source) == .notAppBuilt("remotes are not the app's clone"))

        let m = appBuilt("marked")
        write(m.source + "/" + AppBuiltCheckout.buildMark, "// daemon\n")
        precondition(check(m.source) == .notAppBuilt(AppBuiltCheckout.buildMark + " is still there"))

        precondition(notAppBuilt(check(root + "/nothing-here")))
        try? fm.removeItem(atPath: root)
    }

    // MARK: A real server process

    /// Stand-in for a Walnut server: listens on --port, optionally ignores
    /// SIGTERM, and exits with its parent (the test) or after a minute.
    static func dummyServer(_ argv: [String]) -> Never {
        let port = argv.firstIndex(of: "--port").flatMap { $0 + 1 < argv.count ? UInt16(argv[$0 + 1]) : nil } ?? 0
        if ProcessInfo.processInfo.environment["WALNUT_TEST_IGNORE_TERM"] == "1" { signal(SIGTERM, SIG_IGN) }
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        var addr = sockaddr_in()
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = port.bigEndian
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")
        let bound = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
        }
        guard bound == 0, listen(fd, 4) == 0 else { exit(3) }
        let parent = getppid()
        for _ in 0..<600 where getppid() == parent { usleep(100_000) }
        exit(0)
    }

    static func freePort() -> Int {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        defer { close(fd) }
        var addr = sockaddr_in()
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")
        _ = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } }
        var len = socklen_t(MemoryLayout<sockaddr_in>.size)
        _ = withUnsafeMutablePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &len) } }
        let port = Int(UInt16(bigEndian: addr.sin_port))
        precondition(port != 3456 && port != 3457)
        return port
    }

    /// This test binary under the name `runtime` (node, bun), on `source`'s cli.js, listening.
    static func spawn(runtime: String, source: String, ignoreTerm: Bool) -> (Process, Int) {
        let bin = root + "/bin"
        try? FileManager.default.createDirectory(atPath: bin, withIntermediateDirectories: true)
        let link = bin + "/" + runtime
        let me = URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL.path
        try? FileManager.default.removeItem(atPath: link)
        try! FileManager.default.createSymbolicLink(atPath: link, withDestinationPath: me)
        let port = freePort()
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: link)
        proc.arguments = [source + "/dist/cli.js", "web", "--port", String(port)]
        var env = ProcessInfo.processInfo.environment
        env["WALNUT_TEST_IGNORE_TERM"] = ignoreTerm ? "1" : "0"
        proc.environment = env
        try! proc.run()
        let pid = proc.processIdentifier
        let deadline = Date().addingTimeInterval(10)
        while !LocalProcess.listeners(port: port).contains(pid) {
            precondition(Date() < deadline && proc.isRunning, "the stand-in server never listened")
            usleep(100_000)
        }
        return (proc, port)
    }

    static func realServer() {
        let source = root + "/server/.open-walnut/source"
        // A Node on this checkout that ignores SIGTERM, with a live parent (this test).
        let (node, port) = spawn(runtime: "node", source: source, ignoreTerm: true)
        let pid = node.processIdentifier
        let seen = LocalProcess.parsePsLine(LocalProcess.psLine(pid: pid) ?? "")
        precondition(seen?.command == root + "/bin/node " + source + "/dist/cli.js web --port \(port)", "\(String(describing: seen))")
        precondition(AppBuiltCheckout.isOldAppServerCommand(seen!.command, sourceDir: source))
        // No record and a live parent: left alone, even on a checkout said to be the app's.
        precondition(AppBuiltCheckout.stopOldServers(sourceDir: source, recordedPid: nil, ports: [port], checkoutIsAppBuilt: true, grace: 1).isEmpty)
        // The record names it, but for another checkout: left alone.
        precondition(AppBuiltCheckout.stopOldServers(sourceDir: root + "/other/source", recordedPid: pid, ports: [port], checkoutIsAppBuilt: true, grace: 1).isEmpty)
        precondition(node.isRunning)
        // The recorded pid on this checkout: SIGTERM is ignored, so it takes the grace and a SIGKILL.
        let began = Date()
        precondition(AppBuiltCheckout.stopOldServers(sourceDir: source, recordedPid: pid, ports: [port], checkoutIsAppBuilt: false, grace: 1) == [pid])
        precondition(Date().timeIntervalSince(began) >= 0.9, "SIGKILL before the grace ran out")
        node.waitUntilExit()
        precondition(node.terminationReason == .uncaughtSignal && node.terminationStatus == SIGKILL)
        precondition(LocalProcess.listeners(port: port).isEmpty)

        // A server this app runs on bun from a checkout is never the old app's, recorded or not.
        let (bun, bunPort) = spawn(runtime: "bun", source: source, ignoreTerm: false)
        precondition(AppBuiltCheckout.stopOldServers(sourceDir: source, recordedPid: bun.processIdentifier, ports: [bunPort], checkoutIsAppBuilt: true, grace: 1).isEmpty)
        precondition(bun.isRunning)
        // An ordinary SIGTERM is enough for a server that honours it.
        precondition(LocalProcess.stop(pid: bun.processIdentifier, grace: 5))
        bun.waitUntilExit()
        precondition(bun.terminationReason == .uncaughtSignal && bun.terminationStatus == SIGTERM)
        try? FileManager.default.removeItem(atPath: root)
    }
}

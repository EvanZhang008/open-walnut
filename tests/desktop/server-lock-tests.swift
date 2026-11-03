import Foundation

/// The lock a Walnut server holds on its data directory, as the app reads it at
/// launch (ServerLockHolder in desktop/DesktopDiagnostics.swift). The shape is
/// src/core/instance-lock.ts's; tests/core/instance-lock-app-contract.test.ts pins
/// the server side of the same contract.
@main
struct ServerLockTests {
    static func main() throws {
        let holder = ServerLockHolder.parse(Data(#"{"pid":86344,"port":3456,"startedAt":"2026-11-03T13:41:58.418Z"}"#.utf8))
        precondition(holder == ServerLockHolder(pid: 86344, port: 3456), "reads pid and port")

        // A server still booting has not recorded a port yet (port 0 before listen, or null).
        precondition(ServerLockHolder.parse(Data(#"{"pid":42,"port":null,"startedAt":"x"}"#.utf8)) == ServerLockHolder(pid: 42, port: nil))
        precondition(ServerLockHolder.parse(Data(#"{"pid":42,"port":0}"#.utf8))?.port == nil)

        // Unreadable, or a pid no server can have, is no holder.
        for raw in ["", "{", "[]", #"{"port":3456}"#, #"{"pid":"86344"}"#, #"{"pid":1}"#, #"{"pid":0}"#, #"{"pid":-1}"#] {
            precondition(ServerLockHolder.parse(Data(raw.utf8)) == nil, "no holder in \(raw)")
        }

        // The file the server writes, read from disk.
        let dir = NSTemporaryDirectory() + "walnut-server-lock-tests-\(getpid())"
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(atPath: dir) }
        precondition(ServerLockHolder.read(home: dir) == nil, "no lock file, no holder")
        try #"{"pid":777,"port":4567}"#.write(toFile: ServerLockHolder.lockFile(home: dir), atomically: true, encoding: .utf8)
        precondition(ServerLockHolder.read(home: dir) == ServerLockHolder(pid: 777, port: 4567))

        // Every way a Walnut server runs, and programs that only share a pid with a dead one.
        let servers = [
            "/var/folders/ph/x/T//open-walnut-stage.1/dist-bin/walnut-darwin-arm64 web --port 3456",
            "/Users/me/.open-walnut/app/walnut web --port 3456",
            "/Users/me/.bun/bin/bun /Users/me/walnut/dist/cli.js web --port 3456",
            "/opt/homebrew/bin/node /Users/me/.open-walnut/app/lib/node_modules/open-walnut/dist/cli.js web --port 4567",
            "bun src/cli.ts web --dev",
            "open-walnut web",
        ]
        for c in servers { precondition(ServerLockHolder.isWalnutServerCommand(c), "server: \(c)") }
        let others = [
            "/usr/bin/python3 -m http.server 3456",
            "/Applications/Safari.app/Contents/MacOS/Safari",
            "walnut-darwin-arm64 __daemon --start",
            "/usr/local/bin/web --walnut",
            "",
        ]
        for c in others { precondition(!ServerLockHolder.isWalnutServerCommand(c), "not a server: \(c)") }

        precondition(RunningServerWait.gaveUpText(pid: 9, port: 3456).contains("kill 9"))
        precondition(RunningServerWait.deadline >= 60, "a busy server gets at least a minute")
        // A server in an ended login session, as GET /api/config reports it.
        let ended = Data(#"{"processNice":0,"loginSession":{"ok":false,"problems":["user_lookup","dns_config","cwd_gone"],"checkedAt":"x"}}"#.utf8)
        precondition(ServerLoginSession.endedSessionProblems(configJSON: ended) == ["user_lookup", "dns_config"])
        // A cwd the server moved out of is its own fix, not a reason to replace it; an older server says nothing.
        precondition(ServerLoginSession.endedSessionProblems(configJSON: Data(#"{"loginSession":{"ok":false,"problems":["cwd_gone"]}}"#.utf8)).isEmpty)
        precondition(ServerLoginSession.endedSessionProblems(configJSON: Data(#"{"config":{}}"#.utf8)).isEmpty)
        precondition(ServerLoginSession.endedSessionProblems(configJSON: Data("not json".utf8)).isEmpty)
        precondition(ServerLoginSession.ownSessionWorks(), "this test runs in a working session")
        // The exit screen leads with why, and no line can fill it.
        let guardLine = "    files: " + String(repeating: "src/providers/x-core.ts, ", count: 400)
        let exitLine = #"[2026-11-03T16:12:45.860Z] SERVER EXIT: uncaughtException {"pid":53692,"detail":"Another Walnut server (pid 86344, port 3456) already owns /Users/me/.open-walnut."}"#
        let screen = StartupExitText.text(code: 1, output: "booting\n\(guardLine)\n\(exitLine)", hint: "hint")
        let body = screen.split(separator: "\n")
        precondition(body[1].hasPrefix("Another Walnut server (pid 86344"), "the reason comes first: \(body[1])")
        precondition(body.allSatisfy { $0.count <= StartupExitText.maxLineChars + 3 }, "no line runs past the cut")
        precondition(StartupExitText.reason("plain crash\nTypeError: x is undefined") == "TypeError: x is undefined")
        precondition(StartupExitText.text(code: 1, output: "", hint: "h").contains("No output was captured."))
        print("server-lock-tests: ok")
    }
}

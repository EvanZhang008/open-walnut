import Foundation

final class DesktopLogger {
    static let shared = DesktopLogger()

    private let queue = DispatchQueue(label: "com.local.walnut-desktop.logger", qos: .utility)
    private let logURL: URL
    private let maxBytes: UInt64

    init(logURL: URL? = nil, maxBytes: UInt64 = 1_048_576) {
        if let logURL {
            self.logURL = logURL
        } else {
            let appSupport = FileManager.default.urls(
                for: .applicationSupportDirectory,
                in: .userDomainMask
            ).first!
            self.logURL = appSupport
                .appendingPathComponent("Walnut", isDirectory: true)
                .appendingPathComponent("desktop.log")
        }
        self.maxBytes = maxBytes
    }

    func log(_ event: String, fields: [String: String] = [:]) {
        let url = logURL
        let limit = maxBytes
        queue.async {
            let directory = url.deletingLastPathComponent()
            try? FileManager.default.createDirectory(
                at: directory,
                withIntermediateDirectories: true
            )
            Self.rotateIfNeeded(url: url, maxBytes: limit)

            var record = fields
            record["event"] = event
            record["timestamp"] = ISO8601DateFormatter().string(from: Date())
            guard JSONSerialization.isValidJSONObject(record),
                  let data = try? JSONSerialization.data(withJSONObject: record, options: [.sortedKeys]),
                  var line = String(data: data, encoding: .utf8) else {
                return
            }
            line.append("\n")

            if !FileManager.default.fileExists(atPath: url.path) {
                try? line.write(to: url, atomically: true, encoding: .utf8)
                return
            }
            guard let handle = try? FileHandle(forWritingTo: url),
                  let lineData = line.data(using: .utf8) else {
                return
            }
            defer { try? handle.close() }
            do {
                try handle.seekToEnd()
                try handle.write(contentsOf: lineData)
            } catch {
                return
            }
        }
    }

    func flush() {
        queue.sync {}
    }

    private static func rotateIfNeeded(url: URL, maxBytes: UInt64) {
        guard let attributes = try? FileManager.default.attributesOfItem(atPath: url.path),
              let size = attributes[.size] as? UInt64,
              size >= maxBytes else {
            return
        }
        let rotated = url.deletingPathExtension().appendingPathExtension("previous.log")
        try? FileManager.default.removeItem(at: rotated)
        try? FileManager.default.moveItem(at: url, to: rotated)
    }
}

final class ProcessOutputReader {
    private let handle: FileHandle
    private let logger: (String, [String: String]) -> Void
    private let lock = NSLock()
    private let maxBufferCharacters: Int
    private var stopped = false
    private var buffer = ""

    init(
        handle: FileHandle,
        maxBufferCharacters: Int = 262_144,
        logger: @escaping (String, [String: String]) -> Void
    ) {
        self.handle = handle
        self.maxBufferCharacters = maxBufferCharacters
        self.logger = logger
    }

    func start(onText: @escaping (String) -> Void, onEOF: @escaping () -> Void) {
        lock.lock()
        guard !stopped else {
            lock.unlock()
            return
        }
        lock.unlock()

        handle.readabilityHandler = { [weak self] fileHandle in
            guard let self else { return }
            let data = fileHandle.availableData
            guard !data.isEmpty else {
                if self.stop(reason: "eof") {
                    onEOF()
                }
                return
            }
            guard let text = String(data: data, encoding: .utf8) else {
                self.logger("server_output_decode_failed", ["bytes": String(data.count)])
                return
            }

            self.lock.lock()
            self.buffer.append(text)
            if self.buffer.count > self.maxBufferCharacters {
                self.buffer = String(self.buffer.suffix(self.maxBufferCharacters))
            }
            let snapshot = self.buffer
            self.lock.unlock()
            onText(snapshot)
        }
        logger("server_output_reader_started", [:])
    }

    @discardableResult
    func stop(reason: String) -> Bool {
        lock.lock()
        guard !stopped else {
            lock.unlock()
            return false
        }
        stopped = true
        lock.unlock()

        handle.readabilityHandler = nil
        logger("server_output_reader_stopped", ["reason": reason])
        return true
    }

    func outputSnapshot() -> String {
        lock.lock()
        defer { lock.unlock() }
        return buffer
    }

    var isStopped: Bool {
        lock.lock()
        defer { lock.unlock() }
        return stopped
    }
}

/// What the app says when the server never printed "listening" in time. The
/// wait is finite (ServerRestartPolicy), and the screen says why without
/// Console: a server that was still installing an update before it starts (one
/// from before this app, which starts its own with updates off) is named as
/// such, then the server's last lines.
enum StartupFailureText {
    static func timedOut(seconds: Int, output: String) -> String {
        let trimmed = output.trimmingCharacters(in: .whitespacesAndNewlines)
        let tail = trimmed.split(separator: "\n", omittingEmptySubsequences: false).suffix(15).joined(separator: "\n")
        var text = "The Walnut server did not become ready within \(seconds) seconds."
        // The 0.6.x server's line before its npm install; a later one names when it starts anyway.
        if trimmed.contains("installing it before starting") && !trimmed.contains("Installed Open Walnut") && !trimmed.contains("is still installing") {
            text += " It was still installing a Walnut update before starting, which took longer than that."
        }
        return text + "\n\n" + (tail.isEmpty ? "No output was captured." : tail)
    }
}

/// What the app says when the server it started exited before it listened: the
/// line that says why first (the server's own "SERVER EXIT" line), then its last
/// lines, each cut short. 2026-11-03: one advisory line of 140 file names filled
/// the screen and the reason, the last line, was off the bottom of it.
enum StartupExitText {
    static let maxLineChars = 300
    static let tailLines = 8

    static func reason(_ output: String) -> String? {
        let lines = output.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        guard let exit = lines.last(where: { $0.contains("SERVER EXIT") }) ?? lines.last else { return nil }
        // "[<ISO time>] SERVER EXIT: uncaughtException {"detail":"..."}": the detail is the reason.
        if let data = exit.range(of: "{").map({ String(exit[$0.lowerBound...]) })?.data(using: .utf8),
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let detail = obj["detail"] as? String, !detail.isEmpty {
            return cut(detail)
        }
        return cut(exit)
    }

    static func cut(_ line: String) -> String {
        return line.count <= maxLineChars ? line : String(line.prefix(maxLineChars)) + "..."
    }

    static func text(code: Int32, output: String, hint: String) -> String {
        let lines = output.trimmingCharacters(in: .whitespacesAndNewlines).split(separator: "\n", omittingEmptySubsequences: false)
        let tail = lines.suffix(tailLines).map { cut(String($0)) }.joined(separator: "\n")
        var text = "The Walnut server exited during startup (exit code \(code))."
        if let why = reason(output) { text += "\n\n\(why)" }
        text += "\n\nLast output:\n" + (tail.isEmpty ? "No output was captured." : tail)
        return text + "\n\n" + hint
    }
}

struct ServerRestartPolicy {
    static let healthyResetInterval: TimeInterval = 120
    static let ordinaryStartupTimeout: TimeInterval = 180
    static let delays: [TimeInterval] = [1, 2, 4, 8, 16]

    private(set) var attemptCount = 0

    mutating func nextDelay(healthyFor: TimeInterval?) -> TimeInterval? {
        if let healthyFor, healthyFor >= Self.healthyResetInterval {
            attemptCount = 0
        }
        guard attemptCount < Self.delays.count else { return nil }
        let delay = Self.delays[attemptCount]
        attemptCount += 1
        return delay
    }

    mutating func reset() {
        attemptCount = 0
    }
}

func shouldAutomaticallyRestartServer(
    portConfirmed: Bool,
    ownsServer: Bool,
    isTerminating: Bool,
    isCurrentProcess: Bool
) -> Bool {
    return portConfirmed && ownsServer && !isTerminating && isCurrentProcess
}

/// The Walnut server that owns a data directory, read from the lock it holds
/// there (src/core/instance-lock.ts writes {pid, port, startedAt} to
/// <home>/server.lock.json). A launch that finds a live holder waits for that
/// server and attaches to it instead of starting a second one, which the lock
/// refuses: 2026-11-03, a server busy right after a log-in missed one 2-second
/// probe, the app started its own, the lock turned it away, and the first launch
/// ended on an error screen until the app was opened again.
struct ServerLockHolder: Equatable {
    let pid: Int32
    let port: Int?

    static func lockFile(home: String) -> String {
        return (home as NSString).appendingPathComponent("server.lock.json")
    }

    /// The holder the lock names, or nil when there is no lock or it is unreadable.
    static func parse(_ data: Data) -> ServerLockHolder? {
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let rawPid = obj["pid"] as? NSNumber, rawPid.int32Value > 1 else { return nil }
        let port = (obj["port"] as? NSNumber).map { $0.intValue }.flatMap { (1...65535).contains($0) ? $0 : nil }
        return ServerLockHolder(pid: rawPid.int32Value, port: port)
    }

    static func read(home: String) -> ServerLockHolder? {
        guard let data = FileManager.default.contents(atPath: lockFile(home: home)) else { return nil }
        return parse(data)
    }

    /// Whether `ps -o command=` of the holder is a Walnut server: the compiled
    /// file (`walnut-<target> web`, `walnut web`) or a checkout's (`cli.js web`,
    /// `src/cli.ts web`). A pid the system gave to another program after the
    /// server died hard (SIGKILL leaves the lock behind) is not one.
    static func isWalnutServerCommand(_ command: String) -> Bool {
        let parts = command.split(separator: " ").map(String.init)
        guard let webAt = parts.firstIndex(of: "web"), webAt > 0 else { return false }
        return parts[..<webAt].contains { part in
            let name = (part as NSString).lastPathComponent
            return name == "walnut" || name.hasPrefix("walnut-") || name == "open-walnut"
                || name == "cli.js" || name == "cli.ts"
        }
    }
}

/// How the app waits for a Walnut server that already runs but has not answered.
/// Three minutes, the same ceiling as a server this app starts itself
/// (ServerRestartPolicy.ordinaryStartupTimeout): a server stalled by load after
/// a log-in answers well inside it.
enum RunningServerWait {
    static let deadline: TimeInterval = ServerRestartPolicy.ordinaryStartupTimeout
    static let pollInterval: TimeInterval = 2
    static let requestTimeout: TimeInterval = 5
    /// A holder that died while the app waited sends it back to discovery, at most this often.
    static let maxRediscoveries = 3

    static func busyText(pid: Int32, port: Int?) -> String {
        let at = port.map { " on port \($0)" } ?? ""
        return "Walnut is already running\(at) (pid \(pid)). Waiting for it to answer..."
    }

    static func keptStoppingText() -> String {
        return "Walnut kept stopping while it started. Retry starts it again."
    }

    static func gaveUpText(pid: Int32, port: Int?) -> String {
        let at = port.map { ", port \($0)" } ?? ""
        return "Walnut is already running (pid \(pid)\(at)) but has not answered for \(Int(deadline / 60)) minutes.\n\n"
            + "It may be stuck. Retry waits for it again. To start over, stop it in Terminal with:\n    kill \(pid)\nthen choose Retry."
    }
}

/// What a running server says of its own login session (src/core/login-session.ts,
/// GET /api/config `loginSession`). A server that lives on in a session macOS
/// ended (the user was logged out while it ran) cannot look up its user or
/// resolve names, and cannot move itself into the new session; the app, which
/// runs in it, replaces that server with its own.
enum ServerLoginSession {
    /// The session problems in a /api/config reply (a deleted cwd the server fixes
    /// itself, so it is not one); empty when the reply has none or is unreadable.
    static func endedSessionProblems(configJSON data: Data) -> [String] {
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let session = obj["loginSession"] as? [String: Any],
              let problems = session["problems"] as? [String] else { return [] }
        return problems.filter { $0 == "user_lookup" || $0 == "dns_config" }
    }

    /// Whether this process can look up its own user: the app's own session works.
    static func ownSessionWorks() -> Bool {
        return getpwuid(getuid()) != nil
    }
}

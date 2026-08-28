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

struct ServerRestartPolicy {
    static let healthyResetInterval: TimeInterval = 120
    static let ordinaryStartupTimeout: TimeInterval = 180
    static let nativeRebuildStartupTimeout: TimeInterval = 300
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

import Foundation

/// One async call bounded by a wall clock: the work's answer, or `Deadline.Expired`
/// once `limit` passes (the work is cancelled then). A request's own
/// `timeoutInterval` is an idle timeout and the transport retries a timed-out GET
/// once, so neither bounds how long a screen waits; this does.
enum Deadline {
    struct Expired: Error {}

    static func run<T: Sendable>(_ limit: Duration, _ work: @escaping @Sendable () async throws -> T) async throws -> T {
        try await withThrowingTaskGroup(of: T.self) { group in
            group.addTask { try await work() }
            group.addTask {
                try await Task.sleep(for: limit)
                throw Expired()
            }
            defer { group.cancelAll() }
            guard let first = try await group.next() else { throw Expired() }
            return first
        }
    }
}

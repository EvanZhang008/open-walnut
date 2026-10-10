import Foundation

/// When Walnut may put iOS's Always question: only once it has stayed active for
/// `hold`, so the While Using question has closed. False when that has not
/// happened by `limit` (the user left Walnut); a clock that jumped past `limit`
/// while Walnut was suspended ends it too, and the return asks again.
enum PlacesSettle {
    static func wait(
        hold: TimeInterval = 1,
        limit: TimeInterval = 6,
        step: Duration = .milliseconds(100),
        isActive: () -> Bool,
        now: () -> Date = Date.init,
        sleep: (Duration) async -> Void = { try? await Task.sleep(for: $0) }
    ) async -> Bool {
        let started = now()
        var activeSince: Date?
        while now().timeIntervalSince(started) < limit {
            if isActive() {
                let since = activeSince ?? now()
                activeSince = since
                if now().timeIntervalSince(since) >= hold { return true }
            } else {
                activeSince = nil
            }
            await sleep(step)
        }
        return false
    }
}

/// One attempt at a time. A caller that finds one running waits for it, then
/// runs its own only if `stillWanted` still holds, so an attempt that could not
/// do the work (Walnut was not open) never swallows the next caller's.
@MainActor
final class PlacesOneAtATime {
    private var running: Task<Void, Never>?

    func run(stillWanted: () -> Bool, _ attempt: @escaping @MainActor () async -> Void) async {
        // Each attempt clears `running` before it finishes, so this ends.
        while let task = running { await task.value }
        guard stillWanted() else { return }
        let task = Task { @MainActor in
            await attempt()
            self.running = nil
        }
        running = task
        await task.value
    }
}

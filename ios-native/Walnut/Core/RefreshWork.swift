import Foundation

/// Runs a pull to refresh's work on its own task and waits for it.
///
/// SwiftUI cancelled the letter reader's `.refreshable` task when the work
/// wrote view state at its start (a `loading` flag). The cancelled request was
/// dropped without a word, so under load,
/// when an answer takes longer than that redraw, the pull ended with nothing new
/// on screen (2026-10-28: the letter reader's pull reached the server three
/// times and never showed the new reply; with the answer held 8 s, the read was
/// cancelled after 16 ms). The work's own task is not cancelled with the
/// gesture's, so its answer still lands. `refreshBoard` does the same.
@MainActor
func refreshOnItsOwn(_ work: @escaping @MainActor () async -> Void) async {
    await Task { @MainActor in await work() }.value
}

/// Orders a view's overlapping reads of one thing: an answer is applied only
/// when no read started after it has already been applied, so a slow older
/// answer never replaces a newer one. A class, so counting a read writes no
/// view state (a state write is what redraws the view and cancels a pull).
@MainActor
final class ReadOrder {
    private var started = 0
    private var applied = 0

    /// Call when a read starts; pass the number to `accept` with its answer.
    func begin() -> Int {
        started += 1
        return started
    }

    /// True when this read's answer is the newest so far; it then counts as applied.
    func accept(_ read: Int) -> Bool {
        guard read > applied else { return false }
        applied = read
        return true
    }
}

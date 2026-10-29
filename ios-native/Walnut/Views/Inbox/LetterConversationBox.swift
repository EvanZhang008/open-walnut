import CoreGraphics
import Foundation

/// How tall a letter's conversation box is (`LetterReaderView`). The page
/// scrolls the letter and, under it, the box, which scrolls on its own and
/// opens at its newest turn.
///
/// A letter that leaves the box room on one screen shares that screen with
/// it, so a short letter and its replies are all in view and the page does
/// not scroll. A longer one is read first; the box then fills the screen once
/// the page is scrolled to its end, so a long thread gets the whole height
/// instead of a slot beside the document (2026-10-26).
enum LetterConversationBox {
    /// The least the box keeps when it shares the screen with the letter: half
    /// the visible height, never under `floor`.
    static let shareOfScreen: CGFloat = 0.5
    static let floor: CGFloat = 220

    /// - Parameters:
    ///   - visible: the page's visible height, between the navigation bar and
    ///     the reply box (and the keyboard, when it is up). 0 before it is measured.
    ///   - document: the letter's height above the box, 0 before it is measured.
    /// The most of the reader's height the reply field may take, so a long
    /// draft scrolls inside the field instead of squeezing the conversation.
    static let replyFieldShare: CGFloat = 1.0 / 3.0

    /// The reply field's height cap, from the height the page and the reply box
    /// share (the navigation bar down to the keyboard, or the tab bar), at every
    /// text size and orientation: at the largest sizes five lines took 340pt of
    /// the 430 left above the keyboard and the box got 43 (2026-10-28), and in
    /// landscape five default lines leave the conversation about 60pt. On a tall
    /// phone at the default size five lines sit under it. Nil before it is
    /// measured, so the field keeps its lines.
    static func replyFieldCap(shared: CGFloat) -> CGFloat? {
        guard shared > 0 else { return nil }
        return shared * replyFieldShare
    }

    static func height(visible: CGFloat, document: CGFloat) -> CGFloat {
        guard visible > 0 else { return floor }
        let least = min(visible, max(floor, visible * shareOfScreen))
        let left = visible - document
        return left >= least ? left : visible
    }
}

/// When the letter's page follows a growing draft (`LetterReaderView`): only
/// right after an edit, and once for a burst of new lines. A class, so marking
/// an edit writes no view state.
@MainActor
final class DraftGrowthFollow {
    private var editedAt = Date.distantPast
    private var pending: Task<Void, Never>?

    func edited(at now: Date = Date()) { editedAt = now }

    /// The reply box grew within half a second of an edit: the edit grew it.
    func editedRecently(now: Date = Date()) -> Bool { now.timeIntervalSince(editedAt) < 0.5 }

    /// Runs `action` once the lines stop coming (150ms after the last call).
    func once(_ action: @escaping @MainActor () -> Void) {
        pending?.cancel()
        pending = Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(150))
            guard !Task.isCancelled else { return }
            action()
        }
    }
}

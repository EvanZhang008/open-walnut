import CoreGraphics

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
    static func height(visible: CGFloat, document: CGFloat) -> CGFloat {
        guard visible > 0 else { return floor }
        let least = min(visible, max(floor, visible * shareOfScreen))
        let left = visible - document
        return left >= least ? left : visible
    }
}

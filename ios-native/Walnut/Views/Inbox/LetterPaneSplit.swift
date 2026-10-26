import CoreGraphics

/// How a letter with a thread shares the screen between its two scrolls: the
/// document (decision, body, items) on top and the conversation under it, each
/// scrolling on its own, the conversation opening at its newest turn.
///
/// One scroll used to hold both, and a long document (a daily digest renders at
/// its full height) sat between the reader and the newest reply, so a long
/// thread was hard to scroll to its end (2026-10-25). The console's reader
/// splits the same way, with the same share (`thread-pane-model.ts`).
enum LetterPaneSplit {
    /// The document's share when both panes have more than fits.
    static let documentShare: CGFloat = 0.4

    /// How tall the document pane is: its content when that fits, and otherwise
    /// the larger of its share and what the conversation leaves free, so the
    /// conversation keeps the larger part.
    ///
    /// - Parameters:
    ///   - space: what both panes and the bar between them share.
    ///   - bar: the bar's height.
    ///   - document: the document's content height, 0 before it is measured.
    ///   - conversation: the conversation's content height.
    static func documentHeight(space: CGFloat, bar: CGFloat, document: CGFloat, conversation: CGFloat) -> CGFloat? {
        let avail = space - bar
        guard avail > 0 else { return nil }
        let most = max(avail * documentShare, avail - conversation)
        return document > 0 ? min(document, most) : most
    }
}

import CoreGraphics

/// What a row the reader just opened lays out under it is brought into view.
///
/// Opening a fold keeps the tapped line where it was on screen (the toggle anchor in
/// `TimelineCollectionController`), so a line near the bottom edge opened into rows
/// below the edge: the chevron turned and nothing appeared. At accessibility text
/// sizes the opened row stayed off screen for good, and the tap that should open the
/// thought hit nothing (2026-11-21 iOS gate, the lone "> Thinking" line). The fix is
/// the one every disclosure list makes: scroll just far enough to show what opened,
/// and never so far that the tapped line leaves the top.
enum TimelineOpenReveal {
    /// The rows the tapped row opened: the run of rows right after it in `new` that
    /// `old` did not have. Zero when it closed, or when nothing new appeared.
    static func openedCount(rowID: String, old: [String], new: [String]) -> Int {
        guard let at = new.firstIndex(of: rowID) else { return 0 }
        let before = Set(old)
        var count = 0
        for id in new[(at + 1)...] {
            guard !before.contains(id) else { break }
            count += 1
        }
        return count
    }

    /// The content offset that shows the opened block, `blockMinY` (the tapped line's
    /// top) to `blockMaxY` (the last opened row's bottom): unchanged when it already
    /// fits; otherwise scrolled down by the overflow, at most until the tapped line
    /// reaches the top edge, and never past the end of the content.
    static func offset(current: CGFloat, viewportHeight: CGFloat, topInset: CGFloat,
                       bottomInset: CGFloat, blockMinY: CGFloat, blockMaxY: CGFloat,
                       maxOffset: CGFloat) -> CGFloat {
        let visibleBottom = current + viewportHeight - bottomInset
        let overflow = blockMaxY - visibleBottom
        guard overflow > 0 else { return current }
        let room = max(0, blockMinY - (current + topInset))
        return max(current, min(current + min(overflow, room), maxOffset))
    }
}

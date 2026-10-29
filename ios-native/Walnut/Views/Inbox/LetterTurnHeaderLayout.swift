import SwiftUI

/// A thread turn's header: who wrote it, then the date beside it while both fit
/// whole, else the date on its own line under the name (a task's long name, a
/// large text size).
///
/// A `Layout`, not a `ViewThatFits`: the `ViewThatFits` this replaces kept the
/// app from ever going idle once a session was opened from the letter
/// (2026-10-28: XCUITest timed out waiting for the app to idle, and the same
/// test passed with a plain row). This decides from the width it is offered
/// alone, so nothing it lays out feeds back into the choice.
struct LetterTurnHeaderLayout: Layout {
    var spacing: CGFloat = 5
    var lineSpacing: CGFloat = 2

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        guard let name = subviews.first else { return .zero }
        guard subviews.count > 1 else { return name.sizeThatFits(proposal) }
        let date = subviews[1]
        let line = Self.oneLine(name: name.sizeThatFits(.unspecified), date: date.sizeThatFits(.unspecified), spacing: spacing)
        if Self.fits(line, in: width) { return line }
        let fit = ProposedViewSize(width: width, height: nil)
        let n = name.sizeThatFits(fit)
        let d = date.sizeThatFits(fit)
        return CGSize(width: min(width, max(n.width, d.width)), height: n.height + lineSpacing + d.height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        guard let name = subviews.first else { return }
        guard subviews.count > 1 else {
            name.place(at: bounds.origin, proposal: ProposedViewSize(bounds.size))
            return
        }
        let date = subviews[1]
        let nameIdeal = name.sizeThatFits(.unspecified)
        let dateIdeal = date.sizeThatFits(.unspecified)
        let line = Self.oneLine(name: nameIdeal, date: dateIdeal, spacing: spacing)
        if Self.fits(line, in: bounds.width) {
            name.place(at: CGPoint(x: bounds.minX, y: bounds.midY), anchor: .leading, proposal: ProposedViewSize(nameIdeal))
            date.place(
                at: CGPoint(x: bounds.minX + nameIdeal.width + spacing, y: bounds.midY),
                anchor: .leading, proposal: ProposedViewSize(dateIdeal)
            )
            return
        }
        let fit = ProposedViewSize(width: bounds.width, height: nil)
        let n = name.sizeThatFits(fit)
        name.place(at: bounds.origin, proposal: fit)
        date.place(at: CGPoint(x: bounds.minX, y: bounds.minY + n.height + lineSpacing), proposal: fit)
    }

    /// One rule for both passes, with room for the bounds' rounding to the pixel
    /// grid: a line measured to fit must be placed as one line.
    static func fits(_ line: CGSize, in width: CGFloat) -> Bool {
        line.width <= width + 0.5
    }

    /// Name and date side by side at their own widths.
    static func oneLine(name: CGSize, date: CGSize, spacing: CGFloat) -> CGSize {
        CGSize(width: name.width + spacing + date.width, height: max(name.height, date.height))
    }
}

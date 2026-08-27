import SwiftUI

/// Lays a row of small pills out left to right, wrapping onto a new line when the
/// next one would not fit.
///
/// Why this exists rather than a horizontal `ScrollView`: a closed set of choices
/// (the tier tokens) must be visible all at once. A scroller hides some of them
/// behind a gesture nobody knows to make, and — measured on a 402pt-wide iPhone —
/// clips the last pill mid-word right where the letter rail sits, which reads as a
/// broken layout rather than as "there is more this way". One extra line is the
/// cheaper trade.
///
/// Why a `Layout` and not an `HStack` of computed rows: the wrap point depends on
/// the width this view is actually given, which only the layout system knows. A
/// hand-rolled version has to guess a width and re-guesses it wrong on every
/// device, in landscape, and at larger text sizes.
struct WrappingTokenRow: Layout {
    /// Gap between pills on the same line.
    var spacing: CGFloat = 6
    /// Gap between lines.
    var lineSpacing: CGFloat = 6

    /// One line's worth of laid-out subviews, produced once and reused by both
    /// `sizeThatFits` and `placeSubviews` so the two can never disagree about
    /// where the wrap happened.
    private struct Line {
        var indices: [Int] = []
        var width: CGFloat = 0
        var height: CGFloat = 0
    }

    private func lines(for proposal: ProposedViewSize, subviews: Subviews) -> [Line] {
        // No width offered (a sizing probe) → treat it as unbounded and let the
        // caller's own proposal decide later. `.greatestFiniteMagnitude` rather
        // than `.infinity` so the arithmetic below stays finite.
        let maxWidth = proposal.width ?? .greatestFiniteMagnitude
        var result: [Line] = []
        var line = Line()
        for index in subviews.indices {
            let size = subviews[index].sizeThatFits(.unspecified)
            let needed = line.indices.isEmpty ? size.width : line.width + spacing + size.width
            if !line.indices.isEmpty, needed > maxWidth {
                result.append(line)
                line = Line()
                line.indices = [index]
                line.width = size.width
                line.height = size.height
            } else {
                line.width = needed
                line.height = max(line.height, size.height)
                line.indices.append(index)
            }
        }
        if !line.indices.isEmpty { result.append(line) }
        return result
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let laid = lines(for: proposal, subviews: subviews)
        guard !laid.isEmpty else { return .zero }
        let height = laid.reduce(0) { $0 + $1.height } + CGFloat(laid.count - 1) * lineSpacing
        // Report the WIDEST line, not the proposed width: reporting the proposal
        // would claim the full row width even for a single short pill, which
        // pushes anything trailing it off screen.
        let width = laid.map(\.width).max() ?? 0
        return CGSize(width: min(width, proposal.width ?? width), height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var y = bounds.minY
        for line in lines(for: proposal, subviews: subviews) {
            var x = bounds.minX
            for index in line.indices {
                let size = subviews[index].sizeThatFits(.unspecified)
                subviews[index].place(
                    at: CGPoint(x: x, y: y + (line.height - size.height) / 2),
                    proposal: ProposedViewSize(size)
                )
                x += size.width + spacing
            }
            y += line.height + lineSpacing
        }
    }
}

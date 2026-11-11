import UIKit

/// Vertical stack layout of KNOWN row heights — no self-sizing, ever.
/// Heights come from the actor's pre-measurement, so prepare() is pure
/// prefix-sum arithmetic: O(rows) additions per invalidation (~µs at 400
/// rows), and layoutAttributesForElements is a binary search + slice.
final class TimelineLayout: UICollectionViewLayout {
    /// Row heights, set by the controller before invalidation.
    var rowHeights: [CGFloat] = []
    var rowSpacing: CGFloat = 10
    /// Which rows are steps of a turn (`TimelineRowContent.isStepRow`): two steps in a
    /// row sit `stepSpacing` apart, the web's density (rows about 26pt apart), every
    /// other pair `rowSpacing`. Empty (or shorter than the rows): `rowSpacing` throughout.
    var rowIsStep: [Bool] = []
    var stepSpacing: CGFloat = TimelineMetrics.stepRowGap
    var topInset: CGFloat = 12
    var bottomInset: CGFloat = 12

    private var yOffsets: [CGFloat] = []
    private var contentHeight: CGFloat = 0
    private var width: CGFloat = 0

    override func prepare() {
        super.prepare()
        width = collectionView?.bounds.width ?? 0
        yOffsets.removeAll(keepingCapacity: true)
        yOffsets.reserveCapacity(rowHeights.count)
        var y = topInset
        for (i, h) in rowHeights.enumerated() {
            yOffsets.append(y)
            y += h
            if i + 1 < rowHeights.count { y += gap(after: i) }
        }
        contentHeight = y + bottomInset
    }

    /// The space between row `i` and the next.
    func gap(after i: Int) -> CGFloat {
        let steps = i + 1 < rowIsStep.count && rowIsStep[i] && rowIsStep[i + 1]
        return steps ? stepSpacing : rowSpacing
    }

    override var collectionViewContentSize: CGSize {
        CGSize(width: width, height: contentHeight)
    }

    override func layoutAttributesForItem(at indexPath: IndexPath) -> UICollectionViewLayoutAttributes? {
        let i = indexPath.item
        guard i >= 0, i < rowHeights.count else { return nil }
        let attrs = UICollectionViewLayoutAttributes(forCellWith: indexPath)
        attrs.frame = CGRect(x: 0, y: yOffsets[i], width: width, height: rowHeights[i])
        return attrs
    }

    override func layoutAttributesForElements(in rect: CGRect) -> [UICollectionViewLayoutAttributes]? {
        guard !yOffsets.isEmpty else { return nil }
        // Binary search for the first row whose maxY >= rect.minY.
        var lo = 0
        var hi = yOffsets.count - 1
        while lo < hi {
            let mid = (lo + hi) / 2
            if yOffsets[mid] + rowHeights[mid] < rect.minY { lo = mid + 1 } else { hi = mid }
        }
        var out: [UICollectionViewLayoutAttributes] = []
        var i = lo
        while i < yOffsets.count, yOffsets[i] <= rect.maxY {
            if let attrs = layoutAttributesForItem(at: IndexPath(item: i, section: 0)) {
                out.append(attrs)
            }
            i += 1
        }
        return out
    }

    override func shouldInvalidateLayout(forBoundsChange newBounds: CGRect) -> Bool {
        newBounds.width != width
    }

    // MARK: - Anchor queries (viewport restoration for unpinned readers)

    /// Index of the first row whose bottom edge reaches `y` (binary search on
    /// the prefix sums). nil when the layout is empty.
    func rowIndex(at y: CGFloat) -> Int? {
        guard !yOffsets.isEmpty else { return nil }
        var lo = 0
        var hi = yOffsets.count - 1
        while lo < hi {
            let mid = (lo + hi) / 2
            if yOffsets[mid] + rowHeights[mid] < y { lo = mid + 1 } else { hi = mid }
        }
        return lo
    }

    /// Top y of row `i` in content coordinates (nil out of range). Reads the
    /// CURRENT prepared offsets — call after invalidate+layout.
    func rowMinY(_ i: Int) -> CGFloat? {
        guard i >= 0, i < yOffsets.count else { return nil }
        return yOffsets[i]
    }
}

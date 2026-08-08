import UIKit

/// Vertical stack layout of KNOWN row heights — no self-sizing, ever.
/// Heights come from the actor's pre-measurement, so prepare() is pure
/// prefix-sum arithmetic: O(rows) additions per invalidation (~µs at 400
/// rows), and layoutAttributesForElements is a binary search + slice.
final class TimelineLayout: UICollectionViewLayout {
    /// Row heights, set by the controller before invalidation.
    var rowHeights: [CGFloat] = []
    var rowSpacing: CGFloat = 10
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
        for h in rowHeights {
            yOffsets.append(y)
            y += h + rowSpacing
        }
        contentHeight = (rowHeights.isEmpty ? topInset : y - rowSpacing) + bottomInset
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
}

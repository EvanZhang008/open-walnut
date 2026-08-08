import UIKit

/// TextKit 2 height/size pre-measurement, run on the TimelineLayoutActor
/// (never the main thread). One instance per actor: TextKit objects are not
/// thread-safe, but the actor serializes all access to this stack.
///
/// PARITY CONTRACT: the measuring stack must match the rendering stack.
/// TimelineTextCell renders through a UITextView with TextKit 2 (the iOS 16+
/// default), `lineFragmentPadding = 0` and `.zero` container insets — this
/// measurer uses an identically configured NSTextLayoutManager, so measured
/// heights equal rendered heights (verified by the parity gate in
/// TimelineEngineTests).
final class TimelineTextMeasurer {
    private let layoutManager = NSTextLayoutManager()
    private let container: NSTextContainer
    private let contentStorage = NSTextContentStorage()

    init() {
        container = NSTextContainer(size: CGSize(width: 0, height: CGFloat.greatestFiniteMagnitude))
        container.lineFragmentPadding = 0
        layoutManager.textContainer = container
        contentStorage.addTextLayoutManager(layoutManager)
    }

    /// Height of `text` wrapped at `width`.
    func height(_ text: NSAttributedString, width: CGFloat) -> CGFloat {
        measure(text, width: width).height
    }

    /// Full used size (bubbles hug their text, so the used WIDTH matters too).
    func measure(_ text: NSAttributedString, width: CGFloat) -> CGSize {
        guard text.length > 0, width > 0 else { return .zero }
        container.size = CGSize(width: width, height: .greatestFiniteMagnitude)
        contentStorage.performEditingTransaction {
            contentStorage.attributedString = text
        }
        layoutManager.ensureLayout(for: layoutManager.documentRange)
        var maxY: CGFloat = 0
        var maxX: CGFloat = 0
        layoutManager.enumerateTextLayoutFragments(
            from: nil, options: [.ensuresLayout]
        ) { fragment in
            let frame = fragment.layoutFragmentFrame
            maxY = max(maxY, frame.maxY)
            // Fragment frames span the container width; the USED width lives
            // on the line fragments.
            for line in fragment.textLineFragments {
                maxX = max(maxX, frame.minX + line.typographicBounds.maxX)
            }
            return true
        }
        // Detach the (potentially large) string so the stack doesn't retain it
        // between measurements.
        contentStorage.performEditingTransaction {
            contentStorage.attributedString = NSAttributedString()
        }
        return CGSize(width: ceil(min(maxX, width)), height: ceil(maxY))
    }

    /// Unwrapped single-run measurement for horizontally scrolling content
    /// (code blocks): height = line count x line height, width = longest line.
    func codeSize(_ text: String, font: UIFont) -> CGSize {
        var lines = 0
        var maxWidth: CGFloat = 0
        var start = text.startIndex
        let attrs: [NSAttributedString.Key: Any] = [.font: font]
        while start < text.endIndex {
            let end = text[start...].firstIndex(of: "\n") ?? text.endIndex
            let line = String(text[start..<end])
            lines += 1
            if !line.isEmpty {
                maxWidth = max(maxWidth, (line as NSString).size(withAttributes: attrs).width)
            }
            start = end < text.endIndex ? text.index(after: end) : text.endIndex
        }
        if text.hasSuffix("\n") { lines += 1 }
        lines = max(lines, 1)
        return CGSize(width: ceil(maxWidth), height: ceil(CGFloat(lines) * font.lineHeight))
    }
}

import UIKit

/// Attachments used inside the WYSIWYG editor. Each carries the EXACT
/// original markdown source it replaced, so serialization is lossless by
/// construction: emitting `source` for attachments and characters for
/// everything else reproduces the note byte-for-byte.

/// Stands in for a task marker (`- [ ] ` / `- [x] `, any indent/bullet char).
final class CheckboxAttachment: NSTextAttachment {
    /// Exact matched marker text, e.g. "  - [x] ". Toggling flips only the
    /// bracket character inside this string.
    private(set) var source: String
    private(set) var checked: Bool

    init(source: String, checked: Bool) {
        self.source = source
        self.checked = checked
        super.init(data: nil, ofType: nil)
        updateImage()
    }

    required init?(coder: NSCoder) { nil }

    func toggle() {
        checked.toggle()
        if let range = source.range(of: #"\[( |x|X)\]"#, options: .regularExpression) {
            source = source.replacingCharacters(in: range, with: checked ? "[x]" : "[ ]")
        }
        updateImage()
    }

    /// Canvas is wider than the glyph: the extra trailing width IS the gap
    /// between circle and text (Apple Notes spacing). Keep in sync with the
    /// `.task` headIndent in MarkdownAttributed so wrapped lines align.
    static let canvasWidth: CGFloat = 34

    private func updateImage() {
        let config = UIImage.SymbolConfiguration(pointSize: 21, weight: .light)
        let name = checked ? "checkmark.circle.fill" : "circle"
        // Fixed mid-tone colors legible in both light and dark mode — attachment
        // images are baked, dynamic colors don't re-resolve on trait change.
        let tint = checked ? UIColor(red: 0.66, green: 0.45, blue: 0.25, alpha: 1) : UIColor(white: 0.68, alpha: 1)
        let symbol = UIImage(systemName: name, withConfiguration: config)?
            .withTintColor(tint, renderingMode: .alwaysOriginal)
        let size = CGSize(width: Self.canvasWidth, height: 24)
        image = UIGraphicsImageRenderer(size: size).image { _ in
            symbol?.draw(at: CGPoint(x: 0, y: (size.height - (symbol?.size.height ?? 0)) / 2))
        }
        bounds = CGRect(x: 0, y: -5, width: size.width, height: size.height)
    }
}

/// Round dot standing in for a `- ` / `* ` / `+ ` bullet marker (any indent),
/// so the editor shows an Apple Notes-style bullet instead of the literal
/// dash. Serializes back to the exact original marker text.
final class BulletAttachment: NSTextAttachment {
    /// Exact matched marker text including leading whitespace, e.g. "  - ".
    let source: String

    /// Wider-than-glyph canvas = built-in gap to the text (matches checkbox).
    static let canvasWidth: CGFloat = 26

    init(source: String) {
        self.source = source
        super.init(data: nil, ofType: nil)
        let size = CGSize(width: Self.canvasWidth, height: 20)
        image = UIGraphicsImageRenderer(size: size).image { _ in
            let dot = CGRect(x: 6, y: 7, width: 6, height: 6)
            UIColor.label.setFill()
            UIBezierPath(ovalIn: dot).fill()
        }
        bounds = CGRect(x: 0, y: -2.5, width: size.width, height: size.height)
    }

    required init?(coder: NSCoder) { nil }
}

/// Inline image for `![[name.png]]` / `![alt](path)` embeds. Shows a grey
/// placeholder immediately; swaps in the real image when the authed loader
/// delivers, resizing to the editor width without touching the text (so the
/// caret never jumps).
final class RemoteImageAttachment: NSTextAttachment {
    /// Exact original embed text (e.g. "![[pasted-image-x.png|300]]").
    let source: String
    /// What GET /api/notes-v2/attachment resolves (name or vault path).
    let rawPath: String
    private var loadStarted = false

    init(source: String, rawPath: String, maxWidth: CGFloat) {
        self.source = source
        self.rawPath = rawPath
        super.init(data: nil, ofType: nil)
        bounds = CGRect(x: 0, y: 0, width: max(maxWidth, 80), height: 160)
        image = Self.placeholder(size: bounds.size)
    }

    required init?(coder: NSCoder) { nil }

    /// Kick off the async fetch once; on arrival update the attachment and
    /// invalidate layout for just this attachment's range.
    func loadIfNeeded(maxWidth: CGFloat, in textView: UITextView) {
        guard !loadStarted else { return }
        loadStarted = true
        Task { @MainActor [weak self, weak textView] in
            guard let self else { return }
            guard let loaded = await AttachmentLoader.shared.image(for: self.rawPath) else { return }
            let width = min(max(maxWidth, 80), loaded.size.width == 0 ? maxWidth : max(loaded.size.width, 80))
            let height = loaded.size.width > 0 ? width * loaded.size.height / loaded.size.width : 160
            self.image = loaded
            self.bounds = CGRect(x: 0, y: 0, width: width, height: height)
            guard let textView else { return }
            let storage = textView.textStorage
            storage.enumerateAttribute(.attachment, in: NSRange(location: 0, length: storage.length)) { value, range, stop in
                if value as? RemoteImageAttachment === self {
                    storage.edited(.editedAttributes, range: range, changeInLength: 0)
                    textView.layoutManager.invalidateLayout(forCharacterRange: range, actualCharacterRange: nil)
                    stop.pointee = true
                }
            }
        }
    }

    private static func placeholder(size: CGSize) -> UIImage {
        let renderer = UIGraphicsImageRenderer(size: size)
        return renderer.image { ctx in
            UIColor.secondarySystemBackground.setFill()
            UIBezierPath(roundedRect: CGRect(origin: .zero, size: size), cornerRadius: 12).fill()
            let config = UIImage.SymbolConfiguration(pointSize: 28, weight: .light)
            if let photo = UIImage(systemName: "photo", withConfiguration: config)?
                .withTintColor(.tertiaryLabel, renderingMode: .alwaysOriginal) {
                let origin = CGPoint(x: (size.width - photo.size.width) / 2, y: (size.height - photo.size.height) / 2)
                photo.draw(at: origin)
            }
        }
    }
}

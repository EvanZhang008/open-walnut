import SwiftUI

/// A markdown letter body (or a markdown thread turn), rendered with the SAME
/// no-remote-subresource posture the HTML path gets from its CSP.
///
/// Why this exists instead of calling `MarkdownView` directly: a letter is
/// arbitrary AGENT-authored text read on a phone, and the app's markdown
/// pipeline resolves an image reference through `AttachmentLoader`, which
/// fetches any `http(s)://` reference directly and unauthenticated. So
/// `![](https://example.com/p.png)` in a letter — or even a bare image URL,
/// which the parser also auto-detects — would hand a third party the exact
/// moment the human opened the letter, plus the device IP and user agent, and
/// cache the bytes to disk. `LetterHTMLBody` blocks precisely that with
/// `default-src 'none'; img-src data: blob:`, and the two body formats must not
/// have different security floors.
///
/// What still renders: everything that stays inside Walnut. A local path
/// (`/tmp/run/shot.png`) goes through the authenticated media endpoint on the
/// letter's own host, and a vault-relative name through the notes attachment
/// endpoint, exactly as before. Only references that would leave the device for
/// somewhere else are replaced with a visible note — never silently dropped, so
/// the human can still see that the agent meant to show something.
struct LetterMarkdownBody: View {
    let markdown: String

    var body: some View {
        MarkdownView(blocks: Self.blocks(for: markdown))
    }

    static func blocks(for markdown: String) -> [MarkdownBlock] {
        sanitized(MarkdownParser.parse(markdown, cache: .skip, clipOversized: false))
    }

    /// True when loading this reference would make a request to something other
    /// than Walnut. Any URL SCHEME counts, not just http(s): a future loader
    /// that learns one more scheme must not silently re-open the hole. `data:`
    /// and `blob:` are the two exceptions — they never leave the device, and
    /// they are exactly what the HTML path's CSP allows.
    static func isRemoteReference(_ raw: String) -> Bool {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let colon = trimmed.firstIndex(of: ":") else { return false }
        let scheme = trimmed[trimmed.startIndex..<colon].lowercased()
        guard let first = scheme.first, first.isLetter else { return false }
        let wellFormed = scheme.allSatisfy { $0.isLetter || $0.isNumber || $0 == "+" || $0 == "-" || $0 == "." }
        guard wellFormed else { return false }
        return scheme != "data" && scheme != "blob"
    }

    /// Replace every remote image block with a note. Blocks are flat (the parser
    /// splits images out of their paragraph), so one pass covers the document.
    static func sanitized(_ blocks: [MarkdownBlock]) -> [MarkdownBlock] {
        blocks.map { block in
            guard case .image(let raw, let alt) = block.kind, isRemoteReference(raw) else { return block }
            return MarkdownBlock(id: block.id, kind: .paragraph(blockedImageNote(raw: raw, alt: alt)))
        }
    }

    /// The note names what was skipped (alt text if the agent wrote one, else the
    /// reference itself, clipped) so the letter still reads honestly.
    static func blockedImageNote(raw: String, alt: String) -> AttributedString {
        let label = alt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            ? String(raw.trimmingCharacters(in: .whitespacesAndNewlines).prefix(120))
            : alt.trimmingCharacters(in: .whitespacesAndNewlines)
        var note = AttributedString("Image not loaded — a letter never fetches from another server: \(label)")
        note.font = .footnote.italic()
        return note
    }
}

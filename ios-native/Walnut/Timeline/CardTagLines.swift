import Foundation

/// A reply's thread card lines, left out of what the screen shows. Port of the server's
/// `src/lib/card-tag.ts` (`stripCardTags`), the half a screen needs; `InternalLines.strip`
/// runs it, so the shared cases (`tests/fixtures/internal-lines/cases.json`) hold it on
/// both sides.
///
/// A session that keeps Threads ends its reply with one line of its own per thread,
/// `<walnut-card thread="th-..." state="answered"/>`, and Walnut writes the thread's card
/// from it. The server's history parse takes the lines off every saved row; a reply still
/// streaming has not been through it, so the timeline drops them itself, and holds back a
/// last line that is so far the start of one, so the tag never flashes up.
///
/// A line is one only as a line of its own outside a code fence; a quote of it in a
/// sentence or a code block stays text. The server reads only the ones among the reply's
/// last lines; the screen leaves every one out.
enum CardTagLines {
    static let name = "walnut-card"
    private static let head = "<\(name)"
    /// From here on a start is this tag's alone: the other tags' holds take a shorter one.
    private static let ownStart = "<walnut-c"

    // `\z`, not `$`: ICU's `$` also matches before a final line break.
    private static let cardLine = InternalLines.js(#"^ {0,3}<walnut-card(?![A-Za-z0-9_-])[^\n\r]*>\s*\z"#)
    private static let cardStart = InternalLines.js(#"^<walnut-card(?![A-Za-z0-9_-])"#)
    /// How a card line may start: at most three spaces before its first character.
    private static let cardLead = InternalLines.js(#"^ {0,3}\S"#)
    private static let trailingSpace = InternalLines.js(#"\s+\z"#)

    /// The text as the screen shows it: never a card line. `streaming`: a last line that is
    /// so far the start of one stays out too.
    static func strip(_ text: String, streaming: Bool = false) -> String {
        let out = withoutCardLines(text)
        guard streaming else { return out }
        // In UTF-16, as the server cuts: a Swift "\r\n" is one Character.
        let ns = out as NSString
        let cut = ns.range(of: "\n", options: .backwards).location
        let last = cut == NSNotFound ? out : ns.substring(from: cut + 1)
        // A line indented further than a card line may be (four spaces, a tab) is code: it shows as it comes.
        guard InternalLines.test(cardLead, last) else { return out }
        let tail = InternalLines.trimmed(last)
        guard (tail.utf16.count >= ownStart.utf16.count && head.hasPrefix(tail)) || InternalLines.test(cardStart, tail) else { return out }
        // Inside a code block the line is code: it shows as it comes.
        guard MessageAboutTag.outsideFence(InternalLines.lines(out).map(InternalLines.bare)).last == true else { return out }
        return cut == NSNotFound ? "" : ns.substring(to: cut)
    }

    /// The text without its card lines, wherever they stand (one further up would flash up while
    /// the reply streams), or as it is when it holds none. One blank line stays where a card
    /// line left the middle of the text.
    private static func withoutCardLines(_ src: String) -> String {
        guard InternalLines.has(src, head) else { return src }
        let lines = InternalLines.lines(src)
        // The tasks line's fence rule, as on the server (message-about.ts outsideFence): one for both.
        let outside = MessageAboutTag.outsideFence(lines.map(InternalLines.bare))
        var kept: [String] = []
        var after = false
        var found = false
        for (i, line) in lines.enumerated() {
            if outside[i], InternalLines.test(cardLine, line) { after = true; found = true; continue }
            if after, InternalLines.trimmed(line).isEmpty, InternalLines.trimmed(kept.last ?? "").isEmpty { continue }
            after = false
            kept.append(line)
        }
        guard found else { return src }
        let text = kept.joined(separator: "\n")
        let ns = text as NSString
        guard let m = trailingSpace.firstMatch(in: text, range: NSRange(location: 0, length: ns.length)) else { return text }
        return ns.substring(to: m.range.location)
    }
}

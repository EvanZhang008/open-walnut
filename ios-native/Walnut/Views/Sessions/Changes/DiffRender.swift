import SwiftUI
import UIKit

/// A file's diff ready to draw: the aligned lines, each with its syntax colors.
///
/// Built once per file off the main actor (`make`), so a 5,000-line file costs
/// the page nothing while it scrolls.
struct DiffRender {
    let diff: FileDiff
    /// One per `diff.lines`, colored for the file's language (plain when it has none).
    let styled: [AttributedString]
    /// The widest line, in characters (tabs expanded): sizes the no-wrap canvas.
    let widestLine: String
    /// `DiffLine.key` to its index in `diff.lines`.
    let indexByKey: [String: Int]
    /// How many lines are drawn cut (`maxShownCharacters`).
    var cutLines = 0

    /// How many spaces a tab is drawn as.
    static let tabWidth = 4
    /// A line drawn longer than this is cut there (a minified file's one line
    /// would make a view a million points wide); Copy in the selection bar copies all of it.
    static let maxShownCharacters = 3_000
    /// Past this much text in one version the colors are left out.
    static let maxHighlightedCharacters = 600_000
    /// Each colored run is at most this long (the highlighter's own cap is 20,000).
    static let highlightChunk = 16_000

    static func make(before: String, after: String, fileName: String) -> DiffRender {
        let diff = DiffEngine.diff(before: before, after: after)
        let grammar = CodeHighlighter.fence(fileName).grammar
        let oldColored = grammar.flatMap { colorLines(before, grammar: $0) }
        let newColored = grammar.flatMap { colorLines(after, grammar: $0) }
        var styled: [AttributedString] = []
        styled.reserveCapacity(diff.lines.count)
        var widest = ""
        var widestCount = 0
        var indexByKey: [String: Int] = [:]
        var cutLines = 0
        indexByKey.reserveCapacity(diff.lines.count)
        for (index, line) in diff.lines.enumerated() {
            indexByKey[line.key] = index
            if isCut(line.text), let cut = cutLine(line.text) {
                if cut.shown.count > widestCount { widestCount = cut.shown.count; widest = cut.shown }
                styled.append(cut.styled)
                cutLines += 1
                continue
            }
            let shown = expandTabs(line.text)
            if shown.count > widestCount { widestCount = shown.count; widest = shown }
            var colored: AttributedString?
            switch line.kind {
            case .removed:
                if let n = line.oldNumber, let all = oldColored, n - 1 < all.count { colored = all[n - 1] }
            default:
                if let n = line.newNumber, let all = newColored, n - 1 < all.count { colored = all[n - 1] }
            }
            styled.append(colored ?? AttributedString(shown))
        }
        return DiffRender(diff: diff, styled: styled, widestLine: widest, indexByKey: indexByKey, cutLines: cutLines)
    }

    /// True when `text` is drawn cut (the UTF-16 test first: it is the cheap one).
    static func isCut(_ text: String) -> Bool {
        text.utf16.count > maxShownCharacters && text.count > maxShownCharacters
    }

    /// A line past `maxShownCharacters`, cut there, with how much is left.
    static func cutLine(_ text: String) -> (styled: AttributedString, shown: String)? {
        guard isCut(text) else { return nil }
        let head = expandTabs(String(text.prefix(maxShownCharacters)))
        let left = text.count - maxShownCharacters
        var note = AttributedString(" \u{2026} \(left.formatted()) more characters (select the line, then Copy, for all of it)")
        note.foregroundColor = Color.secondary
        return (AttributedString(head) + note, head + " \u{2026} \(left.formatted()) more characters (select the line, then Copy, for all of it)")
    }

    static func expandTabs(_ text: String) -> String {
        text.contains("\t") ? text.replacingOccurrences(of: "\t", with: String(repeating: " ", count: tabWidth)) : text
    }

    /// Every line of `text` colored, highlighted a chunk of whole lines at a time.
    static func colorLines(_ text: String, grammar: CodeHighlighter.Grammar) -> [AttributedString]? {
        guard !text.isEmpty, text.utf16.count <= maxHighlightedCharacters else { return nil }
        // A cut line is drawn plain: its colors are not worth painting what is not shown.
        let lines = DiffEngine.lines(of: text).map { isCut($0) ? "" : $0 }
        let font = UIFont.monospacedSystemFont(ofSize: 12, weight: .regular)
        var out: [AttributedString] = []
        out.reserveCapacity(lines.count)
        var start = 0
        while start < lines.count {
            var end = start
            var size = 0
            while end < lines.count, end == start || size + lines[end].utf16.count + 1 <= highlightChunk {
                size += lines[end].utf16.count + 1
                end += 1
            }
            let chunk = lines[start..<end].joined(separator: "\n")
            let painted = CodeHighlighter.attributed(chunk, grammar: grammar, font: font)
            var location = 0
            for k in start..<end {
                let length = lines[k].utf16.count
                out.append(attributedLine(painted, NSRange(location: location, length: length)))
                location += length + 1
            }
            start = end
        }
        return out
    }

    /// One line of a painted chunk as SwiftUI text: its color runs, tabs expanded.
    private static func attributedLine(_ painted: NSAttributedString, _ range: NSRange) -> AttributedString {
        guard range.length > 0, NSMaxRange(range) <= painted.length else { return AttributedString("") }
        var line = AttributedString()
        let whole = painted.string as NSString
        painted.enumerateAttribute(.foregroundColor, in: range) { value, run, _ in
            let text = expandTabs(whole.substring(with: run))
            var piece = AttributedString(text)
            if let color = value as? UIColor, !color.isEqual(UIColor.label) {
                piece.foregroundColor = Color(uiColor: color)
            }
            line += piece
        }
        return line
    }
}

extension DiffRender {
    /// True when a comment's lines still read as they did when it was left; false
    /// once the file changed under it (its card then says so).
    func reads(_ comment: DiffReviewComment) -> Bool {
        let now = comment.lineKeys.compactMap { indexByKey[$0].map { diff.lines[$0].text } }
        return now.count == comment.lineKeys.count && now.joined(separator: "\n") == comment.code
    }
}

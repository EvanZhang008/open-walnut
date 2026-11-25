import Foundation

/// The lines of a reply that the screen leaves out, for a developer's "Hidden by Walnut" fold
/// (Settings > Advanced, `ui.show_hidden_lines`). Port of the server's `hiddenLinesOf`
/// (src/lib/internal-lines.ts), case for case: both run `tests/fixtures/hidden-lines/cases.json`.
/// It only compares the two texts, so any hiding counts (the status report, a turn-end marker, an
/// Org chat's tasks line, a version tag): a line is hidden when no line of `shown` stands for it
/// in the longest run they share, and a line whose start alone was cut gives only that start.
enum HiddenLines {
    /// Past this many cells the middle is compared by set, not by the exact walk (a long rewrite).
    static let diffCellsMax = 200_000

    static func of(raw: String, shown: String) -> String {
        if raw == shown { return "" }
        // Split on "\n" alone, as the server does: Swift's Character treats "\r\n" as one.
        let a = lines(raw)
        let b = shown.isEmpty ? [] : lines(shown)
        var head = 0
        while head < a.count, head < b.count, a[head] == b[head] { head += 1 }
        var tail = 0
        while tail < a.count - head, tail < b.count - head, a[a.count - 1 - tail] == b[b.count - 1 - tail] { tail += 1 }
        let midA = Array(a[head..<(a.count - tail)])
        let midB = Array(b[head..<(b.count - tail)])
        var out: [String]
        if midB.isEmpty {
            out = midA
        } else if midA.count * midB.count > diffCellsMax {
            let kept = Set(midB)
            out = midA.filter { !kept.contains($0) }
        } else {
            func stands(_ r: String, _ sh: String) -> Bool {
                r == sh || (!sh.trimmingCharacters(in: .whitespaces).isEmpty && r.hasSuffix(sh))
            }
            let n = midA.count, m = midB.count, w = m + 1
            var len = [UInt32](repeating: 0, count: (n + 1) * w)
            for i in stride(from: n - 1, through: 0, by: -1) {
                for j in stride(from: m - 1, through: 0, by: -1) {
                    len[i * w + j] = stands(midA[i], midB[j]) ? len[(i + 1) * w + j + 1] + 1
                        : max(len[(i + 1) * w + j], len[i * w + j + 1])
                }
            }
            out = []
            var i = 0, j = 0
            while i < n {
                if j < m, stands(midA[i], midB[j]) {
                    let cut = String(midA[i].unicodeScalars.dropLast(midB[j].unicodeScalars.count))
                        .trimmingCharacters(in: .whitespaces)
                    if !cut.isEmpty { out.append(cut) }
                    i += 1; j += 1
                } else if j < m, len[i * w + j + 1] >= len[(i + 1) * w + j] {
                    j += 1
                } else {
                    out.append(midA[i]); i += 1
                }
            }
        }
        let blank = { (s: String) in s.trimmingCharacters(in: .whitespaces).isEmpty }
        var s = 0, e = out.count
        while s < e, blank(out[s]) { s += 1 }
        while e > s, blank(out[e - 1]) { e -= 1 }
        return out[s..<e].joined(separator: "\n")
    }

    /// The text's lines split on "\n" by scalar, each without its trailing whitespace (`lineKey`).
    private static func lines(_ text: String) -> [String] {
        text.unicodeScalars.split(separator: "\n", omittingEmptySubsequences: false).map { scalars in
            var view = String.UnicodeScalarView(scalars)
            while let last = view.last, CharacterSet.whitespacesAndNewlines.contains(last) { view.removeLast() }
            return String(view)
        }
    }
}

import Foundation

/// One line of a unified diff.
struct DiffLine: Equatable, Hashable {
    enum Kind: String, Codable { case context, added, removed }
    let kind: Kind
    /// 1-based line in the old file (nil for an added line).
    let oldNumber: Int?
    /// 1-based line in the new file (nil for a removed line).
    let newNumber: Int?
    /// The line's text, without its newline.
    let text: String

    /// The number a person reads for it: the new file's, or the old one's for a
    /// removed line (the same rule the web diff's line comments use).
    var displayNumber: Int { newNumber ?? oldNumber ?? 0 }

    /// Identity inside one diff, stable across a reload of the same content.
    var key: String {
        switch kind {
        case .removed: return "o\(oldNumber ?? 0)"
        default: return "n\(newNumber ?? 0)"
        }
    }
}

/// What a page of the diff shows: the lines near a change, and a fold for each
/// run of unchanged lines between them.
enum DiffRow: Equatable, Identifiable {
    /// `index` into `FileDiff.lines`.
    case line(index: Int)
    /// Unchanged lines `range` (indices into `FileDiff.lines`) folded away.
    case fold(range: Range<Int>)

    var id: String {
        switch self {
        case .line(let index): return "l\(index)"
        case .fold(let range): return "f\(range.lowerBound)-\(range.upperBound)"
        }
    }
}

/// A file's whole diff: every line of both versions, aligned.
struct FileDiff: Equatable {
    let lines: [DiffLine]
    let additions: Int
    let deletions: Int
    /// The rewrite was too large to align line by line, so its middle reads as
    /// all removed, then all added.
    let approximate: Bool

    var isEmpty: Bool { additions == 0 && deletions == 0 }

    /// Unchanged lines kept around each change.
    static let context = 3
    /// A fold this short opens all at once; a longer one opens this many lines at each end.
    static let foldStep = 20

    /// The rows to draw: lines within `context` of a change or inside an opened
    /// range, and one fold per run of the rest.
    func rows(opened: [Range<Int>] = []) -> [DiffRow] {
        guard !lines.isEmpty else { return [] }
        var visible = [Bool](repeating: false, count: lines.count)
        for (i, line) in lines.enumerated() where line.kind != .context {
            let lo = max(0, i - Self.context)
            let hi = min(lines.count - 1, i + Self.context)
            for j in lo...hi { visible[j] = true }
        }
        for range in opened {
            let lo = max(0, range.lowerBound)
            let hi = min(lines.count, range.upperBound)
            if lo < hi { for j in lo..<hi { visible[j] = true } }
        }
        var rows: [DiffRow] = []
        var i = 0
        while i < lines.count {
            if visible[i] {
                rows.append(.line(index: i))
                i += 1
            } else {
                var j = i
                while j < lines.count && !visible[j] { j += 1 }
                rows.append(.fold(range: i..<j))
                i = j
            }
        }
        return rows
    }

    /// What tapping a fold opens: all of a short one, both ends of a long one.
    static func opening(_ fold: Range<Int>) -> [Range<Int>] {
        if fold.count <= foldStep * 2 { return [fold] }
        return [fold.lowerBound..<(fold.lowerBound + foldStep), (fold.upperBound - foldStep)..<fold.upperBound]
    }
}

/// Line diff of two texts. Pure and synchronous: callers run it off the main actor.
enum DiffEngine {
    /// Past this many lines left after trimming the common head and tail, the
    /// middle is not aligned (a whole-file rewrite would take seconds on a phone).
    static let maxAlignedLines = 24_000
    /// Past this many removed plus added lines the middle is not aligned either:
    /// the walk's time and memory grow with it (memory with its square). The
    /// server's line counts stop being exact at the same number
    /// (EXACT_COUNT_MAX_EDITS in session-changes-core.ts).
    static let maxAlignedEdits = 1_500

    /// Lines the way a diff counts them: a final newline ends the last line.
    /// A trailing CR (a CRLF file) is not part of what is shown.
    static func lines(of text: String) -> [String] {
        guard !text.isEmpty else { return [] }
        var parts = text.components(separatedBy: "\n")
        if parts.last == "" { parts.removeLast() }
        return parts.map { $0.hasSuffix("\r") ? String($0.dropLast()) : $0 }
    }

    /// Myers' O(ND) walk with an edit budget: which lines of `a` go and which of
    /// `b` come, or nil when it takes more than `maxEdits` of them. Keeps each
    /// step's frontier (about D squared numbers in all) to walk the path back.
    static func alignedEdits(_ a: [String], _ b: [String], maxEdits: Int) -> (removed: Set<Int>, inserted: Set<Int>)? {
        var ids: [String: Int] = [:]
        func id(_ line: String) -> Int {
            if let known = ids[line] { return known }
            let next = ids.count
            ids[line] = next
            return next
        }
        let x = a.map(id)
        let y = b.map(id)
        let n = x.count, m = y.count
        // Lines one side has more of than the other must change: a floor under the edits.
        var surplus: [Int: Int] = [:]
        for v in x { surplus[v, default: 0] += 1 }
        for v in y { surplus[v, default: 0] -= 1 }
        if surplus.values.reduce(0, { $0 + abs($1) }) > maxEdits { return nil }

        let maxD = min(n + m, maxEdits)
        let offset = maxD + 1
        var v = [Int](repeating: 0, count: 2 * maxD + 3)
        // trace[d] = the frontier for diagonals -d...d as step d began.
        var trace: [[Int]] = []
        for d in 0...maxD {
            trace.append(Array(v[(offset - d)...(offset + d)]))
            var k = -d
            while k <= d {
                var i: Int
                if k == -d || (k != d && v[offset + k - 1] < v[offset + k + 1]) {
                    i = v[offset + k + 1]
                } else {
                    i = v[offset + k - 1] + 1
                }
                var j = i - k
                while i < n, j < m, x[i] == y[j] { i += 1; j += 1 }
                v[offset + k] = i
                if i >= n, j >= m {
                    return walkBack(trace, n: n, m: m, steps: d)
                }
                k += 2
            }
        }
        return nil
    }

    private static func walkBack(_ trace: [[Int]], n: Int, m: Int, steps: Int) -> (removed: Set<Int>, inserted: Set<Int>) {
        var removed = Set<Int>()
        var inserted = Set<Int>()
        var i = n
        var j = m
        var d = steps
        while d > 0 {
            let frontier = trace[d]
            func at(_ k: Int) -> Int { frontier[k + d] }
            let k = i - j
            let down = k == -d || (k != d && at(k - 1) < at(k + 1))
            let prevK = down ? k + 1 : k - 1
            let prevI = at(prevK)
            let prevJ = prevI - prevK
            if down { inserted.insert(prevJ) } else { removed.insert(prevI) }
            i = prevI
            j = prevJ
            d -= 1
        }
        return (removed, inserted)
    }

    static func diff(before: String, after: String) -> FileDiff {
        let a = lines(of: before)
        let b = lines(of: after)
        var head = 0
        while head < a.count, head < b.count, a[head] == b[head] { head += 1 }
        var tail = 0
        while tail < a.count - head, tail < b.count - head, a[a.count - 1 - tail] == b[b.count - 1 - tail] { tail += 1 }
        let midA = Array(a[head..<(a.count - tail)])
        let midB = Array(b[head..<(b.count - tail)])

        var removed = Set<Int>()
        var inserted = Set<Int>()
        var approximate = false
        if midA.isEmpty {
            inserted = Set(midB.indices)
        } else if midB.isEmpty {
            removed = Set(midA.indices)
        } else if midA.count + midB.count <= maxAlignedLines,
                  let edits = alignedEdits(midA, midB, maxEdits: maxAlignedEdits) {
            removed = edits.removed
            inserted = edits.inserted
        } else {
            removed = Set(midA.indices)
            inserted = Set(midB.indices)
            approximate = true
        }

        var out: [DiffLine] = []
        out.reserveCapacity(a.count + inserted.count)
        for k in 0..<head {
            out.append(DiffLine(kind: .context, oldNumber: k + 1, newNumber: k + 1, text: a[k]))
        }
        // Walk the middle: a run of removals, then the insertions at the same
        // place, then the shared line both sides keep.
        var i = 0
        var j = 0
        while i < midA.count || j < midB.count {
            if i < midA.count, removed.contains(i) {
                out.append(DiffLine(kind: .removed, oldNumber: head + i + 1, newNumber: nil, text: midA[i]))
                i += 1
            } else if j < midB.count, inserted.contains(j) {
                out.append(DiffLine(kind: .added, oldNumber: nil, newNumber: head + j + 1, text: midB[j]))
                j += 1
            } else if i < midA.count, j < midB.count {
                out.append(DiffLine(kind: .context, oldNumber: head + i + 1, newNumber: head + j + 1, text: midA[i]))
                i += 1
                j += 1
            } else if i < midA.count {
                out.append(DiffLine(kind: .removed, oldNumber: head + i + 1, newNumber: nil, text: midA[i]))
                i += 1
            } else {
                out.append(DiffLine(kind: .added, oldNumber: nil, newNumber: head + j + 1, text: midB[j]))
                j += 1
            }
        }
        for k in 0..<tail {
            let oldNo = a.count - tail + k + 1
            let newNo = b.count - tail + k + 1
            out.append(DiffLine(kind: .context, oldNumber: oldNo, newNumber: newNo, text: a[oldNo - 1]))
        }
        return FileDiff(lines: out, additions: inserted.count, deletions: removed.count, approximate: approximate)
    }
}

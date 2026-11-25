import Foundation

/// Lines of Walnut's own formats that a reply never shows. Port of the server's
/// `src/lib/internal-lines.ts` (`stripInternalLines`), case for case: both run the
/// cases in `tests/fixtures/internal-lines/cases.json` (`InternalLinesTests` here,
/// `tests/lib/internal-lines.test.ts` there), so the two never drift apart.
///
/// Walnut asks a session for its status report in a side question of its own
/// (FOR_USER_STATE, FOR_USER_NOW, FOR_USER_ASK, ...), and until 2026-11-19 put a
/// version tag in front of every line of a rule block ("[v16908844] "). Models copy
/// both into their replies (2026-11-20, the user: "why it show?"), and since
/// 2026-11-24 one line per open thread too ("th-...: answered · ..."), the status
/// question's thread lines, which a session never sees in its own chat. The server's
/// history parse leaves them out of every saved row; a reply still streaming has not
/// been through it, so the timeline drops them itself (`TimelineTurnMarker.stripLive`).
///
/// Only the report at the END of the text goes (field lines, the lines that carry a
/// value on, blank lines; Walnut's own `<walnut-` tag lines stay), and a version tag
/// at the start of a line is cut off. Outside code blocks only; a field line with
/// the session's words after it, a mention in a sentence and a text that opens with
/// the report (the answer to Walnut's own question) stay as written. Thread lines at
/// the end go too, with their heading and a tag of Walnut's around them, unless they
/// are the whole reply or follow one sentence outside such a tag: then the list is
/// the answer and stays. Sentences, not lines (2026-11-25: a real answer is often one
/// line of several).
enum InternalLines {
    // `\z`, not `$`: ICU's `$` also matches before a final line break.
    // swiftlint:disable force_try
    /// A line of the report: a FOR_USER_ field name (any, "FOR_USER_THREAD t1:" too),
    /// optionally bold, then a colon (a full-width one too), or the bare name alone.
    private static let field = try! NSRegularExpression(
        pattern: #"^\s{0,3}(?:\*\*)?FOR_USER_[A-Z][A-Z0-9_]*(?:\*\*)?(?:(?:\s+[^\s:\x{FF1A}]{1,40})?\s*(?:\*\*)?[:\x{FF1A}]|\s*\z)"#)
    private static let versionTag = try! NSRegularExpression(pattern: #"^(\s{0,3})\[v[0-9a-f]{8}\]\s+"#)
    private static let walnutTag = try! NSRegularExpression(pattern: #"^\s{0,3}</?walnut-"#)
    private static let continuation = try! NSRegularExpression(pattern: #"^(?:\s+\S|\s{0,3}(?:[-*+]|\d+[.)])\s)"#)
    /// While a reply streams in, a last line that is so far only the start of a field name.
    private static let fieldStart = try! NSRegularExpression(
        pattern: #"^\s{0,3}(?:\*\*)?F(?:O(?:R(?:_(?:U(?:S(?:E(?:R(?:_[A-Z0-9_]*)?)?)?)?)?)?)?)?\z"#)
    private static let fence = try! NSRegularExpression(pattern: #"^\s{0,3}(`{3,}|~{3,})(.*)\z"#)
    private static let indentedCode = try! NSRegularExpression(pattern: #"^(?: {4}|\t)"#)
    private static let brief = try! NSRegularExpression(pattern: #"FOR_USER_BRIEF\b"#)
    private static let streamingTail = try! NSRegularExpression(pattern: #"[Ft<]\S*\z"#)
    private static let trailingSpace = try! NSRegularExpression(pattern: #"\s+\z"#)

    /// A thread's id as Walnut writes it.
    private static let threadID = try! NSRegularExpression(pattern: #"th-[0-9a-f]{6,32}"#)
    /// Its state, in the words sessions wrote it (English, and Chinese).
    private static let threadState = try! NSRegularExpression(
        pattern: #"^(?:working|waiting|answered|done|needs|pending|new|closed|\x{5904}\x{7406}\x{4E2D}|\x{8FDB}\x{884C}\x{4E2D}|\x{7B49}\x{5F85}\x{4E2D}|\x{5DF2}\x{56DE}\x{7B54}|\x{7B49}\x{4F60}\x{51B3}\x{5B9A}|\x{7B49}\x{4F60}\x{5B9A}|\x{5DF2}\x{5B8C}\x{6210}|\x{5B8C}\x{6210}|\x{5DF2}\x{5173}\x{95ED})(?![a-z])"#,
        options: [.caseInsensitive])
    /// Before the id: a list mark, bold, "Thread ", or a short title opening a bracket ("title (th-...)").
    private static let threadPrefix = try! NSRegularExpression(
        pattern: #"^\s{0,3}(?:(?:[-*+]|\d+[.)])\s+)?(?:\*\*)?(?:thread\s+|\x{7EBF}\x{7A0B}\s*|[^\n]{0,80}?[(\x{FF08}])?[`"]?\z"#,
        options: [.caseInsensitive])
    /// Between the id and its state: closing marks, its title in brackets or quotes, separators.
    private static let threadAfterID = try! NSRegularExpression(
        pattern: #"^[`*"\x{300D}\x{FF09})\x{201D}]*\s*(?:(?:"[^"\n]{0,160}"|\x{201C}[^\x{201D}\n]{0,160}\x{201D}|\x{300C}[^\x{300D}\n]{0,160}\x{300D}|\x{FF08}[^\x{FF09}\n]{0,160}\x{FF09}|\([^)\n]{0,160}\))\s*)?[`*]*\s*[:\x{FF1A}|\x{00B7}\x{2014}\x{2013},\x{FF0C}-]*\s*[`*]*\s*"#)
    /// A line of a tag of Walnut's that names a thread (`<walnut-status thread="th-..." state="working">`).
    private static let threadTagLine = try! NSRegularExpression(
        pattern: #"^\s{0,3}<walnut-[a-z0-9-]+\b[^>]*th-[0-9a-f]{6,32}"#, options: [.caseInsensitive])
    /// A line that is only an opening or closing tag of Walnut's (a wrapper), never a self-closing one.
    private static let walnutWrapper = try! NSRegularExpression(
        pattern: #"^\s{0,3}</?walnut-[a-z0-9-]+\b[^>]*[^/>]?>\s*\z"#, options: [.caseInsensitive])
    private static let selfClosing = try! NSRegularExpression(pattern: #"/>\s*\z"#)
    private static let tagName = try! NSRegularExpression(pattern: #"<(walnut-[a-z0-9-]+)"#, options: [.caseInsensitive])
    /// While a reply streams in, a last line that is so far a tag of Walnut's still coming in (no ">" yet).
    private static let tagSoFar = try! NSRegularExpression(
        pattern: #"^\s{0,3}</?(?:w(?:a(?:l(?:n(?:u(?:t(?:-[^>\n]*)?)?)?)?)?)?)?\z"#, options: [.caseInsensitive])
    private static let closingTag = try! NSRegularExpression(pattern: #"^\s*</"#)
    /// The heading sessions put over those lines ("Thread status:", "Open threads:", "Threads:", and the
    /// Chinese ones: "each thread's status", "threads that changed this turn").
    private static let threadHeading = try! NSRegularExpression(
        pattern: #"^\s{0,3}(?:#{1,4}\s+)?(?:\*\*)?\s*(?:open\s+|\x{5404}\s*|\x{672C}\x{8F6E}[^\s:\x{FF1A}*]{0,6}?)?(?:threads?|\x{7EBF}\x{7A0B})\s*(?:\x{7684}\s*)?(?:\x{72B6}\x{6001}|status(?:es)?|updates?)?\s*(?:\*\*)?\s*[:\x{FF1A}]?\s*(?:\*\*)?\s*\z"#,
        options: [.caseInsensitive])
    private static let ruleLine = try! NSRegularExpression(pattern: #"^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*\z"#)
    /// While a reply streams in, a text that may end with that heading (its lines still to come).
    /// `[^A-Za-z0-9_]`, not `\W`: ICU's `\w` takes every script's letters, the server's only ASCII.
    private static let streamingHeadingEnd = try! NSRegularExpression(
        pattern: #"(?:threads?|status(?:es)?|updates?|\x{7EBF}\x{7A0B}|\x{72B6}\x{6001})[^A-Za-z0-9_]*\z"#, options: [.caseInsensitive])
    /// A list item naming a thread, an optional title in brackets, then a colon, whatever its state
    /// words say: a thread's line when it is one of a run of two or more such lines (2026-11-25).
    private static let threadItem = try! NSRegularExpression(
        pattern: #"^\s{0,3}(?:[-*+]|\d+[.)])\s+(?:\*\*)?`?th-[0-9a-f]{6,32}`?(?:\*\*)?\s*(?:(?:\x{FF08}[^\x{FF09}\n]{0,160}\x{FF09}|\([^)\n]{0,160}\)|\x{300C}[^\x{300D}\n]{0,160}\x{300D}|\x{3010}[^\x{3011}\n]{0,160}\x{3011}|\[[^\]\n]{0,160}\])\s*)?(?:\*\*)?\s*[:\x{FF1A}]"#)
    /// A line that carries the item above it on (indented, not an item of its own): it never ends a run.
    private static let underItem = try! NSRegularExpression(pattern: #"^\s+\S"#)
    private static let listItem = try! NSRegularExpression(pattern: #"^\s*(?:[-*+]|\d+[.)])\s"#)
    /// Where a sentence ends inside a line: U+3002, U+FF01, U+FF1F anywhere; ".", "!" or "?" only before a space or the
    /// line's end (never the dots of "1.0.267.0" or "x.test.ts:242", nor a "?" in a URL), closing marks
    /// after it included.
    private static let sentenceEnd = try! NSRegularExpression(
        pattern: #"(?:[\x{3002}\x{FF01}\x{FF1F}]+|[.!?]+(?=[)"'\x{201D}\x{300D}\x{FF09}*_`]*(?:\s|\z)))[)"'\x{201D}\x{300D}\x{FF09}*_`]*"#)
    /// While a reply streams in, the start of a thread's line: a list mark, bold, then its id as far as it has come.
    private static let threadIDSoFar = try! NSRegularExpression(
        pattern: #"^\s{0,3}(?:(?:[-*+]|\d+[.)])(?:\s+|\z))?\*{0,2}(?:t(?:h(?:-[0-9a-f]{0,31})?)?)?\z"#)
    /// While a reply streams in, an id as far as it has come at the line's end ("title (th-3").
    private static let idSoFarEnd = try! NSRegularExpression(pattern: #"t(?:h(?:-[0-9a-f]{0,31})?)?\z"#)
    private static let headingLead = try! NSRegularExpression(pattern: #"^\s{0,3}(?:#{1,4}\s*)?\**\s*"#)
    private static let headingTrail = try! NSRegularExpression(pattern: #"\s*[:\x{FF1A}]?\**\s*\z"#)
    private static let spaces = try! NSRegularExpression(pattern: #"\s+"#)
    private static let ruleSoFar = try! NSRegularExpression(pattern: #"^\s{0,3}-{2,}\s*\z"#)
    // swiftlint:enable force_try

    /// The headings sessions wrote over thread lines, lowercase, for a heading still coming in ("Thre").
    private static let headings = ["thread status", "thread statuses", "thread updates", "threads", "open threads",
                                   "\u{5404} thread \u{7684}\u{72B6}\u{6001}", "\u{5404} thread \u{72B6}\u{6001}",
                                   "\u{5404}\u{7EBF}\u{7A0B}\u{72B6}\u{6001}", "\u{7EBF}\u{7A0B}\u{72B6}\u{6001}",
                                   "\u{672C}\u{8F6E}\u{53D8}\u{4E86}\u{7684}\u{7EBF}\u{7A0B}"]
    /// The tags whose starts another hold takes while a reply streams in (`TimelineTurnMarker`,
    /// `MessageAboutTag`): a start of one of them is left to that hold.
    private static let heldElsewhere = [TimelineTurnMarker.tag, TimelineTurnMarker.legacyTag]
    private static let aboutStart = "<\(MessageAboutTag.name)"

    /// True when the line is a thread's line of the status question (outside code: the caller
    /// tracks fences): a thread's id, then its state word, with at most a title and separators
    /// between them, or a line of a Walnut tag that names a thread.
    static func isThreadStatusLine(_ line: String) -> Bool {
        let ns = line as NSString
        guard let m = threadID.firstMatch(in: line, range: NSRange(location: 0, length: ns.length)) else { return false }
        if test(threadTagLine, line) { return true }
        guard test(threadPrefix, ns.substring(to: m.range.location)) else { return false }
        let rest = ns.substring(from: NSMaxRange(m.range))
        let between = matchLength(threadAfterID, rest)
        return test(threadState, (rest as NSString).substring(from: between))
    }

    /// How many sentences the words before a thread block hold: two lines or more count as two; in
    /// one line, its sentence ends, and one more for words after the last end (a lead-in ending in a
    /// colon, "Here is where they stand:", is one sentence).
    static func sentenceCount(_ lines: [String]) -> Int {
        if lines.count != 1 { return lines.isEmpty ? 0 : 2 }
        let line = trimmed(lines[0])
        let ns = line as NSString
        let ends = sentenceEnd.matches(in: line, range: NSRange(location: 0, length: ns.length))
        let after = ends.last.map { NSMaxRange($0.range) } ?? 0
        return ends.count + (trimmed(ns.substring(from: after)).isEmpty ? 0 : 1)
    }

    /// The text without Walnut's internal lines. `streaming`: a last line that is only the start of a
    /// field name, a thread's line, its heading or a tag of Walnut's around them is held back, so it
    /// never flashes up.
    static func strip(_ text: String, streaming: Bool = false) -> String {
        guard text.contains("FOR_USER_") || text.contains("[v") || text.contains("th-")
            || (streaming && tailMayHold(text)) else { return text }
        // Foundation splits on "\n" alone, as the server's `split('\n')` cuts.
        let lines = text.components(separatedBy: "\n")
        let bare = { (l: String) -> String in l.hasSuffix("\r") ? String(l.dropLast()) : l }
        var code: [Bool] = []
        var open: String?
        var out: [String] = []
        for raw in lines {
            let line = bare(raw)
            if case let (mark, rest)? = fenceParts(line) {
                if open == nil { open = mark } else if let current = open, mark.first == current.first,
                    mark.utf16.count >= current.utf16.count, trimmed(rest).isEmpty { open = nil }
                code.append(true)
                out.append(raw)
                continue
            }
            let isCode = open != nil || test(indentedCode, line)
            code.append(isCode)
            out.append(isCode ? raw : replaceFirst(versionTag, in: raw, with: "$1"))
        }
        let isField = { (i: Int) -> Bool in !code[i] && test(field, bare(out[i])) }
        let first = out.firstIndex { !trimmed(bare($0)).isEmpty } ?? -1
        // A text that opens with the report: the answer to Walnut's own question, left whole.
        if first >= 0, isField(first) { return out.joined(separator: "\n") }
        let last = out.count - 1
        // The lines of a tag of Walnut's that names a thread, to its closing tag (one that spans lines).
        var inThreadTag = [Bool](repeating: false, count: out.count)
        var closing: String?
        for i in out.indices {
            let line = bare(out[i])
            if closing == nil, !code[i], test(threadTagLine, line) {
                let name = firstGroup(tagName, line) ?? ""
                if !line.contains("</\(name)>") && !test(selfClosing, line) { closing = "</\(name)>" }
                inThreadTag[i] = true
            } else if let close = closing {
                inThreadTag[i] = true
                if line.contains(close) { closing = nil }
            }
        }
        let strict = out.indices.map { !code[$0] && (inThreadTag[$0] || isThreadStatusLine(bare(out[$0]))) }
        // While it streams in, the last line as far as it has come (its id, not yet its state).
        var end = last
        while end > first && trimmed(bare(out[end])).isEmpty { end -= 1 }
        let soFar = streaming && end >= 0 && end >= first && !code[end] && threadLineSoFar(bare(out[end]))
        // An item that names a thread with free words for its state is a thread's line in a run of two or more.
        let item = out.indices.map { !code[$0] && test(threadItem, bare(out[$0])) }
        let inRun = { (j: Int) -> Bool in j >= 0 && (item[j] || strict[j] || (soFar && j == end)) }
        let next = { (i: Int, step: Int) -> Int in
            var j = i + step
            while j >= 0 && j <= last {
                let l = bare(out[j])
                if !trimmed(l).isEmpty && !(test(underItem, l) && !test(listItem, l)) { return j }
                j += step
            }
            return -1
        }
        let isThread = { (i: Int) -> Bool in strict[i] || (item[i] && (inRun(next(i, -1)) || inRun(next(i, 1)))) }
        /// The report's start: the earliest line from which, to the end, nothing but the report follows.
        /// `withThreads`: thread lines are part of it, with their heading, a rule above it and a wrapper tag.
        func reportStart(withThreads: Bool) -> (start: Int, threads: Bool) {
            var start = -1
            var threads = false
            var i = last
            while i >= first && i >= 0 {
                defer { i -= 1 }
                let line = bare(out[i])
                if trimmed(line).isEmpty { continue }
                if withThreads && isThread(i) { start = i; threads = true; continue }
                // A heading over thread lines below it, between two runs of them, is part of the block.
                if threads && !code[i] && test(threadHeading, line) { continue }
                if test(walnutTag, line) { continue }
                if isField(i) { start = i; continue }
                // While it streams in, a thread's line as far as it has come.
                if withThreads && soFar && i == end { continue }
                // While it streams in, the next field's name as far as it has come ("F", "FOR"): part of the report.
                // So is a tag line of Walnut's as far as it has come ("<walnut-ab", "</"): it stays out until whole.
                if streaming, i == last, !code[i], test(fieldStart, line) || test(tagSoFar, line) { continue }
                // A value carried on, indented four spaces deep too (that is not code inside the report).
                if (!code[i] || test(indentedCode, line)) && test(continuation, line) { continue }
                break
            }
            if !withThreads { return (start, threads) }
            // While it streams in: a last line that may still become a thread's line, a heading over
            // thread lines that have not come yet, or a tag of Walnut's that may wrap them, stays out
            // until they show what they are. So does the first item under a thread heading while its
            // title comes in before its id ("- title (").
            let tail = end >= 0 ? bare(out[end]) : ""
            let above = end >= 0 ? next(end, -1) : -1
            let underHeading = above >= 0 && above >= first && !code[above] && test(threadHeading, bare(out[above]))
                && test(listItem, tail) && !test(threadID, tail) && tail.utf16.count <= 90
            if streaming, start < 0, end >= 0, end >= first, !code[end],
               soFar || test(threadHeading, tail) || headingSoFar(tail) || tagComing(tail) || isWrapperOpen(tail) || underHeading {
                start = end
                threads = true
            }
            if !threads { return (start, threads) }
            var heading = false
            var k = start - 1
            while k >= first && k >= 0 {
                defer { k -= 1 }
                let line = bare(out[k])
                if trimmed(line).isEmpty { continue }
                if code[k] { break }
                if test(walnutWrapper, line) && !test(selfClosing, line) { start = k; continue }
                if !heading && test(threadHeading, line) { start = k; heading = true; continue }
                if test(ruleLine, line) { start = k }
                break
            }
            return (start, threads)
        }
        /// Thread lines are the answer itself, and stay, when nothing but them is in the reply, or one
        /// sentence leads in to them outside a tag of Walnut's ("Here is where they stand:", or "Done.":
        /// the accepted cost). After two sentences, or in a tag a session made up, they are a report.
        func isTheAnswer(_ start: Int) -> Bool {
            let words = out[..<start].map(bare).filter { !trimmed($0).isEmpty && !test(walnutTag, $0) }
            if words.isEmpty { return true }
            // While it streams in, a tag still coming in may be such a tag.
            let wrapped = (start..<out.count).contains { i in
                let l = bare(out[i])
                return !code[i] && (inThreadTag[i] || (test(walnutWrapper, l) && !test(selfClosing, l))
                    || (streaming && i == end && tagComing(l)))
            }
            return !wrapped && sentenceCount(words) <= 1
        }
        let scan = reportStart(withThreads: true)
        var start = scan.start
        var threads = scan.threads
        // They stay then, and only the report's field lines after them go.
        if threads && isTheAnswer(start) {
            let fieldsOnly = reportStart(withThreads: false)
            start = fieldsOnly.start
            threads = fieldsOnly.threads
        }
        // From the Brief's field on, everything is the Brief, whatever came after it.
        if let briefAt = out.indices.first(where: { $0 > first && isField($0) && test(brief, bare(out[$0])) }),
           briefAt > first, start < 0 || briefAt < start {
            start = briefAt
        }
        // Walnut's own self-closing tags after the report stay (the turn marker); a wrapper or a
        // thread's tag goes with the thread lines it holds. While it streams in, a tag still coming in
        // after them waits until it shows whether it is one.
        let keepTag = { (i: Int) -> Bool in
            let l = bare(out[i])
            return test(walnutTag, l) && (!threads || (!inThreadTag[i] && !(test(walnutWrapper, l) && !test(selfClosing, l))
                && !(streaming && i == end && tagComing(l))))
        }
        var kept = out
        if start >= 0 {
            let tags: [String] = (start..<out.count).filter(keepTag).map { out[$0] }
            kept = Array(out[..<start]) + tags
        }
        if streaming, kept.count > 1, let tail = kept.last, test(fieldStart, bare(tail)),
           trimmed(tail).utf16.count >= 4 {
            kept.removeLast()
        }
        let joined = kept.joined(separator: "\n")
        return joined == text ? text : replaceFirst(trailingSpace, in: joined, with: "")
    }

    /// While a reply streams in, whether its last line that is not blank may still be held back
    /// (cheap: the whole check runs only then).
    private static func tailMayHold(_ text: String) -> Bool {
        let said = replaceFirst(trailingSpace, in: text, with: "")
        let tail = said.components(separatedBy: "\n").last ?? ""
        return test(streamingTail, text) || test(streamingHeadingEnd, text) || threadLineSoFar(tail)
            || headingSoFar(tail) || (test(listItem, tail) && said.contains("\n"))
    }

    /// While a reply streams in, a last line that may still become a thread's line (its id is in, its state not yet).
    private static func threadLineSoFar(_ line: String) -> Bool {
        let ns = line as NSString
        let all = NSRange(location: 0, length: ns.length)
        if let m = threadID.firstMatch(in: line, range: all) ?? idSoFarEnd.firstMatch(in: line, range: all),
           test(threadPrefix, ns.substring(to: m.range.location)), ns.length - m.range.location < 200 {
            return true
        }
        return !trimmed(line).isEmpty && test(threadIDSoFar, line)
    }

    /// While a reply streams in, a last line that is so far the start of one of the headings, or of a rule above them.
    private static func headingSoFar(_ line: String) -> Bool {
        let lead = replaceFirst(headingLead, in: line, with: "")
        let core = replaceFirst(headingTrail, in: lead, with: "")
        let ns = core as NSString
        let t = spaces.stringByReplacingMatches(in: core, range: NSRange(location: 0, length: ns.length), withTemplate: " ").lowercased()
        return (!t.isEmpty && headings.contains { $0.hasPrefix(t) }) || test(ruleSoFar, line)
    }

    /// While a reply streams in, a last line that is a tag of Walnut's still coming in that no other hold takes.
    private static func tagComing(_ line: String) -> Bool {
        let t = trimmed(line)
        return test(tagSoFar, line) && !heldElsewhere.contains { $0.hasPrefix(t) }
            && !(t.utf16.count >= 2 && (aboutStart.hasPrefix(t) || t.hasPrefix(aboutStart)))
    }

    /// An opening wrapper tag of Walnut's, never its closing one or a self-closing tag.
    private static func isWrapperOpen(_ line: String) -> Bool {
        test(walnutWrapper, line) && !test(selfClosing, line) && !test(closingTag, line)
    }

    /// `^\s{0,3}(`{3,}|~{3,})(.*)$`: the fence's mark and what follows it.
    private static func fenceParts(_ line: String) -> (String, String)? {
        let ns = line as NSString
        guard let m = fence.firstMatch(in: line, range: NSRange(location: 0, length: ns.length)) else { return nil }
        return (ns.substring(with: m.range(at: 1)), ns.substring(with: m.range(at: 2)))
    }

    /// JS `trim()`: whitespace and line ends at both sides.
    private static func trimmed(_ s: String) -> String { s.trimmingCharacters(in: .whitespacesAndNewlines) }

    private static func test(_ re: NSRegularExpression, _ s: String) -> Bool {
        re.firstMatch(in: s, range: NSRange(location: 0, length: (s as NSString).length)) != nil
    }

    /// The length (UTF-16, as the server's string indexes) of the match at the start, 0 for none.
    private static func matchLength(_ re: NSRegularExpression, _ s: String) -> Int {
        re.firstMatch(in: s, range: NSRange(location: 0, length: (s as NSString).length))?.range.length ?? 0
    }

    /// The first capture group of the first match.
    private static func firstGroup(_ re: NSRegularExpression, _ s: String) -> String? {
        let ns = s as NSString
        guard let m = re.firstMatch(in: s, range: NSRange(location: 0, length: ns.length)),
              m.range(at: 1).location != NSNotFound else { return nil }
        return ns.substring(with: m.range(at: 1))
    }

    private static func replaceFirst(_ re: NSRegularExpression, in s: String, with template: String) -> String {
        let ns = s as NSString
        guard let m = re.firstMatch(in: s, range: NSRange(location: 0, length: ns.length)) else { return s }
        return ns.replacingCharacters(in: m.range, with: re.replacementString(for: m, in: s, offset: 0, template: template))
    }
}

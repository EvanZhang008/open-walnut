import Foundation

/// Lines of Walnut's own formats that a reply never shows. Port of the server's
/// `src/lib/internal-lines.ts` (`stripInternalLines`), case for case: both run the
/// cases in `tests/fixtures/internal-lines/cases.json` (`InternalLinesTests` here,
/// `tests/lib/internal-lines.test.ts` there), so the two never drift apart. The rules
/// and their incidents are written out there once.
///
/// The status report a side question asks (FOR_USER_STATE, ...), an old version tag in
/// front of a line ("[v16908844] ") and the status question's thread lines
/// ("th-...: answered · ...") at the END of a reply go; the server's history parse
/// leaves them out of every saved row, and a reply still streaming has not been through
/// it, so the timeline drops them itself (`TimelineTurnMarker.stripLive`). Precision
/// first: a thread block goes only when it is strictly the reply's end and nothing of
/// it is the answer, proof or an ask of his.
///
/// It reads text as the server's JavaScript does: lines split on "\n" alone, `\s` and
/// `trim()` take JavaScript's whitespace (`js`, `trimmed`), digits are `[0-9]`, word
/// ends are written out, and lengths count UTF-16 units.
enum InternalLines {
    // `\z`, not `$`: ICU's `$` also matches before a final line break.
    /// A line of the report: a FOR_USER_ field name (any, "FOR_USER_THREAD t1:" too),
    /// optionally bold, then a colon (a full-width one too), or the bare name alone.
    private static let field = js(#"^\s{0,3}(?:\*\*)?FOR_USER_[A-Z][A-Z0-9_]*(?:\*\*)?(?:(?:\s+[^\s:\x{FF1A}]{1,40})?\s*(?:\*\*)?[:\x{FF1A}]|\s*\z)"#)
    private static let versionTag = js(#"^(\s{0,3})\[v[0-9a-f]{8}\]\s+"#)
    private static let walnutTag = js(#"^\s{0,3}</?walnut-"#)
    private static let continuation = js(#"^(?:\s+\S|\s{0,3}(?:[-*+]|[0-9]+[.)])\s)"#)
    /// While a reply streams in, a last line that is so far only the start of a field name.
    private static let fieldStart = js(#"^\s{0,3}(?:\*\*)?F(?:O(?:R(?:_(?:U(?:S(?:E(?:R(?:_[A-Z0-9_]*)?)?)?)?)?)?)?)?\z"#)
    private static let briefField = js(#"FOR_USER_BRIEF(?![A-Za-z0-9_])"#)

    /// A thread's id as Walnut writes it.
    private static let threadID = js(#"th-[0-9a-f]{6,32}"#)
    /// Its state, in the words sessions wrote it (English, and Chinese).
    private static let threadState = js(
        #"^(?:working|waiting|answered|done|needs|pending|new|closed|\x{5904}\x{7406}\x{4E2D}|\x{8FDB}\x{884C}\x{4E2D}|\x{7B49}\x{5F85}\x{4E2D}|\x{5DF2}\x{56DE}\x{7B54}|\x{7B49}\x{4F60}\x{51B3}\x{5B9A}|\x{7B49}\x{4F60}\x{5B9A}|\x{5DF2}\x{5B8C}\x{6210}|\x{5B8C}\x{6210}|\x{5DF2}\x{5173}\x{95ED})(?![a-z])"#,
        [.caseInsensitive])
    /// A table row or a quote: never a thread's line, whatever it holds.
    private static let tableOrQuote = js(#"^\s{0,3}[|>]"#)
    /// Before the id, a thread's line holds at most a list mark, bold, "Thread " and an opening mark.
    private static let idFirst = js(#"^\s{0,3}(?:(?:[-*+]|[0-9]+[.)])\s+)?(?:\*\*)?(?:thread\s+|\x{7EBF}\x{7A0B}\s*)?[`"]?\z"#, [.caseInsensitive])
    /// Or a short title right before the id in brackets, with no sentence mark or comma in it.
    private static let titleFirst = js(#"^\s{0,3}(?:(?:[-*+]|[0-9]+[.)])\s+)?(?:\*\*)?(?:[^\n\x{3002}\x{FF01}\x{FF1F}\x{FF1B}\x{FF0C}!?;,.]|\.(?!\s)){1,60}[(\x{FF08}]\z"#)
    /// After a title-first id: its closing bracket, then a colon.
    private static let titleIDClose = js(#"^[)\x{FF09}][`*]*\s*[:\x{FF1A}]\s*[`*]*\s*"#)
    /// Between the id and its state: closing marks, its title in brackets or quotes, separators.
    private static let threadAfterID = js(
        #"^[`*"\x{300D}\x{FF09})\x{201D}]*\s*(?:(?:"[^"\n]{0,160}"|\x{201C}[^\x{201D}\n]{0,160}\x{201D}|\x{300C}[^\x{300D}\n]{0,160}\x{300D}|\x{FF08}[^\x{FF09}\n]{0,160}\x{FF09}|\([^)\n]{0,160}\))\s*)?[`*]*\s*[:\x{FF1A}|\x{00B7}\x{2014}\x{2013},\x{FF0C}-]*\s*[`*]*\s*"#)
    /// A line of a tag of Walnut's that names a thread (`<walnut-status thread="th-..." state="working">`).
    private static let threadTagLine = js(#"^\s{0,3}<walnut-[a-z0-9-]+(?![A-Za-z0-9_])[^>]*th-[0-9a-f]{6,32}"#, [.caseInsensitive])
    /// A line that is only an opening or closing tag of Walnut's (a wrapper), never a self-closing one.
    private static let walnutWrapper = js(#"^\s{0,3}</?walnut-[a-z0-9-]+(?![A-Za-z0-9_])[^>]*[^/>]?>\s*\z"#, [.caseInsensitive])
    private static let selfClosing = js(#"/>\s*\z"#)
    private static let tagName = js(#"<(walnut-[a-z0-9-]+)"#, [.caseInsensitive])
    /// While a reply streams in, a last line that is so far a tag of Walnut's still coming in (no ">" yet).
    private static let tagSoFar = js(#"^\s{0,3}</?(?:w(?:a(?:l(?:n(?:u(?:t(?:-[^>\n]*)?)?)?)?)?)?)?\z"#, [.caseInsensitive])
    private static let closingTag = js(#"^\s*</"#)
    /// The heading sessions put over those lines ("Thread status:", "Open threads:", "Threads:", and the
    /// Chinese ones: "each thread's status", "threads that changed this turn").
    private static let threadHeading = js(
        #"^\s{0,3}(?:#{1,4}\s+)?(?:\*\*)?\s*(?:open\s+|\x{5404}\s*|\x{672C}\x{8F6E}[^\s:\x{FF1A}*]{0,6}?)?(?:threads?|\x{7EBF}\x{7A0B})\s*(?:\x{7684}\s*)?(?:\x{72B6}\x{6001}|status(?:es)?|updates?)?\s*(?:\*\*)?\s*[:\x{FF1A}]?\s*(?:\*\*)?\s*\z"#,
        [.caseInsensitive])
    private static let ruleLine = js(#"^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*\z"#)
    /// While a reply streams in, a text that may end with that heading (its lines still to come).
    private static let streamingHeadingEnd = js(#"(?:threads?|status(?:es)?|updates?|\x{7EBF}\x{7A0B}|\x{72B6}\x{6001})[^A-Za-z0-9_]*\z"#, [.caseInsensitive])
    /// A list item naming a thread, an optional title in brackets, then a colon, whatever its state
    /// words say: a thread's line only in a block that is plainly one (a heading, a tag of Walnut's
    /// around it, or a line with a known state word in it).
    private static let threadItem = js(
        #"^\s{0,3}(?:[-*+]|[0-9]+[.)])\s+(?:\*\*)?`?th-[0-9a-f]{6,32}`?(?:\*\*)?\s*(?:(?:\x{FF08}[^\x{FF09}\n]{0,160}\x{FF09}|\([^)\n]{0,160}\)|\x{300C}[^\x{300D}\n]{0,160}\x{300D}|\x{3010}[^\x{3011}\n]{0,160}\x{3011}|\[[^\]\n]{0,160}\])\s*)?(?:\*\*)?\s*[:\x{FF1A}]"#)
    private static let listItem = js(#"^\s*(?:[-*+]|[0-9]+[.)])\s"#)
    private static let leadingSpace = js(#"^\s*"#)
    /// Where a sentence ends inside a line: U+3002, U+FF01, U+FF1F anywhere; ".", "!" or "?" only before a space or the
    /// line's end (never the dots of "1.0.267.0" or "x.test.ts:242", nor a "?" in a URL), closing marks
    /// after it included.
    private static let sentenceEnd = js(#"(?:[\x{3002}\x{FF01}\x{FF1F}]+|[.!?]+(?=[)"'\x{201D}\x{300D}\x{FF09}*_`]*(?:\s|\z)))[)"'\x{201D}\x{300D}\x{FF09}*_`]*"#)
    /// A lead-in: the sentence right before a list says it follows or names the threads.
    private static let endsWithColon = js(#"[:\x{FF1A}][*_]*\s*\z"#)
    private static let leadIn = js(
        #"\x{5982}\x{4E0B}|\x{4EE5}\x{4E0B}|\x{4E0B}\x{9762}|\x{4E0B}\x{5217}|as follows|(?<![A-Za-z])below(?![A-Za-z])|the following|\x{7EBF}\x{7A0B}|(?<![A-Za-z])threads?(?![A-Za-z])"#,
        [.caseInsensitive])
    /// Proof a block holds: a URL (to the first CJK character or full-width mark), an absolute path, a
    /// letter's id, a task ref tag, or the target of a relative link or image.
    private static let evidence = js(#"https?://[^\s<>"'`()\[\]\x{3000}-\x{303F}\x{4E00}-\x{9FFF}\x{FF00}-\x{FFEF}]+|(?<![A-Za-z0-9._~/-])~?/[A-Za-z0-9._@-]+(?:/[A-Za-z0-9._@-]+)+|(?<![A-Za-z0-9_-])lt-[0-9a-z]{6,}|<task-ref[^>]*>|(?<=\]\()(?![A-Za-z][A-Za-z0-9+.-]*:)[^)\s]+(?=\))"#)
    private static let evidenceTail = js(#"[.,;:!?\x{3002}\x{FF0C}\x{FF1B}\x{FF1A}\x{FF01}\x{FF1F}]+\z"#)
    /// A line that waits on him: its state is needs or new, or its words ask him (a decision, a review,
    /// a question, news to answer), once the words saying he is not needed are taken out.
    private static let askingState = js(#"^(?:needs|new)\z"#, [.caseInsensitive])
    private static let tagState = js(#"(?<![A-Za-z0-9_-])state=["']?([A-Za-z]+)"#)
    private static let asks = js(#"\x{7B49}\x{4F60}(?:\x{51B3}\x{5B9A}|\x{5B9A}|\x{5BA1}|\x{9009}|\x{70B9}\x{5934}|\x{56DE}|\x{6279}|\x{786E}\x{8BA4}|\x{770B})|\x{8981}\x{4F60}(?:\x{70B9}\x{5934}|\x{51B3}\x{5B9A}|\x{5B9A}|\x{786E}\x{8BA4}|\x{5BA1}|\x{9009}|\x{6279}\x{51C6}|\x{56DE})|\x{9700}\x{8981}\x{4F60}(?:\x{56DE}|\x{51B3}\x{5B9A}|\x{786E}\x{8BA4}|\x{5BA1}|\x{9009}|\x{6279}\x{51C6}|\x{70B9}\x{5934}|\x{770B}|\x{5904}\x{7406})|\x{8BF7}\x{56DE}\x{6211}|\x{8BF7}\x{4F60}(?:\x{5B9A}|\x{9009}|\x{786E}\x{8BA4}|\x{51B3}\x{5B9A}|\x{56DE})|\x{4F60}\x{6765}\x{5B9A}|\x{7531}\x{4F60}(?:\x{5B9A}|\x{51B3}\x{5B9A})|(?<![A-Za-z])(?:your call|up to you|wait(?:s|ing)? (?:on|for) your?|needs? (?:you|your (?:decision|review|approval|answer|ok|yes|input))|for your (?:review|approval|decision|answer|ok|yes))(?![A-Za-z])|[?\x{FF1F}]"#, [.caseInsensitive])
    private static let notAsking = js(#"\x{4E0D}\x{9700}\x{8981}\x{4F60}|\x{4E0D}\x{7528}\x{4F60}|\x{65E0}\x{9700}\x{4F60}|\x{4E0D}\x{7B49}\x{4F60}|no need for you|nothing (?:for|from) you|not waiting (?:on|for) you"#, [.caseInsensitive])
    /// While a reply streams in, the start of a thread's line: a list mark, bold, then its id as far as it has come.
    private static let threadIDSoFar = js(#"^\s{0,3}(?:(?:[-*+]|[0-9]+[.)])(?:\s+|\z))?\*{0,2}(?:t(?:h(?:-[0-9a-f]{0,31})?)?)?\z"#)
    /// While a reply streams in, an id as far as it has come at the line's end ("title (th-3").
    private static let idSoFarEnd = js(#"t(?:h(?:-[0-9a-f]{0,31})?)?\z"#)
    private static let headingLead = js(#"^\s{0,3}(?:#{1,4}\s*)?\**\s*"#)
    private static let headingTrail = js(#"\s*[:\x{FF1A}]?\**\s*\z"#)
    private static let spaces = js(#"\s+"#)
    private static let ruleSoFar = js(#"^\s{0,3}-{2,}\s*\z"#)
    private static let fence = js(#"^\s{0,3}(`{3,}|~{3,})([^\n\r\x{2028}\x{2029}]*)\z"#)
    private static let indentedCode = js(#"^(?: {4}|\t)"#)
    private static let trailingSpace = js(#"\s+\z"#)
    private static let streamingTail = js(#"[Ft<]\S*\z"#)

    /// The headings sessions wrote over thread lines, lowercase, for a heading still coming in ("Thre").
    private static let headings = ["thread status", "thread statuses", "thread updates", "threads", "open threads",
                                   "\u{5404} thread \u{7684}\u{72B6}\u{6001}", "\u{5404} thread \u{72B6}\u{6001}",
                                   "\u{5404}\u{7EBF}\u{7A0B}\u{72B6}\u{6001}", "\u{7EBF}\u{7A0B}\u{72B6}\u{6001}",
                                   "\u{672C}\u{8F6E}\u{53D8}\u{4E86}\u{7684}\u{7EBF}\u{7A0B}"]
    /// The tags whose starts another hold takes while a reply streams in (`TimelineTurnMarker`,
    /// `MessageAboutTag`): a start of one of them is left to that hold.
    private static let heldElsewhere = [TimelineTurnMarker.tag, TimelineTurnMarker.legacyTag]
    private static let aboutStart = "<\(MessageAboutTag.name)"

    /// JavaScript's `\s` (and `trim()`'s whitespace): ICU's `\s` adds U+0085 and lacks U+FEFF.
    private static let jsSpace = #"\t\n\x{000B}\f\r \x{00A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}"#
    private static let jsSpaceSet: CharacterSet = {
        var set = CharacterSet(charactersIn: "\t\n\u{0B}\u{0C}\r \u{A0}\u{1680}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}")
        set.insert(charactersIn: "\u{2000}"..."\u{200A}")
        return set
    }()

    /// A pattern as the server writes it, compiled with JavaScript's `\s` and `\S`.
    static func js(_ pattern: String, _ options: NSRegularExpression.Options = []) -> NSRegularExpression {
        var out = ""
        var inClass = false
        var escaped = false
        for ch in pattern {
            if escaped {
                escaped = false
                if ch == "s" { out += inClass ? jsSpace : "[\(jsSpace)]"; continue }
                if ch == "S" { precondition(!inClass, "\\S inside a class"); out += "[^\(jsSpace)]"; continue }
                out += "\\\(ch)"
                continue
            }
            if ch == "\\" { escaped = true; continue }
            if ch == "[" && !inClass { inClass = true } else if ch == "]" && inClass { inClass = false }
            out.append(ch)
        }
        // swiftlint:disable:next force_try
        return try! NSRegularExpression(pattern: out, options: options)
    }

    /// True when the line is a thread's line of the status question (outside code: the caller
    /// tracks fences): a thread's id, then its state word, with at most a title and separators
    /// between them, or a short title, the id in brackets, a colon and the state; or a line of a
    /// Walnut tag that names a thread. Never a table row, a quote, or prose that names a thread.
    static func isThreadStatusLine(_ line: String) -> Bool { threadStateOf(line) != nil }

    /// A thread's line's state word (a tag's state attribute, "" for a tag without one); nil for no thread line.
    private static func threadStateOf(_ line: String) -> String? {
        let ns = line as NSString
        guard let m = threadID.firstMatch(in: line, range: NSRange(location: 0, length: ns.length)),
              !test(tableOrQuote, line) else { return nil }
        if test(threadTagLine, line) { return firstGroup(tagState, line) ?? "" }
        let before = ns.substring(to: m.range.location)
        let rest = ns.substring(from: NSMaxRange(m.range))
        let after: String
        if test(idFirst, before) {
            after = (rest as NSString).substring(from: matchLength(threadAfterID, rest))
        } else {
            guard test(titleFirst, before), let close = titleIDClose.firstMatch(in: rest, range: NSRange(location: 0, length: (rest as NSString).length))
            else { return nil }
            after = (rest as NSString).substring(from: NSMaxRange(close.range))
        }
        guard let state = threadState.firstMatch(in: after, range: NSRange(location: 0, length: (after as NSString).length)) else { return nil }
        return (after as NSString).substring(with: state.range)
    }

    /// A line that waits on him (`asks`): its words, without the proof in them (a "?" of a URL).
    private static func asksHim(_ line: String) -> Bool {
        if let state = threadStateOf(line), test(askingState, state) { return true }
        var words = line
        for re in [evidence, notAsking] {
            words = re.stringByReplacingMatches(in: words, range: NSRange(location: 0, length: (words as NSString).length), withTemplate: " ")
        }
        return test(asks, words)
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
    /// never flashes up. A reply's thread card lines (`CardTagLines`) go before and after the
    /// report, as on the server: either may stand last.
    static func strip(_ text: String, streaming: Bool = false) -> String {
        CardTagLines.strip(stripReport(CardTagLines.strip(text, streaming: streaming), streaming: streaming), streaming: streaming)
    }

    private static func stripReport(_ text: String, streaming: Bool) -> String {
        guard has(text, "FOR_USER_") || has(text, "[v") || has(text, "th-")
            || (streaming && tailMayHold(text)) else { return text }
        var code: [Bool] = []
        var open: String?
        var out: [String] = []
        for raw in lines(text) {
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
        let blank = { (i: Int) -> Bool in trimmed(bare(out[i])).isEmpty }
        let first = out.indices.first { !blank($0) } ?? -1
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
                if !has(line, "</\(name)>") && !test(selfClosing, line) { closing = "</\(name)>" }
                inThreadTag[i] = true
            } else if let close = closing {
                inThreadTag[i] = true
                if has(line, close) { closing = nil }
            }
        }
        let strict = out.indices.map { !code[$0] && (inThreadTag[$0] || isThreadStatusLine(bare(out[$0]))) }
        let item = out.indices.map { !code[$0] && test(threadItem, bare(out[$0])) }
        // While it streams in, the last line as far as it has come (its id, not yet its state).
        var end = last
        while end > first && blank(end) { end -= 1 }
        let soFar = streaming && end >= 0 && end >= first && !code[end] && threadLineSoFar(bare(out[end]))
        let indent = { (i: Int) -> Int in matchLength(leadingSpace, bare(out[i])) }
        let above = { (i: Int) -> Int in
            var j = i - 1
            while j >= 0 && blank(j) { j -= 1 }
            return j
        }
        // A list item or an indented line carries a field's value on when nothing but such lines stand
        // between it and the field: a thread's line ends that (what follows one is not a field's value).
        let carriesField = { (i: Int) -> Bool in
            var j = above(i)
            while j >= 0 {
                let l = bare(out[j])
                if isField(j) { return true }
                if strict[j] || item[j] || (code[j] && !test(indentedCode, l)) || !test(continuation, l) { return false }
                j = above(j)
            }
            return false
        }
        // A line carries a thread's list item on only when it is indented deeper than the item.
        let carriesThread = { (i: Int, isBlock: (Int) -> Bool) -> Bool in
            let own = indent(i)
            if own == 0 { return false }
            var j = above(i)
            while j >= 0 {
                if indent(j) < own { return isBlock(j) && test(listItem, bare(out[j])) }
                j = above(j)
            }
            return false
        }
        let wrappedFrom = { (start: Int) -> Bool in
            (max(start, 0)..<out.count).contains { i in
                let l = bare(out[i])
                // While it streams in, a tag still coming in may be such a tag.
                return !code[i] && (inThreadTag[i] || isWrapper(l) || (streaming && i == end && tagComing(l)))
            }
        }
        /// The report's start: the earliest line from which, to the end, nothing but the report follows.
        /// `isBlock`: which lines count as thread lines (nil: the report's fields alone). With thread
        /// lines, their heading, a rule above them and a wrapper tag go too.
        func reportStart(_ isBlock: ((Int) -> Bool)?) -> (start: Int, threads: Bool, heading: Bool) {
            let withThreads = isBlock != nil
            let inBlock = isBlock ?? { _ in false }
            var start = -1
            var threads = false
            var heading = false
            var i = last
            while i >= first && i >= 0 {
                defer { i -= 1 }
                let line = bare(out[i])
                if trimmed(line).isEmpty { continue }
                if inBlock(i) { start = i; threads = true; continue }
                // A heading over thread lines below it is part of the block (the one at its top is added below).
                if threads && !code[i] && test(threadHeading, line) { heading = true; continue }
                if test(walnutTag, line) { continue }
                if isField(i) { start = i; continue }
                // While it streams in, a thread's line as far as it has come.
                if withThreads && soFar && i == end { continue }
                // While it streams in, the next field's name as far as it has come ("F", "FOR"): part of the report.
                // So is a tag line of Walnut's as far as it has come ("<walnut-ab", "</"): it stays out until whole.
                if streaming, i == last, !code[i], test(fieldStart, line) || test(tagSoFar, line) { continue }
                // A value carried on, indented four spaces deep too (that is not code inside the report).
                if (!code[i] || test(indentedCode, line)) && test(continuation, line)
                    && (carriesField(i) || (withThreads && carriesThread(i, inBlock))) { continue }
                // The session's own words: the report, if any, started after them.
                break
            }
            if !withThreads { return (start, threads, heading) }
            // While it streams in: a last line that may still become a thread's line, a heading over
            // thread lines that have not come yet, or a tag of Walnut's that may wrap them, stays out
            // until they show what they are. So does the first item under a thread heading while its
            // title comes in before its id ("- title (").
            let tail = end >= 0 && end >= first ? bare(out[end]) : ""
            let up = end >= 0 ? above(end) : -1
            let underHeading = up >= 0 && up >= first && !code[up] && test(threadHeading, bare(out[up]))
                && test(listItem, tail) && !test(threadID, tail) && tail.utf16.count <= 90
            if streaming, start < 0, end >= 0, end >= first, !code[end],
               soFar || test(threadHeading, tail) || headingSoFar(tail) || tagComing(tail) || isWrapperOpen(tail) || underHeading {
                start = end
                threads = true
            }
            if !threads { return (start, threads, heading) }
            var top = false
            var k = above(start)
            while k >= 0 && k >= first {
                let line = bare(out[k])
                if code[k] { break }
                if isWrapper(line) { start = k; k = above(k); continue }
                if !top && test(threadHeading, line) { start = k; top = true; heading = true; k = above(k); continue }
                if test(ruleLine, line) { start = k }
                break
            }
            return (start, threads, heading)
        }
        // Items whose state is said in free words count only in a block that is plainly one.
        var block = reportStart { strict[$0] || item[$0] }
        if block.threads && !block.heading && !wrappedFrom(block.start)
            && !(block.start..<out.count).contains(where: { strict[$0] }) {
            block = reportStart { strict[$0] }
        }
        var start = block.start
        var threads = block.threads
        if threads {
            let words = out[..<start].map(bare).filter { !trimmed($0).isEmpty && !test(walnutTag, $0) }
            let lead = words.last ?? ""
            let keptTags = (start..<out.count).map { bare(out[$0]) }.enumerated()
                .filter { test(walnutTag, $0.element) && !inThreadTag[start + $0.offset] && !isWrapper($0.element) }.map { $0.element }
            let shown = (Array(out[..<start]) + keptTags).joined(separator: "\n")
            // The list is the answer itself: the whole reply, after one sentence outside a made-up tag, or after a lead-in.
            let isTheAnswer = words.isEmpty || (!wrappedFrom(start)
                && (test(endsWithColon, lead) || test(leadIn, lead) || sentenceCount(words) <= 1))
            // The tail of a longer list: the list stays whole.
            let up = above(start)
            let tailOfList = up >= 0 && !code[up] && test(listItem, bare(out[start])) && test(continuation, bare(out[up]))
            // Proof in it the reply keeps nowhere else, or a line that waits on him.
            let blockLines = (start..<out.count).map { bare(out[$0]) }
            let keeps = evidenceIn(blockLines).contains { !has(shown, $0) } || blockLines.contains(where: asksHim)
            // They stay then, and only the report's field lines after them go.
            if isTheAnswer || tailOfList || keeps {
                let fieldsOnly = reportStart(nil)
                start = fieldsOnly.start
                threads = fieldsOnly.threads
            }
        }
        // From the Brief's field on, everything is the Brief, whatever came after it.
        if let briefAt = out.indices.first(where: { $0 > first && isField($0) && test(briefField, bare(out[$0])) }),
           briefAt > first, start < 0 || briefAt < start {
            start = briefAt
        }
        // Walnut's own self-closing tags after the report stay (the turn marker); a wrapper or a
        // thread's tag goes with the thread lines it holds. While it streams in, a tag still coming in
        // after them waits until it shows whether it is one.
        let keepTag = { (i: Int) -> Bool in
            let l = bare(out[i])
            return test(walnutTag, l) && (!threads || (!inThreadTag[i] && !isWrapper(l) && !(streaming && i == end && tagComing(l))))
        }
        var kept = out
        if start >= 0 { kept = Array(out[..<start]) + (start..<out.count).filter(keepTag).map { out[$0] } }
        if streaming, kept.count > 1, let tail = kept.last, test(fieldStart, bare(tail)), trimmed(tail).utf16.count >= 4 {
            kept.removeLast()
        }
        let joined = kept.joined(separator: "\n")
        return joined == text ? text : replaceFirst(trailingSpace, in: joined, with: "")
    }

    /// While a reply streams in, whether its last line that is not blank may still be held back
    /// (cheap: the whole check runs only then).
    private static func tailMayHold(_ text: String) -> Bool {
        let said = replaceFirst(trailingSpace, in: text, with: "")
        let tail = lines(said).last ?? ""
        return test(streamingTail, text) || test(streamingHeadingEnd, text) || threadLineSoFar(tail)
            || headingSoFar(tail) || (test(listItem, tail) && has(said, "\n"))
    }

    /// While a reply streams in, a last line that may still become a thread's line (its id is in, its state not yet).
    private static func threadLineSoFar(_ line: String) -> Bool {
        if test(tableOrQuote, line) { return false }
        let ns = line as NSString
        let all = NSRange(location: 0, length: ns.length)
        if let m = threadID.firstMatch(in: line, range: all) ?? idSoFarEnd.firstMatch(in: line, range: all),
           ns.length - m.range.location < 200 {
            let before = ns.substring(to: m.range.location)
            if test(idFirst, before) || test(titleFirst, before) { return true }
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

    /// A wrapper tag line of Walnut's (opening or closing, never self-closing).
    private static func isWrapper(_ line: String) -> Bool { test(walnutWrapper, line) && !test(selfClosing, line) }

    /// An opening wrapper tag of Walnut's, never its closing one or a self-closing tag.
    private static func isWrapperOpen(_ line: String) -> Bool { isWrapper(line) && !test(closingTag, line) }

    /// The URLs and paths in some lines, without the sentence mark a line may end them with.
    private static func evidenceIn(_ lines: [String]) -> [String] {
        lines.flatMap { line -> [String] in
            let ns = line as NSString
            return evidence.matches(in: line, range: NSRange(location: 0, length: ns.length))
                .map { replaceFirst(evidenceTail, in: ns.substring(with: $0.range), with: "") }
        }
    }

    /// The fence's mark and what follows it.
    private static func fenceParts(_ line: String) -> (String, String)? {
        let ns = line as NSString
        guard let m = fence.firstMatch(in: line, range: NSRange(location: 0, length: ns.length)) else { return nil }
        return (ns.substring(with: m.range(at: 1)), ns.substring(with: m.range(at: 2)))
    }

    /// `split('\n')`: on U+000A alone, never on the "\r\n" grapheme Swift sees as one character.
    static func lines(_ s: String) -> [String] {
        let ns = s as NSString
        var parts: [String] = []
        var from = 0
        for i in 0..<ns.length where ns.character(at: i) == 10 {
            parts.append(ns.substring(with: NSRange(location: from, length: i - from)))
            from = i + 1
        }
        parts.append(ns.substring(from: from))
        return parts
    }

    /// The line without one "\r" at its end.
    static func bare(_ l: String) -> String {
        let ns = l as NSString
        return ns.length > 0 && ns.character(at: ns.length - 1) == 13 ? ns.substring(to: ns.length - 1) : l
    }

    /// `includes`: UTF-16 units, as the server compares.
    static func has(_ s: String, _ part: String) -> Bool {
        (s as NSString).range(of: part, options: .literal).location != NSNotFound
    }

    /// JS `trim()`: JavaScript's whitespace and line ends at both sides.
    static func trimmed(_ s: String) -> String { s.trimmingCharacters(in: jsSpaceSet) }

    static func test(_ re: NSRegularExpression, _ s: String) -> Bool {
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

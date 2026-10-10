import Foundation
import NaturalLanguage

/// What voice mode reads aloud from a reply, and in which language.
///
/// A session's reply is written to be READ: markdown, code, tables, file paths,
/// sometimes raw HTML. Read aloud as-is, that is a minute of "asterisk asterisk"
/// and "slash Users slash". The server asks a voice send for a short spoken answer
/// first, with any detail below a line holding only `---` (voice-reply.ts on the
/// server), so the first rule here is to read only what comes before that line.
/// Everything after it stays on screen.
///
/// A reply that ignores the shape still has to sound right: a turn the session
/// started on its own (a worker reporting back) never carried the voice line. So
/// the rest of this file turns any reply into plain sentences and stops at about
/// `budgetSeconds` of speech, saying the rest is on screen.
///
/// Pure and synchronous: the speaker and the tests share it.
enum SpokenText {
    struct Prepared: Equatable {
        /// The sentences to speak.
        let text: String
        /// BCP-47 tag for the voice ("zh-CN", "en-US", ...).
        let language: String
        /// Something was left out (the part after `---`, or the budget ran out).
        let truncated: Bool
    }

    /// About how long one answer may take to say. Long enough for the two to four
    /// sentences the server asks for; a full report is for the screen.
    static let budgetSeconds: Double = 40

    /// nil when nothing speakable is left (a reply that was only code or a table).
    static func prepare(_ raw: String) -> Prepared? {
        let (head, cutAtRule) = spokenPart(raw)
        let plainText = plain(head)
        guard !plainText.isEmpty else { return nil }
        let language = language(of: plainText)
        let (capped, cutByBudget) = cap(plainText, budget: budgetSeconds)
        let truncated = cutAtRule || cutByBudget
        let text = truncated ? capped + " " + restOnScreen : capped
        return Prepared(text: text, language: language, truncated: truncated)
    }

    // MARK: - The spoken part

    /// The text before the first line that holds only `---`, when there is any.
    static func spokenPart(_ raw: String) -> (String, Bool) {
        let lines = raw.components(separatedBy: "\n")
        guard let rule = lines.firstIndex(where: { $0.trimmingCharacters(in: .whitespaces) == "---" }) else {
            return (raw, false)
        }
        let head = lines[..<rule].joined(separator: "\n")
        // A reply that OPENS with a rule (front matter, a divider) has no head to
        // read: fall back to the whole text rather than to silence.
        guard !head.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return (raw, false) }
        let tail = lines[(rule + 1)...].joined(separator: "\n")
        return (head, !tail.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
    }

    // MARK: - Markdown and HTML to sentences

    /// Plain sentences, one per source line, each ending in punctuation so the
    /// voice pauses between list items instead of running them together.
    static func plain(_ text: String) -> String {
        var s = text
        // Blocks that have no spoken form at all.
        s = replace(s, #"```[\s\S]*?(```|$)"#, "\n")
        s = replace(s, #"~~~[\s\S]*?(~~~|$)"#, "\n")
        s = replace(s, #"(?is)<(svg|style|script)\b.*?(</\1>|$)"#, " ")
        s = replace(s, #"<[^>\n]{1,400}>"#, " ")
        s = s.replacingOccurrences(of: "&nbsp;", with: " ")
            .replacingOccurrences(of: "&amp;", with: "&")
            .replacingOccurrences(of: "&lt;", with: "<")
            .replacingOccurrences(of: "&gt;", with: ">")
            .replacingOccurrences(of: "&quot;", with: "\"")
        // Links keep their words; images and bare URLs go.
        s = replace(s, #"!\[[^\]]*\]\([^)]*\)"#, "")
        s = replace(s, #"\[([^\]]+)\]\([^)]*\)"#, "$1")
        s = replace(s, #"https?://\S+"#, "")
        // Inline code keeps its text; the backticks are not words.
        s = replace(s, #"`([^`\n]+)`"#, "$1")
        s = s.replacingOccurrences(of: "`", with: "")

        var out: [String] = []
        for rawLine in s.components(separatedBy: "\n") {
            var line = rawLine.trimmingCharacters(in: .whitespaces)
            if line.isEmpty { continue }
            // Table rows and their separators have no spoken form.
            if line.hasPrefix("|") { continue }
            if line.range(of: #"^[-=*_\s]{3,}$"#, options: .regularExpression) != nil { continue }
            line = replace(line, #"^#{1,6}\s+"#, "")
            line = replace(line, #"^>\s?"#, "")
            line = replace(line, #"^([-*+]|\d+[.)])\s+"#, "")
            line = replace(line, #"^\[[ xX]\]\s+"#, "")
            line = line.replacingOccurrences(of: "**", with: "")
                .replacingOccurrences(of: "__", with: "")
                .replacingOccurrences(of: "~~", with: "")
            line = replace(line, #"(?<![\w*])\*(\S[^*\n]*?)\*(?![\w*])"#, "$1")
            line = replace(line, #"(?<![\w_])_(\S[^_\n]*?)_(?![\w_])"#, "$1")
            line = shortenPaths(line)
            line = replace(line, #"\s{2,}"#, " ").trimmingCharacters(in: .whitespaces)
            if line.isEmpty { continue }
            out.append(endSentence(line))
        }
        return out.joined(separator: " ")
    }

    /// `/Users/me/repo/src/Foo.swift` and `src/Foo.swift` are read as `Foo.swift`.
    /// Only path-shaped tokens: one that starts at a root (`/`, `~`, `./`) or whose
    /// last part has an extension. "and/or" stays as it is.
    static func shortenPaths(_ line: String) -> String {
        let pattern = #"(?<![\w/])((?:~|\.{1,2})?/?(?:[\w.@+-]+/)+[\w.@+-]+)"#
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return line }
        let ns = line as NSString
        var result = line
        for match in regex.matches(in: line, range: NSRange(location: 0, length: ns.length)).reversed() {
            let token = ns.substring(with: match.range)
            let rooted = token.hasPrefix("/") || token.hasPrefix("~") || token.hasPrefix("./") || token.hasPrefix("../")
            guard let last = token.split(separator: "/").last.map(String.init) else { continue }
            guard rooted || last.contains(".") else { continue }
            let r = Range(match.range, in: result)!
            result.replaceSubrange(r, with: last)
        }
        return result
    }

    /// Full-width (CJK) punctuation, escaped: the ideographic full stop, then the
    /// full-width exclamation, question, semicolon, colon and comma.
    private static let fullStop = "\u{3002}"
    private static let cjkSentenceEnds: Set<Character> = ["\u{3002}", "\u{FF01}", "\u{FF1F}", "\u{FF1B}"]
    private static let sentenceEnds: Set<Character> = cjkSentenceEnds
        .union([".", "!", "?", ";", "\u{FF1A}", ":", "\u{FF0C}", ","])

    private static func endSentence(_ line: String) -> String {
        guard let last = line.last, !sentenceEnds.contains(last) else { return line }
        return line + (containsCJK(line) ? fullStop : ".")
    }

    // MARK: - Language

    /// The voice's language. Chinese wins whenever the reply is substantially
    /// Chinese, even with English words mixed in (a Chinese voice reads "PR" and
    /// "Swift" fine; an English voice cannot read Chinese at all).
    static func language(of text: String) -> String {
        var cjk = 0, kana = 0, letters = 0
        for scalar in text.unicodeScalars {
            switch scalar.value {
            case 0x3040...0x30FF: kana += 1
            case 0x4E00...0x9FFF, 0x3400...0x4DBF: cjk += 1
            default:
                if CharacterSet.letters.contains(scalar) { letters += 1 }
            }
        }
        if kana > 0, kana * 5 >= cjk { return "ja-JP" }
        let total = cjk + letters
        if cjk >= 2, total > 0, Double(cjk) / Double(total) >= 0.15 { return "zh-CN" }
        let recognizer = NLLanguageRecognizer()
        recognizer.processString(text)
        switch recognizer.dominantLanguage {
        case .some(.english), .none: return "en-US"
        case .some(let lang): return lang.rawValue
        }
    }

    /// Said after a cut. English in every language, like the rest of the app's
    /// words; a Chinese voice reads it fine.
    private static let restOnScreen = "The rest is on screen."

    // MARK: - Length

    /// Seconds a voice takes, roughly: about 4 Chinese characters or 2.5 English
    /// words a second at the default rate.
    static func estimatedSeconds(_ text: String) -> Double {
        var cjk = 0
        var latinWords = 0
        var inWord = false
        for scalar in text.unicodeScalars {
            if (0x4E00...0x9FFF).contains(scalar.value) || (0x3040...0x30FF).contains(scalar.value) {
                cjk += 1
                inWord = false
            } else if CharacterSet.alphanumerics.contains(scalar) {
                if !inWord { latinWords += 1 }
                inWord = true
            } else {
                inWord = false
            }
        }
        return Double(cjk) * 0.25 + Double(latinWords) * 0.4
    }

    /// Whole sentences while they fit; a first sentence that alone is too long is
    /// cut at a word or character boundary.
    static func cap(_ text: String, budget: Double) -> (String, Bool) {
        guard estimatedSeconds(text) > budget else { return (text, false) }
        var kept = ""
        for sentence in sentences(text) {
            let candidate = kept + sentence
            if estimatedSeconds(candidate) > budget { break }
            kept = candidate
        }
        if kept.trimmingCharacters(in: .whitespaces).isEmpty {
            var cut = ""
            for ch in text {
                if estimatedSeconds(cut + String(ch)) > budget { break }
                cut.append(ch)
            }
            kept = cut
        }
        return (kept.trimmingCharacters(in: .whitespaces), true)
    }

    /// Split after each sentence end, keeping the terminator with its sentence.
    static func sentences(_ text: String) -> [String] {
        var out: [String] = []
        var current = ""
        let ends = cjkSentenceEnds.union([".", "!", "?", ";"])
        for ch in text {
            current.append(ch)
            if ends.contains(ch) {
                out.append(current)
                current = ""
            }
        }
        if !current.isEmpty { out.append(current) }
        return out
    }

    // MARK: - Helpers

    private static func containsCJK(_ s: String) -> Bool {
        s.unicodeScalars.contains { (0x4E00...0x9FFF).contains($0.value) }
    }

    private static func replace(_ s: String, _ pattern: String, _ template: String) -> String {
        s.replacingOccurrences(of: pattern, with: template, options: .regularExpression)
    }
}

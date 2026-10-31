import SwiftUI

/// Every task a chat message mentions reads as the task's CURRENT title and opens the task.
///
/// The phone twin of the web console's `web/src/utils/task-id-shape.ts` and
/// `bare-task-ids.ts`: the same three kinds of mention and the same token rules, so a
/// message reads the same in both places.
///
///  1. `<task-ref id="X" label="Y"/>`: the server's pill markup.
///  2. `[X|Y]` with X a short id: the legacy bracket form.
///  3. A bare id written in prose (`mvu0ubnq-a02d`, a UUID, or an id's first segment
///     such as `mvkghc5v`), standing alone: not glued to a word, a longer dashed token,
///     a path segment, a file name or an address.
///
/// Only an id the task store knows becomes a link (`TaskMentionResolver`); anything else
/// stays the text it was (a git hash, a session's UUID, a deleted task). A known id
/// becomes a `walnut-task://` link (`TaskMentionLink`) that the timeline and the SwiftUI
/// markdown surfaces route to the in-app task sheet, never to the system opener.
///
/// Code: a bare id that is a whole inline code span is the same citation in backticks
/// and becomes the title link too; an id inside longer code or a fenced block keeps its
/// own text and is not linked (a timeline row's reload key is its plain text, so a link
/// that changes no character could never reach an on-screen cell).
enum TaskMentions {
    /// A standalone token, tried in this order: a UUID, a short id, then a run that may be
    /// an id's first segment. The neighbour classes are spelled out in ASCII on purpose:
    /// ICU's `\w` is Unicode-aware and would treat CJK prose around an id as a word,
    /// where the web's JavaScript `\w` (ASCII) does not.
    static let tokenPattern =
        #"(?<![A-Za-z0-9_\-./@#])"#
        + #"(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[a-z0-9]{7,10}-[a-f0-9]{4}|[a-z0-9]{7,})"#
        + #"(?![A-Za-z0-9_\-/@]|\.[A-Za-z0-9_])"#

    private static let tokenRegex = try? NSRegularExpression(pattern: tokenPattern)
    private static let fullIDRegex = try? NSRegularExpression(
        pattern: #"^(?:[a-z0-9]{7,10}-[a-f0-9]{4}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$"#
    )
    private static let prefixRegex = try? NSRegularExpression(pattern: #"^[a-z0-9]+(?:-[a-z0-9]+)*$"#)

    /// The shortest run that may stand for an id.
    static let minPrefixLength = 7

    /// A whole task id in either shape.
    static func isFullTaskID(_ token: String) -> Bool {
        matches(fullIDRegex, token)
    }

    /// May this token be the leading segment(s) of a task id? Seven characters or more
    /// and at least one letter (a number never is one). No digit is required: a base36
    /// time segment is all letters about 1 in 14 times (`mpwidref` of `mpwidref-7c2e`).
    /// An English word still almost never names a task, because the resolver links it
    /// only when exactly one known id starts with `token + "-"`.
    static func isPrefixToken(_ token: String) -> Bool {
        token.count >= minPrefixLength && matches(prefixRegex, token)
            && token.contains(where: { $0.isASCII && $0.isLetter })
    }

    static func isCandidate(_ token: String) -> Bool {
        isFullTaskID(token) || isPrefixToken(token)
    }

    private static func matches(_ regex: NSRegularExpression?, _ text: String) -> Bool {
        guard let regex else { return false }
        let range = NSRange(location: 0, length: (text as NSString).length)
        return regex.firstMatch(in: text, range: range) != nil
    }

    /// What a mention shows for a task: Main reads as the CEO and a project's lead
    /// ("Walnut lead") as its VP, display only. The web's `shownTaskTitle`
    /// (web/src/stores/entity-label-store.ts) and the server's `orgDisplayTitle`.
    static func shownTitle(_ title: String, orgRole: String?) -> String {
        switch orgRole {
        case "main":
            return ChatOrgModel.ceoName
        case "lead":
            return title.replacingOccurrences(of: #" lead$"#, with: " VP",
                                              options: [.regularExpression, .caseInsensitive])
        default:
            return title
        }
    }

    // MARK: - Source rewrite (before the markdown parse)

    private static let refRegex = try? NSRegularExpression(
        pattern: #"<(task|session)-ref\s+([^>]*?)/?>"#
    )
    private static let refAttrRegex = try? NSRegularExpression(
        pattern: #"(id|label)="([^"]*)""#
    )
    /// `[mvu0ubnq-a02d|Some label]`, never the inside of a `[[wikilink|alias]]` and never
    /// a markdown link's text (`[x|y](url)`).
    private static let legacyRefRegex = try? NSRegularExpression(
        pattern: #"(?<!\[)\[([a-z0-9]{7,10}-[a-f0-9]{4})\|([^\]\n]+)\](?![\]\(])"#
    )

    /// Rewrite every `<task-ref/>` and legacy `[id|label]` into what the reader sees: a
    /// markdown link to the task, titled with its current title, when the id resolves;
    /// else the label (the id when there is none) as plain text, and nothing when both
    /// are empty. `<session-ref/>` keeps its bold label.
    ///
    /// Unlike `MarkdownParser.replaceEntityRefs`, which stays the plain-label
    /// NORMALIZATION the chat stores compare rows by, this is display only.
    ///
    /// A title written beside a mention of the same task is dropped first
    /// (`TaskTitleAbsorb`), so the link names the task once.
    static func rewriteRefs(_ text: String, resolver: TaskMentionResolver = .shared) -> String {
        var out = TaskTitleAbsorb.absorbWrittenTitles(text, resolver: resolver)
        if out.contains("-ref"), let regex = refRegex {
            let ns = out as NSString
            let matches = regex.matches(in: out, range: NSRange(location: 0, length: ns.length))
            for match in matches.reversed() {
                let kind = ns.substring(with: match.range(at: 1))
                let (id, label) = refAttributes(ns.substring(with: match.range(at: 2)))
                guard let range = Range(match.range, in: out) else { continue }
                if kind == "session" {
                    // A ref with neither id nor label has no honest rendering: leave it.
                    let display = label.isEmpty ? id : label
                    guard !display.isEmpty else { continue }
                    out.replaceSubrange(range, with: "**\(display)**")
                } else {
                    out.replaceSubrange(range, with: mentionSource(id: id, label: label, resolver: resolver))
                }
            }
        }
        if out.contains("|"), let regex = legacyRefRegex {
            let ns = out as NSString
            let matches = regex.matches(in: out, range: NSRange(location: 0, length: ns.length))
            for match in matches.reversed() {
                let id = ns.substring(with: match.range(at: 1))
                let label = ns.substring(with: match.range(at: 2))
                guard let range = Range(match.range, in: out) else { continue }
                out.replaceSubrange(range, with: mentionSource(id: id, label: label, resolver: resolver))
            }
        }
        return out
    }

    private static func refAttributes(_ attrs: String) -> (id: String, label: String) {
        var id = "", label = ""
        guard let regex = refAttrRegex else { return (id, label) }
        let ns = attrs as NSString
        for match in regex.matches(in: attrs, range: NSRange(location: 0, length: ns.length)) {
            let key = ns.substring(with: match.range(at: 1))
            // The emitter escapes `"` as `&quot;` inside the attribute.
            let value = ns.substring(with: match.range(at: 2)).replacingOccurrences(of: "&quot;", with: "\"")
            if key == "id" { id = value } else { label = value }
        }
        return (id, label)
    }

    /// The markdown one mention becomes. An empty or unknown id is never a link.
    private static func mentionSource(id: String, label: String, resolver: TaskMentionResolver) -> String {
        let trimmedID = id.trimmingCharacters(in: .whitespaces)
        // The same resolution as a bare id: an exact id, else a unique first segment.
        if !trimmedID.isEmpty, let hit = resolver.resolve(trimmedID),
           let url = TaskMentionLink.url(for: hit.id) {
            let shown = hit.title.isEmpty ? hit.id : hit.title
            return "[\(escapeMarkdown(shown))](\(url.absoluteString))"
        }
        return label.isEmpty ? trimmedID : label
    }

    /// Backslash-escape every ASCII punctuation character, so a title reads as written
    /// inside a link's text (CommonMark allows an escape before any of them).
    static func escapeMarkdown(_ text: String) -> String {
        var out = ""
        out.reserveCapacity(text.count)
        for ch in text {
            if ch == "\n" || ch == "\r" { out.append(" "); continue }
            if ch.isASCII, ch.isPunctuation || ch.isSymbol { out.append("\\") }
            out.append(ch)
        }
        return out
    }

    // MARK: - After the markdown parse

    /// Style the task links the source rewrite produced (accent, semibold) and turn every
    /// bare id the store knows into a link titled with the task's current title.
    static func apply(_ attributed: inout AttributedString, resolver: TaskMentionResolver = .shared) {
        styleTaskLinks(&attributed)
        linkifyBareIDs(&attributed, resolver: resolver)
    }

    private static func styleTaskLinks(_ attributed: inout AttributedString) {
        let start = attributed.characters.startIndex
        var spans: [(offset: Int, length: Int, intent: InlinePresentationIntent?)] = []
        for run in attributed.runs {
            guard let link = run.link, TaskMentionLink.isTaskLink(link) else { continue }
            let offset = attributed.characters.distance(from: start, to: run.range.lowerBound)
            let length = attributed.characters.distance(from: run.range.lowerBound, to: run.range.upperBound)
            spans.append((offset, length, run.inlinePresentationIntent))
        }
        // By offset, recomputed per edit: an index taken before a mutation is not
        // promised to survive it.
        for span in spans {
            let chars = attributed.characters
            let lower = chars.index(chars.startIndex, offsetBy: span.offset)
            let upper = chars.index(lower, offsetBy: span.length)
            var intent = span.intent ?? []
            intent.insert(.stronglyEmphasized)
            attributed[lower..<upper].inlinePresentationIntent = intent
            attributed[lower..<upper].foregroundColor = .accentColor
        }
    }

    private static func linkifyBareIDs(_ attributed: inout AttributedString, resolver: TaskMentionResolver) {
        // An empty table resolves nothing; its first fill always re-renders (see
        // `TaskMentionResolver.update`), so skipping the scan loses nothing.
        guard let regex = tokenRegex, !resolver.isEmpty else { return }
        let plain = String(attributed.characters)
        guard plain.utf8.count >= minPrefixLength else { return }
        let ns = plain as NSString
        var hits: [(offset: Int, length: Int, id: String, title: String)] = []
        for match in regex.matches(in: plain, range: NSRange(location: 0, length: ns.length)) {
            let token = ns.substring(with: match.range)
            guard isCandidate(token), let hit = resolver.resolve(token),
                  let range = Range(match.range, in: plain) else { continue }
            hits.append((plain.distance(from: plain.startIndex, to: range.lowerBound),
                         plain.distance(from: range.lowerBound, to: range.upperBound),
                         hit.id, hit.title))
        }
        for hit in hits.reversed() {
            let chars = attributed.characters
            let lower = chars.index(chars.startIndex, offsetBy: hit.offset)
            let upper = chars.index(lower, offsetBy: hit.length)
            let slice = attributed[lower..<upper]
            // Never inside a link (a markdown link's text, a URL or path claimed already).
            if slice.runs.contains(where: { $0.link != nil }) { continue }
            let isCode: (AttributedString.Runs.Run) -> Bool = {
                $0.inlinePresentationIntent?.contains(.code) == true
            }
            var intent = slice.runs.first?.inlinePresentationIntent ?? []
            if slice.runs.contains(where: isCode) {
                // Only a code span that is exactly the id becomes the title link.
                guard slice.runs.allSatisfy(isCode),
                      !isCodeCharacter(attributed, before: lower),
                      !isCodeCharacter(attributed, at: upper) else { continue }
                intent.remove(.code)
            }
            guard let url = TaskMentionLink.url(for: hit.id) else { continue }
            let attributes = slice.runs.first?.attributes ?? AttributeContainer()
            var replacement = AttributedString(hit.title.isEmpty ? hit.id : hit.title, attributes: attributes)
            intent.insert(.stronglyEmphasized)
            replacement.inlinePresentationIntent = intent
            replacement.link = url
            replacement.foregroundColor = .accentColor
            attributed.replaceSubrange(lower..<upper, with: replacement)
        }
    }

    private static func isCodeCharacter(_ attributed: AttributedString, before index: AttributedString.Index) -> Bool {
        guard index > attributed.characters.startIndex else { return false }
        return isCodeCharacter(attributed, at: attributed.characters.index(before: index))
    }

    private static func isCodeCharacter(_ attributed: AttributedString, at index: AttributedString.Index) -> Bool {
        guard index < attributed.characters.endIndex else { return false }
        let next = attributed.characters.index(after: index)
        return attributed[index..<next].runs.contains {
            $0.inlinePresentationIntent?.contains(.code) == true
        }
    }
}

/// `walnut-task://task/<id>`: "open this task in the app". The timeline
/// (`TimelineCollectionController`) and the SwiftUI markdown surfaces
/// (`FilePathLinkHandling`) intercept it; the system opener never sees one.
enum TaskMentionLink {
    static let scheme = "walnut-task"

    static func url(for id: String) -> URL? {
        guard !id.isEmpty else { return nil }
        var components = URLComponents()
        components.scheme = scheme
        components.host = "task"
        components.path = "/" + id
        return components.url
    }

    static func isTaskLink(_ url: URL) -> Bool { url.scheme == scheme }

    /// The task id a mention link carries; nil for any other URL.
    static func taskID(from url: URL) -> String? {
        guard isTaskLink(url) else { return nil }
        let id = String(url.path(percentEncoded: false).drop(while: { $0 == "/" }))
        return id.isEmpty ? nil : id
    }
}

/// The task titles mentions resolve against: id -> shown title, fed by `TasksStore`
/// whenever its list changes, read by the markdown pipeline from any thread (the
/// timeline builds rows on `TimelineLayoutActor`), so every access takes the lock.
///
/// `version` is part of `MarkdownParser.parse`'s cache key and of the layout actor's
/// memo: it moves when a change can alter rendered text. Like the web's label store,
/// that is not every change. Every token the renderer tried to resolve is remembered
/// (`observed`), and a new, renamed or removed task bumps the version only when its id,
/// or one of its leading segments, was ever looked up. A task created elsewhere that no
/// visible text mentions re-renders nothing. The first fill of an empty table always
/// counts, because the renderer skips the scan while the table is empty.
final class TaskMentionResolver: @unchecked Sendable {
    static let shared = TaskMentionResolver()

    /// Posted on the main thread after `version` moved.
    static let didChange = Notification.Name("walnut.taskMentionsChanged")

    /// Past this many remembered tokens, every change counts (conservative, bounded).
    static let observedLimit = 20_000

    private let lock = NSLock()
    private var titles: [String: String] = [:]
    private var sortedIDs: [String] = []
    private var observed: Set<String> = []
    private var observedOverflow = false
    private var currentVersion = 0

    var version: Int { lock.withLock { currentVersion } }
    var isEmpty: Bool { lock.withLock { titles.isEmpty } }

    /// Shown title of a known id (exact match only). Records the id as looked up.
    func title(for id: String) -> String? {
        lock.withLock { () -> String? in
            noteObserved(id)
            return titles[id]
        }
    }

    /// Resolve a written token: an exact id, else (prefix rule) the one id that starts
    /// with `token + "-"`. Records the token as looked up, hit or miss.
    func resolve(_ token: String) -> (id: String, title: String)? {
        lock.withLock { () -> (id: String, title: String)? in
            noteObserved(token)
            if let title = titles[token] { return (token, title) }
            guard TaskMentions.isPrefixToken(token),
                  let id = uniqueID(withPrefix: token + "-") else { return nil }
            return (id, titles[id] ?? id)
        }
    }

    /// Replace the whole table. Returns true when the version moved (and posts
    /// `didChange`, on the calling thread: `TasksStore` calls this on the main actor).
    @discardableResult
    func update(_ next: [String: String]) -> Bool {
        let moved = lock.withLock { () -> Bool in
            guard next != titles else { return false }
            let relevant = titles.isEmpty || observedOverflow || touchesObserved(old: titles, new: next)
            titles = next
            sortedIDs = next.keys.sorted()
            if relevant { currentVersion &+= 1 }
            return relevant
        }
        if moved { NotificationCenter.default.post(name: Self.didChange, object: self) }
        return moved
    }

    /// Tests: start from an empty table and no remembered tokens (version still moves,
    /// so no cached render of an earlier state survives).
    func resetForTesting() {
        lock.withLock {
            titles = [:]
            sortedIDs = []
            observed = []
            observedOverflow = false
            currentVersion &+= 1
        }
    }

    // MARK: - Under the lock

    private func noteObserved(_ token: String) {
        guard !observedOverflow else { return }
        observed.insert(token)
        if observed.count > Self.observedLimit {
            observed = []
            observedOverflow = true
        }
    }

    /// Does any id added, renamed or removed between `old` and `new` touch a token the
    /// renderer looked up: the id itself, or a leading segment of it (a prefix that may
    /// now resolve, stop resolving, or become ambiguous)?
    private func touchesObserved(old: [String: String], new: [String: String]) -> Bool {
        for (id, title) in new where old[id] != title {
            if touchesObserved(id) { return true }
        }
        for id in old.keys where new[id] == nil {
            if touchesObserved(id) { return true }
        }
        return false
    }

    private func touchesObserved(_ id: String) -> Bool {
        if observed.contains(id) { return true }
        var index = id.startIndex
        while let dash = id[index...].firstIndex(of: "-") {
            if observed.contains(String(id[..<dash])) { return true }
            index = id.index(after: dash)
        }
        return false
    }

    /// The single id with this prefix, or nil when none or several have it. Ids sort
    /// lexicographically (they are ASCII), so every id with a prefix sits in one run.
    private func uniqueID(withPrefix prefix: String) -> String? {
        var low = 0, high = sortedIDs.count
        while low < high {
            let mid = (low + high) / 2
            if sortedIDs[mid] < prefix { low = mid + 1 } else { high = mid }
        }
        guard low < sortedIDs.count, sortedIDs[low].hasPrefix(prefix) else { return nil }
        if low + 1 < sortedIDs.count, sortedIDs[low + 1].hasPrefix(prefix) { return nil }
        return sortedIDs[low]
    }
}

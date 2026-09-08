import Foundation

/// A file path a message mentioned, plus the POSITION inside it, if the writer
/// gave one.
///
/// The web console has linked absolute paths in chat for a long time; the phone
/// showed the same characters as dead text. Detection is only half of the fix:
/// "open `foo.ts:2400`" at line 1 of a 4000-line file is not opening the
/// reference, so the position has to survive the whole trip (message text →
/// `walnut-file://` link → tap → viewer scroll).
///
/// Shapes recognised, all of which real agent output writes:
///   `/a/b/foo.ts:42`        line (`:42:7` also carries the column)
///   `/a/b/foo.ts#L10`       GitHub-style anchor
///   `/a/b/foo.ts#L10-L20`   range (`#L10-20` too)
///   `/a/b/foo.ts(42,7)`     compiler-style line/column
struct FilePathRef: Equatable, Hashable {
    /// Absolute path with every decoration stripped.
    var path: String
    /// 1-based line the reference points at, when it named one.
    var line: Int?
    /// 1-based last line of a range (`#L10-L20`).
    var endLine: Int?
    /// 1-based column, when the reference named one.
    var column: Int?
    /// The reference EXACTLY as the message wrote it, decoration included.
    ///
    /// Kept because it is what `GET /v1/files/resolve-path` wants: the server
    /// owns the parse (`src/providers/path-ref-parse.ts`) and can use signals
    /// the phone has no access to (the session transcript, `git ls-files`). A
    /// path written from another cwd, or a file that has since moved, resolves
    /// there and nowhere else.
    var raw: String?

    init(path: String, line: Int? = nil, endLine: Int? = nil, column: Int? = nil, raw: String? = nil) {
        self.path = path
        self.line = line
        self.endLine = endLine
        self.column = column
        self.raw = raw
    }

    /// File name for a sheet title.
    var displayName: String { (path as NSString).lastPathComponent }

    /// Extensionless = the DIRECTORY shape the linkifier claimed (its second
    /// pass requires a dot-free leaf). Routing re-derives it from the path
    /// instead of reading a transported flag, so a link minted by any build
    /// routes the same way.
    var looksLikeDirectory: Bool { (path as NSString).pathExtension.isEmpty }

    // MARK: - Parsing

    /// `:42` / `:42:7`
    private static let colonSuffix = try? NSRegularExpression(pattern: #":(\d{1,7})(?::(\d{1,7}))?$"#)
    /// `#L10` / `#L10-L20` / `#L10-20`
    private static let anchorSuffix = try? NSRegularExpression(pattern: #"#L(\d{1,7})(?:-L?(\d{1,7}))?$"#)
    /// `(42,7)`
    private static let parenSuffix = try? NSRegularExpression(pattern: #"\((\d{1,7}),\s?(\d{1,7})\)$"#)

    /// Split a decorated reference into path + position.
    ///
    /// ORDER IS LOAD-BEARING: the position is peeled off FIRST, and only then is
    /// trailing sentence punctuation trimmed. Trimming first would eat the `)`
    /// of `(42,7)` and leave `foo.ts(42,7` as the "path" — and trimming a `.`
    /// before the suffix check would turn `foo.ts:42.` into a path ending in a
    /// stray colon. (Same lesson the server's parser encodes: any rule that can
    /// DELETE a character must run after every rule that reads it.)
    static func parse(_ raw: String) -> FilePathRef? {
        var text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        // Agents wrap paths in backticks constantly.
        while text.hasPrefix("`") { text.removeFirst() }
        while text.hasSuffix("`") { text.removeLast() }
        guard !text.isEmpty else { return nil }

        var line: Int?
        var endLine: Int?
        var column: Int?
        let ns = text as NSString
        let full = NSRange(location: 0, length: ns.length)

        func group(_ match: NSTextCheckingResult, _ index: Int) -> Int? {
            let range = match.range(at: index)
            guard range.location != NSNotFound else { return nil }
            return Int(ns.substring(with: range))
        }

        if let match = anchorSuffix?.firstMatch(in: text, range: full) {
            line = group(match, 1)
            endLine = group(match, 2)
            text = ns.substring(to: match.range.location)
        } else if let match = parenSuffix?.firstMatch(in: text, range: full) {
            line = group(match, 1)
            column = group(match, 2)
            text = ns.substring(to: match.range.location)
        } else if let match = colonSuffix?.firstMatch(in: text, range: full) {
            line = group(match, 1)
            column = group(match, 2)
            text = ns.substring(to: match.range.location)
        }

        // Trailing sentence punctuation is prose, not path. `。，、` included:
        // agent output here is routinely Chinese ("报告在 /tmp/out/x.md。").
        while let last = text.last, ".,;:!?、。，)]}".contains(last) { text.removeLast() }
        guard !text.isEmpty else { return nil }

        return FilePathRef(path: text, line: line, endLine: endLine, column: column, raw: raw)
    }

    /// Re-assemble a decorated reference (what `resolve-path` takes as `rel`).
    var decorated: String {
        if let raw, !raw.isEmpty { return raw }
        guard let line else { return path }
        return "\(path):\(line)"
    }
}

// MARK: - walnut-file:// transport

extension FilePreviewLink {
    private static let lineKey = "line"
    private static let endLineKey = "endLine"
    private static let columnKey = "col"
    private static let refKey = "ref"

    /// `walnut-file://preview/tmp/foo.ts?line=42` — the position rides the
    /// QUERY, so the URL's `path` stays the real file path and every existing
    /// reader (`path(from:)`, the WKWebView raw-URL builder) keeps working.
    static func url(for ref: FilePathRef) -> URL? {
        var components = URLComponents()
        components.scheme = scheme
        components.host = "preview"
        // URLComponents REFUSES a non-absolute path while a host is set (it
        // returns nil rather than a broken URL), so a `~/…` reference travels as
        // `/~/…` and is unwrapped in `reference(from:)`. The tilde is preserved
        // rather than expanded because the phone has no idea what the host's home
        // directory is — the server expands it (or forwards it to the remote
        // daemon, which does).
        components.path = ref.path.hasPrefix("~") ? "/" + ref.path : ref.path
        var items: [URLQueryItem] = []
        if let line = ref.line { items.append(URLQueryItem(name: lineKey, value: String(line))) }
        if let end = ref.endLine { items.append(URLQueryItem(name: endLineKey, value: String(end))) }
        if let column = ref.column { items.append(URLQueryItem(name: columnKey, value: String(column))) }
        if let raw = ref.raw, raw != ref.path { items.append(URLQueryItem(name: refKey, value: raw)) }
        if !items.isEmpty { components.queryItems = items }
        return components.url
    }

    /// The reference carried by a tapped link, or nil when the URL is not ours.
    ///
    /// Accepts our own scheme, and a scheme-less absolute path with an
    /// extension (what `[notes](/tmp/notes.md)` markdown parses to). Broader
    /// than `path(from:)`, which stays HTML-only on the scheme-less branch
    /// because the HTML preview is the only thing allowed to claim a URL
    /// sight-unseen.
    static func reference(from url: URL) -> FilePathRef? {
        var path = url.path(percentEncoded: false)
        if url.scheme == scheme {
            // Undo the `/~/…` transport (see `url(for:)`).
            if path.hasPrefix("/~/") || path == "/~" { path.removeFirst() }
            let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
            func int(_ name: String) -> Int? {
                items.first(where: { $0.name == name })?.value.flatMap { Int($0) }
            }
            return FilePathRef(
                path: path, line: int(lineKey), endLine: int(endLineKey), column: int(columnKey),
                raw: items.first(where: { $0.name == refKey })?.value
            )
        }
        guard (url.scheme ?? "").isEmpty, path.hasPrefix("/"),
              !(path as NSString).pathExtension.isEmpty else { return nil }
        return FilePathRef(path: path)
    }

    // MARK: - Failure copy

    /// ONE mapping from a failed read to a `FileReadFailure`, shared by the
    /// WKWebView preview (which sees raw status codes) and the text viewer
    /// (which sees `APIError`).
    ///
    /// Each status is a genuinely different situation and therefore gets its own
    /// sentence — 403 and 501 used to share one, which told a reader whose
    /// daemon was simply out of date to go use their Mac forever:
    ///  - 403: refused BY DESIGN, host-side (`~/.ssh`, `.env*`, `*.pem`,
    ///    `config.yaml`). Retrying will never help.
    ///  - 404: the OWNING HOST answered, and has nothing readable there.
    ///  - 413: over the 2 MB relay cap. The file exists and is readable, just
    ///    not through the phone.
    ///  - 501: the target daemon predates the bounded-read command. It
    ///    self-heals on the primary's next auto-deploy.
    ///  - 502/503: this box could not reach the box that owns the file.
    static func kind(forHTTPStatus status: Int) -> FileReadFailureKind {
        switch status {
        case 401, 407: return .notAuthorised
        case 403: return .refused
        case 404, 410: return .notFoundOnHost
        case 413: return .tooLarge
        case 415: return .unsupportedType
        case 501: return .hostNeedsUpgrade
        case 502, 503, 504: return .hostUnreachable
        default: return .serverError(status: status)
        }
    }

    /// HTTP status + which box was asked → the sentence and the retry decision.
    static func failure(forHTTPStatus status: Int, host: String? = nil) -> FileReadFailure {
        FileReadFailure(kind: kind(forHTTPStatus: status), host: host)
    }

    /// `APIError` → the same failures. Status first (the server reuses the
    /// `not_supported_cloud` CODE for both 403 and 501, so the code alone
    /// cannot tell "refused forever" from "retry in a minute" apart).
    static func failure(for error: Error, host: String? = nil) -> FileReadFailure {
        // Not an APIError at all: nothing ANSWERED, so the phone knows nothing
        // about the file. Saying anything about the file here would be invention.
        guard let api = error as? APIError else {
            return FileReadFailure(kind: .transportFailed, host: host)
        }
        switch api {
        case .server(let status, let code, _, _, _):
            if code == "session_control_needs_upgrade" {
                return FileReadFailure(kind: .hostNeedsUpgrade, host: host)
            }
            return FileReadFailure(kind: kind(forHTTPStatus: status), host: host)
        case .unauthorized, .notConfigured:
            return FileReadFailure(kind: .notAuthorised, host: host)
        case .network, .cancelled:
            return FileReadFailure(kind: .transportFailed, host: host)
        case .rateLimited:
            return FileReadFailure(kind: .serverError(status: 429), host: host)
        case .badResponse:
            return FileReadFailure(kind: .serverError(status: nil), host: host)
        }
    }

    /// The JSON viewer lane answers a MISSING file as `200` with `error` set
    /// (the frozen viewer contract), never as 404 — so for that lane the honest
    /// classification has to come from the text. Anything that is not the
    /// not-found shape is the host failing a read on a path it DID find, which
    /// is a different sentence with a different retry story.
    static func failure(fromPayloadError text: String?, host: String? = nil) -> FileReadFailure {
        let raw = (text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if raw.isEmpty || raw.range(of: "not found", options: .caseInsensitive) != nil {
            return FileReadFailure(kind: .notFoundOnHost, host: host)
        }
        return FileReadFailure(kind: .hostReadFailed(raw), host: host)
    }

    /// String-only entry points, kept because most call sites only want the
    /// sentence. The failure ladder itself lives in exactly one place above.
    static func friendlyMessage(forHTTPStatus status: Int) -> String {
        failure(forHTTPStatus: status).message
    }

    static func friendlyMessage(for error: Error) -> String {
        failure(for: error).message
    }
}

// MARK: - Why a read produced no bytes

/// Deliberately NOT a mirror of HTTP. 404 and 503 are both "no bytes came
/// back", but one is a statement about the FILE and the other is a statement
/// about the NETWORK BETWEEN TWO BOXES — and the phone shipped for a while
/// reporting the second as the first ("That file isn't there anymore"), which is
/// the app telling its owner a falsehood about their own disk. The repo rule is
/// "never answer a path question with an errno; a confident wrong answer is
/// worse than an error", and this enum is what lets the copy obey it.
enum FileReadFailureKind: Equatable {
    /// The owning host ANSWERED, and has nothing readable at that path. Note
    /// this is not the same as "deleted": an agent routinely names a file a
    /// beat before it finishes writing it, so the honest copy invites a retry.
    case notFoundOnHost
    /// The owning host answered, and the read itself failed there.
    case hostReadFailed(String)
    /// Refused BY DESIGN host-side (keys, `.env*`, `config.yaml`).
    case refused
    /// Over the relay's byte cap.
    case tooLarge
    /// The owning host's daemon predates the bounded-read command.
    case hostNeedsUpgrade
    /// The server could not reach the box that owns the file.
    case hostUnreachable
    /// The PHONE could not reach the server at all.
    case transportFailed
    /// This phone isn't allowed to read files.
    case notAuthorised
    /// Bytes arrived, but the phone can't render them.
    case unsupportedType
    /// Anything else. `nil` = the answer itself didn't parse.
    case serverError(status: Int?)
}

/// A failed read, told honestly: which box was asked, what it said, and whether
/// asking again could plausibly change the answer.
struct FileReadFailure: Equatable {
    let kind: FileReadFailureKind
    /// Host alias the read was aimed at. nil / "" / `__local__` = the primary box.
    let host: String?

    init(kind: FileReadFailureKind, host: String? = nil) {
        self.kind = kind
        self.host = host
    }

    /// The host alias when the caller actually told us one, nil when it did not.
    /// Separate from `hostLabel` because "the primary box" and "nobody said" are
    /// different facts, and one case (`hostNeedsUpgrade`) must not conflate them.
    var namedHost: String? {
        guard let host, !host.isEmpty, host != "__local__" else { return nil }
        return host
    }

    /// How to NAME the box that owns the file. Naming it is the whole point:
    /// "it isn't there" and "I couldn't ask" are different sentences, and
    /// neither means anything until the reader knows which machine was asked.
    ///
    /// Defaults to the primary box, which is right for every case that can only
    /// arise about a path the primary was asked for. It is NOT right for a 501 —
    /// see `hostNeedsUpgrade` in `message`.
    var hostLabel: String { namedHost ?? "your Mac" }

    /// Empty-state headline. "Can't preview file" for everything blamed the
    /// FILE for a network problem; each case names its own situation now.
    var title: String {
        switch kind {
        case .notFoundOnHost: return "Not on \(hostLabel)"
        case .hostReadFailed: return "Couldn't read that file"
        case .refused: return "Blocked on the host"
        case .tooLarge: return "File too large"
        case .hostNeedsUpgrade: return "Host needs an upgrade"
        case .hostUnreachable: return "Can't reach \(hostLabel)"
        case .transportFailed: return "Can't reach Walnut"
        case .notAuthorised: return "Not paired"
        case .unsupportedType: return "Can't show this file"
        case .serverError: return "Can't open file"
        }
    }

    var icon: String {
        switch kind {
        case .notFoundOnHost: return "doc.questionmark"
        case .hostReadFailed: return "exclamationmark.triangle"
        case .refused: return "lock.doc"
        case .tooLarge: return "arrow.down.doc"
        case .hostNeedsUpgrade: return "arrow.triangle.2.circlepath"
        case .hostUnreachable, .transportFailed: return "wifi.slash"
        case .notAuthorised: return "person.badge.key"
        case .unsupportedType: return "doc.richtext"
        case .serverError: return "exclamationmark.triangle"
        }
    }

    /// One sentence a person can act on. Two words never appear: "anymore"
    /// (which asserts the file once existed and was deleted — a claim the phone
    /// has no evidence for) and any errno.
    var message: String {
        switch kind {
        case .notFoundOnHost:
            return "There's no file at that path on \(hostLabel) right now. A file an agent has just announced may still be being written, so this is worth another try."
        case .hostReadFailed(let reason):
            return "The path exists on \(hostLabel), but reading it failed there: \(reason)"
        case .refused:
            return "Walnut won't read this path: keys, .env files and other secrets are blocked on \(hostLabel) itself."
        case .tooLarge:
            return "This file is too big to send to the phone. Open it on \(hostLabel)."
        case .hostNeedsUpgrade:
            // The ONE case that must not fall back to "your Mac". A 501 comes from
            // a box whose daemon predates the bounded read, and in cloud mode that
            // box is by definition NOT the phone owner's Mac — so when the caller
            // did not say which host it asked, the honest sentence names no host at
            // all. Naming the wrong machine sends the reader to the wrong machine.
            guard let named = namedHost else {
                return "That file is on a host running an older Walnut daemon, which can't serve file reads yet. It upgrades itself on the next reconnect, so try again shortly."
            }
            return "The Walnut daemon on \(named) is too old to serve file reads yet. It upgrades itself on the next reconnect, so try again shortly."
        case .hostUnreachable:
            // Says UNREACHABLE in as many words. The previous sentence only said
            // "couldn't reach", which reads as a verdict about the request rather
            // than about the link between two machines — and the contract test
            // asks for the word for exactly that reason.
            return "Walnut couldn't reach \(hostLabel) just now, so it can't say what is at that path. The host being unreachable does NOT mean the file is gone — try again once it is back."
        case .transportFailed:
            return "Your phone couldn't reach the Walnut server, so nothing has been said about this file yet. Try again when you're back online."
        case .notAuthorised:
            return "This phone isn't allowed to read files from Walnut. Re-pair it in Settings."
        case .unsupportedType:
            return "The phone can't render this kind of file. Open it on \(hostLabel)."
        case .serverError(let status):
            guard let status else { return "Walnut's answer for this file didn't make sense." }
            return "The server couldn't serve this file (HTTP \(status))."
        }
    }

    /// Whether re-issuing the SAME read could plausibly succeed. This is the
    /// difference between an empty state that dead-ends and one the reader can
    /// escape: the 2026-09-07 report was a 404 that became a 200 SEVENTY
    /// SECONDS later, and the app offered no way to find that out.
    var isRetryable: Bool {
        switch kind {
        case .notFoundOnHost, .hostReadFailed, .hostNeedsUpgrade,
             .hostUnreachable, .transportFailed:
            return true
        case .refused, .tooLarge, .notAuthorised, .unsupportedType:
            return false
        case .serverError(let status):
            // Retry the statuses that mean "later might differ", not the ones
            // that mean "you asked for something impossible".
            guard let status else { return false }
            return status >= 500 || status == 408 || status == 429
        }
    }
}

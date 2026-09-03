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

    /// ONE mapping from an HTTP refusal to a sentence a person can act on,
    /// shared by the WKWebView preview (which sees raw status codes) and the
    /// text viewer (which sees `APIError`).
    ///
    /// Each status is a genuinely different situation and therefore gets its own
    /// sentence — 403 and 501 used to share one, which told a reader whose
    /// daemon was simply out of date to go use their Mac forever:
    ///  - 403: refused BY DESIGN, host-side (`~/.ssh`, `.env*`, `*.pem`,
    ///    `config.yaml`). Retrying will never help.
    ///  - 413: over the 2 MB relay cap. The file exists and is readable, just
    ///    not through the phone.
    ///  - 501: the target daemon predates the bounded-read command. It
    ///    self-heals on the primary's next auto-deploy.
    ///  - 503: the bridge is down right now. Retryable.
    static func friendlyMessage(forHTTPStatus status: Int) -> String {
        switch status {
        case 404:
            return "That file isn't there anymore."
        case 403:
            return "Walnut won't read this path: keys, .env files and other secrets are blocked on the host itself."
        case 413:
            return "This file is too big to send to the phone. Open it on your Mac."
        case 501:
            return "The file's host is running an older Walnut daemon. It upgrades itself on the next reconnect, so try again shortly."
        case 502, 503:
            return "The file's host isn't reachable right now. Try again when it reconnects."
        default:
            return "The server couldn't serve this file (HTTP \(status))."
        }
    }

    /// `APIError` → the same sentences. Status first (the server reuses the
    /// `not_supported_cloud` CODE for both 403 and 501, so the code alone
    /// cannot tell "refused forever" from "retry in a minute" apart).
    static func friendlyMessage(for error: Error) -> String {
        guard let api = error as? APIError else { return error.localizedDescription }
        guard case .server(let status, let code, let message, _, _) = api else {
            return api.errorDescription ?? "Something went wrong."
        }
        if code == "session_control_needs_upgrade" {
            return "Your primary box is upgrading for mobile file browsing. Try again in a minute."
        }
        guard status >= 400 else { return message }
        return friendlyMessage(forHTTPStatus: status)
    }
}

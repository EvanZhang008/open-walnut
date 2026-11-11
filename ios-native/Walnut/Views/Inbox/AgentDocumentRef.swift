import Foundation

/// The web's `parseAgentRef` rules; the phone's links carry them in the query because it has no document token.
enum AgentDocumentRef: Equatable {
    case file(FilePathRef)
    case task(String)
    case letter(String)

    static let route = "/open-ref"
    static let maxPathLength = 8192

    /// A route link that fails to parse is dropped, never handed to Safari.
    static func isRoute(_ url: URL, server: URL?) -> Bool {
        guard let server, sameOrigin(url, server),
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              components.user == nil, components.password == nil else { return false }
        return components.percentEncodedPath == routePath(on: server)
    }

    static func parse(_ url: URL, server: URL?) -> AgentDocumentRef? {
        guard isRoute(url, server: server),
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
        let fragment = components.percentEncodedFragment ?? ""
        let params = parameters(fragment.isEmpty ? (components.percentEncodedQuery ?? "") : fragment)
        switch params["kind"] {
        case "file":
            guard let path = params["path"], isSafePath(path) else { return nil }
            let line = position(params["line"])
            let endLine = line.flatMap { start in position(params["endLine"]).flatMap { $0 > start ? $0 : nil } }
            return .file(FilePathRef(path: path, line: line, endLine: endLine))
        case "task":
            guard let id = params["id"], TaskMentions.isFullTaskID(id) else { return nil }
            return .task(id)
        case "letter":
            guard let id = params["id"], LetterDeepLink.isValidLetterId(id) else { return nil }
            return .letter(id)
        default:
            return nil
        }
    }

    var appURL: URL? {
        switch self {
        case .file(let ref): return FilePreviewLink.url(for: ref)
        case .task(let id): return TaskMentionLink.url(for: id)
        case .letter(let id): return LetterMentionLink.url(for: id)
        }
    }

    static func appURL(for url: URL, server: URL?) -> URL? {
        parse(url, server: server)?.appURL
    }

    // MARK: - Rules

    static func isSafePath(_ path: String) -> Bool {
        guard path.hasPrefix("/") || path.hasPrefix("~/"), !path.hasPrefix("//"),
              path.utf16.count <= maxPathLength else { return false }
        guard !path.unicodeScalars.contains(where: { $0.value < 0x20 || $0.value == 0x7F }) else { return false }
        return !path.split(omittingEmptySubsequences: false, whereSeparator: { $0 == "/" || $0 == "\\" })
            .contains("..")
    }

    private static func position(_ raw: String?) -> Int? {
        guard let raw, !raw.isEmpty, raw.count <= 9, raw.allSatisfy({ $0.isASCII && $0.isNumber }),
              let n = Int(raw), n > 0 else { return nil }
        return n
    }

    /// `URLSearchParams` semantics, as the web reads the same links.
    private static func parameters(_ raw: String) -> [String: String] {
        var out: [String: String] = [:]
        for pair in raw.split(separator: "&") {
            let parts = pair.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
            guard let name = decode(parts[0]),
                  let value = parts.count > 1 ? decode(parts[1]) : "" else { continue }
            if out[name] == nil { out[name] = value }
        }
        return out
    }

    private static func decode(_ raw: Substring) -> String? {
        raw.replacingOccurrences(of: "+", with: " ").removingPercentEncoding
    }

    static func sameOrigin(_ a: URL, _ b: URL) -> Bool {
        guard let scheme = a.scheme?.lowercased(), scheme == "http" || scheme == "https",
              scheme == b.scheme?.lowercased(),
              let host = a.host?.lowercased(), !host.isEmpty, host == b.host?.lowercased() else { return false }
        let fallback = scheme == "https" ? 443 : 80
        return (a.port ?? fallback) == (b.port ?? fallback)
    }

    private static func routePath(on server: URL) -> String {
        var base = URLComponents(url: server, resolvingAgainstBaseURL: false)?.percentEncodedPath ?? ""
        while base.hasSuffix("/") { base.removeLast() }
        return base + route
    }
}

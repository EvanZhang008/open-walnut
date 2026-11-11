import Foundation

/// Fetches a DEFERRED letter body to a local file, ready for the reader.
///
/// A letter's document can be 100MB (a digest with hours of audio inline, a
/// screen recording), so the server stops putting it in the letter JSON past a
/// threshold and answers `bodyUrl` instead. Two things follow for the phone, and
/// both are why this is a file rather than a `String`:
///
/// - `URLSession.download` streams to disk, so the bytes are never resident in
///   the app. Decoding a 100MB body into a Swift String, then handing that String
///   to WKWebView, would be three copies of it in memory at once.
/// - `WKWebView.loadFileURL` reads the document off disk itself, incrementally.
///
/// The document the reader actually shows is the phone's own frame (the CSP,
/// viewport and typography in `LetterHTMLBody`), so the download is assembled
/// into a complete `.html` file: prelude, then the body copied through in bounded
/// chunks, then the suffix. `FileHandle` copying keeps the peak allocation at one
/// chunk regardless of the letter's size.
enum LetterBodyDownload {
    /// Bounded copy window. Small enough that the peak stays trivial, big enough
    /// that a 100MB body is a few hundred iterations, not a few hundred thousand.
    static let copyChunkBytes = 1 << 20

    enum Failure: LocalizedError {
        case notConfigured
        case http(Int)
        case io(String)

        var errorDescription: String? {
            switch self {
            case .notConfigured: return "This device isn't paired with a Walnut server yet."
            case .http(let code): return "The server couldn't send this letter's body (HTTP \(code))."
            case .io(let detail): return "Couldn't save this letter's body: \(detail)"
            }
        }
    }

    /// The server splices its frame head within a document's first 8KB.
    static let framePeekBytes = 16 * 1024

    /// Download `url` and wrap it into a phone-shaped HTML document on disk.
    /// Returns the file URL to hand to `LetterHTMLBody`.
    /// `owner` names the file, so closing one letter never deletes another's.
    static func fetchDocument(from url: URL, isHTML: Bool, refs: Bool = false, owner: String? = nil) async throws -> URL {
        guard let token = AppConfig.token else { throw Failure.notConfigured }
        var request = URLRequest(url: refs ? routedURL(url) : url)
        request.authorizeForWalnut(token: token)
        // A big body over a phone link legitimately takes a while; the default
        // 30s request timeout would kill it mid-transfer.
        request.timeoutInterval = 300

        let (downloaded, response) = try await URLSession.shared.download(for: request)
        if let http = response as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
            try? FileManager.default.removeItem(at: downloaded)
            throw Failure.http(http.statusCode)
        }
        defer { try? FileManager.default.removeItem(at: downloaded) }
        guard isHTML else { return try persist(downloaded, as: "txt", owner: owner) }
        return try assembleDocument(bodyFile: downloaded, owner: owner)
    }

    /// Older servers ignore `refs` (or both) and the phone frame still wraps what comes back.
    static func routedURL(_ url: URL, server: URL? = AppConfig.serverURL) -> URL {
        guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return url }
        var items = (components.queryItems ?? []).filter { !["frame", "refs", "ref_base"].contains($0.name) }
        items.append(URLQueryItem(name: "frame", value: "1"))
        items.append(URLQueryItem(name: "refs", value: "1"))
        // The server sees http behind an HTTPS tunnel, so the paired address names the links' origin.
        if let base = refBase(for: server) { items.append(URLQueryItem(name: "ref_base", value: base)) }
        components.queryItems = items
        return components.url ?? url
    }

    static func refBase(for server: URL?) -> String? {
        guard let server, var c = URLComponents(url: server, resolvingAgainstBaseURL: false),
              let scheme = c.scheme?.lowercased(), scheme == "http" || scheme == "https",
              !(c.host ?? "").isEmpty else { return nil }
        var path = c.percentEncodedPath
        while path.hasSuffix("/") { path.removeLast() }
        c.user = nil
        c.password = nil
        c.query = nil
        c.fragment = nil
        c.percentEncodedPath = path + AgentDocumentRef.route
        return c.string
    }

    static func fileName(owner: String?, ext: String) -> String {
        "\(prefix(owner: owner))\(UUID().uuidString).\(ext)"
    }

    private static func prefix(owner: String?) -> String {
        let safe = owner.map { String($0.unicodeScalars.filter { CharacterSet.alphanumerics.contains($0) || $0 == "-" }) } ?? ""
        return safe.isEmpty ? "letter-" : "letter-\(safe)--"
    }

    /// Move a finished download into the caches dir under a stable extension.
    /// WKWebView needs a real path it may keep reading; the URLSession temp file
    /// is deleted the moment this function returns.
    private static func persist(_ src: URL, as ext: String, owner: String?) throws -> URL {
        let dir = try bodyCacheDir()
        let dest = dir.appendingPathComponent(fileName(owner: owner, ext: ext))
        do {
            try FileManager.default.copyItem(at: src, to: dest)
        } catch {
            throw Failure.io(error.localizedDescription)
        }
        return dest
    }

    /// prelude + body + suffix, written through a bounded buffer.
    private static func assembleDocument(bodyFile: URL, owner: String?) throws -> URL {
        let dir = try bodyCacheDir()
        let dest = dir.appendingPathComponent(fileName(owner: owner, ext: "html"))
        guard FileManager.default.createFile(atPath: dest.path, contents: nil) else {
            throw Failure.io("could not create \(dest.lastPathComponent)")
        }
        do {
            let out = try FileHandle(forWritingTo: dest)
            defer { try? out.close() }
            let input = try FileHandle(forReadingFrom: bodyFile)
            defer { try? input.close() }
            let peek = try input.read(upToCount: framePeekBytes) ?? Data()
            try out.write(contentsOf: assembledHead(peek: peek))
            let suffix = LetterHTMLBody.documentPieces().suffix
            while true {
                guard let chunk = try input.read(upToCount: copyChunkBytes), !chunk.isEmpty else { break }
                try out.write(contentsOf: chunk)
            }
            try out.write(contentsOf: Data(suffix.utf8))
        } catch let failure as Failure {
            throw failure
        } catch {
            throw Failure.io(error.localizedDescription)
        }
        return dest
    }

    static func assembledHead(peek: Data) -> Data {
        guard let end = LetterHTMLBody.serverFrameStyleEnd(in: peek) else {
            return Data(LetterHTMLBody.documentPieces().prelude.utf8) + peek
        }
        var head = Data(LetterHTMLBody.documentPieces(styled: false).prelude.utf8)
        head.append(peek.prefix(end))
        head.append(Data(LetterHTMLBody.phoneStyle.utf8))
        head.append(peek.dropFirst(end))
        return head
    }

    /// Caches, not Documents: a letter body is re-downloadable, so it must be
    /// evictable rather than something the phone backs up and never reclaims.
    private static func bodyCacheDir() throws -> URL {
        guard let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first else {
            throw Failure.io("no caches directory")
        }
        let dir = caches.appendingPathComponent("letter-bodies", isDirectory: true)
        if !FileManager.default.fileExists(atPath: dir.path) {
            do {
                try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            } catch {
                throw Failure.io(error.localizedDescription)
            }
        }
        return dir
    }

    /// Drop everything this module has cached. Called when the reader closes, so
    /// a session of reading big digests doesn't accumulate copies on the device.
    static func clearCache() {
        guard let dir = try? bodyCacheDir() else { return }
        try? FileManager.default.removeItem(at: dir)
    }

    /// A letter opened from a link in another must not delete the files of the one under it.
    static func clearCache(owner: String) {
        guard let dir = try? bodyCacheDir(),
              let names = try? FileManager.default.contentsOfDirectory(atPath: dir.path) else { return }
        let own = prefix(owner: owner)
        guard own != "letter-" else { return clearCache() }
        for name in names where name.hasPrefix(own) {
            try? FileManager.default.removeItem(at: dir.appendingPathComponent(name))
        }
    }
}

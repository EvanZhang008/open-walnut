import Foundation
import Network
import WebKit
import XCTest
@testable import Walnut

/// A connected phone reads a previewed HTML page whole, frames included
/// (2026-10-31: the preview loaded `file-content?path=…`, the page's relative
/// frames resolved to `/api/v1/<name>.html`, WebKit sent them with no header,
/// each answered 401 and the whole preview said "Not paired. Re-pair it in
/// Settings." on a phone that was connected).
final class HTMLPreviewSignInTests: XCTestCase {

    private let base = URL(string: "https://wn.example.test")!

    // MARK: - The path-shaped URL

    func testPathURLNamesTheFileInItsPath() throws {
        let local = try XCTUnwrap(WalnutAPI.rawFilePathURL(base: base, path: "/Users/me/site/index.html", host: nil))
        XCTAssertEqual(local.absoluteString, "https://wn.example.test/api/v1/file-raw/local/Users/me/site/index.html")
        let primary = try XCTUnwrap(WalnutAPI.rawFilePathURL(base: base, path: "/a/b.html", host: "__local__"))
        XCTAssertEqual(primary.path, "/api/v1/file-raw/local/a/b.html")
        let remote = try XCTUnwrap(WalnutAPI.rawFilePathURL(base: base, path: "/home/me/x.html", host: "devbox"))
        XCTAssertEqual(remote.absoluteString, "https://wn.example.test/api/v1/file-raw/devbox/home/me/x.html")
        let home = try XCTUnwrap(WalnutAPI.rawFilePathURL(base: base, path: "~/proj/index.html", host: "devbox"))
        XCTAssertEqual(home.absoluteString, "https://wn.example.test/api/v1/file-raw/devbox/~/proj/index.html")
    }

    func testPathURLEncodesEveryCharacterThatWouldEndTheSegment() throws {
        let url = try XCTUnwrap(WalnutAPI.rawFilePathURL(base: base, path: "/w/mock ups/a#1?;b.html", host: nil))
        XCTAssertEqual(url.absoluteString, "https://wn.example.test/api/v1/file-raw/local/w/mock%20ups/a%231%3F%3Bb.html")
        XCTAssertNil(url.query)
        XCTAssertNil(url.fragment)
        // Unicode survives as UTF-8 escapes. "\u{65E5}" is a CJK character.
        let cjk = try XCTUnwrap(WalnutAPI.rawFilePathURL(base: base, path: "/w/\u{65E5}.html", host: nil))
        XCTAssertEqual(cjk.absoluteString, "https://wn.example.test/api/v1/file-raw/local/w/%E6%97%A5.html")
    }

    func testPathURLRefusesWhatHasNoPathForm() {
        XCTAssertNil(WalnutAPI.rawFilePathURL(base: base, path: "relative/x.html", host: nil))
        XCTAssertNil(WalnutAPI.rawFilePathURL(base: base, path: "/a/../etc/x.html", host: nil))
        XCTAssertNil(WalnutAPI.rawFilePathURL(base: base, path: "", host: nil))
    }

    /// The point of the shape: a relative reference in the page is its sibling.
    func testARelativeReferenceResolvesToTheSiblingFile() throws {
        let page = try XCTUnwrap(WalnutAPI.rawFilePathURL(base: base, path: "/Users/me/mock ups/index.html", host: "devbox"))
        let frame = try XCTUnwrap(URL(string: "01-inbox-lines.html", relativeTo: page)).absoluteURL
        XCTAssertEqual(frame.absoluteString, "https://wn.example.test/api/v1/file-raw/devbox/Users/me/mock%20ups/01-inbox-lines.html")
        let up = try XCTUnwrap(URL(string: "../shared/app.css", relativeTo: page)).absoluteURL
        XCTAssertEqual(up.path, "/api/v1/file-raw/devbox/Users/me/shared/app.css")
    }

    // MARK: - The cookie the page's own requests sign in with

    @MainActor
    func testTheDeviceCookieIsScopedToFileReads() throws {
        let page = try XCTUnwrap(WalnutAPI.rawFilePathURL(base: base, path: "/a/index.html", host: nil))
        let cookie = try XCTUnwrap(HTMLPreviewLoader.deviceCookie(for: page, token: "tok+en/="))
        XCTAssertEqual(cookie.name, "walnut_device")
        XCTAssertEqual(cookie.value.removingPercentEncoding, "tok+en/=", "the server decodes the value")
        XCTAssertFalse(cookie.value.contains(";"))
        // The document's own folder: siblings and subfolders, nothing else.
        XCTAssertEqual(cookie.path, "/api/v1/file-raw/local/a/")
        let spaced = try XCTUnwrap(WalnutAPI.rawFilePathURL(base: base, path: "/w/mock ups/index.html", host: "devbox"))
        XCTAssertEqual(HTMLPreviewLoader.deviceCookie(for: spaced, token: "t")?.path, "/api/v1/file-raw/devbox/w/mock%20ups/")
        XCTAssertEqual(cookie.domain, "wn.example.test")
        XCTAssertTrue(cookie.isSecure)
        XCTAssertEqual(cookie.sameSitePolicy, .sameSiteStrict)

        let plain = try XCTUnwrap(WalnutAPI.rawFilePathURL(base: URL(string: "http://100.64.0.2:3456")!, path: "/a/index.html", host: nil))
        XCTAssertFalse(try XCTUnwrap(HTMLPreviewLoader.deviceCookie(for: plain, token: "t")).isSecure)

        XCTAssertNil(HTMLPreviewLoader.deviceCookie(for: page, token: nil))
        XCTAssertNil(HTMLPreviewLoader.deviceCookie(for: page, token: ""))
        // The query shape has no siblings, so it never needs the cookie.
        XCTAssertNil(HTMLPreviewLoader.deviceCookie(
            for: URL(string: "https://wn.example.test/api/v1/file-content?path=/a/x.html&raw=1")!, token: "t"))
    }

    // MARK: - An older companion's redirect

    /// A companion from before this change answers the path shape with a 302 to
    /// `/api/file-content?…`, form-encoded and with no host for this machine.
    /// The preview follows it instead of cancelling it and spinning forever.
    func testAnOlderCompanionsRedirectIsTheSameFile() throws {
        let origin = try XCTUnwrap(WalnutAPI.rawFilePathURL(base: base, path: "/Users/me/mock ups/index.html", host: "__local__"))
        let local = FilePreviewTarget(path: "/Users/me/mock ups/index.html", host: "__local__")
        let redirect = URL(string: "https://wn.example.test/api/file-content?path=%2FUsers%2Fme%2Fmock+ups%2Findex.html&raw=1")!
        XCTAssertTrue(HTMLPreviewNavigator.isRawRead(of: local, at: redirect, origin: origin))
        let remote = FilePreviewTarget(path: "/home/me/a+b c.html", host: "devbox")
        let remoteRedirect = URL(string: "https://wn.example.test/api/file-content?path=%2Fhome%2Fme%2Fa%2Bb+c.html&raw=1&host=devbox")!
        XCTAssertTrue(HTMLPreviewNavigator.isRawRead(of: remote, at: remoteRedirect, origin: origin))

        // Anything else is still not followed.
        for other in [
            "https://wn.example.test/api/file-content?path=%2FUsers%2Fme%2Fother.html&raw=1",
            "https://wn.example.test/api/file-content?path=%2FUsers%2Fme%2Fmock+ups%2Findex.html",
            "https://wn.example.test/api/file-content?path=%2FUsers%2Fme%2Fmock+ups%2Findex.html&raw=1&host=devbox",
            "https://elsewhere.test/api/file-content?path=%2FUsers%2Fme%2Fmock+ups%2Findex.html&raw=1",
            "https://wn.example.test/api/tasks?path=%2FUsers%2Fme%2Fmock+ups%2Findex.html&raw=1",
        ] {
            XCTAssertFalse(HTMLPreviewNavigator.isRawRead(of: local, at: URL(string: other)!, origin: origin), other)
        }
    }

    // MARK: - The words

    /// A 401 is never a verdict on the pairing: the connection re-checks it
    /// with the same token and signs out only on a refusal there.
    func testASignInRefusalNeverTellsAConnectedPhoneToPairAgain() {
        for failure in [FilePreviewLink.failure(forHTTPStatus: 401), FilePreviewLink.failure(forHTTPStatus: 407),
                        FilePreviewLink.failure(for: APIError.unauthorized)] {
            XCTAssertEqual(failure.kind, .signInRefused)
            XCTAssertTrue(failure.isRetryable)
            for text in [failure.title, failure.message] {
                XCTAssertNil(text.range(of: "pair", options: .caseInsensitive), "tells the phone to pair: \(text)")
            }
        }
    }

    /// Every sentence the app shows, scanned from the source: none tells the
    /// phone to pair again. A connected phone's refusal is checked by the
    /// connection, which shows the pairing screen itself when it is really gone.
    func testNoUserVisibleStringTellsThePhoneToPairAgain() throws {
        let pattern = try NSRegularExpression(
            pattern: #""[^"\n]*\b(re-?pair|pair (it|this \w+|the \w+) again|pair again)\b[^"\n]*""#,
            options: [.caseInsensitive])
        var hits: [String] = []
        for file in try Self.swiftSources() {
            let text = try String(contentsOf: file, encoding: .utf8)
            for (number, line) in text.components(separatedBy: "\n").enumerated() {
                let code = line.trimmingCharacters(in: .whitespaces)
                if code.hasPrefix("//") { continue }
                let range = NSRange(code.startIndex..., in: code)
                if pattern.firstMatch(in: code, range: range) != nil {
                    hits.append("\(file.lastPathComponent):\(number + 1): \(code)")
                }
            }
        }
        XCTAssertEqual(hits, [])
    }

    /// Every web view that loads a SERVER URL must give its page's own requests
    /// the device cookie, or each frame and image answers 401. Today only the
    /// HTML preview does; the others render a string with no base URL.
    func testEveryWebViewThatLoadsAServerURLSetsTheDeviceCookie() throws {
        let renderStringOnly: [String: String] = [
            "LetterHTMLBody.swift": "renders the letter's own HTML string with no base URL",
            "TimelineRichHTMLCell.swift": "renders the message's HTML string with no base URL",
        ]
        var seen: [String] = []
        for file in try Self.swiftSources() {
            let text = try String(contentsOf: file, encoding: .utf8)
            guard text.contains("WKWebView(frame") else { continue }
            let name = file.lastPathComponent
            seen.append(name)
            if renderStringOnly[name] != nil {
                XCTAssertFalse(text.contains(".load(") || text.contains("walnutLoad("),
                               "\(name) now loads a URL: give it the device cookie and drop it from the list")
            } else {
                XCTAssertTrue(text.contains("httpCookieStore.setCookie"),
                              "\(name) builds a WKWebView without the device cookie")
            }
        }
        XCTAssertTrue(seen.contains("HTMLFilePreview.swift"), "the scan found no web views")
        for name in renderStringOnly.keys { XCTAssertTrue(seen.contains(name), "stale entry: \(name)") }
    }

    private static func swiftSources() throws -> [URL] {
        let app = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()   // WalnutTests/
            .deletingLastPathComponent()   // ios-native/
            .appendingPathComponent("Walnut")
        guard let walker = FileManager.default.enumerator(at: app, includingPropertiesForKeys: nil) else { return [] }
        return walker.compactMap { $0 as? URL }.filter { $0.pathExtension == "swift" }
    }

    // MARK: - A real web view against a server that checks the sign-in

    /// The whole path, in WebKit: the document carries the Bearer header, its
    /// relative frame resolves to the sibling file and signs in with the cookie,
    /// and a frame the server refuses leaves the page on screen.
    @MainActor
    func testAPreviewedPageLoadsItsFramesSignedIn() async throws {
        let server = try SignInCheckingServer(token: "marina-phone-token")
        defer { server.stop() }
        let port = try await server.start()
        let base = URL(string: "http://127.0.0.1:\(port)")!
        let page = try XCTUnwrap(WalnutAPI.rawFilePathURL(base: base, path: "/Users/me/mock ups/index.html", host: nil))
        let loader = HTMLPreviewLoader(target: FilePreviewTarget(path: "/Users/me/mock ups/index.html", host: nil),
                                       url: page, token: "marina-phone-token")
        defer { loader.teardown() }

        try await waitUntil { loader.phase == .loaded }
        try await waitUntil { server.requests.contains { $0.path.hasSuffix("/missing.html") } }
        let frames = server.requests.filter { $0.path.hasSuffix("/01-inbox-lines.html") }
        XCTAssertEqual(frames.count, 1, "the relative frame went to \(server.requests.map(\.path))")
        XCTAssertEqual(frames.first?.status, 200, "the frame was refused: \(frames)")
        XCTAssertEqual(frames.first?.path, "/api/v1/file-raw/local/Users/me/mock%20ups/01-inbox-lines.html")
        XCTAssertEqual(loader.phase, .loaded, "a refused frame failed the whole preview")
        // Outside the document's folder the cookie is not sent.
        try await waitUntil { server.requests.contains { $0.path.hasSuffix("/secret.html") } }
        XCTAssertEqual(server.requests.first { $0.path.hasSuffix("/secret.html") }?.status, 401)

        let frameText = try await loader.webView.evaluateJavaScript(
            "document.getElementById('f').contentDocument ? document.getElementById('f').contentDocument.body.innerText : 'cross'")
        XCTAssertEqual(frameText as? String, "frame ok")
    }

    @MainActor
    func testADocumentRefusalIsRetryableAndNeverSaysPair() async throws {
        let server = try SignInCheckingServer(token: "marina-phone-token")
        defer { server.stop() }
        let port = try await server.start()
        let base = URL(string: "http://127.0.0.1:\(port)")!
        let page = try XCTUnwrap(WalnutAPI.rawFilePathURL(base: base, path: "/Users/me/mock ups/index.html", host: nil))
        let loader = HTMLPreviewLoader(target: FilePreviewTarget(path: "/Users/me/mock ups/index.html", host: nil),
                                       url: page, token: "stale-token")
        defer { loader.teardown() }
        try await waitUntil { if case .failed = loader.phase { return true } else { return false } }
        guard case .failed(let failure) = loader.phase else { return XCTFail() }
        XCTAssertEqual(failure.kind, .signInRefused)
        XCTAssertTrue(failure.isRetryable)
    }

    /// A server that does not know the path shape answers 404: the preview asks
    /// the query shape once and shows the page.
    @MainActor
    func testAServerWithoutThePathShapeFallsBackToTheQueryShape() async throws {
        let server = try SignInCheckingServer(token: "marina-phone-token", pathShape: false)
        defer { server.stop() }
        let port = try await server.start()
        let base = URL(string: "http://127.0.0.1:\(port)")!
        let page = try XCTUnwrap(WalnutAPI.rawFilePathURL(base: base, path: "/Users/me/mock ups/index.html", host: nil))
        let loader = HTMLPreviewLoader(target: FilePreviewTarget(path: "/Users/me/mock ups/index.html", host: nil),
                                       url: page, token: "marina-phone-token")
        defer { loader.teardown() }
        try await waitUntil { loader.phase == .loaded }
        XCTAssertEqual(server.requests.map(\.status).prefix(2), [404, 200])
        XCTAssertEqual(server.requests.dropFirst().first?.path, "/api/v1/file-content")
        XCTAssertEqual(loader.currentURL, loader.fallbackURL)

        // A Try Again starts from the path shape again (a file missing a moment
        // ago on a server that has it comes back with its frames), then falls back.
        let before = server.requests.count
        loader.reload()
        try await waitUntil { server.requests.count >= before + 2 && loader.phase == .loaded }
        XCTAssertTrue(server.requests[before].path.hasPrefix("/api/v1/file-raw/"), "\(server.requests.map(\.path))")
    }

    /// An older companion's 302 from the path shape to the query shape is
    /// followed, and the page shows (it used to be cancelled, silently).
    @MainActor
    func testAnOlderCompanionsRedirectShowsThePage() async throws {
        let server = try SignInCheckingServer(token: "marina-phone-token", pathShape: false, redirect: true)
        defer { server.stop() }
        let port = try await server.start()
        let base = URL(string: "http://127.0.0.1:\(port)")!
        let page = try XCTUnwrap(WalnutAPI.rawFilePathURL(base: base, path: "/Users/me/mock ups/index.html", host: nil))
        let loader = HTMLPreviewLoader(target: FilePreviewTarget(path: "/Users/me/mock ups/index.html", host: nil),
                                       url: page, token: "marina-phone-token")
        defer { loader.teardown() }
        try await waitUntil { loader.phase == .loaded }
        XCTAssertEqual(server.requests.prefix(2).map(\.status), [302, 200])
    }

    /// A Try Again after a re-pair signs in with the new token.
    @MainActor
    func testATryAgainSignsInWithTheCurrentToken() async throws {
        let server = try SignInCheckingServer(token: "marina-phone-token")
        defer { server.stop() }
        let port = try await server.start()
        let base = URL(string: "http://127.0.0.1:\(port)")!
        let page = try XCTUnwrap(WalnutAPI.rawFilePathURL(base: base, path: "/Users/me/mock ups/index.html", host: nil))
        let loader = HTMLPreviewLoader(target: FilePreviewTarget(path: "/Users/me/mock ups/index.html", host: nil),
                                       url: page, token: "old-token")
        defer { loader.teardown() }
        try await waitUntil { if case .failed = loader.phase { return true } else { return false } }
        loader.reload(token: "marina-phone-token")
        try await waitUntil { loader.phase == .loaded }
    }

    @MainActor
    private func waitUntil(timeout: TimeInterval = 15, _ condition: () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition() {
            if Date() > deadline {
                XCTFail("timed out waiting")
                throw CancellationError()
            }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
    }
}

/// A loopback HTTP server shaped like Walnut's file-raw route: the document
/// needs the Bearer header, every other file the cookie (a frame carries no
/// header), and `missing.html` is a 404. The query shape (when `pathShape` is
/// false) answers the document, and a `redirect` server answers the path shape
/// with an older companion's form-encoded 302 to it.
private final class SignInCheckingServer: @unchecked Sendable {
    struct Seen { let path: String; let status: Int }

    private let token: String
    private let pathShape: Bool
    private let listener: NWListener
    private let queue = DispatchQueue(label: "sign-in-checking-server")
    private let lock = NSLock()
    private var seen: [Seen] = []

    var requests: [Seen] { lock.lock(); defer { lock.unlock() }; return seen }

    private let redirect: Bool

    init(token: String, pathShape: Bool = true, redirect: Bool = false) throws {
        self.token = token
        self.pathShape = pathShape
        self.redirect = redirect
        let params = NWParameters.tcp
        params.requiredLocalEndpoint = NWEndpoint.hostPort(host: "127.0.0.1", port: .any)
        listener = try NWListener(using: params)
    }

    func start() async throws -> UInt16 {
        listener.newConnectionHandler = { [weak self] connection in self?.serve(connection) }
        return try await withCheckedThrowingContinuation { continuation in
            var resumed = false
            listener.stateUpdateHandler = { [listener] state in
                guard !resumed else { return }
                switch state {
                case .ready:
                    resumed = true
                    continuation.resume(returning: listener.port?.rawValue ?? 0)
                case .failed(let error):
                    resumed = true
                    continuation.resume(throwing: error)
                default: break
                }
            }
            listener.start(queue: queue)
        }
    }

    func stop() { listener.cancel() }

    private func serve(_ connection: NWConnection) {
        connection.start(queue: queue)
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { [weak self] data, _, _, _ in
            guard let self, let data, let head = String(data: data, encoding: .utf8) else { connection.cancel(); return }
            let lines = head.components(separatedBy: "\r\n")
            let parts = (lines.first ?? "").split(separator: " ")
            let target = parts.count > 1 ? String(parts[1]) : "/"
            let path = target.split(separator: "?", maxSplits: 1).first.map(String.init) ?? target
            func header(_ name: String) -> String? {
                lines.first { $0.lowercased().hasPrefix(name.lowercased() + ":") }
                    .map { String($0.dropFirst(name.count + 1)).trimmingCharacters(in: .whitespaces) }
            }
            let bearer = header("Authorization") == "Bearer \(self.token)"
            let cookie = (header("Cookie") ?? "").split(separator: ";").contains {
                $0.trimmingCharacters(in: .whitespaces) == "walnut_device=\(self.token)"
            }
            var (status, body): (Int, String) = (0, "")
            var location: String?
            let page = "<!doctype html><html><body><h1>page</h1><iframe id=\"f\" src=\"01-inbox-lines.html\"></iframe><iframe src=\"missing.html\"></iframe><iframe src=\"../elsewhere/secret.html\"></iframe></body></html>"
            if self.redirect, path.hasPrefix("/api/v1/file-raw/local/") {
                // What an older companion answers: URLSearchParams, `+` for a space, no host.
                let file = "/" + String(path.dropFirst("/api/v1/file-raw/local/".count)).removingPercentEncoding!
                var form = CharacterSet.alphanumerics
                form.insert(charactersIn: "-._*")
                let encoded = file.addingPercentEncoding(withAllowedCharacters: form.union([" "]))!
                    .replacingOccurrences(of: " ", with: "+")
                (status, body) = (302, "")
                location = "/api/file-content?path=\(encoded)&raw=1"
            } else if !self.pathShape, path == "/api/file-content" || path == "/api/v1/file-content", target.contains("raw=1") {
                (status, body) = bearer ? (200, page) : (401, "{\"error\":\"unauthorized\"}")
            } else if !path.hasPrefix("/api/v1/file-raw/") || !self.pathShape {
                (status, body) = (404, "not found")
            } else if path.hasSuffix("/missing.html") {
                (status, body) = (404, "File not found")
            } else if path.hasSuffix("/index.html") {
                // The header alone: proves the app signs the document in itself.
                (status, body) = bearer ? (200, page) : (401, "{\"error\":\"unauthorized\"}")
            } else {
                (status, body) = cookie ? (200, "<!doctype html><html><body>frame ok</body></html>") : (401, "{\"error\":\"unauthorized\"}")
            }
            self.lock.lock(); self.seen.append(Seen(path: path, status: status)); self.lock.unlock()
            let bytes = Data(body.utf8)
            let extra = location.map { "Location: \($0)\r\n" } ?? ""
            let response = "HTTP/1.1 \(status) X\r\nContent-Type: text/html; charset=utf-8\r\n\(extra)Content-Length: \(bytes.count)\r\nConnection: close\r\n\r\n"
            connection.send(content: Data(response.utf8) + bytes, completion: .contentProcessed { _ in connection.cancel() })
        }
    }
}

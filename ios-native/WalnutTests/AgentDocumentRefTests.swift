import WebKit
import XCTest
@testable import Walnut

final class AgentDocumentRefTests: XCTestCase {
    private let server = URL(string: "https://walnut.example.test")!

    private func ref(_ query: String, base: String = "https://walnut.example.test/open-ref") -> URL {
        URL(string: base + "?" + query)!
    }

    // MARK: - Parser

    func testFileReferenceKeepsDecodedPathAndLineRange() {
        let url = ref("kind=file&path=%2Ftmp%2FOutput%20File.ts&line=10&endLine=20")
        let expected = FilePathRef(path: "/tmp/Output File.ts", line: 10, endLine: 20)
        XCTAssertEqual(AgentDocumentRef.parse(url, server: server), .file(expected))
        XCTAssertEqual(AgentDocumentRef.appURL(for: url, server: server), FilePreviewLink.url(for: expected))
        let opened = AgentDocumentRef.appURL(for: url, server: server).flatMap(FilePreviewLink.reference(from:))
        XCTAssertEqual(opened?.path, "/tmp/Output File.ts")
        XCTAssertEqual(opened?.line, 10)
        XCTAssertEqual(opened?.endLine, 20)
    }

    func testQueryDecodesAsURLSearchParams() {
        XCTAssertEqual(AgentDocumentRef.parse(ref("kind=file&path=/tmp/a+b.ts"), server: server),
                       .file(FilePathRef(path: "/tmp/a b.ts")))
        XCTAssertEqual(AgentDocumentRef.parse(ref("kind=file&path=/tmp/c%2B%2B.ts"), server: server),
                       .file(FilePathRef(path: "/tmp/c++.ts")))
        // The web's token form puts its parameters in the fragment.
        let fragment = URL(string: "https://walnut.example.test/open-ref#kind=task&id=mvu0ubnq-a02d&token=t")!
        XCTAssertEqual(AgentDocumentRef.parse(fragment, server: server), .task("mvu0ubnq-a02d"))
    }

    func testHomeRelativePathRoundTripsThroughTheFileLink() {
        let url = ref("kind=file&path=~%2Fnotes%2Fa.md")
        XCTAssertEqual(AgentDocumentRef.parse(url, server: server), .file(FilePathRef(path: "~/notes/a.md")))
        let opened = AgentDocumentRef.appURL(for: url, server: server).flatMap(FilePreviewLink.reference(from:))
        XCTAssertEqual(opened?.path, "~/notes/a.md")
    }

    func testLinePositionsMustBePositiveDigitsAndARangeMustGrow() {
        for bad in ["0", "-3", "1e3", "abc", "", "1.5", "99999999999"] {
            XCTAssertEqual(AgentDocumentRef.parse(ref("kind=file&path=/a/b.ts&line=\(bad)"), server: server),
                           .file(FilePathRef(path: "/a/b.ts")), "line=\(bad)")
        }
        XCTAssertEqual(AgentDocumentRef.parse(ref("kind=file&path=/a/b.ts&line=9&endLine=9"), server: server),
                       .file(FilePathRef(path: "/a/b.ts", line: 9)))
        XCTAssertEqual(AgentDocumentRef.parse(ref("kind=file&path=/a/b.ts&line=9&endLine=3"), server: server),
                       .file(FilePathRef(path: "/a/b.ts", line: 9)))
        XCTAssertEqual(AgentDocumentRef.parse(ref("kind=file&path=/a/b.ts&endLine=30"), server: server),
                       .file(FilePathRef(path: "/a/b.ts")))
    }

    func testUnsafePathsAreRefused() {
        let unsafe = [
            "/tmp/../private.txt", "/tmp/..", "/tmp/..%5Cx", "%2F%2Fexample.com%2Ffile", "relative/file.ts",
            "~user/x", "/tmp/a%00.txt", "/tmp/a%0A.txt", "/tmp/a%7F.txt", "",
            "/" + String(repeating: "a", count: AgentDocumentRef.maxPathLength),
        ]
        for path in unsafe {
            XCTAssertNil(AgentDocumentRef.parse(ref("kind=file&path=\(path)"), server: server), path)
        }
        XCTAssertNil(AgentDocumentRef.parse(ref("kind=file"), server: server))
        XCTAssertNotNil(AgentDocumentRef.parse(ref("kind=file&path=/tmp/mod..old/thing.ts"), server: server),
                        "a `..` inside a name is not a traversal segment")
    }

    func testOnlyThisServersOwnRouteParses() {
        let others = [
            "https://evil.example.test/open-ref", "http://walnut.example.test/open-ref",
            "https://walnut.example.test:8443/open-ref", "https://user:pw@walnut.example.test/open-ref",
            "https://walnut.example.test/open-ref/", "https://walnut.example.test/x/open-ref",
            "https://walnut.example.test/open-refs", "walnut-file://walnut.example.test/open-ref",
        ]
        for base in others {
            XCTAssertNil(AgentDocumentRef.parse(ref("kind=task&id=mvu0ubnq-a02d", base: base), server: server), base)
        }
        for base in ["https://WALNUT.example.test/open-ref", "https://walnut.example.test:443/open-ref"] {
            XCTAssertEqual(AgentDocumentRef.parse(ref("kind=task&id=mvu0ubnq-a02d", base: base), server: server),
                           .task("mvu0ubnq-a02d"), base)
        }
        XCTAssertNil(AgentDocumentRef.parse(ref("kind=task&id=mvu0ubnq-a02d"), server: nil), "unpaired")
        let prefixed = URL(string: "https://walnut.example.test/walnut")!
        XCTAssertEqual(AgentDocumentRef.parse(ref("kind=task&id=mvu0ubnq-a02d",
                                                  base: "https://walnut.example.test/walnut/open-ref"), server: prefixed),
                       .task("mvu0ubnq-a02d"))
    }

    func testTaskAndLetterIdsAreWholeIdsAndOtherKindsAreRefused() {
        XCTAssertEqual(AgentDocumentRef.appURL(for: ref("kind=task&id=mvu0ubnq-a02d"), server: server),
                       TaskMentionLink.url(for: "mvu0ubnq-a02d"))
        let letter = AgentDocumentRef.appURL(for: ref("kind=letter&id=lt-m9x2k1-a4f7"), server: server)
        XCTAssertEqual(letter, LetterMentionLink.url(for: "lt-m9x2k1-a4f7"))
        XCTAssertEqual(letter.flatMap(LetterMentionLink.letterID(from:)), "lt-m9x2k1-a4f7")
        for query in [
            "kind=task&id=mvu0ubnq", "kind=task&id=../x", "kind=letter&id=not-a-letter", "kind=letter",
            "kind=session&id=abc", "kind=command&id=run", "id=mvu0ubnq-a02d",
        ] {
            XCTAssertNil(AgentDocumentRef.parse(ref(query), server: server), query)
        }
    }

    // MARK: - Navigation

    private func decide(_ url: URL?, _ type: WKNavigationType, mainFrame: Bool? = true) -> LetterHTMLNavigation.Decision {
        LetterHTMLNavigation.decide(url: url, navigationType: type, targetIsMainFrame: mainFrame, server: server)
    }

    func testATappedReferenceOpensInTheApp() {
        let url = ref("kind=task&id=mvu0ubnq-a02d")
        XCTAssertEqual(decide(url, .linkActivated), .openInApp(TaskMentionLink.url(for: "mvu0ubnq-a02d")!))
        // `<base target="_blank">` in the server frame: a tap with no target frame.
        XCTAssertEqual(decide(url, .linkActivated, mainFrame: nil), .openInApp(TaskMentionLink.url(for: "mvu0ubnq-a02d")!))
        XCTAssertEqual(decide(ref("kind=file&path=/tmp/../x"), .linkActivated), .cancel, "never Safari for our route")
    }

    func testSyntheticNavigationsNeverOpenAReference() {
        let url = ref("kind=file&path=/tmp/report.html")
        // `.other` is what a meta refresh is.
        for type: WKNavigationType in [.other, .formSubmitted, .formResubmitted, .reload, .backForward] {
            XCTAssertEqual(decide(url, type), .cancel, "type \(type.rawValue)")
            XCTAssertEqual(decide(URL(string: "https://example.com/")!, type), .cancel, "type \(type.rawValue)")
        }
    }

    func testOtherLinksKeepTheirOldRules() {
        let web = URL(string: "https://example.com/page")!
        XCTAssertEqual(decide(web, .linkActivated), .openInSafari(web))
        let foreign = URL(string: "https://evil.example.test/open-ref?kind=task&id=mvu0ubnq-a02d")!
        XCTAssertEqual(decide(foreign, .linkActivated), .openInSafari(foreign))
        XCTAssertEqual(decide(URL(string: "javascript:alert(1)"), .linkActivated), .cancel)
        XCTAssertEqual(decide(URL(string: "walnut-file://preview/tmp/a.ts"), .linkActivated), .cancel)
        XCTAssertEqual(decide(nil, .other), .allow)
        XCTAssertEqual(decide(URL(string: "about:blank"), .other), .allow)
        XCTAssertEqual(decide(URL(fileURLWithPath: "/tmp/letter.html"), .other), .allow)
        XCTAssertEqual(decide(web, .other, mainFrame: false), .allow)
    }

    // MARK: - Body route

    func testRoutedURLAsksForTheFramedLinkedDocumentAndKeepsTheTurn() throws {
        let url = URL(string: "https://walnut.example.test/api/v1/human-inbox/lt-m9x2k1-a4f7/body?turn=2")!
        let routed = LetterBodyDownload.routedURL(LetterBodyDownload.routedURL(url, server: nil), server: nil)
        let items = try XCTUnwrap(URLComponents(url: routed, resolvingAgainstBaseURL: false)?.queryItems)
        XCTAssertEqual(items, [
            URLQueryItem(name: "turn", value: "2"), URLQueryItem(name: "frame", value: "1"), URLQueryItem(name: "refs", value: "1"),
        ])
        XCTAssertEqual(routed.path, url.path)
    }

    func testRefBaseNamesThePairedHTTPSServerNotTheBodyOrigin() throws {
        let body = URL(string: "http://127.0.0.1:3456/api/v1/human-inbox/lt-m9x2k1-a4f7/body?turn=1&ref_base=https://evil.example.test/open-ref")!
        let paired = URL(string: "https://me:pw@walnut.example.test/walnut/?x=1#y")!
        let routed = LetterBodyDownload.routedURL(LetterBodyDownload.routedURL(body, server: paired), server: paired)
        let items = try XCTUnwrap(URLComponents(url: routed, resolvingAgainstBaseURL: false)?.queryItems)
        XCTAssertEqual(items, [
            URLQueryItem(name: "turn", value: "1"), URLQueryItem(name: "frame", value: "1"), URLQueryItem(name: "refs", value: "1"),
            URLQueryItem(name: "ref_base", value: "https://walnut.example.test/walnut/open-ref"),
        ])
        let base = try XCTUnwrap(items.last?.value)
        XCTAssertEqual(AgentDocumentRef.parse(ref("kind=task&id=mvu0ubnq-a02d", base: base),
                                              server: URL(string: "https://walnut.example.test/walnut")!),
                       .task("mvu0ubnq-a02d"))
        XCTAssertEqual(AgentDocumentRef.parse(ref("kind=letter&id=lt-m9x2k1-a4f7", base: base), server: paired),
                       .letter("lt-m9x2k1-a4f7"))
        XCTAssertNil(AgentDocumentRef.parse(ref("kind=task&id=mvu0ubnq-a02d", base: "http://127.0.0.1:3456/open-ref"),
                                            server: paired), "the body's own origin is not the paired server")
    }

    func testRefBaseIsOnlyAnHTTPServer() {
        XCTAssertEqual(LetterBodyDownload.refBase(for: URL(string: "http://192.168.1.5:3456")!), "http://192.168.1.5:3456/open-ref")
        XCTAssertNil(LetterBodyDownload.refBase(for: nil))
        XCTAssertNil(LetterBodyDownload.refBase(for: URL(string: "walnut-file://preview/tmp")!))
        let routed = LetterBodyDownload.routedURL(URL(string: "https://h.example.test/body?ref_base=x")!, server: nil)
        XCTAssertFalse(routed.absoluteString.contains("ref_base"), "a stale base is dropped, none added unpaired")
    }

    func testEveryHTMLDocumentHasItsBodyRoute() throws {
        let json = """
        {"id":"lt-m9x2k1-a4f7","subject":"s","type":"info","bodyFormat":"html","body":"<p>a</p>",
         "thread":[
          {"from":"agent","bodyFormat":"html","bodyFile":"t0.html","body":"<p>x</p>","at":1},
          {"from":"human","text":"ok","at":2},
          {"from":"agent","bodyFormat":"html","bodyFile":"t2.html","at":3,"bodyDeferred":true,
           "bodyUrl":"/api/v1/human-inbox/lt-m9x2k1-a4f7/body?turn=2"},
          {"from":"agent","bodyFormat":"html","bodyFile":"t3.html","at":4,"bodyUrl":"//evil.example.test/x"}
         ]}
        """
        let letter = try JSONDecoder().decode(Letter.self, from: Data(json.utf8))
        let base = "https://walnut.example.test/api/v1/human-inbox/lt-m9x2k1-a4f7/body"
        XCTAssertEqual(letter.bodyRouteURL(server: server)?.absoluteString, base)
        let turns = letter.threadEntries.map { letter.turnBodyRouteURL($0, server: server)?.absoluteString }
        XCTAssertEqual(turns, [base + "?turn=0", base + "?turn=1", base + "?turn=2", base + "?turn=3"])
        XCTAssertNil(letter.bodyRouteURL(server: nil))
    }

    // MARK: - The phone frame over the server frame

    private func assembled(_ peek: String) -> String {
        String(decoding: LetterBodyDownload.assembledHead(peek: Data(peek.utf8)), as: UTF8.self)
    }

    private func count(_ needle: String, in text: String) -> Int {
        text.components(separatedBy: needle).count - 1
    }

    func testARawBodyKeepsThePhoneFrameAsBefore() {
        let doc = assembled("<p>Hi</p>")
        XCTAssertEqual(doc, LetterHTMLBody.documentPieces().prelude + "<p>Hi</p>")
        XCTAssertEqual(LetterHTMLBody.document(wrapping: "<p>Hi</p>"),
                       LetterHTMLBody.documentPieces().prelude + "<p>Hi</p>" + LetterHTMLBody.documentPieces().suffix)
    }

    func testAServerFramedBodyGetsThePhoneStyleOnceAfterTheFrameReset() throws {
        let framed = #"<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'"><meta name="referrer" content="no-referrer"><base target="_blank"><style>body { padding: 4px; }</style></head><body><p>Hi</p>"#
        let doc = assembled(framed)
        XCTAssertTrue(doc.hasPrefix(LetterHTMLBody.documentPieces(styled: false).prelude), "the phone's CSP stays first, in its head")
        XCTAssertTrue(LetterHTMLBody.documentPieces(styled: false).prelude.contains("default-src 'none'"))
        XCTAssertTrue(LetterHTMLBody.documentPieces(styled: false).prelude.contains("base-uri 'none'"))
        XCTAssertEqual(count(LetterHTMLBody.phoneStyle, in: doc), 1)
        let reset = try XCTUnwrap(doc.range(of: "body { padding: 4px; }</style>"))
        let phone = try XCTUnwrap(doc.range(of: LetterHTMLBody.phoneStyle))
        let agent = try XCTUnwrap(doc.range(of: "<p>Hi</p>"))
        XCTAssertTrue(reset.upperBound <= phone.lowerBound && phone.upperBound <= agent.lowerBound)
    }

    func testTheAgentsOwnStylesStillComeAfterThePhoneStyle() throws {
        let framed = #"<!doctype html><html lang="en"><head><meta name="referrer" content="no-referrer"><base target="_blank"><style>r</style><style>h1 { color: red }</style></head><body>"#
        let doc = assembled(framed)
        let phone = try XCTUnwrap(doc.range(of: LetterHTMLBody.phoneStyle))
        let agent = try XCTUnwrap(doc.range(of: "h1 { color: red }"))
        XCTAssertTrue(phone.upperBound <= agent.lowerBound)
        XCTAssertNil(LetterHTMLBody.serverFrameStyleEnd(in: Data(#"<base target="_blank"><style>never closed"#.utf8)))
    }

    // MARK: - Source guards

    private func source(_ path: String) throws -> String {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        return try String(contentsOf: root.appendingPathComponent(path), encoding: .utf8)
    }

    func testReaderAndThreadReadHTMLThroughTheBodyRoute() throws {
        for file in ["Walnut/Views/Inbox/LetterReaderView.swift", "Walnut/Views/Inbox/LetterThreadView.swift"] {
            let text = try source(file)
            XCTAssertFalse(text.contains("LetterHTMLBody("), "\(file) renders HTML around its body route")
            XCTAssertFalse(text.contains("fetchDocument("), "\(file) downloads a body around LetterRoutedHTMLBody")
            XCTAssertTrue(text.contains("LetterRoutedHTMLBody("), file)
        }
        let thread = try source("Walnut/Views/Inbox/LetterThreadView.swift")
        XCTAssertEqual(count("turnBodyRouteURL(entry)", in: thread), 2, "the inline and the deferred HTML turn")
        XCTAssertTrue(try source("Walnut/Views/Inbox/LetterRoutedHTMLBody.swift").contains("refs: true"))
        let body = try source("Walnut/Views/Inbox/LetterHTMLBody.swift")
        XCTAssertTrue(body.contains("LetterHTMLNavigation.decide("))
        XCTAssertEqual(count("UIApplication.shared.open(", in: body), 1, "Safari only through the decision")
    }
}

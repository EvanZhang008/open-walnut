import XCTest
@testable import Walnut

/// Sees the real /files/locate request ClickedPath builds and answers with a scripted body.
private final class LocateProbe: URLProtocol {
    static var requests: [URLRequest] = []
    static var body = "{}"
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "locate-probe.test" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.requests.append(request)
        let reply = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil,
                                    headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: reply, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(Self.body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

/// A tapped path opens from the host that has it (ClickedPath, GET /v1/files/locate).
final class ClickedPathTests: XCTestCase {
    private var savedURL: URL?
    private var savedToken: String?

    override func setUp() {
        savedURL = AppConfig.processServerURLOverride
        savedToken = AppConfig.processTokenOverride
        AppConfig.processServerURLOverride = URL(string: "http://locate-probe.test")
        AppConfig.processTokenOverride = "probe-token"
        LocateProbe.requests = []
    }

    override func tearDown() {
        AppConfig.processServerURLOverride = savedURL
        AppConfig.processTokenOverride = savedToken
    }

    private func tap(host: String?, sourceOnly: Bool, anywhere: Bool = false, taskID: String? = nil,
                     answer: String) async -> (ClickedPathRoute, [String: String]) {
        LocateProbe.body = answer
        let route = await ClickedPath.locate(FilePathRef(path: mac), host: host, cwd: anywhere ? nil : "/w",
                                             sessionID: anywhere ? nil : "s1", sourceOnly: sourceOnly,
                                             anywhere: anywhere, taskID: taskID,
                                             api: WalnutAPI(protocolClasses: [LocateProbe.self]))
        let items = LocateProbe.requests.last?.url.flatMap { URLComponents(url: $0, resolvingAgainstBaseURL: false) }?
            .queryItems ?? []
        return (route, Dictionary(items.map { ($0.name, $0.value ?? "") }, uniquingKeysWith: { a, _ in a }))
    }

    func testViewerKeepsItsChildAccessibilityIdentifiers() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        let file = root.appendingPathComponent("Walnut/Views/Sessions/SessionFilesSheet.swift")
        let source = try String(contentsOf: file, encoding: .utf8)
        XCTAssertTrue(source.contains(".accessibilityElement(children: .contain)\n                .accessibilityIdentifier(\"session.files.viewer\")"))
        XCTAssertTrue(source.contains("VStack(spacing: 0) {\n                    if let missingNote {"))
        XCTAssertTrue(source.contains("Text(missingNote)\n                                .accessibilityIdentifier(\"session.files.viewer.missing\")"))
    }

    /// The writer is not known: every machine is asked, the task's first, and the file opens from
    /// the one that has it; the person is never asked to pick (2026-11-23).
    func testAnUnknownWriterAsksEveryMachineAndOpensFromTheOneThatHasIt() async {
        let (route, query) = await tap(host: nil, sourceOnly: false, anywhere: true, taskID: "mtask001-0a0a",
                                       answer: #"{"path":"\#(mac)","host":"spare","hostName":"Spare","found":true,"elsewhere":true,"via":"anywhere"}"#)
        XCTAssertEqual(query["anywhere"], "1")
        XCTAssertEqual(query["taskId"], "mtask001-0a0a")
        XCTAssertNil(query["host"])
        XCTAssertNil(query["sourceOnly"])
        guard case .text(let target) = route else { return XCTFail("text") }
        XCTAssertEqual(target.host, "spare")
        XCTAssertEqual(target.hostNote, "Opened from Spare.")
        XCTAssertNil(target.missing)
    }

    func testAnywhereIsSentOnlyWithNoMachineNamed() async {
        let (_, named) = await tap(host: "devbox", sourceOnly: false, anywhere: true, taskID: "mtask001-0a0a",
                                   answer: #"{"path":"\#(mac)","host":"devbox","found":true}"#)
        XCTAssertNil(named["anywhere"], "a named machine is asked first, as before")
        XCTAssertNil(named["taskId"])
        let (_, alone) = await tap(host: nil, sourceOnly: true, anywhere: true,
                                   answer: #"{"path":"\#(mac)","found":true}"#)
        XCTAssertNil(alone["anywhere"])
    }

    func testAnUnknownWritersMissNamesWhoDidNotAnswer() async {
        let (route, _) = await tap(host: nil, sourceOnly: false, anywhere: true,
                                   answer: #"{"path":"\#(mac)","found":false,"missing":true,"checked":["Local"],"unreachable":["home-pc"]}"#)
        guard case .text(let target) = route else { return XCTFail("text") }
        XCTAssertEqual(target.missing, "Couldn't find \(mac) on your Mac. home-pc did not answer, so the file may be there.")
        XCTAssertNil(target.host)
    }

    func testAnUnknownWriterWithNoAnswerReadsNoMachine() async {
        let (route, _) = await tap(host: nil, sourceOnly: false, anywhere: true, answer: #"{"path":"\#(mac)","found":false}"#)
        guard case .text(let target) = route else { return XCTFail("text") }
        XCTAssertEqual(target.missing, "Couldn't look for \(mac): no machine could be asked.", "never the primary read by guess")
    }

    func testAKnownSourceAsksTheServerForItsOwnMachineOnly() async {
        let (_, query) = await tap(host: "devbox", sourceOnly: true,
                                   answer: #"{"path":"\#(mac)","host":"devbox","found":true}"#)
        XCTAssertEqual(query["sourceOnly"], "1")
        XCTAssertEqual(query["host"], "devbox")
        XCTAssertEqual(LocateProbe.requests.last?.url?.path, "/api/v1/files/locate")
    }

    func testAnUnknownSourceKeepsTheAllMachinesLookup() async {
        let (route, query) = await tap(host: "devbox", sourceOnly: false,
                                       answer: #"{"path":"\#(mac)","host":"spare","hostName":"Spare","found":true,"elsewhere":true}"#)
        XCTAssertNil(query["sourceOnly"])
        guard case .text(let target) = route else { return XCTFail("text") }
        XCTAssertEqual(target.host, "spare")
        XCTAssertNil(target.missing)
    }

    func testAnOlderServerAnsweringFromAnotherHostIsNotOpened() async {
        let (route, _) = await tap(host: "devbox", sourceOnly: true,
                                   answer: #"{"path":"\#(mac)","host":"spare","hostName":"Spare","found":true,"elsewhere":true,"via":"other-host"}"#)
        guard case .text(let target) = route else { return XCTFail("a refused stand-in shows the missing line") }
        XCTAssertEqual(target.missing, "Couldn't find \(mac) on devbox.")
        XCTAssertEqual(target.host, "devbox")
        XCTAssertNil(target.hostNote)
    }

    func testAnOlderServerAnswerFromTheMacIsNotOpenedForARemoteSource() async {
        let (route, _) = await tap(host: "devbox", sourceOnly: true,
                                   answer: #"{"path":"\#(mac)","found":true,"elsewhere":true,"via":"other-host"}"#)
        guard case .text(let target) = route else { return XCTFail("text") }
        XCTAssertNotNil(target.missing)
        XCTAssertEqual(target.host, "devbox")
    }

    func testAnAnswerFromAnotherHostIsRefusedEvenWithoutTheElsewhereFlag() async {
        let (route, _) = await tap(host: nil, sourceOnly: true,
                                   answer: #"{"path":"\#(mac)","host":"spare","found":true}"#)
        guard case .text(let target) = route else { return XCTFail("text") }
        XCTAssertEqual(target.missing, "Couldn't find \(mac) on your Mac.")
        XCTAssertNil(target.host)
    }

    func testThePrimaryNamedAnyWayAcceptsItsOwnAnswer() async {
        let (route, _) = await tap(host: "local", sourceOnly: true, answer: #"{"path":"\#(mac)","host":"__local__","found":true}"#)
        guard case .text(let target) = route else { return XCTFail("text") }
        XCTAssertNil(target.missing)
    }

    private let mac = "/Users/someone/.local/state/open-walnut/tasks/t1/video/fix.mp4"

    private func location(_ json: String) throws -> PathLocation {
        try JSONDecoder().decode(PathLocation.self, from: Data(json.utf8))
    }

    func testAMacPathInALinuxSessionOpensFromTheMac() throws {
        let loc = try location(#"{"path":"\#(mac)","found":true,"elsewhere":true,"hostName":"Local","via":"other-host"}"#)
        guard case .text(let target) = ClickedPath.route(FilePathRef(path: mac), location: loc,
                                                         host: "devbox", cwd: "/home/someone/work", sessionID: "s1") else {
            return XCTFail("an mp4 opens in the file viewer")
        }
        XCTAssertNil(target.host, "nil host = the primary, the Mac")
        XCTAssertEqual(target.ref.path, mac)
        XCTAssertEqual(target.hostNote, "Opened from your Mac.")
        XCTAssertNil(target.cwd, "the session's cwd is on its own host, not the Mac")
        XCTAssertNil(target.sessionID)
        XCTAssertNil(target.missing)
    }

    func testAPathOnTheSessionHostKeepsItsContext() throws {
        let loc = try location(#"{"path":"/home/someone/work/a.ts","host":"devbox","found":true,"via":"exact","line":9}"#)
        guard case .text(let target) = ClickedPath.route(FilePathRef(path: "/home/someone/work/a.ts"), location: loc,
                                                         host: "devbox", cwd: "/home/someone/work", sessionID: "s1") else {
            return XCTFail("text")
        }
        XCTAssertEqual(target.host, "devbox")
        XCTAssertEqual(target.cwd, "/home/someone/work")
        XCTAssertEqual(target.sessionID, "s1")
        XCTAssertEqual(target.ref.line, 9)
        XCTAssertNil(target.hostNote)
    }

    func testAnotherRemoteHostIsNamed() throws {
        let loc = try location(#"{"path":"/home/someone/x.html","host":"spare","hostName":"Spare box","found":true,"elsewhere":true}"#)
        XCTAssertEqual(ClickedPath.route(FilePathRef(path: "/home/someone/x.html"), location: loc,
                                         host: nil, cwd: nil, sessionID: nil),
                       .html(FilePreviewTarget(path: "/home/someone/x.html", host: "spare")))
    }

    func testAPathNoHostHasSaysSoPlainly() throws {
        let loc = try location(#"{"path":"\#(mac)","host":"devbox","found":false,"missing":true,"checked":["Dev box","Local","Spare"]}"#)
        guard case .text(let target) = ClickedPath.route(FilePathRef(path: mac), location: loc,
                                                         host: "devbox", cwd: nil, sessionID: nil) else {
            return XCTFail("missing opens the viewer with its line")
        }
        XCTAssertEqual(target.missing, "Couldn't find \(mac) on Dev box, your Mac or Spare.")
        XCTAssertEqual(target.host, "devbox")
    }

    func testAMissingFolderIsNotRoutedToTheFolderSheet() {
        let route = ClickedPath.route(FilePathRef(path: "/Users/someone/gone"), host: nil, cwd: nil, sessionID: nil,
                                      missing: "Couldn't find /Users/someone/gone on your Mac.")
        guard case .text = route else { return XCTFail("a missing path shows its line, never a folder listing") }
    }

    func testAHostThatCannotAnswerOpensOnTheSessionHostAsBefore() throws {
        let loc = try location(#"{"path":"\#(mac)","host":"devbox","found":false}"#)
        guard case .text(let target) = ClickedPath.route(FilePathRef(path: mac), location: loc,
                                                         host: "devbox", cwd: "/w", sessionID: "s1") else {
            return XCTFail("text")
        }
        XCTAssertEqual(target.host, "devbox")
        XCTAssertNil(target.missing)
        XCTAssertNil(target.hostNote)
    }

    func testMissingLineShapes() {
        XCTAssertEqual(ClickedPath.missingLine(path: "/x", checked: ["Local"]), "Couldn't find /x on your Mac.")
        XCTAssertEqual(ClickedPath.missingLine(path: "/x", checked: ["A", "B"]), "Couldn't find /x on A or B.")
        XCTAssertEqual(ClickedPath.missingLine(path: "/x", checked: []), "Couldn't find /x on any of your machines.")
    }

    /// The web's `missingPathLine` (tests/web/never-ask-which-machine.test.ts), with the phone's
    /// name for the primary.
    func testMissingLineShapesForAnEveryMachineLookup() {
        XCTAssertEqual(ClickedPath.missingLine(path: "/a/b", checked: ["Local", "Dev box"], anywhere: true),
                       "Couldn't find /a/b on your Mac or Dev box.")
        XCTAssertEqual(ClickedPath.missingLine(path: "/a/b", checked: ["Local"], anywhere: true, unreachable: ["home-pc"]),
                       "Couldn't find /a/b on your Mac. home-pc did not answer, so the file may be there.")
        XCTAssertEqual(ClickedPath.missingLine(path: "/a/b", checked: [], anywhere: true, unreachable: ["home-pc", "Dev box"]),
                       "Couldn't look for /a/b: home-pc or Dev box did not answer, so the file may be there.")
        XCTAssertEqual(ClickedPath.missingLine(path: "/a/b", checked: [], anywhere: true),
                       "Couldn't look for /a/b: no machine could be asked.")
        XCTAssertEqual(ClickedPath.missingLine(path: "src/a.ts", checked: [], anywhere: true),
                       "Couldn't open src/a.ts: it is a relative path, and Walnut does not know which session's folder it is in.")
        XCTAssertEqual(ClickedPath.missingLine(path: "~/a", checked: ["Spare"], anywhere: true), "Couldn't find ~/a on Spare.")
        // A named machine's miss reads as before.
        XCTAssertEqual(ClickedPath.missingLine(path: "/a/b", checked: ["Dev box"]), "Couldn't find /a/b on Dev box.")
    }
}

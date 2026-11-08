import XCTest
@testable import Walnut

/// The Changed page reads offline: a list and a diff opened before are served
/// from this phone's copy when the server does not answer (the hosted test
/// process reaches a refused port, so every request here fails fast), and the
/// page knows it is a copy. And the wire shapes decode from an older server
/// that sends no line counts.
@MainActor
final class SessionChangesOfflineTests: XCTestCase {
    private let sessionID = "offline-changes-\(UUID().uuidString)"

    override func tearDown() {
        DiskCache.remove(key: SessionChangesModel.listKey(sessionID, .session))
        UserDefaults.standard.removeObject(forKey: SessionChangesModel.compareKey(sessionID))
        super.tearDown()
    }

    func testAListAndADiffOpenedBeforeReadOfflineAsACopy() async throws {
        let file = SessionChangedFile(filePath: "/r/src/a.ts", relPath: "src/a.ts", status: "modified",
                                      additions: 1, deletions: 1)
        let savedAt = Date(timeIntervalSinceNow: -600)
        DiskCache.save(CachedChanges(savedAt: savedAt, response: SessionChangesResponse(
            sessionId: sessionID,
            groups: [SessionChangeGroup(repoRoot: "/r", label: "r", kind: "cwd", files: [file], compare: nil)],
            light: true)), key: SessionChangesModel.listKey(sessionID, .session))
        let full = file.withContent(before: "a\nOLD\n", after: "a\nNEW\n")
        DiskCache.save(CachedFileChange(savedAt: savedAt, file: full),
                       key: SessionChangesModel.fileKey(sessionID, .session, file.filePath))

        let model = SessionChangesModel(sessionId: sessionID)
        await model.load()
        XCTAssertEqual(model.files.map(\.relPath), ["src/a.ts"])
        XCTAssertNotNil(model.offlineCopyFrom, "the page says it shows a copy")
        XCTAssertEqual(model.offlineCopyFrom?.timeIntervalSince1970 ?? 0, savedAt.timeIntervalSince1970, accuracy: 1)
        XCTAssertNil(model.loadError, "a copy on screen is not an error page")

        let read = try await model.content(of: file)
        XCTAssertEqual(read.file.after, "a\nNEW\n")
        XCTAssertNotNil(read.fromCopy)
        DiskCache.remove(key: SessionChangesModel.fileKey(sessionID, .session, file.filePath))
    }

    func testNoCopyAndNoServerIsAnErrorWithNothingInvented() async {
        let model = SessionChangesModel(sessionId: sessionID + "-none")
        await model.load()
        XCTAssertNil(model.list)
        XCTAssertNotNil(model.loadError)
    }

    func testTheComparisonIsRememberedPerSession() async {
        let model = SessionChangesModel(sessionId: sessionID)
        XCTAssertEqual(model.compare, .session)
        await model.setCompare(.branch(ref: "main"))
        XCTAssertEqual(SessionChangesModel(sessionId: sessionID).compare, .branch(ref: "main"))
        XCTAssertEqual(SessionChangesModel(sessionId: sessionID + "-other").compare, .session)
    }

    func testAnOlderServersListDecodesWithoutCounts() throws {
        let json = """
        {"sessionId":"s","fileCount":1,"anyPartial":false,"light":true,
         "groups":[{"repoRoot":"/r","label":"r","kind":"cwd",
           "files":[{"filePath":"/r/a.ts","relPath":"a.ts","before":"","after":"","status":"modified","ops":2,"partial":false}]}]}
        """
        let list = try JSONDecoder().decode(SessionChangesResponse.self, from: Data(json.utf8))
        XCTAssertEqual(list.files.first?.relPath, "a.ts")
        XCTAssertNil(list.files.first?.additions)
        let refs = try JSONDecoder().decode(SessionGitRefs.self, from: Data(#"{"sessionId":"s","repoRoot":null}"#.utf8))
        XCTAssertNil(refs.repoRoot)
        XCTAssertTrue(refs.refs.isEmpty)
    }

    /// Saved diffs never pile up: past the cap the least recently written go first.
    func testSavedCopiesStayUnderTheirCap() async throws {
        let prefix = "\(SessionChangesModel.cachePrefix)trim-test-\(UUID().uuidString)."
        let blob = String(repeating: "x", count: 10_000)
        for i in 0..<5 {
            DiskCache.save(["text": blob], key: "\(prefix)\(i)")
            try await Task.sleep(for: .milliseconds(30))
        }
        DiskCache.trim(prefix: prefix, maxBytes: 25_000)
        var kept: [Int] = []
        for i in 0..<5 {
            if await DiskCache.loadAsync([String: String].self, key: "\(prefix)\(i)") != nil { kept.append(i) }
        }
        XCTAssertEqual(kept, [3, 4], "the two newest fit, the older ones went")
        // The comparison picked per session is not in the trimmed set.
        XCTAssertFalse(SessionChangesModel.compareKey("s").hasPrefix(SessionChangesModel.cachePrefix))
        XCTAssertTrue(SessionChangesModel.fileKey("s", .session, "/a").hasPrefix(SessionChangesModel.cachePrefix))
        for i in 0..<5 { DiskCache.remove(key: "\(prefix)\(i)") }
    }

    func testQueriesAreEscaped() {
        XCTAssertEqual(WalnutAPI.changesQuery([("path", "/r/a b&c.ts")]), "?path=%2Fr%2Fa%20b%26c.ts")
        XCTAssertEqual(DiffCompare.uncommitted.queryItems.map(\.1), ["uncommitted"])
        XCTAssertEqual(DiffCompare.branch(ref: nil).queryItems.map(\.0), ["base"])
        XCTAssertEqual(DiffCompare.branch(ref: "dev").queryItems.map(\.1), ["branch", "dev"])
    }
}

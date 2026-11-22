import XCTest
@testable import Walnut

/// The notice center's rules (`NoticeCenter`): one way in, newest first, three in sight and the
/// rest folded, an error that never goes fast, a clock that counts only time in sight, and a
/// dismiss that tells its poster.
@MainActor
final class NoticeCenterTests: XCTestCase {

    private func item(_ id: String, tone: NoticeTone = .ok, life: NoticeLife = .automatic,
                      onDismiss: (@MainActor () -> Void)? = nil) -> NoticeItem {
        NoticeItem(id: id, title: "Title \(id)", status: "Done", tone: tone, preview: "Preview \(id)",
                   life: life, announces: false, onDismiss: onDismiss)
    }

    func testTheNewestIsNearestTheTopAndARepostComesBackToTheTop() {
        let center = NoticeCenter()
        center.post(item("a"))
        center.post(item("b"))
        center.post(item("c"))
        XCTAssertEqual(center.inSight.map(\.id), ["c", "b", "a"], "newest first")
        center.post(item("a"))
        XCTAssertEqual(center.inSight.map(\.id), ["a", "c", "b"], "a repost replaces the one up and comes to the top")
        XCTAssertEqual(center.entries.count, 3, "one notice per id")
    }

    func testAtMostThreeAreInSightAndTheRestFoldIntoOneLine() {
        let center = NoticeCenter()
        for id in ["a", "b", "c", "d", "e"] { center.post(item(id)) }
        XCTAssertEqual(center.inSight.map(\.id), ["e", "d", "c"])
        XCTAssertEqual(center.folded, 2, "\"2 more\"")
        center.showsAll = true
        XCTAssertEqual(center.inSight.count, 5, "the \"N more\" line shows them all")
        XCTAssertEqual(center.folded, 0)
        center.dismiss("e")
        center.dismiss("d")
        XCTAssertFalse(center.showsAll, "back to three or fewer, the stack folds again next time")
        XCTAssertEqual(center.inSight.map(\.id), ["c", "b", "a"])
    }

    func testAnErrorStaysAtLeastEightSecondsWhateverItsPosterAsked() {
        XCTAssertEqual(NoticeCenter.lifetime(of: item("x", tone: .error, life: .seconds(2))), NoticeCenter.errorMinimum)
        XCTAssertEqual(NoticeCenter.lifetime(of: item("x", tone: .error)), 8)
        XCTAssertEqual(NoticeCenter.lifetime(of: item("x", tone: .error, life: .seconds(12))), 12)
        XCTAssertEqual(NoticeCenter.lifetime(of: item("x", tone: .ok)), 3, "info about 3 s")
        XCTAssertEqual(NoticeCenter.lifetime(of: item("x", tone: .ok, life: .seconds(6))), 6)
        XCTAssertNil(NoticeCenter.lifetime(of: item("x", tone: .live)), "on its way: until its poster ends it")
        XCTAssertNil(NoticeCenter.lifetime(of: item("x", tone: .error, life: .untilDismissed)))

        let center = NoticeCenter()
        center.post(item("err", tone: .error, life: .seconds(1)))
        center.post(item("info"))
        for _ in 0..<12 { center.tick(0.25, visible: true) }
        XCTAssertNil(center.item("info"), "info goes after 3 s")
        XCTAssertNotNil(center.item("err"), "the error is still there at 3 s")
        for _ in 0..<19 { center.tick(0.25, visible: true) }
        XCTAssertNotNil(center.item("err"), "and at 7.75 s")
        center.tick(0.25, visible: true)
        XCTAssertNil(center.item("err"), "8 s in sight, then it goes")
    }

    func testTheClockCountsOnlyTimeInSight() {
        let center = NoticeCenter()
        center.post(item("err", tone: .error))
        for _ in 0..<100 { center.tick(0.5, visible: false) }
        XCTAssertNotNil(center.item("err"), "time with the app away does not count")

        // Folded under three newer ones, it waits too.
        let folded = NoticeCenter()
        folded.post(item("old"))
        for id in ["a", "b", "c"] { folded.post(item(id, life: .untilDismissed)) }
        for _ in 0..<40 { folded.tick(0.25, visible: true) }
        XCTAssertNotNil(folded.item("old"), "a folded notice was not seen")
        folded.dismiss("a")
        for _ in 0..<12 { folded.tick(0.25, visible: true) }
        XCTAssertNil(folded.item("old"), "in sight, its 3 s run")
    }

    func testADismissTellsItsPosterOnceByAnyWay() {
        let center = NoticeCenter()
        var told: [String] = []
        center.post(item("x", onDismiss: { told.append("x") }))
        center.post(item("y", tone: .error, onDismiss: { told.append("y") }))
        center.dismiss("x")
        center.dismiss("x")
        XCTAssertEqual(told, ["x"], "an X or a swipe: once")
        for _ in 0..<40 { center.tick(0.25, visible: true) }
        XCTAssertEqual(told, ["x", "y"], "its clock too")
        XCTAssertTrue(center.entries.isEmpty)
    }

    func testAnUpdateChangesTheNoticeInPlaceAndNeverBringsBackOneHeClosed() {
        let center = NoticeCenter()
        center.post(item("upload", tone: .live, life: .untilDismissed))
        center.post(item("other"))
        center.update("upload") { $0.preview = "2 of 5" }
        XCTAssertEqual(center.item("upload")?.preview, "2 of 5")
        XCTAssertEqual(center.inSight.map(\.id), ["other", "upload"], "its place stays")
        center.dismiss("upload")
        center.update("upload") { $0.preview = "3 of 5" }
        XCTAssertNil(center.item("upload"), "closed stays closed")
    }

    func testTheWindowIsToldOnEveryPostAndWhenTheLastGoes() {
        let center = NoticeCenter()
        var told: [Bool] = []
        center.onPresenceChange = { told.append($0) }
        center.post(item("a"))
        center.post(item("b"))
        center.dismiss("a")
        center.dismiss("b")
        XCTAssertEqual(told, [true, true, false])
    }

    func testTheCardReadsAsOneElementWithTitleStatusAndPreview() {
        XCTAssertEqual(item("a").spokenText, "Title a, Done, Preview a")
        let bare = NoticeItem(id: "b", title: "Session", tone: .live)
        XCTAssertEqual(bare.spokenText, "Session")
        XCTAssertEqual(NoticeAvatar.initials(of: "Growth VP"), .initials("GV"))
        XCTAssertEqual(NoticeAvatar.initials(of: "\u{201C}Q3 plan\u{201D}"), .initials("Qp"), "quotes are no letters")
        XCTAssertEqual(NoticeAvatar.initials(of: "..."), .symbol("person.fill"))
        XCTAssertGreaterThanOrEqual(NoticeCard.closeSide, 44, "the X takes a full finger")
    }
}

/// Every passing notice goes through the center: no screen draws a toast of its own again, and no
/// card or row carries a coloured bar down one side (2026-11-20: the user asked for one notice
/// system for the whole app, and found the side bar ugly and unneeded).
final class NoticeCenterGuardTests: XCTestCase {

    private static var iosRoot: URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
    }

    /// Code lines of every Swift file of the app and its shared code, comments left out.
    private func sources() throws -> [(path: String, lines: [String])] {
        var out: [(String, [String])] = []
        for dir in ["Walnut", "Shared"] {
            let root = Self.iosRoot.appendingPathComponent(dir)
            guard let walker = FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil) else {
                throw XCTSkip("no source tree at \(root.path)")
            }
            for case let url as URL in walker where url.pathExtension == "swift" {
                let relative = String(url.path.dropFirst(Self.iosRoot.path.count + 1))
                let lines = try String(contentsOf: url, encoding: .utf8).components(separatedBy: "\n")
                    .map { $0.trimmingCharacters(in: .whitespaces).hasPrefix("//") ? "" : $0 }
                out.append((relative, lines))
            }
        }
        XCTAssertGreaterThan(out.count, 100, "the walk found the app's sources")
        return out
    }

    /// Every notice shows its X, a live one too (2026-11-22, the user, of a card he could not close:
    /// "why there is no x so that i cna close"). A notice has no way to leave it out.
    func testEveryNoticeCanBeClosed() throws {
        let optOut = try NSRegularExpression(pattern: #"\b(closable|showsClose|hidesClose)\s*[:=]"#)
        for (path, lines) in try sources() {
            for (n, line) in lines.enumerated() {
                let range = NSRange(line.startIndex..., in: line)
                XCTAssertNil(optOut.firstMatch(in: line, range: range),
                             "\(path):\(n + 1) lets a notice go without its X: every notice can be closed")
            }
        }
    }

    func testNoScreenDrawsAToastOfItsOwn() throws {
        let ownToast = try NSRegularExpression(pattern: #"\b(struct|class|enum)\s+\w*(Toast|Toaster|Snackbar)\w*\b"#)
        for (path, lines) in try sources() {
            for (n, line) in lines.enumerated() {
                let range = NSRange(line.startIndex..., in: line)
                XCTAssertNil(ownToast.firstMatch(in: line, range: range),
                             "\(path):\(n + 1) declares a toast of its own: post a NoticeItem to NoticeCenter.shared instead")
            }
        }
    }

    /// A thin coloured strip (2 to 4 pt wide) drawn down one side of something. The two left are
    /// not cards: a markdown quote's mark, and the gutter mark of a selected line of code.
    private static let sideMarks: [String: String] = [
        "Walnut/Markdown/MarkdownView.swift": "a blockquote's mark in rendered markdown",
        "Walnut/Views/Sessions/Changes/SessionFileDiffView.swift": "the gutter mark of a selected or commented line of code",
    ]

    func testNoCardHasAColouredBarDownOneSide() throws {
        let narrow = try NSRegularExpression(pattern: #"\.frame\(width: ?[2-4](\.\d+)?\)"#)
        for (path, lines) in try sources() {
            for (n, line) in lines.enumerated() {
                guard narrow.firstMatch(in: line, range: NSRange(line.startIndex..., in: line)) != nil else { continue }
                let around = lines[max(0, n - 3)...n].joined(separator: " ")
                guard around.contains(".fill("),
                      around.contains("Rectangle(") || around.contains("Capsule(") else { continue }
                XCTAssertNotNil(Self.sideMarks[path],
                                "\(path):\(n + 1) draws a coloured bar down one side: give the card one hairline all round, and a 6 pt status dot where the colour means something")
            }
        }
    }
}

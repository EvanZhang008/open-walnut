import XCTest
@testable import Walnut

/// FilePreviewLink round-trips + the bare-HTML-path linkifier — the plumbing
/// that turns "report saved to /tmp/x/report.html" into a tappable in-app
/// WKWebView preview (mirror of the bare-image-path pipeline's tests).
final class FilePreviewLinkTests: XCTestCase {

    // MARK: - URL round-trip

    func testURLRoundTripsPlainPath() {
        let url = FilePreviewLink.url(for: "/tmp/demo/report.html")
        XCTAssertNotNil(url)
        XCTAssertEqual(url?.scheme, "walnut-file")
        XCTAssertEqual(FilePreviewLink.path(from: url!), "/tmp/demo/report.html")
    }

    func testURLRoundTripsPathWithSpaces() {
        let path = "/tmp/my reports/2026 summary.html"
        let url = FilePreviewLink.url(for: path)
        XCTAssertNotNil(url)
        XCTAssertEqual(FilePreviewLink.path(from: url!), path)
    }

    func testSchemelessAbsoluteHTMLPathAccepted() {
        // `[report](/tmp/report.html)` markdown parses to a scheme-less URL.
        let url = URL(string: "/tmp/report.html")!
        XCTAssertEqual(FilePreviewLink.path(from: url), "/tmp/report.html")
    }

    func testForeignURLsRejected() {
        XCTAssertNil(FilePreviewLink.path(from: URL(string: "https://example.com/x.html")!))
        XCTAssertNil(FilePreviewLink.path(from: URL(string: "mailto:a@b.c")!))
        // Scheme-less but not previewable → not ours.
        XCTAssertNil(FilePreviewLink.path(from: URL(string: "/tmp/notes.txt")!))
    }

    func testIsPreviewablePath() {
        XCTAssertTrue(FilePreviewLink.isPreviewablePath("/tmp/a.html"))
        XCTAssertTrue(FilePreviewLink.isPreviewablePath("/tmp/a.HTM"))
        XCTAssertFalse(FilePreviewLink.isPreviewablePath("/tmp/a.md"))
        XCTAssertFalse(FilePreviewLink.isPreviewablePath("/tmp/html"))
    }

    // MARK: - linkifyPreviewableFilePaths

    private func links(in text: String) -> [URL] {
        var attributed = AttributedString(text)
        MarkdownParser.linkifyPreviewableFilePaths(&attributed)
        return attributed.runs.compactMap { $0.link }
    }

    /// The links a message produces, decoded back into path + position — the
    /// whole trip the tap takes (text → walnut-file:// → router).
    private func refs(in text: String) -> [FilePathRef] {
        links(in: text).compactMap { FilePreviewLink.reference(from: $0) }
    }

    func testBareHTMLPathBecomesPreviewLink() {
        let found = links(in: "Report saved to /tmp/demo/report.html — open it")
        XCTAssertEqual(found.count, 1)
        XCTAssertEqual(found.first.flatMap { FilePreviewLink.path(from: $0) }, "/tmp/demo/report.html")
    }

    func testCJKPunctuationBoundaryAccepted() {
        // Same boundary contract as bare image paths — agents write
        // "报告:`/tmp/x.html`" style lines constantly.
        let found = links(in: "报告:/tmp/out/x.html。")
        XCTAssertEqual(found.count, 1)
        XCTAssertEqual(found.first.flatMap { FilePreviewLink.path(from: $0) }, "/tmp/out/x.html")
    }

    func testURLTailNotLinkified() {
        // The path inside a web URL must stay part of that URL, not become a
        // separate file link.
        XCTAssertTrue(links(in: "see https://example.com/docs/page.html for details").isEmpty)
    }

    /// FLIPPED (2026-09): this used to assert that every non-HTML path stayed
    /// DEAD TEXT on the phone, which was the bug — the web console has linked
    /// these for a long time, so a path written in chat was openable on the
    /// desktop and inert on the phone.
    func testNonHTMLPathsNowLink() {
        let found = refs(in: "wrote /tmp/demo/notes.md and /tmp/x/data.json")
        XCTAssertEqual(found.map(\.path), ["/tmp/demo/notes.md", "/tmp/x/data.json"])
    }

    func testPlainCodePathBecomesOneLink() {
        let found = refs(in: "the guard lives in /Users/someone/repo/src/foo.ts today")
        XCTAssertEqual(found.count, 1)
        XCTAssertEqual(found.first?.path, "/Users/someone/repo/src/foo.ts")
        XCTAssertNil(found.first?.line)
    }

    func testHomeRelativePathLinks() {
        let found = refs(in: "see ~/repo/src/foo.ts for the parser")
        XCTAssertEqual(found.map(\.path), ["~/repo/src/foo.ts"])
    }

    // MARK: - Position carried through the link

    func testColonLineForm() {
        let found = refs(in: "see /Users/someone/repo/src/foo.ts:42 for the guard")
        XCTAssertEqual(found.count, 1)
        XCTAssertEqual(found.first?.path, "/Users/someone/repo/src/foo.ts")
        XCTAssertEqual(found.first?.line, 42)
    }

    func testColonLineColumnForm() {
        let found = refs(in: "/Users/someone/repo/src/foo.ts:42:7 is the call")
        XCTAssertEqual(found.first?.path, "/Users/someone/repo/src/foo.ts")
        XCTAssertEqual(found.first?.line, 42)
        XCTAssertEqual(found.first?.column, 7)
    }

    func testAnchorLineForm() {
        let found = refs(in: "start at /Users/someone/repo/src/foo.ts#L10 please")
        XCTAssertEqual(found.count, 1)
        XCTAssertEqual(found.first?.path, "/Users/someone/repo/src/foo.ts")
        XCTAssertEqual(found.first?.line, 10)
        XCTAssertNil(found.first?.endLine)
    }

    func testAnchorRangeForm() {
        let found = refs(in: "read /Users/someone/repo/src/foo.ts#L10-L20 closely")
        XCTAssertEqual(found.count, 1)
        XCTAssertEqual(found.first?.path, "/Users/someone/repo/src/foo.ts")
        XCTAssertEqual(found.first?.line, 10)
        XCTAssertEqual(found.first?.endLine, 20)
    }

    func testParenLineColumnForm() {
        let found = refs(in: "compiler says /Users/someone/repo/src/foo.ts(42,7) is wrong")
        XCTAssertEqual(found.count, 1)
        XCTAssertEqual(found.first?.path, "/Users/someone/repo/src/foo.ts")
        XCTAssertEqual(found.first?.line, 42)
        XCTAssertEqual(found.first?.column, 7)
    }

    func testTrailingSentencePeriodIsNotPartOfThePath() {
        let found = refs(in: "I wrote it to /Users/someone/repo/src/foo.ts.")
        XCTAssertEqual(found.map(\.path), ["/Users/someone/repo/src/foo.ts"])
    }

    func testTrailingPeriodAfterLineNumberIsNotPartOfThePosition() {
        let found = refs(in: "It breaks at /Users/someone/repo/src/foo.ts:42.")
        XCTAssertEqual(found.first?.path, "/Users/someone/repo/src/foo.ts")
        XCTAssertEqual(found.first?.line, 42)
    }

    // MARK: - Regression guards (the two shapes that already worked)

    func testHTMLPathStillRoutesToTheHTMLPreview() {
        // The router keys on isPreviewablePath — an .html tap must still take
        // the rendered WKWebView branch, not the new text viewer.
        let found = refs(in: "report at /tmp/demo/report.html")
        XCTAssertEqual(found.map(\.path), ["/tmp/demo/report.html"])
        XCTAssertTrue(FilePreviewLink.isPreviewablePath(found[0].path))
        // …and a code path must NOT.
        XCTAssertFalse(FilePreviewLink.isPreviewablePath("/Users/someone/repo/src/foo.ts"))
    }

    func testImagePathStaysAnInlineImageAndNeverBecomesALink() {
        XCTAssertTrue(links(in: "screenshot at /tmp/demo/shot.png").isEmpty)
        // Still claimed by the image pipeline (inline picture + pinch-zoom).
        let pieces = MarkdownParser.splitImages("screenshot at /tmp/demo/shot.png")
        let images: [String] = pieces.compactMap {
            if case .image(let raw, _) = $0 { return raw } else { return nil }
        }
        XCTAssertEqual(images, ["/tmp/demo/shot.png"])
    }

    func testWebURLStillLinkifiesAsAURL() {
        var attributed = AttributedString("see https://example.com/docs/page.html for details")
        MarkdownParser.linkifyBareURLs(&attributed)
        MarkdownParser.linkifyPreviewableFilePaths(&attributed)
        let found = attributed.runs.compactMap { $0.link }
        XCTAssertEqual(found, [URL(string: "https://example.com/docs/page.html")!])
        // …and it is NOT claimed as a file reference.
        XCTAssertNil(found.first.flatMap { FilePreviewLink.reference(from: $0) })
    }

    func testPathInsideAURLIsNotLinkedEvenWithoutTheURLLinkifier() {
        XCTAssertTrue(links(in: "see https://example.com/repo/src/foo.ts for details").isEmpty)
    }

    // MARK: - Absolute directory paths (P2)

    func testAbsoluteDirectoryPathLinks() {
        let found = refs(in: "the work is under /Users/me/repo/src today")
        XCTAssertEqual(found.map(\.path), ["/Users/me/repo/src"])
        XCTAssertTrue(found[0].looksLikeDirectory)
    }

    func testShortRootIsNotLinkedAsADirectory() {
        // ≥3 segments, or prose-y roots light up.
        XCTAssertTrue(links(in: "it lives in /usr/bin somewhere").isEmpty)
    }

    func testFilePathIsNotAlsoClaimedAsADirectory() {
        let found = refs(in: "look at /Users/me/repo/src/foo.ts now")
        XCTAssertEqual(found.count, 1)
        XCTAssertEqual(found[0].path, "/Users/me/repo/src/foo.ts")
        XCTAssertFalse(found[0].looksLikeDirectory)
    }

    func testDirectoryPathBeforePunctuationLinks() {
        let found = refs(in: "cloned into /Users/me/repo/src, then built")
        XCTAssertEqual(found.map(\.path), ["/Users/me/repo/src"])
    }

    // MARK: - FilePathRef parsing (position stripped from the path)

    func testRefParseStripsEveryPositionForm() {
        XCTAssertEqual(FilePathRef.parse("/a/b/c.ts:42")?.line, 42)
        XCTAssertEqual(FilePathRef.parse("/a/b/c.ts:42")?.path, "/a/b/c.ts")
        XCTAssertEqual(FilePathRef.parse("/a/b/c.ts#L9")?.line, 9)
        XCTAssertEqual(FilePathRef.parse("/a/b/c.ts#L9-20")?.endLine, 20)
        XCTAssertEqual(FilePathRef.parse("/a/b/c.ts(3,4)")?.column, 4)
        XCTAssertEqual(FilePathRef.parse("/a/b/c.ts(3,4)")?.path, "/a/b/c.ts")
        XCTAssertEqual(FilePathRef.parse("`/a/b/c.ts`")?.path, "/a/b/c.ts")
    }

    func testRefRoundTripsThroughTheURL() {
        let ref = FilePathRef(path: "/tmp/my code/foo bar.ts", line: 12, endLine: 30,
                              column: 4, raw: "/tmp/my code/foo bar.ts#L12-L30")
        let url = FilePreviewLink.url(for: ref)
        XCTAssertNotNil(url)
        let back = FilePreviewLink.reference(from: url!)
        XCTAssertEqual(back?.path, ref.path)
        XCTAssertEqual(back?.line, 12)
        XCTAssertEqual(back?.endLine, 30)
        XCTAssertEqual(back?.column, 4)
        XCTAssertEqual(back?.raw, ref.raw)
    }

    func testSchemelessAbsolutePathIsClaimedAsAReference() {
        // `[notes](/tmp/notes.md)` markdown parses to a scheme-less URL — the
        // router must still recognise it (path(from:) stays HTML-only on purpose).
        XCTAssertEqual(FilePreviewLink.reference(from: URL(string: "/tmp/notes.md")!)?.path,
                       "/tmp/notes.md")
        XCTAssertNil(FilePreviewLink.reference(from: URL(string: "https://example.com/x.md")!))
        XCTAssertNil(FilePreviewLink.reference(from: URL(string: "mailto:a@b.c")!))
    }

    // MARK: - Failure copy (one mapping, distinct sentences)

    func testStatusCopyIsDistinctAndHuman() {
        let statuses = [403, 413, 501, 503]
        let messages = statuses.map { FilePreviewLink.friendlyMessage(forHTTPStatus: $0) }
        XCTAssertEqual(Set(messages).count, statuses.count,
                       "403/413/501/503 are four different situations and must not share copy")
        for (status, message) in zip(statuses, messages) {
            XCTAssertFalse(message.isEmpty, "\(status) returned empty copy")
            XCTAssertGreaterThan(message.split(separator: " ").count, 4,
                                 "\(status) copy reads like a code, not a sentence: \(message)")
            XCTAssertNotEqual(message, String(status))
            XCTAssertFalse(message.contains("ENOENT") || message.contains("EACCES"),
                           "\(status) copy leaks an errno: \(message)")
        }
        // 413 and 501 must not both say "open it on your Mac": one is permanent,
        // the other fixes itself.
        XCTAssertTrue(FilePreviewLink.friendlyMessage(forHTTPStatus: 413).contains("Mac"))
        XCTAssertFalse(FilePreviewLink.friendlyMessage(forHTTPStatus: 501).contains("Mac"))
    }

    func testAPIErrorMapsThroughTheSameCopy() {
        func serverError(_ status: Int, _ code: String) -> APIError {
            .server(status: status, code: code, message: "raw server text",
                    serverHash: nil, serverContent: nil)
        }
        XCTAssertEqual(SessionDirectoryList.friendlyFilesError(serverError(413, "too_large")),
                       FilePreviewLink.friendlyMessage(forHTTPStatus: 413))
        // Same CODE, different STATUS → different sentence. Keying on the code
        // alone told a reader with a merely out-of-date daemon that the file was
        // permanently unreachable.
        XCTAssertNotEqual(
            SessionDirectoryList.friendlyFilesError(serverError(403, "not_supported_cloud")),
            SessionDirectoryList.friendlyFilesError(serverError(501, "not_supported_cloud"))
        )
    }

    func testAlreadyLinkedRunsSkipped() {
        var attributed = try! AttributedString(
            markdown: "[report](https://example.com/r)",
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        )
        MarkdownParser.linkifyPreviewableFilePaths(&attributed)
        let found = attributed.runs.compactMap { $0.link }
        XCTAssertEqual(found, [URL(string: "https://example.com/r")!])
    }

    // MARK: - Segment floor differs by root (and that is deliberate)

    /// A table of sibling home paths used to light up exactly ONE of four, which
    /// reads as a rendering bug rather than a rule. `~/` cannot be produced by a
    /// URL, an HTTP route, a flag or a pattern, so it needs no ≥3-segment
    /// stand-in test for "is this really a path" — it gets the same ≥1 directory
    /// segment floor the FILE rule uses.
    func testTildeDirectoryNeedsOnlyOneDirectorySegment() {
        let found = refs(in: "caches live in ~/Library/Caches today")
        XCTAssertEqual(found.map(\.path), ["~/Library/Caches"])
        XCTAssertTrue(found[0].looksLikeDirectory)
    }

    /// The sibling rows of that same table now agree with each other.
    func testEveryHomeRowOfTheSameTableLinks() {
        let paths = refs(in: "~/Library/Containers/com.docker.docker ~/Library/Caches ~/Library/Developer")
            .map(\.path)
        XCTAssertEqual(paths, ["~/Library/Containers/com.docker.docker",
                               "~/Library/Caches",
                               "~/Library/Developer"])
    }

    /// A bare `~/x` is still not enough: one segment carries no context, the same
    /// reason the file rule requires a directory segment.
    func testSingleSegmentTildePathStaysPlain() {
        XCTAssertTrue(links(in: "put it in ~/Downloads please").isEmpty)
    }

    /// The `/`-rooted floor is UNCHANGED, and this is the reason it exists: at
    /// two segments a rooted token is the shape of an API route. `/opt/homebrew`
    /// staying plain next to three live `~/` rows is the lesser evil — the
    /// alternative claims prose.
    func testTwoSegmentSlashRootedPathsStayPlain() {
        XCTAssertTrue(links(in: "installed under /opt/homebrew here").isEmpty)
        XCTAssertTrue(links(in: "call GET /api/v1 for that").isEmpty)
    }

    // MARK: - CJK punctuation ends a path (bilingual chat is the normal case here)

    /// The exact text that measured 2 of 4 rows lit instead of 3: the row that
    /// stayed plain was followed by a FULLWIDTH `（`, which the terminator class
    /// did not recognise.
    func testFullwidthBracketAfterAPathStillLinksThePath() {
        let found = refs(in: "~/Library/Developer（Xcode 的东西）")
        XCTAssertEqual(found.map(\.path), ["~/Library/Developer"])
    }

    /// All three home rows of the reported table, each terminated the way it is
    /// terminated on screen.
    func testEveryHomeRowOfTheLiveTableLinks() {
        let paths = refs(in: "~/Library/Containers/com.docker.docker，~/Library/Caches；~/Library/Developer（缓存）")
            .map(\.path)
        XCTAssertEqual(paths, ["~/Library/Containers/com.docker.docker",
                               "~/Library/Caches",
                               "~/Library/Developer"])
    }

    func testEveryCJKSentenceMarkTerminatesAPath() {
        for mark in ["。", "，", "、", "（", "）", "：", "；", "！", "？", "【", "】", "《", "》", "「", "」"] {
            let found = refs(in: "看 /Users/me/repo/src\(mark)继续")
            XCTAssertEqual(found.map(\.path), ["/Users/me/repo/src"],
                           "a path followed by \(mark) must still be a path")
        }
    }

    /// The widened terminator class must not have widened what counts as a PATH.
    func testWideningTheTerminatorClassDidNotLoosenTheGuards() {
        XCTAssertTrue(links(in: "见 /opt/homebrew（那里）").isEmpty)
        XCTAssertTrue(links(in: "调用 GET /api/v1：注意").isEmpty)
        XCTAssertTrue(links(in: "改 src/foo/bar（相对路径）").isEmpty)
    }
}

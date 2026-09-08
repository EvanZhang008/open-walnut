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
        // 413 and 501 must not both send the reader away to another machine: one
        // is permanent, the other fixes itself in a minute. (Both sentences NAME
        // the owning box now, so the discriminator is the instruction, not the
        // word "Mac".)
        XCTAssertTrue(FilePreviewLink.friendlyMessage(forHTTPStatus: 413).contains("Open it on your Mac"))
        XCTAssertFalse(FilePreviewLink.friendlyMessage(forHTTPStatus: 501).contains("Open it on"))
        XCTAssertTrue(FilePreviewLink.friendlyMessage(forHTTPStatus: 501).lowercased().contains("try again"))
    }

    // MARK: - The 2026-09-07 defect: a 404 reported as "the file is gone"

    /// The report: the phone (paired to the cloud companion) said
    /// "That file isn't there anymore" about a file that was 15 KB on the Mac.
    /// The relay had worked perfectly — the Mac's own daemon answered ENOENT,
    /// because the agent announced the path SEVENTY SECONDS before it finished
    /// writing the file. Every clause of that sentence was wrong: the file had
    /// never existed, so it could not be there "anymore"; the condition was
    /// temporary; and there was no way to try again.
    func test404NeverClaimsTheFileWasDeleted() {
        let failure = FilePreviewLink.failure(forHTTPStatus: 404)
        XCTAssertFalse(failure.message.lowercased().contains("anymore"),
                       "404 must not assert the file once existed: \(failure.message)")
        XCTAssertFalse(failure.message.lowercased().contains("deleted"))
        XCTAssertFalse(failure.message.lowercased().contains("gone,"))
        XCTAssertTrue(failure.isRetryable,
                      "a file an agent just named may still be being written — the reader needs a retry")
        XCTAssertTrue(failure.message.contains("your Mac"),
                      "the sentence must name the box that was asked: \(failure.message)")
    }

    /// The other half of the rule: an unreachable host must never be reported as
    /// a missing file. These are the two sentences that used to be confusable.
    func testUnreachableHostIsNotReportedAsAMissingFile() {
        let unreachable = FilePreviewLink.failure(forHTTPStatus: 503, host: "buildbox")
        XCTAssertEqual(unreachable.kind, .hostUnreachable)
        XCTAssertTrue(unreachable.isRetryable)
        XCTAssertTrue(unreachable.message.contains("buildbox"),
                      "must name the box it could not reach: \(unreachable.message)")
        XCTAssertTrue(unreachable.message.lowercased().contains("does not mean the file is gone"),
                      "must actively deny the wrong conclusion: \(unreachable.message)")
        XCTAssertNotEqual(unreachable.message, FilePreviewLink.failure(forHTTPStatus: 404, host: "buildbox").message)
        XCTAssertNotEqual(unreachable.title, FilePreviewLink.failure(forHTTPStatus: 404, host: "buildbox").title)
    }

    // MARK: - Status → kind → (sentence, retry) — the whole ladder, one table

    func testEveryServerFailureKindGetsItsOwnSentenceAndRetryDecision() {
        // status, expected kind, retry offered
        let table: [(Int, FileReadFailureKind, Bool)] = [
            (401, .notAuthorised, false),
            (403, .refused, false),
            (404, .notFoundOnHost, true),
            (410, .notFoundOnHost, true),
            (413, .tooLarge, false),
            (415, .unsupportedType, false),
            (500, .serverError(status: 500), true),
            (501, .hostNeedsUpgrade, true),
            (502, .hostUnreachable, true),
            (503, .hostUnreachable, true),
            (504, .hostUnreachable, true),
            (418, .serverError(status: 418), false),
        ]
        for (status, expectedKind, retry) in table {
            let failure = FilePreviewLink.failure(forHTTPStatus: status, host: "buildbox")
            XCTAssertEqual(failure.kind, expectedKind, "status \(status) classified wrong")
            XCTAssertEqual(failure.isRetryable, retry,
                           "status \(status) offers the wrong retry affordance: \(failure.message)")
            XCTAssertFalse(failure.message.isEmpty, "status \(status) has no sentence")
            XCTAssertGreaterThan(failure.message.split(separator: " ").count, 4,
                                 "status \(status) reads like a code: \(failure.message)")
            XCTAssertFalse(failure.title.isEmpty, "status \(status) has no headline")
        }
    }

    /// Distinguishable cases must be distinguishable ON SCREEN. The shipped bug
    /// was one sentence doing duty for several situations, so this pins the
    /// sentences apart rather than trusting the enum.
    func testDistinguishableCasesDoNotShareCopy() {
        let kinds: [FileReadFailureKind] = [
            .notFoundOnHost, .hostReadFailed("disk I/O error"), .refused, .tooLarge,
            .hostNeedsUpgrade, .hostUnreachable, .transportFailed, .notAuthorised,
            .unsupportedType, .serverError(status: 500), .serverError(status: nil),
        ]
        let failures = kinds.map { FileReadFailure(kind: $0, host: nil) }
        XCTAssertEqual(Set(failures.map(\.message)).count, kinds.count,
                       "two different situations share one sentence")
        // Titles may repeat across the two serverError shapes and nothing else.
        XCTAssertGreaterThanOrEqual(Set(failures.map(\.title)).count, kinds.count - 1)
        for failure in failures {
            XCTAssertFalse(failure.message.contains("ENOENT") || failure.message.contains("EACCES"),
                           "copy leaks an errno: \(failure.message)")
            XCTAssertFalse(failure.icon.isEmpty)
        }
    }

    /// A sentence that does not say WHICH box was asked cannot distinguish "not
    /// there" from "couldn't ask", which is the whole defect.
    func testCopyNamesTheOwningBox() {
        let named: [FileReadFailureKind] = [.notFoundOnHost, .hostUnreachable, .refused,
                                            .hostNeedsUpgrade]
        for kind in named {
            XCTAssertTrue(FileReadFailure(kind: kind, host: "buildbox").message.contains("buildbox"),
                          "\(kind) does not name a named host")
        }
        // `.hostNeedsUpgrade` is EXCLUDED from the fallback half, and that is the
        // point rather than an omission: a 501 comes from a box whose daemon
        // predates the bounded read, which in cloud mode is by definition not the
        // reader's own Mac. Defaulting that one to the primary sent the reader to
        // the wrong machine, so with no host named it names no machine at all.
        for kind in named where kind != .hostNeedsUpgrade {
            XCTAssertTrue(FileReadFailure(kind: kind, host: nil).message.contains("your Mac"),
                          "\(kind) does not name the primary box")
        }
        let unnamedUpgrade = FileReadFailure(kind: .hostNeedsUpgrade, host: nil).message
        XCTAssertFalse(unnamedUpgrade.contains("Mac"), unnamedUpgrade)
        XCTAssertTrue(unnamedUpgrade.contains("older Walnut daemon"), unnamedUpgrade)
        // The bridge's internal alias for the primary is not a user-facing name.
        XCTAssertEqual(FileReadFailure(kind: .notFoundOnHost, host: "__local__").hostLabel, "your Mac")
        XCTAssertEqual(FileReadFailure(kind: .notFoundOnHost, host: "").hostLabel, "your Mac")
    }

    /// The JSON viewer lane answers a missing file as 200-with-`error`, never as
    /// 404, so it needs its own classifier — and "Cannot read file on host: …"
    /// is a different situation than "File not found".
    func testPayloadErrorLaneClassifiesNotFoundApartFromAFailedRead() {
        let missing = FilePreviewLink.failure(fromPayloadError: "File not found", host: nil)
        XCTAssertEqual(missing.kind, .notFoundOnHost)
        XCTAssertTrue(missing.isRetryable)

        let broken = FilePreviewLink.failure(fromPayloadError: "Cannot read file on host: disk I/O error")
        XCTAssertEqual(broken.kind, .hostReadFailed("Cannot read file on host: disk I/O error"))
        XCTAssertTrue(broken.isRetryable)
        XCTAssertNotEqual(broken.message, missing.message)

        // An empty/absent error string is still an unreadable file, not a crash.
        XCTAssertEqual(FilePreviewLink.failure(fromPayloadError: nil).kind, .notFoundOnHost)
        XCTAssertEqual(FilePreviewLink.failure(fromPayloadError: "   ").kind, .notFoundOnHost)
    }

    /// The retry AFFORDANCE is only worth anything if the button re-arms the
    /// loader, and that is easy to break by accident: `setPhase` deliberately
    /// refuses to overwrite a failure (so the friendly copy survives the
    /// `.cancel` that produced it), so a `reload()` written in terms of
    /// `setPhase` would leave the spinner-less failed state on screen forever
    /// and the button would look dead. This pins the direct assignment.
    @MainActor
    func testReloadReArmsAFailedPreview() {
        let target = FilePreviewTarget(path: "/tmp/walnut-test/report.html", host: nil)
        let loader = HTMLPreviewLoader(
            target: target,
            url: URL(string: "http://127.0.0.1:59999/api/v1/file-content?path=/tmp/x.html&raw=1")!,
            token: nil
        )
        defer { loader.teardown() }

        loader.setPhase(.failed(FilePreviewLink.failure(forHTTPStatus: 404)))
        XCTAssertEqual(loader.phase, .failed(FilePreviewLink.failure(forHTTPStatus: 404)))
        // The guard that makes reload() need a direct assignment.
        loader.setPhase(.loading)
        XCTAssertNotEqual(loader.phase, .loading, "setPhase must keep the friendly failure")

        loader.reload()
        XCTAssertEqual(loader.phase, .loading, "Try Again left the preview in its failed state")

        // A torn-down loader has no navigation delegate, so a reload would spin
        // forever with nothing to report back — it must decline instead.
        loader.teardown()
        loader.setPhase(.failed(FilePreviewLink.failure(forHTTPStatus: 503)))
        loader.reload()
        XCTAssertNotEqual(loader.phase, .loading, "reload() must decline after teardown")
    }

    /// Transport failures say nothing about the file, and must not pretend to.
    func testTransportFailureBlamesTheNetworkNotTheFile() {
        let offline = FilePreviewLink.failure(
            for: APIError.network(underlying: URLError(.notConnectedToInternet)), host: nil)
        XCTAssertEqual(offline.kind, .transportFailed)
        XCTAssertTrue(offline.isRetryable)
        XCTAssertNotEqual(offline.message, FilePreviewLink.failure(forHTTPStatus: 404).message)

        // A raw NSError (what WKWebView hands the preview) lands in the same place.
        let raw = FilePreviewLink.failure(for: URLError(.timedOut))
        XCTAssertEqual(raw.kind, .transportFailed)
        XCTAssertTrue(raw.isRetryable)

        XCTAssertEqual(FilePreviewLink.failure(for: APIError.unauthorized).kind, .notAuthorised)
        XCTAssertFalse(FilePreviewLink.failure(for: APIError.unauthorized).isRetryable)
        // The primary mid-upgrade is retryable, and reuses the daemon sentence.
        let upgrading = APIError.server(status: 501, code: "session_control_needs_upgrade",
                                       message: "raw", serverHash: nil, serverContent: nil)
        XCTAssertEqual(FilePreviewLink.failure(for: upgrading).kind, .hostNeedsUpgrade)
        XCTAssertTrue(FilePreviewLink.failure(for: upgrading).isRetryable)
    }

    /// A failure names the box it ASKED, or no box at all. The directory listing
    /// dropped its `host` argument, so every failed listing on a remote host was
    /// narrated as a statement about the reader's Mac — and a 501 in particular
    /// comes from a box that is by definition not the reader's Mac.
    func testFailureCopyNeverNamesAMachineItWasNotToldAbout() {
        let cloud501 = APIError.server(status: 501, code: "not_supported_cloud",
                                       message: "no bridge read",
                                       serverHash: nil, serverContent: nil)
        let unknown = SessionDirectoryList.friendlyFilesError(cloud501)
        XCTAssertFalse(unknown.contains("Mac"), unknown)
        XCTAssertTrue(unknown.contains("older Walnut daemon"), unknown)
        let named = SessionDirectoryList.friendlyFilesError(cloud501, host: "build-box")
        XCTAssertTrue(named.contains("build-box"), named)
        XCTAssertFalse(named.contains("your Mac"), named)
        // Every other case still names the primary when nobody said otherwise —
        // those only arise about a path the primary was asked for.
        XCTAssertTrue(FilePreviewLink.failure(forHTTPStatus: 404).message.contains("your Mac"))
        XCTAssertTrue(FilePreviewLink.failure(forHTTPStatus: 404, host: "__local__")
                        .message.contains("your Mac"))
        XCTAssertTrue(FilePreviewLink.failure(forHTTPStatus: 404, host: "remote-1")
                        .message.contains("remote-1"))
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

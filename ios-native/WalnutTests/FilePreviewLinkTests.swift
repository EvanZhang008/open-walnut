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

    func testNonHTMLPathsIgnored() {
        XCTAssertTrue(links(in: "wrote /tmp/demo/notes.md and /tmp/x/data.json").isEmpty)
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
}

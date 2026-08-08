import XCTest
@testable import Walnut

/// Pure per-render helpers of MessageRow / ChatMarkdownBody, tested against
/// the REAL app code via @testable import (no replicas to keep in sync).
final class MessageRowHelperTests: XCTestCase {

    // MARK: - imageSendParts (two wire formats — see MessageRow.swift)

    func testImageSendPartsDashedFormat() {
        let text = "[Images attached — use the Read tool to view them]\n- /tmp/shots/shot-9.png\n\n看下这个截图,哪里不对?"
        let parts = MessageRow.imageSendParts(text)
        XCTAssertEqual(parts?.paths, ["/tmp/shots/shot-9.png"])
        XCTAssertEqual(parts?.text, "看下这个截图,哪里不对?")
    }

    func testImageSendPartsBareFormat() {
        let text = "The user attached 2 images. Read these files for visual context:\n/tmp/a/one.png\n/tmp/a/two.jpg\n\nWhat changed between these?"
        let parts = MessageRow.imageSendParts(text)
        XCTAssertEqual(parts?.paths, ["/tmp/a/one.png", "/tmp/a/two.jpg"])
        XCTAssertEqual(parts?.text, "What changed between these?")
    }

    func testImageSendPartsRejectsOrdinaryText() {
        XCTAssertNil(MessageRow.imageSendParts("just a normal message with /tmp/file.png inline"))
        XCTAssertNil(MessageRow.imageSendParts("The user attached a debugger, not images"))
    }

    func testImageSendPartsRejectsHeaderWithUnexpectedLine() {
        // A non-path, non-empty line inside the header = not the known format.
        let text = "[Images attached — use the Read tool to view them]\nsurprise line\n- /tmp/x.png"
        XCTAssertNil(MessageRow.imageSendParts(text))
    }

    func testImageSendPartsRequiresAtLeastOnePath() {
        XCTAssertNil(MessageRow.imageSendParts("[Images attached — use the Read tool to view them]\n\nno paths here"))
    }

    func testImageSendPartsBodyMayBeEmpty() {
        let parts = MessageRow.imageSendParts("[Images attached — use the Read tool to view them]\n- /tmp/x.png")
        XCTAssertEqual(parts?.paths, ["/tmp/x.png"])
        XCTAssertEqual(parts?.text, "")
    }

    // MARK: - isBlockMarkdown

    func testIsBlockMarkdownDetectsBlockConstructs() {
        XCTAssertTrue(ChatMarkdownBody.isBlockMarkdown("intro\n## heading"))
        XCTAssertTrue(ChatMarkdownBody.isBlockMarkdown("a\n- bullet"))
        XCTAssertTrue(ChatMarkdownBody.isBlockMarkdown("a\n```\ncode\n```"))
        XCTAssertTrue(ChatMarkdownBody.isBlockMarkdown("a\n| c1 | c2 |"))
        XCTAssertTrue(ChatMarkdownBody.isBlockMarkdown("a\n> quoted"))
        XCTAssertTrue(ChatMarkdownBody.isBlockMarkdown("a\n1. first"))
    }

    func testIsBlockMarkdownRejectsPlainAndSingleLine() {
        XCTAssertFalse(ChatMarkdownBody.isBlockMarkdown("## single line heading without newline"))
        XCTAssertFalse(ChatMarkdownBody.isBlockMarkdown("plain\ntwo lines of prose"))
        XCTAssertFalse(ChatMarkdownBody.isBlockMarkdown("收到,第 3 步完成。"))
    }

    // MARK: - containsImageRef

    func testContainsImageRef() {
        XCTAssertTrue(ChatMarkdownBody.containsImageRef("see ![shot](x.png)"))
        XCTAssertTrue(ChatMarkdownBody.containsImageRef("saved to /tmp/probe/heatmap.PNG"))
        XCTAssertTrue(ChatMarkdownBody.containsImageRef("photo at /a/b/pic.jpeg done"))
        XCTAssertFalse(ChatMarkdownBody.containsImageRef("plain text, no refs"))
        XCTAssertFalse(ChatMarkdownBody.containsImageRef("path /tmp/data.json is not an image"))
    }

    // MARK: - MarkdownParser.isImagePath (used by imageSendParts)

    func testIsImagePath() {
        XCTAssertTrue(MarkdownParser.isImagePath("/tmp/x/shot.png"))
        XCTAssertTrue(MarkdownParser.isImagePath("/tmp/x/SHOT.WEBP"))
        XCTAssertFalse(MarkdownParser.isImagePath("/tmp/x/notes.md"))
        XCTAssertFalse(MarkdownParser.isImagePath("/tmp/x/pngfile"))
    }
}

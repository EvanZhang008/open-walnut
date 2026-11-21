import XCTest
@testable import Walnut

/// A recorded video's stills and narration blocks, written by the phone and read
/// back by its timeline: byte for byte the server's `videoClipBlocks` and
/// `splitAttachmentHeaders` (src/lib/attachment-headers.ts).
final class VideoClipHeaderTests: XCTestCase {

    private static let video = "/path/on/host/camera-1416.mp4"
    private static let still0 = "/path/on/host/camera-1416-still-0m00s.jpg"
    private static let still6 = "/path/on/host/camera-1416-still-0m06s.jpg"

    /// The example the format was agreed on, after the files block naming the video.
    private static let expected =
        "[Files attached \u{2014} open them from these paths]\n"
        + "- /path/on/host/camera-1416.mp4\n"
        + "\n"
        + "[Video stills \u{2014} frames of camera-1416.mp4 (0:42), time in each name; use the Read tool to view them]\n"
        + "- /path/on/host/camera-1416-still-0m00s.jpg\n"
        + "- /path/on/host/camera-1416-still-0m06s.jpg\n"
        + "\n"
        + "[Video narration \u{2014} what was said in camera-1416.mp4]\n"
        + "- the transcript on one line\n"
        + "\n"
        + "<what the person typed>"

    private func file(_ id: String, _ name: String, clip: ComposerFile.ClipRole? = nil) -> ComposerFile {
        ComposerFile(id: id, name: name, size: 10, sha256: "x", kind: ComposerFile.kind(for: nil, name: name),
                     localURL: URL(fileURLWithPath: "/tmp/\(id)/\(name)"), clip: clip)
    }

    private func clipFiles(narration: String? = "the transcript   on\n one\tline ") -> [ComposerFile] {
        [
            file("up-v", "camera-1416.mp4", clip: .video(durationMs: 42_000, narration: narration,
                                                         narrationNote: narration == nil ? "no sound recorded" : nil)),
            file("up-s0", "camera-1416-still-0m00s.jpg", clip: .still(videoID: "up-v")),
            file("up-s6", "camera-1416-still-0m06s.jpg", clip: .still(videoID: "up-v")),
        ]
    }

    // MARK: - Writing

    func testTheMessageTextMatchesTheAgreedFormatByteForByte() {
        let text = ComposerFile.messageText("<what the person typed>", files: clipFiles(),
                                            paths: [Self.video, Self.still0, Self.still6])
        XCTAssertEqual(text, Self.expected)
        XCTAssertEqual(Array(text.utf8), Array(Self.expected.utf8))
    }

    func testTheTwoBlocksAloneMatchTheServersBuilder() {
        let blocks = AttachmentHeaders.videoClipBlocks(.init(
            name: "camera-1416.mp4", durationMs: 42_000, stills: [Self.still0, Self.still6], narration: "said it"))
        XCTAssertEqual(blocks,
                       "[Video stills \u{2014} frames of camera-1416.mp4 (0:42), time in each name; use the Read tool to view them]\n"
                       + "- \(Self.still0)\n- \(Self.still6)\n\n"
                       + "[Video narration \u{2014} what was said in camera-1416.mp4]\n- said it\n\n")
    }

    func testABlockWithNothingInItIsLeftOut() {
        let noNarration = ComposerFile.messageText("hi", files: clipFiles(narration: nil),
                                                   paths: [Self.video, Self.still0, Self.still6])
        XCTAssertFalse(noNarration.contains("[Video narration"))
        XCTAssertTrue(noNarration.contains("[Video stills"))
        XCTAssertEqual(AttachmentHeaders.videoClipBlocks(.init(name: "a.mov", durationMs: 1, stills: [" "], narration: "  \n")), "")
        let onlyWords = AttachmentHeaders.videoClipBlocks(.init(name: "a.mov", durationMs: 1, stills: [], narration: "x"))
        XCTAssertEqual(onlyWords, "[Video narration \u{2014} what was said in a.mov]\n- x\n\n")
    }

    func testAMessageWithNoRecordedVideoIsWrittenAsBefore() {
        let pdf = file("up-a", "a.pdf")
        XCTAssertEqual(ComposerFile.messageText("hi", files: [pdf], paths: ["/h/a.pdf"]),
                       "[Files attached \u{2014} open them from these paths]\n- /h/a.pdf\n\nhi")
        XCTAssertEqual(ComposerFile.messageText("hi", imagePaths: ["/h/p.jpg"], paths: []),
                       "[Images attached \u{2014} use the Read tool to view them]\n- /h/p.jpg\n\nhi")
        XCTAssertEqual(ComposerFile.messageText("hi", paths: []), "hi")
        // A still whose video is not in the message is named nowhere.
        let orphan = file("up-s", "x-still-0m00s.jpg", clip: .still(videoID: "up-gone"))
        XCTAssertEqual(ComposerFile.messageText("hi", files: [pdf, orphan], paths: ["/h/a.pdf", "/h/x.jpg"]),
                       "[Files attached \u{2014} open them from these paths]\n- /h/a.pdf\n\nhi")
    }

    func testTheClockAndTheHeaderNameFollowTheServer() {
        XCTAssertEqual(AttachmentHeaders.clipClock(ms: 0), "0:00")
        XCTAssertEqual(AttachmentHeaders.clipClock(ms: 42_000), "0:42")
        XCTAssertEqual(AttachmentHeaders.clipClock(ms: 65_000), "1:05")
        // Math.round: half a second rounds up.
        XCTAssertEqual(AttachmentHeaders.clipClock(ms: 500), "0:01")
        XCTAssertEqual(AttachmentHeaders.clipClock(ms: 1_499), "0:01")
        XCTAssertEqual(AttachmentHeaders.clipClock(ms: 59_500), "1:00")
        XCTAssertEqual(AttachmentHeaders.clipClock(ms: -5), "0:00")
        XCTAssertEqual(AttachmentHeaders.headerSafe("a]b\nc\rd"), "a b c d")
        XCTAssertEqual(AttachmentHeaders.headerSafe(String(repeating: "x", count: 130)).count, 120)
        XCTAssertEqual(AttachmentHeaders.oneLine(" a \n\t b\u{FEFF}c "), "a b c")
    }

    // MARK: - Reading back

    func testTheTimelineReadsTheBlocksOffTheWords() throws {
        let parts = try XCTUnwrap(AttachmentHeaders.split(Self.expected))
        XCTAssertEqual(parts.filePaths, [Self.video])
        XCTAssertEqual(parts.stills, [Self.still0, Self.still6])
        XCTAssertEqual(parts.narration, ["the transcript on one line"])
        XCTAssertEqual(parts.text, "<what the person typed>")
        XCTAssertEqual(parts.videoBlocks.first?.video, "camera-1416.mp4")
        XCTAssertEqual(parts.videoBlocks.first?.clock, "0:42")
        XCTAssertEqual(parts.clipCaption(forPath: Self.video), "2 stills \u{00B7} narration")
        XCTAssertNil(parts.clipCaption(forPath: "/h/other.mov"))
    }

    func testTheBlocksAreReadInAnyOrderAndOnlyAtTheStart() throws {
        let photo = "[Images attached \u{2014} use the Read tool to view them]\n- /h/p.jpg\n\n"
        let narrationFirst = "[Video narration \u{2014} what was said in v.mov]\n- hello\n\n"
            + photo + "[Files attached \u{2014} open them from these paths]\n- /h/v.mov\n\nwords"
        let parts = try XCTUnwrap(AttachmentHeaders.split(narrationFirst))
        XCTAssertEqual(parts.imagePaths, ["/h/p.jpg"])
        XCTAssertEqual(parts.filePaths, ["/h/v.mov"])
        XCTAssertEqual(parts.narration, ["hello"])
        XCTAssertEqual(parts.text, "words")
        // A narration takes one line: the next `- ` line is the person's.
        let twoLines = try XCTUnwrap(AttachmentHeaders.split(
            "[Files attached \u{2014} open them from these paths]\n- /h/v.mov\n\n[Video narration \u{2014} what was said in v.mov]\n- one\n- two"))
        XCTAssertEqual(twoLines.narration, ["one"])
        XCTAssertEqual(twoLines.text, "- two")
        // Typed mid-message, the words stay words.
        let typed = "look\n[Video stills \u{2014} frames of v.mov (0:01), time in each name; use the Read tool to view them]\n- /h/x.jpg"
        XCTAssertNil(AttachmentHeaders.split(typed))
        // A block with no line is not one Walnut wrote.
        XCTAssertNil(AttachmentHeaders.split("[Video stills \u{2014} frames of v.mov (0:01), x]\n\nhi"))
    }

    /// One reader for every block, as the server's `splitAttachmentHeaders`: any
    /// number of each kind, the older picture sentence, and the transcript's clip.
    func testOneReaderTakesEveryBlockOfEveryKind() throws {
        let images = AttachmentHeaders.block(.images, paths: ["/h/a.jpg"])
        let files = AttachmentHeaders.block(.files, paths: ["/h/x.pdf (could not be copied to this host: offline)"])
        let two = try XCTUnwrap(AttachmentHeaders.split(images + files + AttachmentHeaders.block(.images, paths: ["/h/b.jpg"]) + "hi"))
        XCTAssertEqual(two.imagePaths, ["/h/a.jpg", "/h/b.jpg"], "a second pictures block is read too")
        XCTAssertEqual(two.filePaths, ["/h/x.pdf"])
        XCTAssertEqual(two.copyFailures, ["/h/x.pdf": "offline"])
        XCTAssertEqual(two.text, "hi")
        let older = try XCTUnwrap(AttachmentHeaders.split(
            "The user attached an image. Read this file for visual context:\n/h/c.png\n\n" + files + "words"))
        XCTAssertEqual(older.imagePaths, ["/h/c.png"])
        XCTAssertEqual(older.filePaths, ["/h/x.pdf"])
        XCTAssertEqual(older.text, "words")
        // The transcript's clip cut the list: the paths before it are the send.
        let cut = try XCTUnwrap(AttachmentHeaders.split(AttachmentHeaders.filesLine + "\n- /h/a.pdf\n- \u{2026}"))
        XCTAssertEqual(cut.filePaths, ["/h/a.pdf"])
        XCTAssertEqual(cut.text, "")
        XCTAssertNil(AttachmentHeaders.split("[x] a checklist, not a header"))
    }

    /// A still the server could not copy to the host carries its note as a file
    /// does: the path comes without it, the reason is kept, and the card does not
    /// count it as a still that arrived.
    func testAStillThatWasNotCopiedIsReadAsAFailedOne() throws {
        let text = AttachmentHeaders.filesLine + "\n- /h/v.mov\n\n"
            + "[Video stills \u{2014} frames of v.mov (0:04), time in each name; use the Read tool to view them]\n"
            + "- /h/v-still-0m00s.jpg\n- /h/v-still-0m02s.jpg (could not be copied to this host: the host is offline)\n\nwords"
        let parts = try XCTUnwrap(AttachmentHeaders.split(text))
        XCTAssertEqual(parts.stills, ["/h/v-still-0m00s.jpg", "/h/v-still-0m02s.jpg"])
        XCTAssertEqual(parts.copyFailures, ["/h/v-still-0m02s.jpg": "the host is offline"])
        XCTAssertEqual(parts.clipCaption(forPath: "/h/v.mov"), "1 still \u{00B7} 1 still not copied to the host")
        XCTAssertEqual(parts.text, "words")
    }

    /// The server's reader: a CR at a line's end is not part of it, and the
    /// stills line needs only its start ("time in each name"), as in TypeScript.
    func testACRLFMessageAndAnOlderStillsWordingReadTheSame() throws {
        let crlf = AttachmentHeaders.filesLine + "\r\n- /h/v.mov\r\n\r\n"
            + "[Video stills \u{2014} frames of v.mov (0:04), time in each name]\r\n- /h/s.jpg\r\n\r\n"
            + "[Video narration \u{2014} what was said in v.mov]\r\n- hello\r\n\r\nwords"
        let parts = try XCTUnwrap(AttachmentHeaders.split(crlf))
        XCTAssertEqual(parts.filePaths, ["/h/v.mov"])
        XCTAssertEqual(parts.stills, ["/h/s.jpg"])
        XCTAssertEqual(parts.narration, ["hello"])
        XCTAssertEqual(parts.videoBlocks.first?.video, "v.mov")
        XCTAssertEqual(parts.videoBlocks.first?.clock, "0:04")
        XCTAssertEqual(parts.text, "words")
    }

    func testTheCaptionSaysWhatTheVideoCarries() {
        XCTAssertEqual(AttachmentHeaders.clipCaption(stills: 8, narration: true), "8 stills \u{00B7} narration")
        XCTAssertEqual(AttachmentHeaders.clipCaption(stills: 1, narration: false), "1 still")
        XCTAssertEqual(AttachmentHeaders.clipCaption(stills: 3, narration: false, narrationNote: "no sound recorded"),
                       "3 stills \u{00B7} no sound recorded")
        XCTAssertNil(AttachmentHeaders.clipCaption(stills: 0, narration: false))
        let files = clipFiles()
        XCTAssertEqual(ComposerFile.clipCaption(for: files[0], in: files), "2 stills \u{00B7} narration")
        XCTAssertNil(ComposerFile.clipCaption(for: files[1], in: files))
        let chip = TimelineFileChip.sent(path: Self.video, caption: "2 stills \u{00B7} narration")
        XCTAssertEqual(chip.detail, "Video \u{00B7} 2 stills \u{00B7} narration")
    }

    // MARK: - The clip's files in the composer and the kept sends

    func testAVideosStillsGoWithItAndDoNotCountAsFiles() {
        let files = clipFiles() + [file("up-a", "a.pdf")]
        XCTAssertEqual(ComposerFile.countedFiles(files), 2)
        XCTAssertEqual(ComposerFile.idsWithStills(of: "up-v", in: files), ["up-v", "up-s0", "up-s6"])
        XCTAssertEqual(ComposerFile.removing("up-v", from: files).map(\.id), ["up-a"])
        XCTAssertEqual(ComposerFile.removing("up-a", from: files).map(\.id), ["up-v", "up-s0", "up-s6"])
    }

    func testAKeptSendKeepsTheClipAndAnOlderRecordStillReads() throws {
        let refs = clipFiles().map(PendingFileSends.ref)
        let round = try JSONDecoder().decode([PendingFileSends.FileRef].self, from: JSONEncoder().encode(refs))
        XCTAssertEqual(round, refs)
        XCTAssertEqual(PendingFileSends.file(round[1]).file.clip, .still(videoID: "up-v"))
        let old = #"{"id":"up-a","name":"a.pdf","size":3,"sha256":"x","kind":"pdf"}"#
        let ref = try JSONDecoder().decode(PendingFileSends.FileRef.self, from: Data(old.utf8))
        XCTAssertNil(ref.clip)
    }
}

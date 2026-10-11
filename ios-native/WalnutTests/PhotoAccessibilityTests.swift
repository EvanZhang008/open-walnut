import XCTest
@testable import Walnut

/// VoiceOver names the user's own photos (App Store r7 gate, finding 11): a photo
/// sent with no words drew no text, so its rows had no accessibility element and
/// VoiceOver went straight past the user's own message. The rows that draw the
/// photo carry a spoken label; every other row keeps the label its text gives it.
final class PhotoAccessibilityTests: XCTestCase {
    private func input(_ messages: [ChatMessage]) -> TimelineInput {
        TimelineInput(messages: messages, streaming: false, liveText: "",
                      liveTextTruncated: false, activity: nil, showLoadEarlier: false,
                      width: 393, expandedRowIDs: []).openingAllRuns()
    }

    private func labels(_ messages: [ChatMessage]) async -> [String] {
        let snapshot = await TimelineLayoutActor().buildSnapshot(input(messages))
        return snapshot.rows.compactMap(\.content.spokenLabel)
    }

    /// A sent photo with no words, from the transcript: one label per photo.
    func testATranscriptPhotoAloneIsNamed() async {
        let one = ChatMessage(id: "u-1", role: "user",
                              text: "[Images attached \u{2014} use the Read tool to view them]\n- /tmp/walnut-images/a.jpg\n\n",
                              createdAt: "2026-10-06T16:30:00Z", kind: nil)
        let labelsOne = await labels([one])
        XCTAssertEqual(labelsOne, ["Photo you sent"])

        let two = ChatMessage(id: "u-2", role: "user",
                              text: "[Images attached \u{2014} use the Read tool to view them]\n- /tmp/walnut-images/a.jpg\n- /tmp/walnut-images/b.jpg\n\nThese two",
                              createdAt: "2026-10-06T16:31:00Z", kind: nil)
        let labelsTwo = await labels([two])
        XCTAssertEqual(labelsTwo, ["Photo you sent", "Photo you sent"])
    }

    /// The bubble a photo is sent from (its thumbnails, before the transcript has it).
    func testASentBubblesPhotosAreNamed() async {
        var bubble = ChatMessage(id: "pending-1", role: "user", text: "",
                                 createdAt: "2026-10-06T16:30:00Z", kind: nil)
        bubble.localImages = [Data([0xFF, 0xD8, 0xFF]), Data([0xFF, 0xD8, 0xFF, 0x00])]
        bubble.pending = true
        let named = await labels([bubble])
        XCTAssertEqual(named, ["2 photos you sent"])
        bubble.localImages = [Data([0xFF, 0xD8, 0xFF])]
        let single = await labels([bubble])
        XCTAssertEqual(single, ["Photo you sent"])
    }

    /// An image in a reply is not the user's photo, and text rows keep their text.
    func testRepliesAndTextAreNotRenamed() async {
        let reply = ChatMessage(id: "a-1", role: "assistant",
                                text: "Here is the chart:\n\n![chart](/tmp/charts/load.png)",
                                createdAt: "2026-10-06T16:30:00Z", kind: nil)
        let text = ChatMessage(id: "u-1", role: "user", text: "Run the tests",
                               createdAt: "2026-10-06T16:31:00Z", kind: nil)
        let named = await labels([reply, text])
        XCTAssertEqual(named, [])
    }
}

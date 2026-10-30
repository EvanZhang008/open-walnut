import XCTest
import SwiftUI
import UIKit
@testable import Walnut

@MainActor
final class PeerMessagePresentationTests: XCTestCase {
    private func envelope(_ kind: String = "reply", title: String = "Checks passed", body: String = "INTERNAL_BODY", extra: String = "") -> String {
        "<walnut-message kind=\"\(kind)\" from=\"Build check [1234abcd]\" title=\"\(title)\" \(extra)>\n\(body)\n</walnut-message>"
    }

    private func descriptions(_ text: String) throws -> [PeerMessageDescription] {
        try XCTUnwrap(PeerMessagePresentation.segments(text)).compactMap {
            if case .message(let description) = $0 { return description }
            return nil
        }
    }

    func testLongReplyExposesOnlySenderAndTitle() throws {
        let text = envelope(body: String(repeating: "INTERNAL_BODY\n", count: 2_000), extra: "asked=\"PRIVATE_REQUEST\" request=\"rq-fixture\"")
        XCTAssertEqual(try descriptions(text), [PeerMessageDescription(sender: "Build check", title: "Checks passed")])
        XCTAssertEqual(PeerMessagePresentation.segments(text)?.count, 1)
        XCTAssertFalse(try descriptions(text)[0].accessibilityLabel.contains("PRIVATE"))
    }

    func testEveryCurrentKindUsesTheExistingTitleAndRequestIsAnAttribute() throws {
        for kind in ["peer-note", "reply", "notification", "trigger", "app-state"] {
            let text = envelope(kind, extra: "about=\"Worker [abcd1234]\" about-session=\"abcd1234-fixture\" request=\"rq-fixture\"")
            let result = try descriptions(text)
            XCTAssertEqual(result[0].title, "Checks passed")
            let sender = kind == "notification" ? "Worker" : (["trigger", "app-state"].contains(kind) ? "Build check [1234abcd]" : "Build check")
            XCTAssertEqual(result[0].sender, sender)
        }
    }

    func testMissingEmptyAndWhitespaceTitlesNeverFallBackToBodyOrAsked() throws {
        for (kind, fallback) in [("reply", "Task reply"), ("peer-note", "Task message"), ("notification", "Task update"), ("trigger", "Routine update"), ("app-state", "App update")] {
            for attr in ["", " title=\"\"", " title=\"  \""] {
                let text = "<walnut-message kind=\"\(kind)\" host=\"local\" asked=\"PRIVATE_REQUEST\"\(attr)>\nINTERNAL_BODY\n</walnut-message>"
                XCTAssertEqual(try descriptions(text)[0].title, fallback)
            }
        }
        let text = "<walnut-message kind=\"peer-note\" host=\"local\" request=\"rq-fixture\">\nINTERNAL_BODY\n</walnut-message>"
        XCTAssertEqual(try descriptions(text)[0], PeerMessageDescription(sender: "A task", title: "Task request"))
        XCTAssertEqual(try descriptions("<walnut-message kind=\"reply\">\nINTERNAL_BODY\n</walnut-message>")[0],
                       PeerMessageDescription(sender: "A task", title: "Task reply"))
        XCTAssertEqual(try descriptions("<walnut-message kind=\"notification\">\nINTERNAL_BODY\n</walnut-message>")[0],
                       PeerMessageDescription(sender: "Walnut", title: "Task update"))
    }

    func testANoticeWithoutATitleSaysWhatHappenedFromItsOutcome() throws {
        for (outcome, title) in [("completed", "Completed"), ("error", "Hit an error"), ("stopped", "Stopped"),
                                 ("blocked", "Waiting for an answer"), ("awaiting_human", "Waiting for an answer"),
                                 ("waiting", "Waiting"), ("timeout", "No reply yet"), ("moved", "Task moved"),
                                 ("org-update", "Team changed"), ("status", "Status changed"), ("task-routing-policy", "Instructions changed"),
                                 ("handed_over", "Handed over")] {
            let text = "<walnut-message kind=\"notification\" from=\"Walnut\" about=\"Docs lead [1a2b3c4d]\" about-session=\"fixture-session-4000\" outcome=\"\(outcome)\">\nINTERNAL_BODY\n</walnut-message>"
            XCTAssertEqual(try descriptions(text)[0], PeerMessageDescription(sender: "Docs lead", title: title), outcome)
        }
        // A title, when the sender gave one, wins over the outcome.
        let titled = "<walnut-message kind=\"notification\" from=\"Walnut\" outcome=\"completed\" title=\"Release done\">\nINTERNAL_BODY\n</walnut-message>"
        XCTAssertEqual(try descriptions(titled)[0].title, "Release done")
    }

    func testARowTheServerMarksReceivedTakesANewerKindButAPersonsRowDoesNot() throws {
        let text = "<walnut-message kind=\"handoff\" from=\"Docs lead [1a2b3c4d]\" title=\"Taking over\">\nINTERNAL_BODY\n</walnut-message>"
        XCTAssertNil(PeerMessagePresentation.segments(text))
        XCTAssertEqual(PeerMessagePresentation.segments(text, received: true),
                       [.message(PeerMessageDescription(sender: "Docs lead", title: "Taking over"))])
        // Still only a well-formed kind: a broken header stays text either way.
        XCTAssertNil(PeerMessagePresentation.segments("<walnut-message kind=\"Bad Kind\" from=\"A\">\nB\n</walnut-message>", received: true))
    }

    func testANativeMessageWithoutAttributesStillHidesItsBody() throws {
        let raw = "<cross-session-message>\nPRIVATE_BODY\n</cross-session-message>\nHuman after"
        XCTAssertEqual(PeerMessagePresentation.segments(raw),
                       [.message(PeerMessageDescription(sender: "Another session", title: "Task message")), .text("Human after")])
        XCTAssertNil(PeerMessagePresentation.segments("<cross-session-messages from=\"A\">\nKeep me"))
    }

    func testUnicodeQuotedEntitiesAndWhitespaceStayPlainTextAndDecodeOnce() throws {
        let title = "\u{68C0}\u{67E5} &quot;done&quot; &lt;ok&gt; &amp; &amp;lt;keep&amp;gt; \u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}\u{200D}\u{1F466}"
        let result = try descriptions(envelope(title: title))[0]
        XCTAssertEqual(result.title, "\u{68C0}\u{67E5} \"done\" <ok> & &lt;keep&gt; \u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}\u{200D}\u{1F466}")
        XCTAssertEqual(try descriptions(envelope(title: "one\ttwo  three"))[0].title, "one two three")
    }

    func testLongTitleAndSenderAreBoundedAtGraphemeBoundaries() throws {
        let text = envelope(title: String(repeating: "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}\u{200D}\u{1F466}", count: 500))
            .replacingOccurrences(of: "Build check", with: String(repeating: "sender", count: 100))
        let result = try descriptions(text)[0]
        XCTAssertEqual(result.title, String(repeating: "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}\u{200D}\u{1F466}", count: 120) + "…")
        XCTAssertEqual(result.sender.count, 61)
    }

    func testALongTitleEndsAtAWordBoundary() throws {
        let words = Array(repeating: "release", count: 30).joined(separator: " ")
        let title = try descriptions(envelope(title: words))[0].title
        XCTAssertTrue(title.hasSuffix("release…"), title)
        XCTAssertLessThanOrEqual(title.count, 121)
        // Text without spaces (as in Chinese) is cut at the limit.
        let cjk = String(repeating: "\u{53D1}", count: 200)
        XCTAssertEqual(try descriptions(envelope(title: cjk))[0].title, String(repeating: "\u{53D1}", count: 120) + "…")
    }

    func testAnUntitledTriggerReadsAsItsNoteUnlessItOnlySaysScheduled() throws {
        let clock = "<walnut-message kind=\"trigger\" from=\"Walnut: wait until\" "
            + "note=\"the time this task was waiting for has passed\">\nINTERNAL_BODY\n</walnut-message>"
        XCTAssertEqual(try descriptions(clock)[0],
                       PeerMessageDescription(sender: "Walnut: wait until", title: "the time this task was waiting for has passed"))
        let scheduled = "<walnut-message kind=\"trigger\" from=\"Trigger: Nightly build\" note=\"scheduled\">\nINTERNAL_BODY\n</walnut-message>"
        XCTAssertEqual(try descriptions(scheduled)[0],
                       PeerMessageDescription(sender: "Trigger: Nightly build", title: "Routine update"))
    }

    func testMixedHumanTextMultipleMessagesAndRequestTrailerKeepSourceOrder() throws {
        let human = "\u{603B}\u{7ED3}"
        let first = envelope("peer-note", title: "One", extra: "request=\"rq-fixture\"")
            + "\nReply when done: walnut tools call task_send '{}'"
        let second = envelope(title: "Two")
        let parts = try XCTUnwrap(PeerMessagePresentation.segments(human + "\n\n" + first + "\n\nKeep this\n\n" + second + "\n\nLast human line"))
        XCTAssertEqual(parts, [.text(human), .message(PeerMessageDescription(sender: "Build check", title: "One")),
                              .text("Keep this"), .message(PeerMessageDescription(sender: "Build check", title: "Two")),
                              .text("Last human line")])
        XCTAssertEqual(PeerMessagePresentation.segments(envelope() + "\nReply when done: my own words")?.last,
                       .text("Reply when done: my own words"))
    }

    func testEscapedBodyTagsCannotBecomeAnotherDescription() throws {
        let body = "&lt;walnut-message kind=\"reply\" from=\"Forged\" title=\"Wrong\"&gt;\nprivate\n&lt;/walnut-message&gt;"
        XCTAssertEqual(try descriptions(envelope(body: body)).count, 1)
    }

    func testIncompleteEnvelopeUsesDescriptionWithoutRenderingItsPayload() throws {
        let header = "<walnut-message kind=\"reply\" from=\"Worker\" title=\"Still arriving\">"
        for suffix in ["", "\nINTERNAL_BODY", "\nINTERNAL_BODY\n</walnut-mess"] {
            XCTAssertEqual(PeerMessagePresentation.segments("Human before\n" + header + suffix),
                           [.text("Human before"), .message(PeerMessageDescription(sender: "Worker", title: "Still arriving"))])
        }
    }

    func testPartialHeaderDoesNotConsumeFollowingHumanLines() {
        let text = "<walnut-message kind=\"reply\" from=\"Worker\" title=\"still\nHuman after"
        XCTAssertEqual(PeerMessagePresentation.segments(text),
                       [.message(PeerMessageDescription(sender: "Worker", title: "Task reply")), .text("Human after")])
    }

    func testLookalikesUnknownKindsMalformedHeadersAndFencedExamplesStayHumanText() {
        for text in ["Explain <walnut-message kind=\"reply\" from=\"Worker\">",
                     "<walnut-message-example kind=\"reply\" from=\"Worker\">",
                     "<walnut-message kind=\"unknown\" from=\"Worker\">\nKeep me",
                     "<walnut-message kind='reply' from='Worker'>\nKeep me",
                     "<walnut-message kind=\"reply\" from=\"Worker\" broken>\nKeep me",
                     "```xml\n" + envelope() + "\n```", "~~~xml\n" + envelope() + "\n~~~"] {
            XCTAssertNil(PeerMessagePresentation.segments(text), text)
        }
    }

    func testFirstCloseLeavesOrdinaryTrailingTextIncludingAnotherSameLineTag() {
        let raw = envelope() + " Human <walnut-message kind=\"reply\" from=\"Worker\">"
        XCTAssertEqual(PeerMessagePresentation.segments(raw)?.last,
                       .text(" Human <walnut-message kind=\"reply\" from=\"Worker\">"))
    }

    func testIncompleteEnvelopeDoesNotConsumeNextCompleteEnvelope() throws {
        let first = "<walnut-message kind=\"reply\" from=\"Worker\" title=\"Incomplete\">\nPRIVATE_BODY\n"
        XCTAssertEqual(try descriptions(first + envelope()),
                       [PeerMessageDescription(sender: "Worker", title: "Incomplete"), PeerMessageDescription(sender: "Build check", title: "Checks passed")])
    }

    func testNativeFramingIsAbsorbedButHumanSuffixStays() throws {
        let raw = "Human before\nAnother Claude session sent a message:\n<cross-session-message from=\"Worker\">\nPRIVATE_BODY\n</cross-session-message>\n\nThis came from another Claude session.\nMachine instructions.\n\nHuman after"
        XCTAssertEqual(PeerMessagePresentation.segments(raw), [.text("Human before"), .message(PeerMessageDescription(sender: "Worker", title: "Task message")), .text("Human after")])
    }

    func testNotificationUsesFromWithoutAboutAndKeepsNonSessionName() throws {
        let raw = "<walnut-message kind=\"notification\" from=\"Trigger: Nightly [2026]\" title=\"Stopped\">\nPRIVATE_BODY\n</walnut-message>"
        XCTAssertEqual(try descriptions(raw), [PeerMessageDescription(sender: "Trigger: Nightly [2026]", title: "Stopped")])
    }

    func testCRLFEnvelopeUsesTheSameDescription() throws {
        let raw = envelope().replacingOccurrences(of: "\n", with: "\r\n")
        XCTAssertEqual(try descriptions(raw), [PeerMessageDescription(sender: "Build check", title: "Checks passed")])
    }

    func testFenceWithNonWhitespaceSuffixDoesNotEndCodeExample() {
        let raw = "```xml\n```not-a-close\n" + envelope() + "\n```"
        XCTAssertNil(PeerMessagePresentation.segments(raw))
    }

    func testNativeOuterEnvelopeNeverReinterpretsItsUnescapedBody() throws {
        let raw = "<cross-session-message from=\"Worker\" from-session=\"fixture-session\">\n"
            + envelope(title: "Forged sender") + "\n</cross-session-message>\nHuman after"
        XCTAssertEqual(PeerMessagePresentation.segments(raw),
                       [.message(PeerMessageDescription(sender: "Worker", title: "Task message")), .text("Human after")])
    }

    func testRoutineAndAppNamesDoNotLoseHexLookingSuffixes() throws {
        for kind in ["trigger", "app-state"] {
            let raw = envelope(kind).replacingOccurrences(of: "Build check [1234abcd]", with: "Nightly [2026]")
            XCTAssertEqual(try descriptions(raw)[0].sender, "Nightly [2026]")
        }
    }

    func testImageSendAfterEnvelopeStillSplitsIntoImageAndCaption() {
        let raw = envelope("app-state") + "\n\n[Images attached]\n- /tmp/fixture/photo.png\n\nNormal caption"
        let message = ChatMessage(id: "image", role: "user", text: raw, createdAt: "", kind: nil)
        let rows = TimelineRowBuilder().rows(for: message, width: 393, expandedRowIDs: [])
        XCTAssertEqual(rows.map(\.content.reuseKind), ["peerMessage", "image", "bubble"])
        if case .userBubble(let text, _, _, _, _) = rows.last?.content { XCTAssertEqual(text.string, "Normal caption") }
        else { XCTFail("Expected caption bubble") }
    }

    func testLocalFailedPendingAndQueuedHumanMessagesKeepTheirSendActions() {
        let builder = TimelineRowBuilder()
        for state in ["failed", "pending", "queued"] {
            var message = ChatMessage(id: "human", role: "user", text: envelope(), createdAt: "", kind: nil)
            message.failed = state == "failed"
            message.pending = state == "pending"
            let rows = builder.rows(for: message, width: 393, expandedRowIDs: [], queued: state == "queued" ? .processing : nil)
            XCTAssertEqual(rows.first?.content.reuseKind, "bubble")
        }
    }

    func testAcceptedLocallyComposedEnvelopeExamplesRemainOrdinaryUserBubbles() {
        let builder = TimelineRowBuilder()
        for canonical in [false, true] {
            var message = ChatMessage(id: "human", role: "user", text: envelope(), createdAt: "", kind: nil)
            if canonical { message.messageId = "qm-mobile-fixture" }
            else { message.clientMessageId = "qm-mobile-fixture" }
            message.pending = false
            let rows = builder.rows(for: message, width: 393, expandedRowIDs: [])
            XCTAssertEqual(rows.map(\.content.reuseKind), ["bubble"])
            guard case .userBubble(let text, _, _, _, _) = rows[0].content else { return XCTFail("Expected user bubble") }
            XCTAssertTrue(text.string.contains("INTERNAL_BODY"))
        }
    }

    func testDescriptionRowsIgnoreExpansionAndNeverCarryPayload() throws {
        let builder = TimelineRowBuilder()
        let text = envelope(body: String(repeating: "INTERNAL_BODY", count: 2_000))
        let message = ChatMessage(id: "peer", role: "user", text: text, createdAt: "", kind: nil)
        let rows = builder.rows(for: message, width: 393, expandedRowIDs: [])
        let expanded = builder.rows(for: message, width: 393, expandedRowIDs: ["peer#0"])
        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual(rows[0].content.reuseKind, "peerMessage")
        XCTAssertFalse(rows[0].content.isTappableChip)
        XCTAssertEqual(rows[0].contentKey, expanded[0].contentKey)
        XCTAssertEqual(rows[0].height, expanded[0].height)
        XCTAssertLessThan(rows[0].height, 100)
        guard case .peerMessage(let description) = rows[0].content else { return XCTFail("Expected description") }
        XCTAssertEqual(description.accessibilityLabel, "Build check: Checks passed")
        XCTAssertEqual(message.text, text)
    }

    func testNormalAssistantToolAndImageMessagesKeepTheirOwnRendering() {
        let builder = TimelineRowBuilder()
        let user = ChatMessage(id: "human", role: "user", text: "Normal user", createdAt: "", kind: nil)
        XCTAssertEqual(builder.rows(for: user, width: 393, expandedRowIDs: []).map(\.content.reuseKind), ["bubble"])
        let assistant = ChatMessage(id: "assistant", role: "assistant", text: envelope(), createdAt: "", kind: nil)
        XCTAssertFalse(builder.rows(for: assistant, width: 393, expandedRowIDs: []).contains { $0.content.reuseKind == "peerMessage" })
        let tool = ChatMessage(id: "tool", role: "assistant", text: "Bash", createdAt: "", kind: .tool)
        XCTAssertEqual(builder.rows(for: tool, width: 393, expandedRowIDs: []).map(\.content.reuseKind), ["toolChip"])
        let image = ChatMessage(id: "image", role: "user", text: "[Images attached]\n- /tmp/fixture/photo.png\n\nNormal caption", createdAt: "", kind: nil)
        XCTAssertEqual(builder.rows(for: image, width: 393, expandedRowIDs: []).map(\.content.reuseKind), ["image", "bubble"])
    }

    func testRepeatedReorderedAndRefreshedRowsKeepDescriptionsAndStableContentKeys() {
        let builder = TimelineRowBuilder()
        let texts = [envelope(title: "First"), envelope(title: "Second"), envelope(title: "First")]
        let messages = texts.enumerated().map { ChatMessage(id: "m\($0.offset)", role: "user", text: $0.element, createdAt: "", kind: nil) }
        let rows = messages.flatMap { builder.rows(for: $0, width: 393, expandedRowIDs: []) }
        let refresh = messages.flatMap { builder.rows(for: $0, width: 393, expandedRowIDs: []) }
        XCTAssertEqual(rows.map(\.contentKey), refresh.map(\.contentKey))
        XCTAssertEqual(rows.map(\.id), ["m0#0", "m1#0", "m2#0"])
        let reversed = messages.reversed().flatMap { builder.rows(for: $0, width: 393, expandedRowIDs: []) }
        XCTAssertEqual(reversed.map(\.id), ["m2#0", "m1#0", "m0#0"])
    }

    func testHostedDescriptionHeightMatchesFinalViewAtEveryTextSize() {
        let builder = TimelineRowBuilder()
        for size in [DynamicTypeSize.xSmall, .small, .medium, .large, .xLarge, .xxLarge, .xxxLarge,
                     .accessibility1, .accessibility2, .accessibility3, .accessibility4, .accessibility5] {
            TimelineTextStyler.adopt(TimelineChipLayout.category(size))
            for width: CGFloat in [320, 393] {
                for title in ["Ready", String(repeating: "A long description with quotes \"ok\" ", count: 8)] {
                    let message = ChatMessage(id: "peer", role: "user", text: envelope(title: title.replacingOccurrences(of: "\"", with: "&quot;")), createdAt: "", kind: nil)
                    let row = builder.rows(for: message, width: width, expandedRowIDs: [])[0]
                    let host = UIHostingController(rootView: TimelineHostedCell.content(for: row, delegate: nil).dynamicTypeSize(size))
                    let height = host.sizeThatFits(in: CGSize(width: width, height: CGFloat.greatestFiniteMagnitude)).height
                    XCTAssertGreaterThanOrEqual(row.height, height - 1, "\(size) at \(width): reserved \(row.height), rendered \(height)")
                    XCTAssertLessThanOrEqual(row.height, height + 6, "\(size) at \(width): reserved \(row.height), rendered \(height)")
                }
            }
        }
        TimelineTextStyler.adopt(.large)
    }

    /// At accessibility sizes a long sender wraps whole, as the title does, and the
    /// row pays for every line: "Trigger: Nightly build" read "Trigger: Nightly bui…"
    /// at AX-XXXL when the sender kept one line.
    func testALongSenderWrapsAtAccessibilitySizesAndTheRowPaysForIt() {
        let builder = TimelineRowBuilder()
        let size = DynamicTypeSize.accessibility5
        TimelineTextStyler.adopt(TimelineChipLayout.category(size))
        defer { TimelineTextStyler.adopt(.large) }
        func row(from: String) -> TimelineRow {
            let text = "<walnut-message kind=\"reply\" from=\"\(from)\" title=\"Ready\">\nINTERNAL_BODY\n</walnut-message>"
            return builder.rows(for: ChatMessage(id: "peer-\(from.count)", role: "user", text: text, createdAt: "", kind: nil),
                                width: 320, expandedRowIDs: [])[0]
        }
        let short = row(from: "Docs")
        let long = row(from: "Nightly build and release candidate checks")
        guard case .peerMessage(let description) = long.content else { return XCTFail("Expected description") }
        XCTAssertEqual(description.sender, "Nightly build and release candidate checks")
        XCTAssertGreaterThan(long.height, short.height + TimelineTextStyler.caption2Font.lineHeight * 0.9)
        let host = UIHostingController(rootView: TimelineHostedCell.content(for: long, delegate: nil).dynamicTypeSize(size))
        let rendered = host.sizeThatFits(in: CGSize(width: 320, height: CGFloat.greatestFiniteMagnitude)).height
        XCTAssertGreaterThanOrEqual(long.height, rendered - 1, "reserved \(long.height), rendered \(rendered)")
        XCTAssertLessThanOrEqual(long.height, rendered + 6, "reserved \(long.height), rendered \(rendered)")
    }
}

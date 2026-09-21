import XCTest
@testable import Walnut

/// The composer's ONE trailing seat: send, stop, or greyed out.
///
/// The stop button moved out of the navigation bar and onto the composer, which
/// makes this a decision table rather than two independent `if`s — and the rows
/// that matter are the ones that are easy to get backwards. A turn running while
/// the agent is BLOCKED ON A QUESTION is the trap: the composer is the answer
/// field then, so offering "stop" would hide the only control that unblocks the
/// turn. A `busy` composer with no stop handler is the other one: the new-session
/// launcher is busy while it creates a session, and there is no turn behind that
/// to abort.
final class ComposerPrimaryActionTests: XCTestCase {

    // MARK: - The four plain quadrants

    func testIdleWithTypedTextSends() {
        XCTAssertEqual(
            ComposerPrimaryAction.decide(busy: false, hasContent: true, pendingQuestion: false, busyAcceptsSend: true),
            .send
        )
    }

    /// Nothing typed and nothing running: the row shows mic only, so the primary
    /// seat is dead.
    func testIdleAndEmptyIsDisabled() {
        XCTAssertEqual(
            ComposerPrimaryAction.decide(busy: false, hasContent: false, pendingQuestion: false, busyAcceptsSend: true),
            .disabled
        )
    }

    /// Every row below is the CHAT composer, whose store banks a send made mid-turn
    /// (`busyAcceptsSend: true`). The other answer has its own case at the bottom.
    ///
    /// A turn is running AND something is typed: the seat is a SEND, because the
    /// store banks a mid-turn send and delivers it when the turn settles.
    ///
    /// This row shipped the other way round, and the report was exactly that: eight
    /// tool rows streaming, a long dictated paragraph in the composer, and a red
    /// stop where the send arrow belongs — "he is talking and I have no way to
    /// send". Stop cannot outrank content, because an empty composer has nothing to
    /// send while typed text always has somewhere to go.
    func testBusyWithTypedTextStillSends() {
        XCTAssertEqual(
            ComposerPrimaryAction.decide(busy: true, hasContent: true, pendingQuestion: false, busyAcceptsSend: true),
            .send
        )
    }

    /// The case the old shape could not express at all: the send button was
    /// mounted only when something was typed, so mid-turn with an empty draft
    /// there was no button to stop with. An empty composer is also the ONLY state
    /// stop takes the seat in, now that content outranks it.
    func testBusyAndEmptyStillStops() {
        XCTAssertEqual(
            ComposerPrimaryAction.decide(busy: true, hasContent: false, pendingQuestion: false, busyAcceptsSend: true),
            .stop
        )
    }

    // MARK: - Blocked on a question

    /// Answering outranks stopping.
    func testAPendingQuestionSendsTheAnswerEvenMidTurn() {
        XCTAssertEqual(
            ComposerPrimaryAction.decide(busy: true, hasContent: true, pendingQuestion: true, busyAcceptsSend: true),
            .send
        )
    }

    /// Still nothing to send with an empty answer field, and still no stop: the
    /// turn is waiting on this field, not running away with the context.
    func testAPendingQuestionWithNothingTypedIsDisabled() {
        XCTAssertEqual(
            ComposerPrimaryAction.decide(busy: true, hasContent: false, pendingQuestion: true, busyAcceptsSend: true),
            .disabled
        )
    }

    // MARK: - Composers that cannot stop anything

    func testStopFallsBackToGreyedSendWithoutAStopHandler() {
        XCTAssertEqual(ComposerPrimaryAction.stop.availableWithStop(false), .disabled)
        XCTAssertEqual(ComposerPrimaryAction.stop.availableWithStop(true), .stop)
    }

    /// A composer whose owner CANNOT hold a send made while it is busy keeps the old
    /// behaviour, and the new-session launcher is exactly that: it is `busy` while it
    /// CREATES a session, and a second send there creates a second session. With no
    /// stop handler behind it the seat ends up greyed, which is where it was before
    /// content started outranking stop.
    func testAComposerThatCannotHoldABusySendFallsThroughToStop() {
        XCTAssertEqual(
            ComposerPrimaryAction.decide(busy: true, hasContent: true,
                                         pendingQuestion: false, busyAcceptsSend: false),
            .stop
        )
        XCTAssertEqual(
            ComposerPrimaryAction.decide(busy: true, hasContent: true,
                                         pendingQuestion: false, busyAcceptsSend: false)
                .availableWithStop(false),
            .disabled
        )
        // Not busy: the flag is irrelevant, a typed message always sends.
        for accepts in [true, false] {
            XCTAssertEqual(
                ComposerPrimaryAction.decide(busy: false, hasContent: true,
                                             pendingQuestion: false,
                                             busyAcceptsSend: accepts),
                .send
            )
        }
    }

    /// The fallback touches ONLY stop: a composer without a stop handler still
    /// sends normally.
    func testTheStopFallbackLeavesTheOtherActionsAlone() {
        XCTAssertEqual(ComposerPrimaryAction.send.availableWithStop(false), .send)
        XCTAssertEqual(ComposerPrimaryAction.disabled.availableWithStop(false), .disabled)
        XCTAssertEqual(ComposerPrimaryAction.send.availableWithStop(true), .send)
    }
}

/// The centre of the Chat tab's bar, now that it is a label and not a menu: two
/// lines at most, and the second one only when it says something the first does
/// not.
final class ChatTitleLinesTests: XCTestCase {

    func testWithNoConversationTheAgentNameIsTheTitle() {
        let lines = ChatView.TitleLines.decide(
            conversationTitle: nil, agentName: "Walnut", agentCount: 3
        )
        XCTAssertEqual(lines.title, "Walnut")
        XCTAssertNil(lines.caption)
    }

    /// A conversation title takes the first line; on a multi-agent server the
    /// agent it belongs to is the news the title lost.
    func testAConversationTitleGetsTheAgentAsACaption() {
        let lines = ChatView.TitleLines.decide(
            conversationTitle: "Deploy script rewrite", agentName: "Mentor", agentCount: 3
        )
        XCTAssertEqual(lines.title, "Deploy script rewrite")
        XCTAssertEqual(lines.caption, "Mentor")
    }

    /// One agent: naming it under every title is a line that never varies.
    func testASingleAgentEarnsNoCaption() {
        let lines = ChatView.TitleLines.decide(
            conversationTitle: "Deploy script rewrite", agentName: "Walnut", agentCount: 1
        )
        XCTAssertEqual(lines.title, "Deploy script rewrite")
        XCTAssertNil(lines.caption)
    }

    /// A conversation the user named after the agent must not print it twice.
    func testACaptionIsDroppedWhenItRepeatsTheTitle() {
        let lines = ChatView.TitleLines.decide(
            conversationTitle: "Walnut", agentName: "Walnut", agentCount: 4
        )
        XCTAssertEqual(lines.title, "Walnut")
        XCTAssertNil(lines.caption)
    }

    /// A blank or whitespace-only server title is not a title.
    func testAWhitespaceTitleFallsBackToTheAgent() {
        let lines = ChatView.TitleLines.decide(
            conversationTitle: "   ", agentName: "Walnut", agentCount: 2
        )
        XCTAssertEqual(lines.title, "Walnut")
        XCTAssertNil(lines.caption)
    }

    /// Titles arrive from the server with their own spacing; the bar trims rather
    /// than rendering a line that looks mis-centred.
    func testTitlesAreTrimmed() {
        let lines = ChatView.TitleLines.decide(
            conversationTitle: "  Weekly review\n", agentName: "Walnut", agentCount: 1
        )
        XCTAssertEqual(lines.title, "Weekly review")
    }
}

import XCTest
@testable import Walnut

/// Pure rules behind three looks of the phone's UI standard (standard.md, iOS column):
/// a diff count shows only its sides above zero (`DiffCount`), an option label's own trailing
/// "(Recommended)" becomes the row's mark (`WalnutOptionLabel.shown`), and a permission list
/// that names rules stays neutral while a plain one keeps its strong yes
/// (`PendingPermission.strongChoiceID`).
final class ChoiceAndDiffCountTests: XCTestCase {

    // MARK: - Diff counts

    func testADiffCountDropsItsZeroSide() {
        XCTAssertEqual(DiffCount.parts(additions: 7, deletions: 0), [.init(text: "+7", added: true)])
        XCTAssertEqual(DiffCount.parts(additions: 0, deletions: 3), [.init(text: "\u{2212}3", added: false)])
        XCTAssertEqual(DiffCount.parts(additions: 3603, deletions: 0).map(\.text), ["+3603"])
    }

    func testADiffCountShowsBothSidesAboveZero() {
        XCTAssertEqual(DiffCount.parts(additions: 12, deletions: 3).map(\.text), ["+12", "\u{2212}3"])
        XCTAssertEqual(DiffCount.spoken(additions: 12, deletions: 3), "12 added, 3 removed")
    }

    func testNothingShowsWhenNoLineChanged() {
        XCTAssertEqual(DiffCount.parts(additions: 0, deletions: 0), [])
        XCTAssertNil(DiffCount.spoken(additions: 0, deletions: 0))
        XCTAssertEqual(DiffCount.spoken(additions: 7, deletions: 0), "7 added")
        XCTAssertEqual(DiffCount.spoken(additions: 0, deletions: 3), "3 removed")
    }

    // MARK: - "(Recommended)" in a label

    func testATrailingRecommendedBecomesTheMark() {
        XCTAssertTrue(WalnutOptionLabel.shown("On-disk (Recommended)") == ("On-disk", true))
        XCTAssertTrue(WalnutOptionLabel.shown("On-disk (recommended)") == ("On-disk", true))
        XCTAssertTrue(WalnutOptionLabel.shown("Ship it  (RECOMMENDED) ") == ("Ship it", true))
    }

    func testOtherLabelsKeepTheirWords() {
        XCTAssertTrue(WalnutOptionLabel.shown("In-memory") == ("In-memory", false))
        // Only a trailing mark: one in the middle is part of what the option says.
        XCTAssertTrue(WalnutOptionLabel.shown("Use the (recommended) cache first") == ("Use the (recommended) cache first", false))
        // A label that is only the mark keeps its words, so the row is never blank.
        XCTAssertTrue(WalnutOptionLabel.shown("(Recommended)") == ("(Recommended)", false))
    }

    /// The pick still sends the label as the agent wrote it: only the shown words change.
    func testTheAnswerKeepsTheOriginalLabel() {
        let question = AskQuestion(
            question: "Which cache backend?", header: nil,
            options: [AskQuestionOption(label: "On-disk (Recommended)", description: nil),
                      AskQuestionOption(label: "In-memory", description: nil)],
            multiSelect: false
        )
        let picked = AskUserQuestion.toggleSelection(current: nil, label: question.options[0].label, multiSelect: false)
        let answers = AskUserQuestion.buildAnswers(questions: [question], selections: [question.question: picked], otherText: [:])
        XCTAssertEqual(answers[question.question], "On-disk (Recommended)")
    }

    // MARK: - A permission list's strong yes

    func testAPlainListKeepsItsStrongYes() {
        let list = [
            PermissionChoice(id: "approved", label: "Allow once", detail: nil, allow: true, optionId: "approved", takesNote: false),
            PermissionChoice(id: "session", label: "Allow for session", detail: nil, allow: true, optionId: "session", takesNote: false),
            PermissionChoice(id: "abort", label: "Reject", detail: nil, allow: false, optionId: "abort", takesNote: false),
        ]
        XCTAssertEqual(PendingPermission.strongChoiceID(list), "approved")
    }

    func testTheFirstAllowIsAlwaysTheStrongChoice() {
        let withDetail = [
            PermissionChoice(id: "allow", label: "Allow", detail: nil, allow: true, optionId: "allow", takesNote: false),
            PermissionChoice(id: "s", label: "Allow for this session", detail: "Bash(npm test:*)", allow: true, optionId: "s", takesNote: false),
            PermissionChoice.plainDeny(takesNote: false),
        ]
        // A list that names rules still fills its main action (the team's rule, 11-26).
        XCTAssertEqual(PendingPermission.strongChoiceID(withDetail), "allow")
        // The plain pair of a Claude prompt, whose Deny takes a note: Allow is filled.
        XCTAssertEqual(PendingPermission.strongChoiceID([.plainAllow, .plainDeny(takesNote: true)]), "allow")
        // No allow at all: nothing to make strong.
        XCTAssertNil(PendingPermission.strongChoiceID([.plainDeny(takesNote: false)]))
    }
}

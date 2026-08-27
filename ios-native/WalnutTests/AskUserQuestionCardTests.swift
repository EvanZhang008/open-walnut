import XCTest
@testable import Walnut

/// AskUserQuestion decode + answer-payload contract.
///
/// The bug this pins (2026-08-26): the phone showed NOTHING for an
/// AskUserQuestion prompt — not the question, not one option. It arrived as an
/// ordinary `pendingPermissions` entry whose `input` holds a `questions` array,
/// and the iOS card only knew how to render a one-line `inputSummary` (whose key
/// list has no `questions`) plus Allow/Deny. So the human saw the bare tool name
/// and the agent waited forever. Worse, "Allow" without an `answers` map tells
/// the model the user answered nothing.
///
/// The JSON below reproduces the SHAPE of real captured payloads from live
/// session transcripts (`~/.claude/projects/**/*.jsonl`, `tool_use` blocks named
/// AskUserQuestion): `input.questions[]` with `question`, an optional `header`,
/// `options[]` of `{ label, description }`, and `multiSelect` that is sometimes
/// `false`, sometimes `true`, and OFTEN ABSENT ENTIRELY. The wording is
/// substituted (the real ones are project-specific), the keys and their
/// optionality are verbatim.
final class AskUserQuestionCardTests: XCTestCase {

    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }

    /// Three questions, mirroring a real multi-question ask: question 1 has
    /// `multiSelect: false`, question 2 OMITS the key, question 3 sets it true.
    private let realShapeJSON = """
    {
      "session": { "claudeSessionId": "sess-1", "process_status": "running" },
      "pendingPermissions": [
        {
          "requestId": "req-ask-1",
          "toolName": "AskUserQuestion",
          "input": {
            "questions": [
              {
                "question": "Which cache backend should the indexer use?",
                "header": "Backend",
                "multiSelect": false,
                "options": [
                  { "label": "On-disk (Recommended)",
                    "description": "Survives restarts and costs one extra fsync per batch." },
                  { "label": "In-memory",
                    "description": "Fastest, but every restart rebuilds the whole index." }
                ]
              },
              {
                "question": "How should a stale entry be treated?",
                "header": "Staleness",
                "options": [
                  { "label": "Serve stale, refresh behind",
                    "description": "Answers instantly and recomputes in the background." },
                  { "label": "Block until fresh",
                    "description": "Always correct, but a cold entry pays full latency." },
                  { "label": "Drop it" }
                ]
              },
              {
                "question": "Which surfaces should the rollout cover?",
                "header": "Rollout",
                "multiSelect": true,
                "options": [
                  { "label": "Web console", "description": "The desktop browser UI." },
                  { "label": "Phone app", "description": "The native mobile client." },
                  { "label": "CLI", "description": "The terminal entry point." }
                ]
              }
            ]
          }
        }
      ]
    }
    """

    // MARK: - Decode: every question and every option survives

    func testRealPayloadDecodesEveryQuestionAndOption() throws {
        let detail = try decode(SessionDetail.self, realShapeJSON)
        let request = try XCTUnwrap(detail.pendingPermissions.first)
        XCTAssertEqual(request.toolName, "AskUserQuestion")

        let questions = try XCTUnwrap(request.askQuestions, "AskUserQuestion input must parse")
        XCTAssertEqual(questions.count, 3, "no question may be dropped")

        // Question 1 — explicit multiSelect:false, both options with descriptions.
        XCTAssertEqual(questions[0].question, "Which cache backend should the indexer use?")
        XCTAssertEqual(questions[0].header, "Backend")
        XCTAssertFalse(questions[0].multiSelect)
        XCTAssertEqual(questions[0].options.map(\.label), ["On-disk (Recommended)", "In-memory"])
        XCTAssertEqual(
            questions[0].options[0].description,
            "Survives restarts and costs one extra fsync per batch."
        )
        XCTAssertEqual(
            questions[0].options[1].description,
            "Fastest, but every restart rebuilds the whole index."
        )

        // Question 2 — the key is ABSENT in real payloads; it must read false,
        // not crash and not silently become multi-select.
        XCTAssertFalse(questions[1].multiSelect)
        XCTAssertEqual(questions[1].options.count, 3)
        // An option may legitimately carry no description.
        XCTAssertEqual(questions[1].options[2].label, "Drop it")
        XCTAssertNil(questions[1].options[2].description)

        // Question 3 — real multi-select.
        XCTAssertTrue(questions[2].multiSelect)
        XCTAssertEqual(questions[2].options.map(\.label), ["Web console", "Phone app", "CLI"])
        XCTAssertTrue(questions[2].options.allSatisfy { $0.description != nil })
    }

    /// The regression itself: the one-line summary the old card relied on is
    /// blank for this input, which is exactly why the phone rendered nothing.
    /// It must now stay nil (the card renders questions instead of a summary).
    func testSummaryIsNilForAskUserQuestionSoTheCardMustRenderQuestions() throws {
        let detail = try decode(SessionDetail.self, realShapeJSON)
        let request = try XCTUnwrap(detail.pendingPermissions.first)
        XCTAssertNil(request.inputSummary)
        XCTAssertNotNil(request.askQuestions)
    }

    /// Every non-AskUserQuestion prompt keeps the generic Allow/Deny path.
    func testOtherToolsDoNotParseAsQuestions() throws {
        let bash = PendingPermission(
            requestId: "r", toolName: "Bash",
            input: ["command": .string("ls docs/")], reason: nil
        )
        XCTAssertNil(bash.askQuestions)
        XCTAssertEqual(bash.inputSummary, "ls docs/")

        // Right tool name, wrong body → nil, so the generic card renders rather
        // than an empty question card.
        let malformed = PendingPermission(
            requestId: "r2", toolName: "AskUserQuestion",
            input: ["questions": .string("not an array")], reason: nil
        )
        XCTAssertNil(malformed.askQuestions)

        let noInput = PendingPermission(
            requestId: "r3", toolName: "AskUserQuestion", input: nil, reason: nil
        )
        XCTAssertNil(noInput.askQuestions)
    }

    /// Unusable entries are dropped, and an all-unusable payload falls back to
    /// the generic card instead of showing an unanswerable empty form.
    func testBlankQuestionsAndOptionsAreDropped() {
        let input: [String: JSONValue] = [
            "questions": .array([
                .object(["question": .string(""), "options": .array([])]),
                .object([
                    "question": .string("Real question?"),
                    "header": .string(""),
                    "options": .array([
                        .object(["label": .string("")]),
                        .object(["label": .string("Keep me")]),
                        .string("not an object"),
                    ]),
                ]),
            ])
        ]
        let questions = AskUserQuestion.parse(input)
        XCTAssertEqual(questions?.count, 1, "the blank-text question has no answers key")
        XCTAssertEqual(questions?[0].options.map(\.label), ["Keep me"])
        XCTAssertNil(questions?[0].header, "a blank header is the same as an absent one")

        XCTAssertNil(AskUserQuestion.parse(["questions": .array([
            .object(["question": .string("")]),
        ])]))
        XCTAssertNil(AskUserQuestion.parse(["questions": .array([])]))
    }

    // MARK: - Answer payload (the write half)

    func testAnswersMapIsKeyedByQuestionTextAndJoinsMultiSelect() throws {
        let detail = try decode(SessionDetail.self, realShapeJSON)
        let questions = try XCTUnwrap(detail.pendingPermissions.first?.askQuestions)

        let selections: [String: [String]] = [
            questions[0].question: ["On-disk (Recommended)"],
            questions[1].question: ["Block until fresh"],
            questions[2].question: ["Web console", "Phone app"],
        ]
        let answers = AskUserQuestion.buildAnswers(
            questions: questions, selections: selections, otherText: [:]
        )
        XCTAssertEqual(answers.count, 3)
        XCTAssertEqual(answers[questions[0].question], "On-disk (Recommended)")
        XCTAssertEqual(answers[questions[1].question], "Block until fresh")
        // Multi-select joins with ", " — the CLI's own summary format.
        XCTAssertEqual(answers[questions[2].question], "Web console, Phone app")
    }

    func testFreeTextOverridesPillsAndBlankAnswersAreOmitted() {
        let q = AskQuestion(
            question: "Which region?", header: nil,
            options: [AskQuestionOption(label: "us-west-2", description: nil)],
            multiSelect: false
        )
        // Free text WINS: an "Other" answer is a deliberate override.
        XCTAssertEqual(
            AskUserQuestion.buildAnswers(
                questions: [q], selections: [q.question: ["us-west-2"]],
                otherText: [q.question: "eu-central-1"]
            )[q.question],
            "eu-central-1"
        )
        // Whitespace-only free text is not an answer, so the pill stands.
        XCTAssertEqual(
            AskUserQuestion.buildAnswers(
                questions: [q], selections: [q.question: ["us-west-2"]],
                otherText: [q.question: "   "]
            )[q.question],
            "us-west-2"
        )
        // Nothing picked → the key is OMITTED, never sent as "".
        XCTAssertTrue(
            AskUserQuestion.buildAnswers(questions: [q], selections: [:], otherText: [:]).isEmpty
        )
    }

    /// Submit stays gated until EVERY question has an answer — a partial submit
    /// would hand the model a half-answered set.
    func testSubmitGateRequiresEveryQuestion() throws {
        let detail = try decode(SessionDetail.self, realShapeJSON)
        let questions = try XCTUnwrap(detail.pendingPermissions.first?.askQuestions)

        XCTAssertFalse(AskUserQuestion.allAnswered(
            questions: questions, selections: [:], otherText: [:]
        ))
        XCTAssertFalse(AskUserQuestion.allAnswered(
            questions: questions,
            selections: [questions[0].question: ["In-memory"]],
            otherText: [:]
        ))
        XCTAssertTrue(AskUserQuestion.allAnswered(
            questions: questions,
            selections: [
                questions[0].question: ["In-memory"],
                questions[2].question: ["CLI"],
            ],
            otherText: [questions[1].question: "Serve stale"]
        ))
        // No questions at all is never "answered" (guards an empty form).
        XCTAssertFalse(AskUserQuestion.allAnswered(questions: [], selections: [:], otherText: [:]))
    }

    func testToggleSelectionSingleVersusMultiSelect() {
        // Single-select replaces, and re-tapping the picked option clears it.
        XCTAssertEqual(AskUserQuestion.toggleSelection(current: nil, label: "A", multiSelect: false), ["A"])
        XCTAssertEqual(AskUserQuestion.toggleSelection(current: ["A"], label: "B", multiSelect: false), ["B"])
        XCTAssertEqual(AskUserQuestion.toggleSelection(current: ["A"], label: "A", multiSelect: false), [])
        // Multi-select toggles membership and preserves tap order.
        XCTAssertEqual(AskUserQuestion.toggleSelection(current: ["A"], label: "B", multiSelect: true), ["A", "B"])
        XCTAssertEqual(AskUserQuestion.toggleSelection(current: ["A", "B"], label: "A", multiSelect: true), ["B"])
    }

    /// The `answers` map must ride on the ALLOW response and be omitted when
    /// empty — the server reads a bare allow as "the user answered nothing".
    func testPermissionRequestBodyCarriesAnswersOnlyWhenNonEmpty() throws {
        struct Body: Encodable {
            let requestId: String
            let allow: Bool
            let message: String?
            let answers: [String: String]?
        }
        func encode(_ answers: [String: String]?) throws -> [String: Any] {
            let body = Body(
                requestId: "req-ask-1", allow: true, message: nil,
                answers: (answers?.isEmpty ?? true) ? nil : answers
            )
            let data = try JSONEncoder().encode(body)
            return try XCTUnwrap(
                JSONSerialization.jsonObject(with: data) as? [String: Any]
            )
        }

        let withAnswers = try encode(["Which region?": "us-west-2"])
        XCTAssertEqual(withAnswers["allow"] as? Bool, true)
        XCTAssertEqual(
            (withAnswers["answers"] as? [String: String])?["Which region?"], "us-west-2"
        )
        XCTAssertNil(try encode([:])["answers"])
        XCTAssertNil(try encode(nil)["answers"])
    }
}

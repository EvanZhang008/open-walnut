import XCTest
@testable import Walnut

/// The permission card's richer answers: the `acpOptions` a prompt lists (a
/// Claude prompt's remembering options, built by the server from the CLI's
/// suggested rules; an ACP adapter's own), the note a deny carries to the agent,
/// and the request body that answers it.
///
/// The JSON mirrors what the server sends for a pending permission
/// (src/providers/claude-permission-options.ts for the Claude options, the ACP
/// adapter's option shape for the other), and the note's words are the web
/// client's (web/src/components/sessions/prompt-keys.ts), so both surfaces put
/// the same bytes on the wire.
final class PermissionOptionsTests: XCTestCase {

    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }

    private let claudeBashJSON = """
    {
      "session": { "claudeSessionId": "sess-1", "process_status": "running" },
      "pendingPermissions": [
        {
          "requestId": "req-bash-1",
          "toolName": "Bash",
          "input": { "command": "npm test" },
          "acpOptions": [
            { "optionId": "allow_once", "kind": "allow_once", "name": "Allow" },
            { "optionId": "allow_session", "kind": "allow_always", "name": "Allow for this session",
              "detail": "Bash(npm test:*)" },
            { "optionId": "allow_always", "kind": "allow_always", "name": "Always allow in this project",
              "detail": "Bash(npm test:*)" },
            { "optionId": "reject_once", "kind": "reject_once", "name": "Deny", "takesNote": true }
          ]
        }
      ]
    }
    """

    // MARK: - Decoding

    func testClaudeOptionsDecodeWithDetailAndNote() throws {
        let detail = try decode(SessionDetail.self, claudeBashJSON)
        let request = try XCTUnwrap(detail.pendingPermissions.first)
        let options = try XCTUnwrap(request.acpOptions)
        XCTAssertEqual(options.map(\.optionId), ["allow_once", "allow_session", "allow_always", "reject_once"])
        XCTAssertEqual(options[1].detail, "Bash(npm test:*)")
        XCTAssertEqual(options.map(\.isReject), [false, false, false, true])
        XCTAssertEqual(options[3].takesNote, true)
        XCTAssertNil(options[0].takesNote)

        let choices = request.choices
        XCTAssertEqual(choices.map(\.label), ["Allow", "Allow for this session", "Always allow in this project", "Deny"])
        XCTAssertEqual(choices.map(\.allow), [true, true, true, false])
        XCTAssertEqual(choices.map(\.takesNote), [false, false, false, true])
        XCTAssertEqual(choices[2].detail, "Bash(npm test:*)")
        XCTAssertEqual(choices.map(\.accessibilityID), [
            "session.permission.option.allow_once", "session.permission.option.allow_session",
            "session.permission.option.allow_always", "session.permission.option.reject_once",
        ])
    }

    /// An older server (or a prompt with nothing to remember) sends no field: the
    /// prompt still decodes and keeps the plain pair, whose Deny takes a note.
    func testNoOptionsKeepsThePlainPair() throws {
        let detail = try decode(SessionDetail.self, """
        { "session": { "claudeSessionId": "sess-2", "process_status": "running" }, "pendingPermissions": [
          { "requestId": "req-plain", "toolName": "WebFetch", "input": { "url": "https://example.com" } }
        ] }
        """)
        let request = try XCTUnwrap(detail.pendingPermissions.first)
        XCTAssertNil(request.acpOptions)
        let choices = request.choices
        XCTAssertEqual(choices.map(\.id), ["allow", "deny"])
        XCTAssertEqual(choices.map(\.accessibilityID), ["session.permission.allow", "session.permission.deny"])
        XCTAssertNil(choices[0].optionId)
        XCTAssertFalse(choices[0].takesNote)
        XCTAssertTrue(choices[1].takesNote)
        // An empty list is the same as none.
        let empty = PendingPermission(requestId: "r", toolName: "Bash", input: nil, reason: nil, acpOptions: [])
        XCTAssertEqual(empty.choices.map(\.id), ["allow", "deny"])
    }

    /// An ACP adapter's own options: no detail, no note, any reject kind refuses.
    func testACPOptionsMapKindsAndCarryNoNote() throws {
        let request = try decode(PendingPermission.self, """
        { "requestId": "req-acp", "toolName": "Edit", "acpOptions": [
          { "optionId": "approved", "kind": "allow_once", "name": "Allow once" },
          { "optionId": "approved-for-session", "kind": "allow_always", "name": "Allow for session" },
          { "optionId": "abort", "kind": "reject_always", "name": "Reject" }
        ] }
        """)
        let choices = request.choices
        XCTAssertEqual(choices.map(\.optionId), ["approved", "approved-for-session", "abort"])
        XCTAssertEqual(choices.map(\.allow), [true, true, false])
        XCTAssertTrue(choices.allSatisfy { !$0.takesNote && $0.detail == nil })
    }

    /// One bad entry never fails the session detail: a field of the wrong type is
    /// dropped, an option with no id is skipped, a missing name shows the id, and
    /// options that cannot refuse still get a plain Deny.
    func testMalformedOptionsDecodeLeniently() throws {
        let request = try decode(PendingPermission.self, """
        { "requestId": "req-odd", "acpOptions": [
          { "kind": "allow_once", "name": "No id" },
          { "optionId": "go", "kind": 7, "name": "Go", "takesNote": "yes" },
          { "optionId": "later", "kind": "allow_always", "detail": "" }
        ] }
        """)
        XCTAssertEqual(request.acpOptions?.count, 3)
        let choices = request.choices
        XCTAssertEqual(choices.map(\.id), ["go", "later", "deny"])
        XCTAssertEqual(choices.map(\.label), ["Go", "later", "Deny"])
        // A kind that is not a string is not a reject: the option allows.
        XCTAssertTrue(choices[0].allow)
        XCTAssertNil(choices[1].detail, "an empty detail is no detail")
        // The fallback Deny is the plain one, sent without an option id.
        XCTAssertFalse(choices[2].allow)
        XCTAssertNil(choices[2].optionId)
        XCTAssertFalse(choices[2].takesNote)
    }

    /// Only a deny carries a note, whatever the option says.
    func testAnAllowNeverTakesANote() {
        let option = PermissionOption(optionId: "a", kind: "allow_once", name: "Allow", detail: nil, takesNote: true)
        XCTAssertFalse(PermissionChoice(option: option).takesNote)
    }

    // MARK: - The note

    func testNoteMessageUsesTheWebPrefixAndTrims() {
        XCTAssertEqual(
            PermissionNote.message("  run the unit tests first \n"),
            "The user denied this tool call and said: run the unit tests first"
        )
        XCTAssertNil(PermissionNote.message("   \n "))
        XCTAssertNil(PermissionNote.message(""))
    }

    func testDenyLabelSaysWithNoteOnlyWhileANoteIsTyped() throws {
        let deny = PermissionChoice.plainDeny(takesNote: true)
        XCTAssertEqual(deny.displayLabel(note: ""), "Deny")
        XCTAssertEqual(deny.displayLabel(note: "  "), "Deny")
        XCTAssertEqual(deny.displayLabel(note: "use pnpm"), "Deny with note")
        // A choice that does not carry the note keeps its label.
        XCTAssertEqual(PermissionChoice.plainAllow.displayLabel(note: "use pnpm"), "Allow")
        let reject = try XCTUnwrap(try decode(SessionDetail.self, claudeBashJSON).pendingPermissions.first?.choices.last)
        XCTAssertEqual(reject.displayLabel(note: "use pnpm"), "Deny with note")
    }

    func testReplyCarriesTheOptionAndTheNote() throws {
        let choices = try XCTUnwrap(try decode(SessionDetail.self, claudeBashJSON).pendingPermissions.first?.choices)
        XCTAssertEqual(choices[1].reply(note: "ignored"), PermissionReply(allow: true, optionId: "allow_session"))
        XCTAssertEqual(
            choices[3].reply(note: "use pnpm"),
            PermissionReply(allow: false, optionId: "reject_once", message: "The user denied this tool call and said: use pnpm")
        )
        XCTAssertEqual(choices[3].reply(note: " "), PermissionReply(allow: false, optionId: "reject_once"))
        XCTAssertEqual(PermissionChoice.plainAllow.reply(note: ""), PermissionReply(allow: true))
        XCTAssertEqual(
            PermissionChoice.plainDeny(takesNote: true).reply(note: "stop"),
            PermissionReply(allow: false, message: "The user denied this tool call and said: stop")
        )
    }

    /// The vertical note field inserts Return's newline: that one keystroke is a
    /// send, a pasted block with line breaks is not.
    func testReturnKeyIsOneAddedNewline() {
        XCTAssertTrue(PermissionNote.isReturnKey(old: "use pnpm", new: "use pnpm\n"))
        XCTAssertTrue(PermissionNote.isReturnKey(old: "use pnpm", new: "use\n pnpm"))
        XCTAssertFalse(PermissionNote.isReturnKey(old: "use pnpm", new: "use pnpm!"))
        XCTAssertFalse(PermissionNote.isReturnKey(old: "a", new: "a\nb\nc"))
        XCTAssertFalse(PermissionNote.isReturnKey(old: "a\n", new: "a"))
    }

    // MARK: - Request body

    private func json(_ body: SessionPermissionBody) throws -> [String: Any] {
        let data = try JSONEncoder().encode(body)
        return try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    func testBodyOmitsUnsetFields() throws {
        let plain = try json(SessionPermissionBody(requestId: "r1", allow: true))
        XCTAssertEqual(Set(plain.keys), ["requestId", "allow"])
        XCTAssertEqual(plain["requestId"] as? String, "r1")
        XCTAssertEqual(plain["allow"] as? Bool, true)
        // An empty id is no choice.
        XCTAssertEqual(Set(try json(SessionPermissionBody(requestId: "r1", allow: true, optionId: "")).keys), ["requestId", "allow"])
    }

    func testBodyCarriesOptionAndNoteWhenSet() throws {
        let option = try json(SessionPermissionBody(requestId: "r2", allow: true, optionId: "allow_session"))
        XCTAssertEqual(Set(option.keys), ["requestId", "allow", "optionId"])
        XCTAssertEqual(option["optionId"] as? String, "allow_session")

        let reply = PermissionChoice.plainDeny(takesNote: true).reply(note: "run the linter first")
        let deny = try json(SessionPermissionBody(
            requestId: "r3", allow: reply.allow, optionId: reply.optionId, message: reply.message
        ))
        XCTAssertEqual(Set(deny.keys), ["requestId", "allow", "message"])
        XCTAssertEqual(deny["allow"] as? Bool, false)
        XCTAssertEqual(deny["message"] as? String, "The user denied this tool call and said: run the linter first")
    }

    /// The AskUserQuestion fields keep their old rules: no empty answers map, and
    /// pictures only with an allow that answers.
    func testBodyKeepsTheAnswerRules() throws {
        let picture = ImagePayload(data: "AAAA", mediaType: "image/jpeg")
        XCTAssertNil(try json(SessionPermissionBody(requestId: "r", allow: true, answers: [:], images: [picture]))["answers"])
        XCTAssertNil(try json(SessionPermissionBody(requestId: "r", allow: true, answers: [:], images: [picture]))["images"])
        let answered = try json(SessionPermissionBody(requestId: "r", allow: true, answers: ["Q": "A"], images: [picture]))
        XCTAssertEqual(answered["answers"] as? [String: String], ["Q": "A"])
        XCTAssertEqual((answered["images"] as? [Any])?.count, 1)
        XCTAssertNil(try json(SessionPermissionBody(requestId: "r", allow: false, answers: ["Q": "A"], images: [picture]))["images"])
    }

    /// A standing rule says where it is kept, under the rule, as the web card does.
    func testStandingRuleShowsWhereItIsSaved() throws {
        let option = try decode(PermissionOption.self, """
        { "optionId": "allow_always", "kind": "allow_always", "name": "Always allow in this project",
          "detail": "Bash: this exact command", "savedTo": ".claude/settings.local.json" }
        """)
        XCTAssertEqual(PermissionChoice(option: option).detail, "Bash: this exact command\nSaves to .claude/settings.local.json")
        // The file it is kept in is what makes the card ask for a second tap.
        XCTAssertEqual(PermissionChoice(option: option).savedTo, ".claude/settings.local.json")
        let session = try decode(PermissionOption.self, #"{ "optionId": "allow_session", "kind": "allow_always", "name": "Allow for this session", "detail": "Bash: this exact command" }"#)
        XCTAssertEqual(PermissionChoice(option: session).detail, "Bash: this exact command")
        XCTAssertNil(PermissionChoice(option: session).savedTo)
    }

}

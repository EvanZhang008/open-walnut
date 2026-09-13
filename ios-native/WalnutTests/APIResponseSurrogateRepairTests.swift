import Foundation
import XCTest
@testable import Walnut

/// A BAD CHARACTER IN ONE ROW MUST NOT COST THE WHOLE PAGE.
///
/// `JSONDecoder` rejects a lone surrogate escape (`\uD800`-`\uDBFF` with no low half
/// after it, or `\uDC00`-`\uDFFF` with no high half before it) and it rejects the WHOLE
/// DOCUMENT — so one truncated emoji anywhere in a 100-row conversation page threw the
/// page away. The 2026-09-12 gate found the phone then showing "Your Personal AI is
/// listening" over a conversation with 24 messages in it, with no error and no retry,
/// because the failure was swallowed by a `catch` that only reacted to network errors.
///
/// The server is being fixed to never emit one. This is the other half, and it is not
/// redundant: the phone talks to servers of every age, and the cloud replica runs weeks
/// behind the primary.
///
/// Escapes are written as `\\u…` in these fixtures, so the bytes under test are the
/// escape sequences a JSON producer emits — never raw surrogate bytes, which UTF-8
/// cannot encode at all.
final class APIResponseSurrogateRepairTests: XCTestCase {

    private static let messagesURL = URL(
        string: "https://example.invalid/api/v1/conversations/c1/messages")!

    private func ok(_ url: URL = APIResponseSurrogateRepairTests.messagesURL) -> HTTPURLResponse {
        HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil)!
    }

    private func row(id: String, role: String, text: String) -> String {
        """
        {"id":"\(id)","role":"\(role)","text":"\(text)","createdAt":"2026-09-12T06:00:00Z"}
        """
    }

    /// A page carrying a lone HIGH surrogate at the end of one row's text and a lone LOW
    /// at the start of another decodes, keeps every row, and shows U+FFFD where the
    /// broken character was.
    ///
    /// RED PROOF (decoding `data` instead of `repair.data` in `WalnutAPI.decode`):
    ///   testALoneSurrogateInOneRowStillYieldsEveryRow : failed: caught error:
    ///   "badResponse", with the cause printed by the probe below as
    ///   `dataCorrupted at []: The given data was not valid JSON.`
    ///
    /// Note the EMPTY coding path in that cause: the failure happens in the tokenizer, so
    /// Foundation cannot even name the row it choked on. There is nothing to degrade
    /// gracefully to at the model layer, which is why the repair has to happen on the
    /// bytes.
    func testALoneSurrogateInOneRowStillYieldsEveryRow() throws {
        let json = """
        [\(row(id: "m1", role: "assistant", text: "cut here \\ud83d")),
         \(row(id: "m2", role: "user", text: "\\ude00 starts broken")),
         \(row(id: "m3", role: "assistant", text: "a whole one \\ud83d\\ude00"))]
        """
        let data = Data(json.utf8)

        // The bug, stated as a fact about Foundation rather than an assumption: these
        // bytes are undecodable as they stand, and the failure is page-wide.
        XCTAssertThrowsError(try JSONDecoder().decode([ChatMessage].self, from: data)) { error in
            XCTAssertTrue(error is DecodingError,
                          "expected a DecodingError, got \(error)")
            print("PROBE-RAW \(JSONResponseRepair.describe(decodeFailure: error))")
        }

        let rows = try WalnutAPI.decode([ChatMessage].self, data: data, response: ok())
        XCTAssertEqual(rows.map(\.id), ["m1", "m2", "m3"],
                       "one bad character may cost its own character, never the page")
        XCTAssertEqual(rows[0].text, "cut here \u{FFFD}")
        XCTAssertEqual(rows[1].text, "\u{FFFD} starts broken")
        XCTAssertEqual(rows[2].text, "a whole one \u{1F600}",
                       "a VALID pair in the same page has to survive untouched")

        let repair = JSONResponseRepair.repairingLoneSurrogates(data)
        XCTAssertEqual(repair.repaired, 2, "exactly the two broken halves, not the good pair")
    }

    /// A page with nothing wrong with it is handed to `JSONDecoder` BYTE FOR BYTE. The
    /// repair may not become a re-encoding pass every response pays for.
    func testAValidPairIsLeftExactlyAsItArrived() throws {
        let json = "[\(row(id: "m1", role: "user", text: "hello \\ud83d\\ude00 there"))]"
        let data = Data(json.utf8)

        let repair = JSONResponseRepair.repairingLoneSurrogates(data)
        XCTAssertEqual(repair.repaired, 0)
        XCTAssertEqual(repair.data, data, "untouched means the same bytes")

        let rows = try WalnutAPI.decode([ChatMessage].self, data: data, response: ok())
        XCTAssertEqual(rows.first?.text, "hello \u{1F600} there")
    }

    /// …and a body with no surrogate escape at all never enters the pass. The pre-scan
    /// is the reason this repair is free on every ordinary response.
    func testOrdinaryBodiesSkipTheRepairEntirely() {
        let plain = Data("[{\"id\":\"m1\",\"role\":\"user\",\"text\":\"plain ascii\"}]".utf8)
        XCTAssertFalse(JSONResponseRepair.mayContainSurrogateEscape(plain))
        XCTAssertEqual(JSONResponseRepair.repairingLoneSurrogates(plain).repaired, 0)

        // A non-surrogate `\u` escape is not a candidate either.
        let accented = Data("{\"text\":\"caf\\u00e9\"}".utf8)
        XCTAssertFalse(JSONResponseRepair.mayContainSurrogateEscape(accented))
    }

    /// AN ESCAPED BACKSLASH IS NOT AN ESCAPE. `"\\\\ud83d"` is a backslash followed by
    /// the literal text `ud83d`, and rewriting it would corrupt a string that was
    /// perfectly fine — a repair that damages good data is worse than the bug.
    func testAnEscapedBackslashBeforeUIsLiteralText() throws {
        // JSON: {"text":"path \\ud83d end"}  → the string is: path \ud83d end
        let data = Data("{\"text\":\"path \\\\ud83d end\"}".utf8)
        let repair = JSONResponseRepair.repairingLoneSurrogates(data)
        XCTAssertEqual(repair.repaired, 0, "the `u` here is text, not an escape")

        struct Box: Decodable { let text: String }
        let box = try JSONDecoder().decode(Box.self, from: repair.data)
        XCTAssertEqual(box.text, "path \\ud83d end")
    }

    /// Two lone highs in a row are two repairs: the first must not swallow the second
    /// while looking for its partner.
    func testAdjacentLoneHighSurrogatesAreBothRepaired() throws {
        let data = Data("{\"text\":\"\\ud83d\\ud83dend\"}".utf8)
        let repair = JSONResponseRepair.repairingLoneSurrogates(data)
        XCTAssertEqual(repair.repaired, 2)

        struct Box: Decodable { let text: String }
        let box = try JSONDecoder().decode(Box.self, from: repair.data)
        XCTAssertEqual(box.text, "\u{FFFD}\u{FFFD}end")
    }

    /// A truncated escape at the very end of a body cannot walk off the array.
    func testATruncatedEscapeAtTheEndOfTheBodyIsSurvived() {
        for tail in ["\\ud8", "\\ud83", "\\u", "\\"] {
            let data = Data("{\"text\":\"x\(tail)".utf8)
            XCTAssertEqual(JSONResponseRepair.repairingLoneSurrogates(data).repaired, 0,
                           "a partial escape (\(tail)) is not a lone surrogate to rewrite")
        }
    }

    /// A DECODE FAILURE THAT SURVIVES THE REPAIR IS DIAGNOSABLE. The log line carries
    /// Foundation's own `debugDescription` and the CODING PATH, so a field report names
    /// the row and the field instead of only "Unexpected server response".
    func testADecodeFailureIsDescribedWithItsCodingPath() {
        // `text` as a number: a shape mismatch, which reports a real coding path.
        let data = Data("""
        [{"id":"m1","role":"user","text":42,"createdAt":"2026-09-12T06:00:00Z"}]
        """.utf8)
        do {
            _ = try WalnutAPI.decode([ChatMessage].self, data: data, response: ok())
            XCTFail("a number where the text belongs has to fail")
        } catch {
            XCTAssertTrue(error as? APIError != nil, "callers still see APIError, got \(error)")
        }

        do {
            _ = try JSONDecoder().decode([ChatMessage].self, from: data)
            XCTFail("unreachable")
        } catch {
            let described = JSONResponseRepair.describe(decodeFailure: error)
            XCTAssertTrue(described.contains("typeMismatch"),
                          "the case has to be named; got \(described)")
            XCTAssertTrue(described.contains("text"),
                          "the coding path has to name the field; got \(described)")
            print("PROBE-DESCRIBE \(described)")
        }
    }
}

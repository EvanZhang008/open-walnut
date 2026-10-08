import XCTest
@testable import Walnut

/// `GlobalSearchModel`: the Tasks tab's server search runs on every query change, says
/// "Searching…" from the first keystroke, and only the newest query writes state.
///
/// The bug it fixes: the search lived in the "More Results" section at the foot of a
/// lazy List, started only once that section was drawn, and the section drew nothing
/// before it had something to say. A query with many local matches and no completed
/// match on the phone therefore never searched (2026-10-08).
@MainActor
final class GlobalSearchModelTests: XCTestCase {

    private func response(_ title: String) -> GlobalSearchResponse {
        GlobalSearchResponse(results: [
            GlobalSearchResult(type: "task", resultId: "t-\(title)", title: title, snippet: title, score: 1,
                               taskId: "t-\(title)", matchField: "title")
        ])
    }

    /// Waits until `condition` holds, polling the main actor (the model's tasks run there).
    private func eventually(_ condition: @autoclosure () -> Bool, timeout: TimeInterval = 2) async {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition() && Date() < deadline {
            try? await Task.sleep(for: .milliseconds(5))
        }
    }

    func testAQuerySearchesAtOnceWithoutAnyViewDrawingIt() async {
        var asked: [String] = []
        let model = GlobalSearchModel(debounce: .zero) { query in
            asked.append(query)
            return self.response(query)
        }
        model.schedule("walnut")
        XCTAssertTrue(model.searching, "the typing pause already says Searching")
        await eventually(!model.searching)
        XCTAssertEqual(asked, ["walnut"])
        XCTAssertEqual(model.answer(for: "walnut")?.results.first?.title, "walnut")
        XCTAssertNil(model.answer(for: "walnu"), "an answer is only for its own query")
    }

    func testOnlyTheNewestQueryWritesState() async {
        let slowStarted = expectation(description: "the first search is in flight")
        var release: CheckedContinuation<Void, Never>?
        let model = GlobalSearchModel(debounce: .zero) { query in
            if query == "first" {
                slowStarted.fulfill()
                await withCheckedContinuation { release = $0 }
                return self.response("first")
            }
            return self.response(query)
        }
        model.schedule("first")
        await fulfillment(of: [slowStarted], timeout: 2)
        model.schedule("second")
        await eventually(model.answer(for: "second") != nil)
        release?.resume()
        try? await Task.sleep(for: .milliseconds(50))
        XCTAssertEqual(model.searchedQuery, "second", "the late first answer is dropped")
        XCTAssertNil(model.answer(for: "first"))
        XCTAssertFalse(model.searching)
    }

    func testAFailureIsSaidAndTheNextQueryStartsClean() async {
        var fail = true
        let model = GlobalSearchModel(debounce: .zero) { query in
            if fail { throw APIError.network(underlying: URLError(.cannotConnectToHost)) }
            return self.response(query)
        }
        model.schedule("walnut")
        await eventually(model.failed)
        XCTAssertTrue(model.failed)
        XCTAssertEqual(model.searchedQuery, "walnut")
        XCTAssertNil(model.answer(for: "walnut"))
        XCTAssertFalse(model.searching)

        fail = false
        model.schedule("walnuts")
        XCTAssertFalse(model.failed, "a failure belongs to the query it happened to")
        await eventually(model.answer(for: "walnuts") != nil)
        XCTAssertNotNil(model.answer(for: "walnuts"))
    }

    func testACancellationTheModelDidNotMakeIsAFailureNotSilence() async {
        let model = GlobalSearchModel(debounce: .zero) { _ in throw APIError.cancelled }
        model.schedule("walnut")
        await eventually(model.failed)
        XCTAssertTrue(model.failed, "otherwise the section would show nothing at all")
    }

    func testAnOldCompanionSaysSearchNeedsTheMac() async {
        let model = GlobalSearchModel(debounce: .zero) { _ in
            throw APIError.server(status: 501, code: "not_supported_cloud", message: "x", serverHash: nil, serverContent: nil)
        }
        model.schedule("walnut")
        await eventually(model.unavailableNotice != nil)
        XCTAssertEqual(model.unavailableNotice, "Search needs your Mac online. Notes search still works.")
        XCTAssertFalse(model.failed)
        model.schedule("w")
        XCTAssertNil(model.unavailableNotice, "the notice belongs to the query it answered")
    }

    func testOneCharacterAsksNothingAndANewQueryFoldsBothReveals() async {
        var asked = 0
        let model = GlobalSearchModel(debounce: .zero) { query in
            asked += 1
            return self.response(query)
        }
        model.schedule("w")
        XCTAssertFalse(model.searching)
        try? await Task.sleep(for: .milliseconds(30))
        XCTAssertEqual(asked, 0)

        model.showCompleted = true
        model.showRelated = true
        model.schedule("walnut")
        XCTAssertFalse(model.showCompleted)
        XCTAssertFalse(model.showRelated)
    }
}

import XCTest
@testable import Walnut

/// The threads store's rules the second review round found open (2026-11-08):
///
///  1. A thread a read by id brought is dropped once a later read by id says it is gone, unless a
///     list read holds it itself (`OrgThreadsStore.afterGone`), and a reveal of such a copy reads
///     it by id again first (`OrgThreadRevealModel.outcome` with `byIdOnly`).
///  2. A new page starts from the phone's last copy of the node's threads (`OrgThreadsCache`),
///     which round-trips through its disk form, and a failed read over that copy says so.
///  3. The Closed fold says "this week" only of threads closed this week.
@MainActor
final class OrgThreadsStoreRulesTests: XCTestCase {
    private let t0 = Date(timeIntervalSince1970: 1_800_000_000)
    private static let now = WalnutTask.parseISO("2026-11-08T12:00:00Z")!

    private func thread(_ id: String, state: String = "needs", closedAt: String? = nil,
                        title: String? = nil, updatedAt: String = "2026-11-04T10:00:00Z") throws -> OrgThread {
        let closed = closedAt.map { #","closed":{"how":"acked","at":"\#($0)","by":"human"}"# } ?? ""
        let shownTitle = title ?? "Title \(id)"
        let json = #"{"id":"\#(id)","title":"\#(shownTitle)","state":"\#(state)","messages":[],"createdAt":"2026-11-04T09:00:00Z","updatedAt":"\#(updatedAt)"\#(closed)}"#
        return try JSONDecoder().decode(OrgThread.self, from: Data(json.utf8))
    }

    // MARK: - 1. A copy read by id

    func testACopyReadByIdGoesWhenTheServerSaysItIsGone() throws {
        let listed = try thread("th-000001")
        let byId = try thread("th-0000c0", state: "answered", closedAt: "2026-10-01T10:00:00Z")
        let shown = OrgThreadsStore.merged([listed], keeping: [byId.id: byId])
        XCTAssertEqual(shown.map(\.id), ["th-000001", "th-0000c0"])

        let after = OrgThreadsStore.afterGone(byId.id, threads: shown, found: [byId.id: byId], listIds: [listed.id])
        XCTAssertEqual(after.threads?.map(\.id), ["th-000001"], "the copy leaves the page")
        XCTAssertTrue(after.found.isEmpty, "and the store")

        let kept = OrgThreadsStore.afterGone(listed.id, threads: shown, found: [listed.id: listed], listIds: [listed.id])
        XCTAssertEqual(kept.threads?.map(\.id), shown.map(\.id), "a thread the list read holds itself stays")
    }

    /// A second read by id of a thread the page already holds a copy of (from the first push's
    /// read by id) shows what the server says now, in the copy's place.
    func testTheNewestReadByIdReplacesTheCopyThePageHolds() throws {
        let listed = try thread("th-000001")
        let first = try thread("th-0000c0", state: "answered", closedAt: "2026-10-01T10:00:00Z", title: "Old title")
        let shown = OrgThreadsStore.merged([listed], keeping: [first.id: first])
        let second = try thread("th-0000c0", state: "answered", closedAt: "2026-10-01T10:00:00Z",
                                title: "New title", updatedAt: "2026-11-08T10:00:00Z")
        let after = OrgThreadsStore.afterFound(second, threads: shown)
        XCTAssertEqual(after.map(\.id), ["th-000001", "th-0000c0"], "one copy, in its place")
        XCTAssertEqual(after.last?.title, "New title", "the newest read wins over the older copy")
        // The old seam kept the old copy: the list's own copy wins in `merged`, which is a list read's rule.
        XCTAssertEqual(OrgThreadsStore.merged(shown, keeping: [second.id: second]).last?.title, "Old title")
        // A thread the page did not hold joins it.
        XCTAssertEqual(OrgThreadsStore.afterFound(second, threads: [listed]).map(\.id), ["th-000001", "th-0000c0"])
        XCTAssertEqual(OrgThreadsStore.afterFound(second, threads: nil).map(\.id), ["th-0000c0"])
        // A list read that brings the thread itself wins over the copy read by id before it.
        let relisted = try thread("th-0000c0", state: "answered", closedAt: "2026-10-01T10:00:00Z", title: "Listed title")
        XCTAssertEqual(OrgThreadsStore.merged([listed, relisted], keeping: [second.id: second]).last?.title, "Listed title")

        let code = try String(contentsOf: URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Walnut/Views/Org/OrgThreadsStore.swift"), encoding: .utf8)
        XCTAssertTrue(code.contains("threads = Self.afterFound(thread, threads: threads)"), "a read by id goes through this rule")
    }

    func testARevealOfACopyReadByIdAsksAgainFirst() throws {
        let byId = try thread("th-0000c0", state: "answered", closedAt: "2026-10-01T10:00:00Z")
        let threads = [byId]
        let sections = OrgThreadModel.sections(threads, now: Self.now)
        let read = OrgThreadRevealModel.Read(startedAt: t0 + 1, failed: false)
        let focus = OrgThreadFocus(threadId: byId.id, at: t0)
        let old = OrgThreadRevealModel.Probe(startedAt: t0 - 60, result: .found)
        XCTAssertEqual(OrgThreadRevealModel.outcome(focus, threads: threads, sections: sections, lastRead: read,
                                                    probe: old, byIdOnly: [byId.id]), .probe,
                       "a copy found before this request is asked again")
        let fresh = OrgThreadRevealModel.Probe(startedAt: t0 + 2, result: .found)
        XCTAssertEqual(OrgThreadRevealModel.outcome(focus, threads: threads, sections: sections, lastRead: read,
                                                    probe: fresh, byIdOnly: [byId.id]), .show(.closed))
        let failed = OrgThreadRevealModel.Probe(startedAt: t0 + 2, result: .failed)
        XCTAssertEqual(OrgThreadRevealModel.outcome(focus, threads: threads, sections: sections, lastRead: read,
                                                    probe: failed, byIdOnly: [byId.id]), .unchecked)
        XCTAssertEqual(OrgThreadRevealModel.outcome(focus, threads: threads, sections: sections, lastRead: read,
                                                    probe: old), .show(.closed), "a listed thread shows as it is")
    }

    // MARK: - 2. The phone's copy

    func testTheCopyRoundTripsThroughItsDiskForm() throws {
        let entry = OrgThreadsCache.Entry(threads: [try thread("th-000001"), try thread("th-000002", closedAt: "2026-11-07T10:00:00Z")],
                                          shownCount: 1, closedCount: 1, savedAt: t0)
        let data = try JSONEncoder().encode(entry)
        XCTAssertEqual(try JSONDecoder().decode(OrgThreadsCache.Entry.self, from: data), entry)
    }

    func testANewPageStartsFromTheCopy() throws {
        let cache = OrgThreadsCache.shared
        let node = "task-copy-\(UUID().uuidString.prefix(8))"
        cache.save(node, threads: [try thread("th-000001")], shownCount: 1, closedCount: 0)
        let store = OrgThreadsStore(taskId: node)
        XCTAssertEqual(store.threads?.map(\.id), ["th-000001"])
        XCTAssertTrue(store.fromCache)
        XCTAssertEqual(store.shownCount, 1)
        cache.drop("th-000001", from: node)
        XCTAssertEqual(cache.cached(node)?.threads.count, 0, "a thread gone for him leaves the copy")
        XCTAssertNil(OrgThreadsStore(taskId: "task-never-read-\(UUID().uuidString)").threads, "no copy: nothing yet")
    }

    /// Two callers asking for a node's copy while it is still coming off the disk both get it: a
    /// cold offline open asked whether a copy existed (its notice) a moment before the page asked
    /// for the copy, and the page was answered "nothing" (2026-11-09 fleet run, round 3).
    func testTwoLoadsAtOnceBothGetTheCopyOnDisk() async throws {
        let cache = OrgThreadsCache.shared
        let node = "task-disk-\(UUID().uuidString.prefix(8))"
        let entry = OrgThreadsCache.Entry(threads: [try thread("th-000001")], shownCount: 1, closedCount: 0, savedAt: t0)
        DiskCache.save(entry, key: OrgThreadsCache.key(node))
        defer { DiskCache.remove(key: OrgThreadsCache.key(node)) }
        async let first = cache.has(node)
        async let second = cache.load(node)
        let (had, loaded) = await (first, second)
        XCTAssertTrue(had, "the first caller finds the copy")
        XCTAssertEqual(loaded?.threads.map(\.id), ["th-000001"], "the caller that came while it was read gets it too")
        let store = OrgThreadsStore(taskId: node)
        XCTAssertEqual(store.threads?.map(\.id), ["th-000001"], "and a page opened after starts from it")

        let code = try String(contentsOf: URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Walnut/Views/Org/OrgThreadsCache.swift"), encoding: .utf8)
        XCTAssertTrue(code.contains("if let inFlight = reading[taskId] { return await inFlight.value }"),
                      "a load while the disk read is on its way waits for it")
        let store2 = try String(contentsOf: URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Walnut/Views/Org/OrgThreadsStore.swift"), encoding: .utf8)
        XCTAssertTrue(store2.contains("if threads == nil { await hydrate() }"), "a failed read takes the copy before it says it could not load")
    }

    /// The Threads switch never counts threads the page cannot show.
    func testTheThreadsCountIsOnlyWhatThePageCanShow() {
        XCTAssertEqual(OrgThreadsStore.tabCount(read: 3, serverCount: 3, nodeCount: 14, readFailed: false), 3)
        XCTAssertEqual(OrgThreadsStore.tabCount(read: 3, serverCount: nil, nodeCount: 14, readFailed: true), 3,
                       "the phone's copy is on the page: its count")
        XCTAssertEqual(OrgThreadsStore.tabCount(read: 0, serverCount: 2, nodeCount: nil, readFailed: false), 2,
                       "a read that brought none of them shows the count it names, as its page says")
        XCTAssertEqual(OrgThreadsStore.tabCount(read: nil, serverCount: nil, nodeCount: 14, readFailed: false), 14,
                       "before the first read: the node's own count")
        XCTAssertEqual(OrgThreadsStore.tabCount(read: nil, serverCount: nil, nodeCount: nil, readFailed: false), 0, "Threads 0")
        XCTAssertNil(OrgThreadsStore.tabCount(read: nil, serverCount: nil, nodeCount: 14, readFailed: true),
                     "nothing read and nothing on the page: no number")
    }

    func testAFailedReadSaysWhatThePageShows() {
        XCTAssertTrue(OrgThreadsStore.readError(hasThreads: false, fromCache: false).hasPrefix("Couldn't load"))
        XCTAssertTrue(OrgThreadsStore.readError(hasThreads: true, fromCache: true).contains("as the phone last saw them"))
        XCTAssertEqual(OrgThreadsStore.readError(hasThreads: true, fromCache: false), "Couldn't refresh the threads.")
    }

    // MARK: - 3. The Closed fold

    func testTheClosedFoldSaysThisWeekOnlyOfThisWeek() throws {
        let recent = try thread("th-000001", closedAt: "2026-11-07T10:00:00Z")
        let old = try thread("th-0000c0", closedAt: "2026-10-01T10:00:00Z")
        XCTAssertEqual(OrgThreadModel.closedFoldLabel(count: 1, closed: [recent], now: Self.now), "1 closed this week")
        XCTAssertEqual(OrgThreadModel.closedFoldLabel(count: 2, closed: [recent, old], now: Self.now), "2 closed",
                       "a thread closed a month ago is not this week's")
    }
}

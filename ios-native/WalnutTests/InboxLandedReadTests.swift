import XCTest
@testable import Walnut

/// A transport whose reads answer with the server's rows AS THEY WERE when the
/// request arrived and then wait on a gate: a server that made its answer before a
/// write landed and delivered it after. The demo server works this way (it answers,
/// then waits a random 50 to 160 ms), and so can a real one under any delay.
final class SnapshotInboxTransport: InboxTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var serverLetters: [Letter]
    private var asked = 0
    private var answeredWrites = 0
    var readGate: CheckedContinuationGate?

    init(_ letters: [Letter]) { serverLetters = letters }

    /// GETs that have taken their snapshot so far.
    var readsAsked: Int { lock.withLock { asked } }
    /// Read writes the server has applied and answered.
    var writesAnswered: Int { lock.withLock { answeredWrites } }

    /// Another device flips a letter on the server.
    func setServerRead(_ id: String, _ read: Bool) {
        lock.withLock {
            guard let i = serverLetters.firstIndex(where: { $0.id == id }) else { return }
            serverLetters[i].read = read
            serverLetters[i].readAt = Date().timeIntervalSince1970 * 1000
        }
    }

    func letters(archived: Bool) async throws -> LetterListResponse {
        let (rows, gate) = lock.withLock { () -> ([Letter], CheckedContinuationGate?) in
            asked += 1
            return (serverLetters.filter { $0.isArchived == archived }, readGate)
        }
        await gate?.wait()
        return LetterListResponse(letters: rows, unreadCount: rows.filter { !$0.isRead }.count)
    }

    func letter(id: String) async throws -> Letter {
        let (row, gate) = lock.withLock { () -> (Letter?, CheckedContinuationGate?) in
            asked += 1
            return (serverLetters.first { $0.id == id }, readGate)
        }
        await gate?.wait()
        guard let row else { throw APIError.badResponse }
        return row
    }

    func setLetterRead(id: String, read: Bool) async throws -> Letter {
        let row: Letter? = lock.withLock {
            guard let i = serverLetters.firstIndex(where: { $0.id == id }) else { return nil }
            if serverLetters[i].isRead != read {
                serverLetters[i].read = read
                serverLetters[i].readAt = Date().timeIntervalSince1970 * 1000
            }
            answeredWrites += 1
            return serverLetters[i]
        }
        guard let row else { throw APIError.badResponse }
        return row
    }

    func setLetterPinned(id: String, pinned: Bool) async throws -> Letter { try await letter(id: id) }
    func setLetterArchived(id: String, archived: Bool) async throws -> Letter { try await letter(id: id) }
    func answerLetter(id: String, actionId: String, freeText: String?) async throws -> LetterActionResult {
        throw APIError.badResponse
    }
    func replyToLetter(id: String, text: String) async throws -> LetterActionResult { throw APIError.badResponse }
}

/// A transport whose every read (list, letter, pin and archive answers) takes its
/// snapshot when asked and then waits on ITS OWN gate, so a test picks the order the
/// answers arrive in. Adopted from the App Store r6 gate's probe
/// (`GateProbeOrderedTransport`), with archive answers that take their snapshot too.
final class OrderedInboxTransport: InboxTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var serverLetters: [Letter]
    private var gates: [CheckedContinuationGate] = []
    private var answeredWrites = 0
    /// While true, every read waits for `openRead(_:)`; while false it answers at once.
    var holdReads = false

    init(_ letters: [Letter]) { serverLetters = letters }

    /// Reads asked so far (each one numbered from 0 in the order asked).
    var readsAsked: Int { lock.withLock { gates.count } }
    var writesAnswered: Int { lock.withLock { answeredWrites } }
    /// Let read number `i` deliver its answer.
    func openRead(_ i: Int) { lock.withLock { gates[i] }.open() }

    /// Another device flips a letter on the server.
    func setServerRead(_ id: String, _ read: Bool) {
        lock.withLock {
            guard let i = serverLetters.firstIndex(where: { $0.id == id }) else { return }
            serverLetters[i].read = read
            serverLetters[i].readAt = Date().timeIntervalSince1970 * 1000
        }
    }

    private func snapshot<T>(_ change: ((inout [Letter]) -> Void)? = nil,
                             _ take: ([Letter]) -> T) -> (T, CheckedContinuationGate) {
        lock.withLock {
            let gate = CheckedContinuationGate()
            if !holdReads { gate.open() }
            gates.append(gate)
            change?(&serverLetters)
            return (take(serverLetters), gate)
        }
    }

    func letters(archived: Bool) async throws -> LetterListResponse {
        let (rows, gate) = snapshot(nil) { $0.filter { $0.isArchived == archived } }
        await gate.wait()
        return LetterListResponse(letters: rows, unreadCount: rows.filter { !$0.isRead }.count)
    }

    func letter(id: String) async throws -> Letter {
        let (row, gate) = snapshot(nil) { $0.first { $0.id == id } }
        await gate.wait()
        guard let row else { throw APIError.badResponse }
        return row
    }

    func setLetterRead(id: String, read: Bool) async throws -> Letter {
        let row: Letter? = lock.withLock {
            guard let i = serverLetters.firstIndex(where: { $0.id == id }) else { return nil }
            serverLetters[i].read = read
            serverLetters[i].readAt = Date().timeIntervalSince1970 * 1000
            answeredWrites += 1
            return serverLetters[i]
        }
        guard let row else { throw APIError.badResponse }
        return row
    }

    func setLetterPinned(id: String, pinned: Bool) async throws -> Letter {
        let (row, gate) = snapshot({ rows in
            if let i = rows.firstIndex(where: { $0.id == id }) { rows[i].pinned = pinned }
        }) { $0.first { $0.id == id } }
        await gate.wait()
        guard let row else { throw APIError.badResponse }
        return row
    }

    func setLetterArchived(id: String, archived: Bool) async throws -> Letter {
        let (row, gate) = snapshot({ rows in
            if let i = rows.firstIndex(where: { $0.id == id }) { rows[i].archived = archived }
        }) { $0.first { $0.id == id } }
        await gate.wait()
        guard let row else { throw APIError.badResponse }
        return row
    }

    func answerLetter(id: String, actionId: String, freeText: String?) async throws -> LetterActionResult {
        throw APIError.badResponse
    }
    func replyToLetter(id: String, text: String) async throws -> LetterActionResult { throw APIError.badResponse }
}

/// Opening a letter asks for it and marks it read at the same moment. The letter's
/// answer is made with the old flag, and when it arrives after the write's own
/// answer it used to put the letter back to unread: the row, the Unread chip and the
/// tab badge all said unread for a letter on screen (demo run, App Store r8 gate:
/// two launches in three). An answer asked before a read landed keeps that read; one
/// asked after it is the server's newer word.
@MainActor
final class InboxLandedReadTests: XCTestCase {

    private var defaults: UserDefaults!
    private var suiteName = ""

    override func setUp() {
        super.setUp()
        suiteName = "InboxLandedReadTests-\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
        super.tearDown()
    }

    private func letter(_ id: String, read: Bool, minutesAgo: Double) -> Letter {
        let json: [String: Any] = [
            "id": id, "subject": "Subject of \(id)", "type": "info",
            "createdAt": Date().timeIntervalSince1970 * 1000 - minutesAgo * 60_000,
            "read": read, "pinned": false, "archived": false,
        ]
        let data = try! JSONSerialization.data(withJSONObject: json)
        return try! JSONDecoder().decode(Letter.self, from: data)
    }

    private func waitUntil(_ what: String, timeout: Double = 3, _ condition: () -> Bool,
                           line: UInt = #line) async {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return }
            try? await Task.sleep(for: .milliseconds(5))
        }
        XCTFail("timed out waiting for \(what)", line: line)
    }

    /// The write's answer has reached the store (its task runs on the main actor
    /// right after the transport answers).
    private func settle() async {
        for _ in 0..<20 { await Task.yield() }
        try? await Task.sleep(for: .milliseconds(30))
    }

    private func pairedStore(_ transport: SnapshotInboxTransport) async -> InboxStore {
        let inbox = InboxStore(transport: transport, defaults: defaults)
        await inbox.refresh()
        return inbox
    }

    func testTheLetterAnswerMadeBeforeTheOpenReadLandedKeepsItRead() async {
        let transport = SnapshotInboxTransport([
            letter("a", read: false, minutesAgo: 1), letter("b", read: false, minutesAgo: 2),
        ])
        let inbox = await pairedStore(transport)
        XCTAssertEqual(inbox.unreadCount, 2)
        let before = transport.readsAsked

        // The reader's order: the letter is asked for, then marked read.
        let gate = CheckedContinuationGate()
        transport.readGate = gate
        let detail = Task { try? await inbox.detail(id: "a") }
        await waitUntil("the letter's answer made") { transport.readsAsked == before + 1 }
        inbox.markReadOnOpen(id: "a")
        await waitUntil("the read landed") { transport.writesAnswered == 1 }
        await settle()
        XCTAssertEqual(inbox.letter(id: "a")?.isRead, true)

        gate.open()
        _ = await detail.value
        XCTAssertEqual(inbox.letter(id: "a")?.isRead, true, "the older answer put the opened letter back to unread")
        XCTAssertEqual(inbox.unreadCount, 1)
    }

    func testAListAnswerMadeBeforeTheReadLandedKeepsItRead() async {
        let transport = SnapshotInboxTransport([
            letter("a", read: false, minutesAgo: 1), letter("b", read: false, minutesAgo: 2),
        ])
        let inbox = await pairedStore(transport)
        let before = transport.readsAsked

        let gate = CheckedContinuationGate()
        transport.readGate = gate
        let refresh = Task { await inbox.refresh() }
        await waitUntil("the list's answer made") { transport.readsAsked == before + 1 }
        inbox.mark(id: "b", read: true)
        await waitUntil("the read landed") { transport.writesAnswered == 1 }
        await settle()

        gate.open()
        await refresh.value
        XCTAssertEqual(inbox.letter(id: "b")?.isRead, true, "the older list put the swiped letter back to unread")
        XCTAssertEqual(inbox.unreadCount, 1)
    }

    func testAnAnswerAskedAfterTheReadLandedIsTheNewerWord() async {
        let transport = SnapshotInboxTransport([letter("a", read: false, minutesAgo: 1)])
        let inbox = await pairedStore(transport)
        inbox.markReadOnOpen(id: "a")
        await waitUntil("the read landed") { transport.writesAnswered == 1 }
        await settle()

        // Another device marks it unread; a refresh asked now reports that.
        transport.setServerRead("a", false)
        await inbox.refresh()
        XCTAssertEqual(inbox.letter(id: "a")?.isRead, false, "a landed read must not outvote a newer answer")
        XCTAssertEqual(inbox.unreadCount, 1)
        // And it is not held for later answers either.
        await inbox.refresh()
        XCTAssertEqual(inbox.letter(id: "a")?.isRead, false)
    }

    // MARK: - Answers out of order (App Store r6 gate, finding 2)

    private func orderedStore(_ transport: OrderedInboxTransport) async -> InboxStore {
        let inbox = InboxStore(transport: transport, defaults: defaults)
        await inbox.refresh()
        transport.holdReads = true
        return inbox
    }

    /// The gate's probe P1: a letter answer asked BEFORE the read landed arrives
    /// AFTER one asked after it. The r8 rule dropped the landed read on the newer
    /// answer, and the older one then put the letter back to unread.
    func testAnOlderAnswerArrivingAfterANewerOneKeepsTheRead() async {
        let transport = OrderedInboxTransport([letter("a", read: false, minutesAgo: 1)])
        let inbox = await orderedStore(transport)
        XCTAssertEqual(inbox.unreadCount, 1)
        let base = transport.readsAsked

        let older = Task { try? await inbox.detail(id: "a") }
        await waitUntil("older asked") { transport.readsAsked == base + 1 }
        inbox.markReadOnOpen(id: "a")
        await waitUntil("the read landed") { transport.writesAnswered == 1 }
        await settle()
        let newer = Task { try? await inbox.detail(id: "a") }
        await waitUntil("newer asked") { transport.readsAsked == base + 2 }

        transport.openRead(base + 1)
        _ = await newer.value
        XCTAssertEqual(inbox.letter(id: "a")?.isRead, true)
        transport.openRead(base)
        _ = await older.value
        XCTAssertEqual(inbox.letter(id: "a")?.isRead, true, "the older answer undid the read")
        XCTAssertEqual(inbox.unreadCount, 0, "the badge went back up")
    }

    /// The verdict's scenario: a letter opened while a list refresh is in flight, the
    /// letter fetched again after the read landed; the newer letter answer comes
    /// first, the older list last.
    func testAnOlderListArrivingAfterANewerLetterAnswerKeepsTheRead() async {
        let transport = OrderedInboxTransport([
            letter("a", read: false, minutesAgo: 1), letter("b", read: false, minutesAgo: 2),
        ])
        let inbox = await orderedStore(transport)
        let base = transport.readsAsked

        let list = Task { await inbox.refresh() }
        await waitUntil("the list asked") { transport.readsAsked == base + 1 }
        inbox.markReadOnOpen(id: "a")
        await waitUntil("the read landed") { transport.writesAnswered == 1 }
        await settle()
        let fetch = Task { try? await inbox.detail(id: "a") }
        await waitUntil("the letter asked") { transport.readsAsked == base + 2 }

        transport.openRead(base + 1)
        _ = await fetch.value
        transport.openRead(base)
        await list.value
        XCTAssertEqual(inbox.letter(id: "a")?.isRead, true, "the older list undid the read")
        XCTAssertEqual(inbox.letter(id: "b")?.isRead, false)
        XCTAssertEqual(inbox.unreadCount, 1)
    }

    /// Two list refreshes around a swipe, answered newer first.
    func testAnOlderListArrivingAfterANewerListKeepsTheRead() async {
        let transport = OrderedInboxTransport([
            letter("a", read: false, minutesAgo: 1), letter("b", read: false, minutesAgo: 2),
        ])
        let inbox = await orderedStore(transport)
        let base = transport.readsAsked

        let older = Task { await inbox.refresh() }
        await waitUntil("older asked") { transport.readsAsked == base + 1 }
        inbox.mark(id: "b", read: true)
        await waitUntil("the read landed") { transport.writesAnswered == 1 }
        await settle()
        let newer = Task { await inbox.refresh() }
        await waitUntil("newer asked") { transport.readsAsked == base + 2 }

        transport.openRead(base + 1)
        await newer.value
        XCTAssertEqual(inbox.letter(id: "b")?.isRead, true)
        transport.openRead(base)
        await older.value
        XCTAssertEqual(inbox.letter(id: "b")?.isRead, true, "the older list undid the swipe")
        XCTAssertEqual(inbox.unreadCount, 1)
    }

    /// The newest word wins both ways: after the read landed another device marked the
    /// letter unread, and an answer asked after that says so. An answer asked before
    /// the read that arrives last must not bring the read back.
    func testAnOlderAnswerDoesNotOutvoteANewerUnread() async {
        let transport = OrderedInboxTransport([letter("a", read: false, minutesAgo: 1)])
        let inbox = await orderedStore(transport)
        let base = transport.readsAsked

        let older = Task { try? await inbox.detail(id: "a") }
        await waitUntil("older asked") { transport.readsAsked == base + 1 }
        inbox.markReadOnOpen(id: "a")
        await waitUntil("the read landed") { transport.writesAnswered == 1 }
        await settle()
        transport.setServerRead("a", false)
        let newer = Task { await inbox.refresh() }
        await waitUntil("newer asked") { transport.readsAsked == base + 2 }

        transport.openRead(base + 1)
        await newer.value
        XCTAssertEqual(inbox.letter(id: "a")?.isRead, false, "the newer answer is the server's word")
        transport.openRead(base)
        _ = await older.value
        XCTAssertEqual(inbox.letter(id: "a")?.isRead, false, "an older answer brought back a read the server no longer has")
        XCTAssertEqual(inbox.unreadCount, 1)
    }

    /// The gate's probe P2: a pin answer made before the read landed keeps the read.
    func testAPinAnswerMadeBeforeTheReadLandedKeepsItRead() async {
        let transport = OrderedInboxTransport([letter("a", read: false, minutesAgo: 1)])
        let inbox = await orderedStore(transport)
        let base = transport.readsAsked

        let pin = Task { await inbox.setPinned(id: "a", pinned: true) }
        await waitUntil("pin asked") { transport.readsAsked == base + 1 }
        inbox.mark(id: "a", read: true)
        await waitUntil("the read landed") { transport.writesAnswered == 1 }
        await settle()
        transport.openRead(base)
        await pin.value
        XCTAssertEqual(inbox.letter(id: "a")?.isRead, true, "the pin answer undid the read")
        XCTAssertEqual(inbox.letter(id: "a")?.pinned, true)
        XCTAssertEqual(inbox.unreadCount, 0)
    }

    /// An archive answer made before the read landed keeps the read (the gate's
    /// mutant M4 removed the overlay from the pin and archive answers, and no
    /// shipped test failed).
    func testAnArchiveAnswerMadeBeforeTheReadLandedKeepsItRead() async {
        let transport = OrderedInboxTransport([
            letter("a", read: false, minutesAgo: 1), letter("b", read: false, minutesAgo: 2),
        ])
        let inbox = await orderedStore(transport)
        let base = transport.readsAsked

        let archive = Task { await inbox.setArchived(id: "a", archived: true) }
        await waitUntil("archive asked") { transport.readsAsked == base + 1 }
        inbox.mark(id: "a", read: true)
        await waitUntil("the read landed") { transport.writesAnswered == 1 }
        await settle()
        transport.openRead(base)
        await archive.value
        XCTAssertEqual(inbox.letter(id: "a")?.isArchived, true)
        XCTAssertEqual(inbox.letter(id: "a")?.isRead, true, "the archive answer undid the read")
        XCTAssertTrue(inbox.archivedLetters.contains { $0.id == "a" && $0.isRead })
    }

    /// Unarchiving brings the letter back to the inbox with the read it got while
    /// the answer was on the wire.
    func testAnUnarchiveAnswerMadeBeforeTheReadLandedKeepsItRead() async {
        var archived = letter("a", read: false, minutesAgo: 1)
        archived.archived = true
        let transport = OrderedInboxTransport([archived, letter("b", read: false, minutesAgo: 2)])
        let inbox = InboxStore(transport: transport, defaults: defaults)
        await inbox.refresh()
        await inbox.refreshArchived()
        transport.holdReads = true
        let base = transport.readsAsked

        let restore = Task { await inbox.setArchived(id: "a", archived: false) }
        await waitUntil("unarchive asked") { transport.readsAsked == base + 1 }
        inbox.mark(id: "a", read: true)
        await waitUntil("the read landed") { transport.writesAnswered == 1 }
        await settle()
        transport.openRead(base)
        await restore.value
        XCTAssertEqual(inbox.letter(id: "a")?.isArchived, false)
        XCTAssertEqual(inbox.letter(id: "a")?.isRead, true, "the unarchive answer undid the read")
        XCTAssertEqual(inbox.unreadCount, 1)
    }

    // MARK: - The App Store r7 gate's probes P3, P5 and P6

    /// P3: this device marks a read letter unread while a list asked before that
    /// write is in flight; the list (still "read") arrives after the write landed.
    func testAnOlderListDoesNotUndoThisDevicesUnread() async {
        let transport = OrderedInboxTransport([letter("a", read: true, minutesAgo: 1)])
        let inbox = await orderedStore(transport)
        XCTAssertEqual(inbox.unreadCount, 0)
        let base = transport.readsAsked

        let older = Task { await inbox.refresh() }
        await waitUntil("older asked") { transport.readsAsked == base + 1 }
        inbox.mark(id: "a", read: false)
        await waitUntil("the unread landed") { transport.writesAnswered == 1 }
        await settle()
        transport.openRead(base)
        await older.value
        XCTAssertEqual(inbox.letter(id: "a")?.isRead, false, "an older list undid this device's unread")
        XCTAssertEqual(inbox.unreadCount, 1)
    }

    /// P5: two answers both asked after the read landed, with another device's unread
    /// between them; the later-asked one arrives first. The later-asked answer is the
    /// newest word and stands.
    func testTheLaterAskedAnswerWinsEvenWhenItArrivesFirst() async {
        let transport = OrderedInboxTransport([letter("a", read: false, minutesAgo: 1)])
        let inbox = InboxStore(transport: transport, defaults: defaults)
        await inbox.refresh()
        inbox.markReadOnOpen(id: "a")
        await waitUntil("the read landed") { transport.writesAnswered == 1 }
        await settle()
        transport.holdReads = true
        let base = transport.readsAsked

        let first = Task { await inbox.refresh() }
        await waitUntil("first asked") { transport.readsAsked == base + 1 }
        transport.setServerRead("a", false)
        let second = Task { try? await inbox.detail(id: "a") }
        await waitUntil("second asked") { transport.readsAsked == base + 2 }
        transport.openRead(base + 1)
        _ = await second.value
        XCTAssertEqual(inbox.letter(id: "a")?.isRead, false)
        transport.openRead(base)
        await first.value
        XCTAssertEqual(inbox.letter(id: "a")?.isRead, false, "an earlier-asked answer outvoted the newest word")
        XCTAssertEqual(inbox.unreadCount, 1)
    }

    /// P6: the Archived list. An archived unread letter is opened while an Archived
    /// list asked before the read is in flight; the list arrives after the read
    /// landed, and the letter stays read.
    func testAnOlderArchivedListKeepsTheRead() async {
        var archived = letter("z", read: false, minutesAgo: 30)
        archived.archived = true
        let transport = OrderedInboxTransport([archived])
        let inbox = InboxStore(transport: transport, defaults: defaults)
        await inbox.refreshArchived()
        XCTAssertEqual(inbox.letter(id: "z")?.isRead, false)
        transport.holdReads = true
        let base = transport.readsAsked

        let older = Task { await inbox.refreshArchived() }
        await waitUntil("older asked") { transport.readsAsked == base + 1 }
        inbox.markReadOnOpen(id: "z")
        await waitUntil("the read landed") { transport.writesAnswered == 1 }
        await settle()
        transport.openRead(base)
        await older.value
        XCTAssertEqual(inbox.letter(id: "z")?.isRead, true, "the archived list undid the read")
        XCTAssertTrue(inbox.archivedLetters.contains { $0.id == "z" && $0.isRead })
    }
}

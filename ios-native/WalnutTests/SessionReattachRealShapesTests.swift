import XCTest
@testable import Walnut

/// The wire shapes a phone met on reopening a running session (live review, 2026-11-04): the stream's
/// snapshot, the cached read of the saved rows and the fresh one, as the server answered them.
@MainActor
final class SessionReattachRealShapesTests: XCTestCase {
    private let snapshotJSON = #"""
{"blocks":[{"type":"thinking","content":"The user is asking me to run6 steps sequentially, each one sleeping for 25 seconds and then printing a status message. They explicitly say \"one after another, each as its own Bash call\" and \"Do not combine steps.\"\n\nThis is straightforward - I need to call the Bash tool6 times sequentially, waiting for each to complete before starting the next (since they depend on each other in the sense that I should wait for one to finish before calling the next).\n\nLet me start with step 1.","msgId":"msg_bdrk_rosdvredx25xs5t6jg4ifozopqhcghmnewjtqlk3jh5smhivb6xa"},{"type":"text","content":"I'll run these steps sequentially for you, one Bash call at a time.","msgId":"msg_bdrk_rosdvredx25xs5t6jg4ifozopqhcghmnewjtqlk3jh5smhivb6xa"},{"type":"tool_call","toolUseId":"toolu_bdrk_011UkSb2zwE91modPR6GVL5h","name":"Bash","input":{"command":"sleep 25 && echo shard-1-done","description":"Step 1: Sleep and echo shard-1-done"},"status":"done","result":"shard-1-done"},{"type":"text","content":"Step 1 complete: **shard-1-done**","msgId":"msg_bdrk_fyquvt46rydrjk23mbc4nyahtjpxuf7df6f5ochcls767azlswya"},{"type":"tool_call","toolUseId":"toolu_bdrk_01A3LDynuaaDDru9SVNqgeN1","name":"Bash","input":{"command":"sleep 25 && echo shard-2-done","description":"Step 2: Sleep and echo shard-2-done"},"status":"done","result":"shard-2-done"},{"type":"text","content":"Step 2 complete: **shard-2-done**","msgId":"msg_bdrk_lcxllpkoqd5rhbwn7yr2zu5l6iipiauj7rgk77ifssn4kkgogsxa"},{"type":"tool_call","toolUseId":"toolu_bdrk_0153GEFXqhtnYaJqSU3PrRWj","name":"Bash","input":{"command":"sleep 25 && echo shard-3-done","description":"Step 3: Sleep and echo shard-3-done"},"status":"calling"}],"isStreaming":true,"completedLen":0,"processStatus":"running"}
"""#
    private let cachedJSON = #"""
{"version":1,"sessionId":"ca480069-d632-4b41-a9f7-f62f1f3eef6c","exportedAt":"2026-11-05T04:30:19.050Z","truncated":false,"messages":[{"role":"user","text":"Rebuild the search index in 6 shards. Run these steps one after another, each as its own Bash call, and tell me the result after each one: step 1: sleep 25 && echo shard-1-done. step 2: sleep 25 && echo shard-2-done. step 3: sleep 25 && echo shard-3-done. step 4: sleep 25 && echo shard-4-done. step 5: sleep 25 && echo shard-5-done. step 6: sleep 25 && echo shard-6-done. Do not combine steps.","timestamp":"2026-11-05T04:29:13.527Z","sentBy":"person"},{"role":"assistant","text":"The user is asking me to run 6 steps sequentially, each one sleeping for 25 seconds and then printing a status message. They explicitly say \"one after another, …","timestamp":"2026-11-05T04:29:15.751Z","kind":"thinking"},{"role":"assistant","text":"I'll run these steps sequentially for you, one Bash call at a time.","timestamp":"2026-11-05T04:29:15.751Z"},{"role":"assistant","text":"Bash","timestamp":"2026-11-05T04:29:15.751Z","kind":"tool","detail":"Step 1: Sleep and echo shard-1-done","resultPreview":"shard-1-done"},{"role":"assistant","text":"Step 1 complete: **shard-1-done**","timestamp":"2026-11-05T04:29:44.211Z"},{"role":"assistant","text":"Bash","timestamp":"2026-11-05T04:29:44.211Z","kind":"tool","detail":"Step 2: Sleep and echo shard-2-done","resultPreview":"shard-2-done"},{"role":"assistant","text":"Step 2 complete: **shard-2-done**","timestamp":"2026-11-05T04:30:10.745Z"},{"role":"assistant","text":"Bash","timestamp":"2026-11-05T04:30:10.745Z","kind":"tool","detail":"Step 3: Sleep and echo shard-3-done"}]}
"""#
    private let freshJSON = #"""
{"version":1,"sessionId":"ca480069-d632-4b41-a9f7-f62f1f3eef6c","exportedAt":"2026-11-05T04:30:19.060Z","truncated":false,"messages":[{"role":"user","text":"Rebuild the search index in 6 shards. Run these steps one after another, each as its own Bash call, and tell me the result after each one: step 1: sleep 25 && echo shard-1-done. step 2: sleep 25 && echo shard-2-done. step 3: sleep 25 && echo shard-3-done. step 4: sleep 25 && echo shard-4-done. step 5: sleep 25 && echo shard-5-done. step 6: sleep 25 && echo shard-6-done. Do not combine steps.","timestamp":"2026-11-05T04:29:13.527Z","sentBy":"person"},{"role":"assistant","text":"The user is asking me to run 6 steps sequentially, each one sleeping for 25 seconds and then printing a status message. They explicitly say \"one after another, …","timestamp":"2026-11-05T04:29:15.751Z","kind":"thinking","thinkingText":"The user is asking me to run 6 steps sequentially, each one sleeping for 25 seconds and then printing a status message. They explicitly say \"one after another, each as its own Bash call\" and \"Do not combine steps.\"\n\nThis is straightforward - I need to call the Bash tool 6 times sequentially, waiting for each to complete before starting the next (since they depend on each other in the sense that I should wait for one to finish before calling the next).\n\nLet me start with step 1."},{"role":"assistant","text":"I'll run these steps sequentially for you, one Bash call at a time.","timestamp":"2026-11-05T04:29:15.751Z"},{"role":"assistant","text":"Bash","timestamp":"2026-11-05T04:29:15.751Z","kind":"tool","detail":"Step 1: Sleep and echo shard-1-done","inputPreview":"command: sleep 25 && echo shard-1-done\ndescription: Step 1: Sleep and echo shard-1-done","resultPreview":"shard-1-done"},{"role":"assistant","text":"Step 1 complete: **shard-1-done**","timestamp":"2026-11-05T04:29:44.211Z"},{"role":"assistant","text":"Bash","timestamp":"2026-11-05T04:29:44.211Z","kind":"tool","detail":"Step 2: Sleep and echo shard-2-done","inputPreview":"command: sleep 25 && echo shard-2-done\ndescription: Step 2: Sleep and echo shard-2-done","resultPreview":"shard-2-done"},{"role":"assistant","text":"Step 2 complete: **shard-2-done**","timestamp":"2026-11-05T04:30:10.745Z"},{"role":"assistant","text":"Bash","timestamp":"2026-11-05T04:30:10.745Z","kind":"tool","detail":"Step 3: Sleep and echo shard-3-done","inputPreview":"command: sleep 25 && echo shard-3-done\ndescription: Step 3: Sleep and echo shard-3-done"}],"rich":true,"pageable":true}
"""#

    private func shape(_ messages: [ChatMessage]) -> [String] {
        messages.map { m in
            switch m.kind {
            case .tool: return "tool:\(m.text)"
            case .thinking: return "thinking"
            default: return "\(m.role):\(m.text.prefix(40))"
            }
        }
    }

    func testReopeningMidTurnWithTheServersOwnAnswersLeavesNoCopies() throws {
        let transport = MockSessionSendTransport()
        let store = SessionConversationStore(session: ScriptedSSE.session(id: "reattach-real"), transport: transport)
        store.handle(SSEEvent(id: nil, event: "snapshot", data: snapshotJSON))
        let cached = try JSONDecoder().decode(SessionTranscript.self, from: Data(cachedJSON.utf8))
        let fresh = try JSONDecoder().decode(SessionTranscript.self, from: Data(freshJSON.utf8))
        store.reconcile(cached)
        store.reconcile(fresh)
        XCTAssertEqual(store.liveText, "", "every step the snapshot told is a saved row")
        XCTAssertTrue(store.liveTools.isEmpty)
        XCTAssertEqual(store.messages.filter { $0.text.hasPrefix("Step 1 complete") }.count, 1)
    }

    func testAnOlderCachedReadFollowedByTheFreshOneLeavesNoCopies() throws {
        let fresh = try JSONDecoder().decode(SessionTranscript.self, from: Data(freshJSON.utf8))
        for keep in 2...6 {
            let transport = MockSessionSendTransport()
            let store = SessionConversationStore(session: ScriptedSSE.session(id: "reattach-real-\(keep)"), transport: transport)
            store.handle(SSEEvent(id: nil, event: "snapshot", data: snapshotJSON))
            let older = SessionTranscript(sessionId: fresh.sessionId, exportedAt: fresh.exportedAt, truncated: false,
                                          messages: Array(fresh.messages.prefix(keep)))
            store.reconcile(older)
            let afterOlder = store.liveText
            store.reconcile(fresh)
            XCTAssertEqual(store.liveText, "", "cache of \(keep) rows (live after it: \(afterOlder.debugDescription))")
            XCTAssertTrue(store.liveTools.isEmpty, "cache of \(keep) rows")
        }
    }

    /// The page's own open(): the cached read is held while the snapshot lands (it did, 17 ms after the
    /// stream connected, in the phone's log), then the cached read and the fresh page answer.
    func testOpenWithTheSnapshotLandingBeforeTheCachedReadLeavesNoCopies() async throws {
        let transport = MockSessionSendTransport()
        let store = SessionConversationStore(session: ScriptedSSE.session(id: "reattach-real-open"), transport: transport)
        let cached = try JSONDecoder().decode(SessionTranscript.self, from: Data(cachedJSON.utf8))
        let fresh = try JSONDecoder().decode(SessionTranscript.self, from: Data(freshJSON.utf8))
        transport.transcript = cached
        transport.pages = { _ in fresh }
        let gate = CheckedContinuationGate()
        transport.transcriptGate = gate
        let opening = Task { await store.open() }
        try await Task.sleep(for: .milliseconds(50))
        store.handle(SSEEvent(id: nil, event: "snapshot", data: snapshotJSON))
        gate.open()
        _ = await opening.value
        XCTAssertEqual(store.liveText, "", "every step the snapshot told is a saved row")
        XCTAssertTrue(store.liveTools.isEmpty)
    }

    /// What the primary server writes right after the snapshot of a stream with no Last-Event-ID: its ring of
    /// recent events, which is the end of the same turn the snapshot just told. A short turn is there whole,
    /// from its own `turn-start`; a long one has lost its head (`ring` = how many events the ring still holds).
    private func replayEvents(ring: Int? = nil) throws -> [SSEEvent] {
        let snap = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(snapshotJSON.utf8)) as? [String: Any])
        let blocks = try XCTUnwrap(snap["blocks"] as? [[String: Any]])
        var out: [SSEEvent] = []
        var seq = 1000
        func add(_ name: String, _ body: [String: Any]) {
            seq += 1
            let data = (try? JSONSerialization.data(withJSONObject: body)).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
            out.append(SSEEvent(id: String(seq), event: name, data: data))
        }
        add("turn-start", [:])
        for block in blocks {
            switch block["type"] as? String {
            case "thinking":
                add("thinking", ["delta": block["content"] as? String ?? ""])
            case "text":
                let text = block["content"] as? String ?? ""
                var rest = Substring(text)
                while !rest.isEmpty {
                    let piece = rest.prefix(7)
                    add("text-delta", ["delta": String(piece)])
                    rest = rest.dropFirst(piece.count)
                }
            case "tool_call":
                add("tool", ["name": block["name"] as? String ?? "", "toolUseId": block["toolUseId"] as? String ?? "",
                             "detail": "sleep"])
                if block["status"] as? String == "done" {
                    add("tool-result", ["toolUseId": block["toolUseId"] as? String ?? "", "resultPreview": block["result"] as? String ?? ""])
                }
            default: break
            }
        }
        if let ring { return Array(out.suffix(ring)) }
        return out
    }

    /// The live text is folded in on a short timer.
    private func flush(_ store: SessionConversationStore) async {
        try? await Task.sleep(for: .milliseconds(400))
    }

    private func textDelta(_ text: String, id: Int) -> SSEEvent {
        let data = (try? JSONSerialization.data(withJSONObject: ["delta": text])).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
        return SSEEvent(id: String(id), event: "text-delta", data: data)
    }

    private func openedStore(_ tag: String, clock: SessionStreamClock = SystemSessionStreamClock()) throws
        -> (SessionConversationStore, SessionTranscript) {
        let transport = MockSessionSendTransport()
        let store = SessionConversationStore(session: ScriptedSSE.session(id: "reattach-\(tag)"), transport: transport, clock: clock)
        let fresh = try JSONDecoder().decode(SessionTranscript.self, from: Data(freshJSON.utf8))
        return (store, fresh)
    }

    func testTheReplayThatFollowsTheSnapshotLeavesNoCopiesOfWhatTheHistoryHolds() async throws {
        for ring in [nil, 40, 12, 5] as [Int?] {
            let (store, fresh) = try openedStore("replay-\(ring ?? 0)")
            let cached = try JSONDecoder().decode(SessionTranscript.self, from: Data(cachedJSON.utf8))
            store.handle(SSEEvent(id: nil, event: "snapshot", data: snapshotJSON))
            store.reconcile(cached)
            store.reconcile(fresh)
            for event in try replayEvents(ring: ring) { store.handle(event) }
            await flush(store)
            XCTAssertEqual(store.liveText, "", "a ring of \(ring.map(String.init) ?? "the whole turn")")
            XCTAssertEqual(store.messages.filter { $0.text.hasPrefix("Step 1 complete") }.count, 1)
            store.reconcile(fresh)
            XCTAssertEqual(store.liveText, "")
        }
    }

    func testTheReplayThatComesBeforeTheReadsLeavesNoCopies() async throws {
        for ring in [nil, 12] as [Int?] {
            let (store, fresh) = try openedStore("replay-first-\(ring ?? 0)")
            let cached = try JSONDecoder().decode(SessionTranscript.self, from: Data(cachedJSON.utf8))
            store.handle(SSEEvent(id: nil, event: "snapshot", data: snapshotJSON))
            for event in try replayEvents(ring: ring) { store.handle(event) }
            await flush(store)
            store.reconcile(cached)
            store.reconcile(fresh)
            XCTAssertEqual(store.liveText, "", "a ring of \(ring.map(String.init) ?? "the whole turn")")
            XCTAssertEqual(store.messages.filter { $0.text.hasPrefix("Step 1 complete") }.count, 1)
        }
    }

    func testWordsThatComeAfterTheReplayAreNewAndShownOnce() async throws {
        let (store, fresh) = try openedStore("after")
        store.handle(SSEEvent(id: nil, event: "snapshot", data: snapshotJSON))
        store.reconcile(fresh)
        for event in try replayEvents(ring: 12) { store.handle(event) }
        store.handle(textDelta("Step 3 under way", id: 2000))
        await flush(store)
        XCTAssertEqual(store.liveText.trimmingCharacters(in: .whitespacesAndNewlines), "Step 3 under way")
    }

    func testAReplayThatStopsShortOfTheSnapshotAndIsMadeUpLiveIsStillShownOnce() async throws {
        let (store, fresh) = try openedStore("lag")
        store.handle(SSEEvent(id: nil, event: "snapshot", data: snapshotJSON))
        store.reconcile(fresh)
        let events = try replayEvents(ring: 20)
        let textEvents = events.filter { $0.event == "text-delta" }
        let cut = textEvents.count - 3
        var seen = 0
        for event in events {
            if event.event == "text-delta" {
                seen += 1
                if seen > cut { continue }
            }
            store.handle(event)
        }
        // The last stretch of the snapshot's words reaches the page live, after the replay.
        for (n, event) in textEvents.suffix(3).enumerated() {
            store.handle(SSEEvent(id: String(3000 + n), event: "text-delta", data: event.data))
        }
        store.handle(textDelta("tail", id: 3100))
        await flush(store)
        XCTAssertEqual(store.liveText.trimmingCharacters(in: .whitespacesAndNewlines), "tail")
    }

    func testNewWordsWithNoReplayBeforeThemAreShownInFull() async throws {
        let (store, fresh) = try openedStore("fresh-words")
        store.handle(SSEEvent(id: nil, event: "snapshot", data: snapshotJSON))
        store.reconcile(fresh)
        store.handle(textDelta("Something else ", id: 2))
        store.handle(textDelta("entirely", id: 3))
        await flush(store)
        XCTAssertEqual(store.liveText, "Something else entirely")
    }

    func testWordsThatOnlyLookLikeTheReplayAreShownOnceTheStreamGoesQuiet() async throws {
        let clock = ManualStreamClock()
        let (store, fresh) = try openedStore("quiet", clock: clock)
        store.handle(SSEEvent(id: nil, event: "snapshot", data: snapshotJSON))
        store.reconcile(fresh)
        // A stretch of the snapshot's own words that does not run to its end, and then nothing.
        store.handle(textDelta("Step 1 complete", id: 5))
        await flush(store)
        XCTAssertEqual(store.liveText, "", "kept back while it may still be the replay")
        await clock.advance(by: SessionReplayTwin.holdSpan + 0.5)
        await flush(store)
        XCTAssertEqual(store.liveText, "Step 1 complete")
    }

    func testAReplayOfAnotherTurnIsShownAsNewWords() async throws {
        let (store, fresh) = try openedStore("other")
        store.handle(SSEEvent(id: nil, event: "snapshot", data: snapshotJSON))
        store.reconcile(fresh)
        store.handle(SSEEvent(id: "1", event: "turn-start", data: "{}"))
        store.handle(textDelta("Something else ", id: 2))
        store.handle(textDelta("entirely", id: 3))
        await flush(store)
        XCTAssertEqual(store.liveText, "Something else entirely")
    }

    func testATurnStartAfterTheReplayIsARealNewTurn() async throws {
        let (store, fresh) = try openedStore("next")
        store.handle(SSEEvent(id: nil, event: "snapshot", data: snapshotJSON))
        store.reconcile(fresh)
        for event in try replayEvents() { store.handle(event) }
        store.handle(SSEEvent(id: "4000", event: "turn-end", data: "{}"))
        store.handle(SSEEvent(id: "4001", event: "turn-start", data: "{}"))
        store.handle(textDelta("A new turn", id: 4002))
        await flush(store)
        XCTAssertEqual(store.liveText, "A new turn")
    }

    func testAReconnectMidTurnRepeatsTheSameQuietly() async throws {
        let (store, fresh) = try openedStore("again")
        for ring in [nil, 12] as [Int?] {
            store.handle(SSEEvent(id: nil, event: "snapshot", data: snapshotJSON))
            store.reconcile(fresh)
            for event in try replayEvents(ring: ring) { store.handle(event) }
            await flush(store)
            XCTAssertEqual(store.liveText, "")
            XCTAssertEqual(store.messages.filter { $0.text.hasPrefix("Step 1 complete") }.count, 1)
        }
    }
}

/// The matcher that tells a stream's replay of the snapshot's turn from new words.
final class SessionReplayTwinTests: XCTestCase {
    private func twin(_ text: String) -> SessionReplayTwin { SessionReplayTwin(snapshotText: text, until: 100) }

    func testTheTailOfTheSnapshotIsTheReplayOnceItRunsToTheEnd() {
        var t = twin("Step one complete. Step two complete.")
        XCTAssertEqual(t.take("Step two"), .held)
        XCTAssertEqual(t.take(" complete"), .held)
        XCTAssertEqual(t.take("."), .finished(rest: ""))
    }

    func testWhatFollowsTheSnapshotsEndInTheSameDeltaIsNew() {
        var t = twin("Step one complete.")
        XCTAssertEqual(t.take("Step one complete. Now step two"), .finished(rest: " Now step two"))
    }

    func testWhitespaceDoesNotCount() {
        var t = twin("Step one\n\ncomplete")
        XCTAssertEqual(t.take("Step"), .held)
        XCTAssertEqual(t.take("   one complete"), .finished(rest: ""))
    }

    func testWordsThatStopMatchingAreGivenBackWithEverythingKeptBack() {
        var t = twin("Step one complete. Step two complete.")
        XCTAssertEqual(t.take("Step "), .held)
        XCTAssertEqual(t.take("three"), .differs(release: ["Step ", "three"]))
    }

    func testAStretchTooShortToProveAnythingIsNotTakenForTheReplay() {
        var t = twin("All shards are done.")
        XCTAssertEqual(t.take("."), .differs(release: ["."]), "the last character alone does not make it the replay")
    }

    func testARepeatedBeginningIsFollowedUntilOnlyTheRealStretchIsLeft() {
        var t = twin("alpha beta alpha beta gamma")
        XCTAssertEqual(t.take("alpha beta"), .held, "it fits at the start and in the middle")
        XCTAssertEqual(t.take(" gamma"), .finished(rest: ""), "only the middle one runs to the end")
    }

    func testWhatWasKeptBackCanBeGivenBack() {
        var t = twin("Step one complete.")
        _ = t.take("Step one")
        XCTAssertEqual(t.release(), ["Step one"])
        XCTAssertEqual(t.release(), [])
    }
}

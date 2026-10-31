import Foundation
import CoreGraphics
import UIKit

/// Background build pipeline: TimelineInput (a plain snapshot of store state)
/// → immutable, height-measured TimelineSnapshot. All parsing, markdown
/// attribution and TextKit measurement happen HERE, off the main thread.
///
/// Coalescing is latest-wins: if inputs arrive faster than builds complete
/// (500 ev/s microbursts), intermediate snapshots are skipped — the UI only
/// ever needs the newest state, and the actor's serial execution makes the
/// pending-slot handoff race-free.
///
/// INCREMENTAL BY MEMOIZATION, not by delta protocol: message rows are cached
/// keyed on (message id, revision-relevant flags, expansion, width, text size)
/// and validated against the memoized message itself, so an unchanged message
/// costs a dictionary hit — a 21 ev/s storm re-BUILDS only the live tail while the
/// 105 history messages replay from cache. Live head rows use the dedicated
/// head cache (LiveMarkdownWindow's quantized head is byte-stable across
/// many ticks); a live window carrying raw HTML has no head, because it is
/// segmented whole (see TimelineRowBuilder.liveRows).
actor TimelineLayoutActor {
    private let builder = TimelineRowBuilder()
    private var generation = 0

    private var pendingInput: TimelineInput?
    private var building = false

    /// Memoized rows per message. The key is the BUCKET; the message stored
    /// beside the rows is the AUTHORITY — see `cacheKey`.
    private var rowCache: [String: (message: ChatMessage, rows: [TimelineRow])] = [:]
    private var cacheWidth: CGFloat = 0
    /// Text size the memo was measured at. A live Dynamic Type change moves every
    /// height in it, exactly like a width change.
    private var cacheSizeCategory: UIContentSizeCategory = .unspecified
    private static let rowCacheLimit = 600

    /// Live-head memo (see TimelineRowBuilder.liveRows).
    private var headCache: (key: String, rows: [TimelineRow])?
    /// Conversation the memo was filled for. The rows it holds carry SCOPED ids,
    /// so a head string that repeats across a switch must not replay the
    /// previous conversation's rows (the row cache is safe by key, but the head
    /// memo is keyed on the head TEXT alone).
    private var cacheScope: String = TimelineScope.unscoped
    private var tailRevision = 0

    /// Memo entries whose rows hold a rich-HTML document → the height-cache
    /// identities those rows read (document keys + row ids). Rich rows are the
    /// ONE kind whose height is measured by the cell (WebKit is
    /// main-thread-only) and banked afterwards, so a memoized row would
    /// otherwise replay the rough first guess for ever and the measurement would
    /// never reach the layout.
    ///
    /// The identities are what keeps the response proportional: a measurement
    /// touches the rows that read the number that moved, and every other
    /// message's memo — plus the live head's TextKit measurement — is none of
    /// its business.
    private var richEntryIdentities: [String: Set<String>] = [:]

    /// The shape each turn settled into while the session was quiet, so it holds
    /// while the next turn streams (`TimelineTurnShape.settle`). Per conversation.
    private var settledTurnKinds: [String: TimelineTurnShape.Kind] = [:]

    /// The fold key of the received message the live turn's calls rode while it
    /// streamed. After the turn ends only THAT row keeps the calls: a turn whose
    /// own delivery never reached history (it lands with the refetch) must not
    /// lend its calls to the turn before it.
    private var liveTailKey: String?
    /// The id of the last history row while the turn streamed: at its end, the
    /// rows after it are the reply the store painted, and nothing before them is.
    private var liveLastRowID: String?

    /// Submit the newest input. `onSnapshot` is invoked (on the actor) for
    /// every COMPLETED build — the caller hops to the main queue itself.
    func submit(_ input: TimelineInput, onSnapshot: @escaping @Sendable (TimelineSnapshot) -> Void) {
        pendingInput = input
        guard !building else { return } // the running loop picks it up
        building = true
        while let next = pendingInput {
            pendingInput = nil
            let snapshot = build(next)
            onSnapshot(snapshot)
        }
        building = false
    }

    /// Synchronous build — actor-serialized. Exposed for tests (deterministic
    /// single build without the coalescing loop).
    func buildSnapshot(_ input: TimelineInput) -> TimelineSnapshot {
        build(input)
    }

    private func build(_ input: TimelineInput) -> TimelineSnapshot {
        generation += 1
        // Fonts are resolved for the CURRENT text size rather than frozen at first
        // access, so a live Dynamic Type change has to reach the styler before any
        // measurement in this build reads a font.
        TimelineTextStyler.adopt(input.sizeCategory)
        if input.width != cacheWidth || input.sizeCategory != cacheSizeCategory {
            rowCache = [:]
            headCache = nil
            richEntryIdentities.removeAll(keepingCapacity: true)
            cacheWidth = input.width
            cacheSizeCategory = input.sizeCategory
        }
        if input.scope != cacheScope {
            // The row cache SURVIVES a switch (its keys are scoped, so it can
            // only ever hand back rows built for this conversation — and keeping
            // it is what makes switching back instant). The head memo cannot:
            // it is keyed on the live text alone.
            headCache = nil
            settledTurnKinds = [:]
            liveTailKey = nil
            liveLastRowID = nil
            cacheScope = input.scope
        }
        applyRichHeightChanges()
        var rows: [TimelineRow] = []
        rows.reserveCapacity(input.messages.count * 2 + 4)
        if input.showLoadEarlier {
            rows.append(builder.loadEarlierRow(scope: input.scope, state: input.loadEarlierState))
        }
        func memoizedRows(for message: ChatMessage,
                          queued: QueuedSend.Status?) -> [TimelineRow] {
            let key = cacheKey(message, expandedRowIDs: input.expandedRowIDs,
                               scope: input.scope, queued: queued)
            if let cached = rowCache[key], cached.message == message { return cached.rows }
            let built = builder.rows(for: message, width: input.width,
                                     expandedRowIDs: input.expandedRowIDs,
                                     scope: input.scope, queued: queued)
            rowCache[key] = (message, built)
            let identities = TimelineRowBuilder.richIdentities(in: built)
            if !identities.isEmpty { richEntryIdentities[key] = identities }
            return built
        }
        // A BANKED SEND SITS AFTER THE LIVE REGION, not where it happens to be in
        // `messages`. The store appends its bubble to the end of the message list,
        // but the live rows are appended after ALL of them, so an in-order build put
        // the queued bubble ABOVE the reply that is still streaming — as if it had
        // been sent before the agent started. Worse, the enqueue re-pins to the
        // bottom, so the one row that confirms "I took your message" was the one row
        // scrolled off. Held back and appended last, it lands where the user is
        // looking and reads as what it is: next in line.
        var queuedRows: [TimelineRow] = []
        var afterLiveRows: [TimelineRow] = []
        var inline: [ChatMessage] = []
        inline.reserveCapacity(input.messages.count)
        for message in input.messages {
            let queued = input.queuedMessageStates[message.id]
            // An `undecided` entry renders as an ordinary FAILED bubble in place: it
            // is not waiting for anything, so holding it back would move a row the
            // user has to act on away from where they left it.
            if let queued, queued != .undecided {
                queuedRows.append(contentsOf: memoizedRows(for: message, queued: queued))
            } else if input.afterLiveMessageIDs.contains(message.id) {
                afterLiveRows.append(contentsOf: memoizedRows(for: message, queued: nil))
            } else {
                inline.append(message)
            }
        }
        // The lines the CLI put in itself ride the rows beside them on the wire;
        // here each becomes its own row, where it was (TimelineInjectedLines), so
        // turn shaping folds it with the steps around it.
        inline = TimelineInjectedLines.expand(inline)
        // Consecutive tool and thinking rows fold into ONE "Ran 3 commands ›" row
        // (TimelineToolRunFold, the web console's rule). The member rows are still
        // built through the memo, so an unchanged message costs a dictionary hit
        // whether it is folded or open; only the run row itself is minted per
        // build, and it is a one-line capsule with no measurement in it.
        func appendRun(key: String, members: [ChatMessage]) {
            let runID = TimelineToolRunFold.rowID(scope: input.scope, key: key)
            let expanded = input.expandedRowIDs.contains(runID)
            rows.append(builder.toolRunRow(
                id: runID,
                members: TimelineToolRunFold.phraseMembers(members),
                failCount: TimelineToolRunFold.failCount(members),
                running: false, expanded: expanded, width: input.width
            ))
            if expanded {
                for member in members {
                    rows.append(contentsOf: memoizedRows(for: member, queued: nil))
                }
            }
        }
        // A session transcript that says who sent each row is shaped by turn
        // (TimelineTurnShape / TimelineTurnFold): hidden turns, an answered turn's
        // work folded before its answer, received messages never drawn as the
        // user's bubble. A list without that fact (an older server, the Personal AI
        // chat) is drawn exactly as before.
        func appendPlan(_ parts: [TimelineTurnFold.Part]) {
            for part in parts {
                switch part {
                case .message(let message):
                    rows.append(contentsOf: memoizedRows(for: message,
                                                         queued: input.queuedMessageStates[message.id]))
                case .run(let key, let members):
                    appendRun(key: key, members: members)
                case .inbound(let message):
                    // A received message shows only who sent it and its title: no card to
                    // open, no body (the stored row and its payload stay as they are).
                    if PeerMessagePresentation.segments(message.text, received: true) != nil {
                        rows.append(contentsOf: memoizedRows(for: message.receivedFromAgent, queued: nil))
                    } else {
                        rows.append(builder.peerMessageRow(
                            id: "\(TimelineScope.namespace(input.scope, message.id))#0",
                            description: PeerMessagePresentation.unreadableReceived, width: input.width))
                    }
                case .ack(let message):
                    rows.append(builder.ackRow(id: "\(TimelineScope.namespace(input.scope, message.id))#ack"))
                case .fold(let fold):
                    let id = TimelineTurnFold.rowID(scope: input.scope, key: fold.key)
                    let expanded = input.expandedRowIDs.contains(id)
                    rows.append(builder.foldRow(id: id, phrase: fold.phrase,
                                                failCount: fold.failCount, expanded: expanded,
                                                width: input.width))
                    if expanded { appendPlan(fold.members) }
                case .added(let key, let items):
                    let id = TimelineTurnFold.rowID(scope: input.scope, key: key)
                    rows.append(contentsOf: builder.addedRows(id: id, items: items,
                                                              expanded: input.expandedRowIDs.contains(id),
                                                              width: input.width))
                }
            }
        }
        /// The merged row of a received message's live turn: history's part of it
        /// and the live calls, each call counted once.
        func appendLiveTail(_ tail: TimelineTurnFold.LiveTail, liveCalls: [LiveToolCall],
                            after: [TimelineFoldSteps.Step] = []) {
            let id = TimelineTurnFold.rowID(scope: input.scope, key: tail.key)
            let expanded = input.expandedRowIDs.contains(id)
            // Only this turn's rows can be a live call's history twin: the row may
            // span earlier quiet turns, each ended by its no-action line, and one of
            // them may have run the very same call.
            let turnFrom = tail.rows.lastIndex(where: TimelineTurnFold.isAckOnly).map { $0 + 1 } ?? 0
            let thisTurn = tail.rows[turnFrom...].filter { $0.kind == .tool }
            // A mid-turn refetch can already hold some of this turn's calls,
            // which the live list still carries: count each call once, and draw a
            // matched one from its history row (indexes into `input.liveTools`).
            var unmatched = input.liveTools.indices.filter { TimelineRowBuilder.liveCallFolds(input.liveTools[$0]) }
            var drawnFromHistory: Set<Int> = []
            for m in thisTurn {
                guard let at = unmatched.firstIndex(where: {
                    input.liveTools[$0].name == m.text && (input.liveTools[$0].detail ?? "") == (m.detail ?? "")
                }) else { continue }
                drawnFromHistory.insert(unmatched.remove(at: at))
            }
            // What the steps did, in order: history's rows where they stand (a call
            // the live list also carries is read from there), then the live calls
            // history does not hold yet, so the line reads the same after the refetch.
            let pending = unmatched.map { ChatMessage(id: "", role: "assistant", text: input.liveTools[$0].name,
                                                      createdAt: "", kind: .tool, detail: input.liveTools[$0].detail,
                                                      inputPreview: input.liveTools[$0].inputPreview) }
            let steps = tail.rows.flatMap(TimelineFoldSteps.steps) + pending.flatMap(TimelineFoldSteps.steps) + after
            rows.append(builder.foldRow(
                id: id,
                phrase: TimelineFoldSteps.phrase(steps),
                // Every failure history holds, error notices too (the settled fold counts them).
                failCount: tail.rows.filter(TimelineTurnShape.isFailure).count,
                expanded: expanded, running: input.streaming && liveCalls.contains { !$0.finished },
                width: input.width))
            if expanded {
                appendPlan(tail.members)
                rows.append(contentsOf: builder.liveRunMembers(
                    input.liveTools, liveThinking: input.liveThinking, width: input.width, scope: input.scope,
                    skipping: drawnFromHistory))
            }
        }
        /// Set when the live run rides a received message's fold (see below).
        var runFoldedElsewhere = false
        let additions = TimelineTurnFold.Additions.of(input)
        if TimelineTurnShape.knowsSenders(inline) {
            let turns = TimelineTurnShape.settle(
                TimelineTurnShape.shape(inline, streaming: false), in: inline,
                streaming: input.streaming, settled: &settledTurnKinds)
            let liveCalls = input.liveTools.filter(TimelineRowBuilder.liveCallFolds)
            // The turn just ended and the refetch that brings its calls has not
            // landed: the store keeps the calls until it does (it clears them in
            // the block that installs the fetched rows), and so does this row, the
            // way the web keeps stream blocks until history absorbs them. Without
            // it the row read "Received 1 message" and lost its calls for the
            // length of the refetch, then grew back.
            let turnEnded = !input.streaming && !liveCalls.isEmpty
            // The reply the store painted at turn end sits after the calls it came
            // from, so it waits outside the tail, as the live text did.
            var head = inline
            var reply: [ChatMessage] = []
            /// Rows after the reply: a message the phone sent during the turn,
            /// delivered at its end, and whatever follows it. They draw after the row.
            var later: [ChatMessage] = []
            if input.streaming { liveLastRowID = inline.last?.id }
            if turnEnded, let last = liveLastRowID, let at = inline.lastIndex(where: { $0.id == last }) {
                // The painted rows are the ones history gained since the turn
                // streamed; an earlier turn's ack or reasoning never counts (the
                // refetch that brings this turn's first row has not landed).
                let painted = inline[(at + 1)...]
                let cut = painted.firstIndex { $0.role != "assistant" } ?? painted.endIndex
                reply = Array(painted[..<cut])
                later = Array(painted[cut...])
                head = Array(inline[...at])
            }
            let planned: (parts: [TimelineTurnFold.Part], tail: TimelineTurnFold.LiveTail?)? =
                liveCalls.isEmpty ? nil
                : TimelineTurnFold.planLive(head, turns: input.streaming ? turns : TimelineTurnShape.settle(
                    TimelineTurnShape.shape(head, streaming: false), in: head, streaming: true,
                    settled: &settledTurnKinds), additions: additions)
            if input.streaming || liveCalls.isEmpty { liveTailKey = input.streaming ? planned?.tail?.key : nil }
            if let planned, input.streaming || (planned.tail != nil && planned.tail?.key == liveTailKey) {
                // The live turn a received message started: that message and the
                // calls it is making are ONE row, keyed as its answered fold will be.
                appendPlan(planned.parts)
                if let tail = planned.tail {
                    runFoldedElsewhere = true
                    // A painted ack is the turn's last step: it reads after the calls,
                    // as it will once the refetch puts it after them in history.
                    appendLiveTail(tail, liveCalls: liveCalls,
                                   after: reply.filter(TimelineTurnFold.isAckOnly).flatMap(TimelineFoldSteps.steps))
                }
                for message in reply where !TimelineTurnFold.isAckOnly(message) {
                    rows.append(contentsOf: memoizedRows(for: message, queued: input.queuedMessageStates[message.id]))
                }
                if !later.isEmpty {
                    appendPlan(TimelineTurnFold.plan(later, turns: TimelineTurnShape.shape(later, streaming: false),
                                                     additions: additions))
                }
            } else {
                appendPlan(TimelineTurnFold.plan(inline, turns: turns, additions: additions))
            }
        } else {
            for part in TimelineToolRunFold.fold(inline) {
                switch part {
                case .message(let message):
                    rows.append(contentsOf: memoizedRows(for: message,
                                                         queued: input.queuedMessageStates[message.id]))
                case .run(let key, let members):
                    appendRun(key: key, members: members)
                }
            }
        }
        if rowCache.count > Self.rowCacheLimit {
            // Simple pressure valve: drop everything and let the next build
            // repopulate from the visible window (bounded at ≤400 messages).
            rowCache = [:]
            richEntryIdentities.removeAll(keepingCapacity: true)
        }
        if input.streaming {
            tailRevision += 1
            let live = builder.liveRows(
                liveText: input.liveText, storeTruncated: input.liveTextTruncated,
                activity: input.activity, width: input.width,
                tailRevision: tailRevision, cachedHead: headCache, scope: input.scope,
                liveThinking: input.liveThinking, liveTools: input.liveTools,
                expandedRowIDs: input.expandedRowIDs, runFoldedElsewhere: runFoldedElsewhere
            )
            headCache = live.headCache
            rows.append(contentsOf: live.rows)
        } else {
            headCache = nil
            // The reasoning row OUTLIVES the turn, on purpose: the stores clear
            // `liveThinking` in the same synchronous block that installs the
            // fetched `kind:"thinking"` rows, so keeping it here is what stops
            // the reasoning from blinking out for the length of the refetch (and
            // from staying blank when that refetch fails). Only the reasoning —
            // the shimmering activity row and the live reply text belong to a
            // turn that is over.
            // A turn whose calls still ride a received message's row keeps its
            // reasoning in that row too, as it did while streaming.
            if !runFoldedElsewhere {
                rows.append(contentsOf: builder.liveThinkingRows(
                    liveThinking: input.liveThinking, width: input.width, scope: input.scope))
            }
        }
        rows.append(contentsOf: afterLiveRows)
        rows.append(contentsOf: queuedRows)
        return TimelineSnapshot(rows: rows, width: input.width, generation: generation)
    }

    /// Fold the heights measured since the last build into the memo.
    ///
    /// A measurement changes a HEIGHT, never markup, so the rows it affects are
    /// re-banked in place through the builder's own height resolver: dropping
    /// their memo entry would re-segment the reply and re-parse its markdown to
    /// arrive at byte-identical rows, which on a card-heavy reply is that work
    /// once per card as the cards measure themselves one by one. Everything the
    /// change set does not name — other messages, and the live head's TextKit
    /// measurement, which is exactly the cost the live window exists to bound —
    /// is left alone.
    ///
    /// The race is benign and pre-existing: a height banked between this drain
    /// and the end of the build is reported to the NEXT build, and the host
    /// always resubmits after recording, so the row converges one build later.
    private func applyRichHeightChanges() {
        switch RichHTMLHeightCache.shared.drainChanges() {
        case .none:
            return
        case .everything:
            // No identity describes a wholesale replacement (a test reset), so
            // the only correct answer is the blunt one: drop every rich entry and
            // let the next build guess again.
            for key in richEntryIdentities.keys { rowCache.removeValue(forKey: key) }
            richEntryIdentities.removeAll(keepingCapacity: true)
            headCache = nil
        case .identities(let changed):
            for (key, identities) in richEntryIdentities
            where !identities.isDisjoint(with: changed) {
                guard let cached = rowCache[key] else { continue }
                rowCache[key] = (cached.message,
                                 builder.rebankRichHeights(cached.rows, width: cacheWidth,
                                                           changed: changed))
            }
            // The head is memoized on its own byte-stable string, so a card
            // sitting in it would be just as stuck as one in a message — but a
            // head with no rich row has nothing a measurement can move.
            if let head = headCache,
               !TimelineRowBuilder.richIdentities(in: head.rows).isDisjoint(with: changed) {
                headCache = (head.key, builder.rebankRichHeights(head.rows, width: cacheWidth,
                                                                 changed: changed))
            }
        }
    }

    /// The memo's BUCKET, not its proof of freshness. Everything that can change
    /// a message's rows and is not part of the message itself rides here: the
    /// scope, the optimistic-bubble mutable flags, the expansion state.
    ///
    /// CONTENT IS CHECKED SEPARATELY, by comparing the memoized `ChatMessage`
    /// against the one being built. It has to be: only ONE of the two stores
    /// digests its payload into the id (`SessionConversationStore.assignStableIDs`).
    /// `ChatStore` keeps the server's ids verbatim and `/api/v1` numbers a
    /// conversation's messages POSITIONALLY ("m0", "m1", …), so a tool row at
    /// "m7" that gains its `resultPreview` across the mid-turn refetch arrives
    /// under the same id with different content — and a key-only memo kept
    /// serving the row built before the result existed. It read "Running…", at a
    /// stale height, for the life of the view (collapsing and re-expanding was the
    /// only way out, because that changed the key). Equality is exact where a
    /// digest would only be probable, and it is nearly free in the common case:
    /// an unchanged message hands `String ==` two identical string buffers, which
    /// compares in O(1).
    ///
    /// THE SCOPE IS PART OF THE KEY, not decoration. The same positional ids made
    /// this memo answer conversation Q's "m0" with conversation P's rows — which
    /// is why the stale transcript survived even a full reload: the snapshot
    /// itself carried the previous conversation's content.
    private func cacheKey(_ m: ChatMessage, expandedRowIDs: Set<String>,
                          scope: String, queued: QueuedSend.Status? = nil) -> String {
        let namespace = TimelineScope.namespace(scope, m.id)
        var key = namespace
        // Part of the key for the same reason `pending` is: the badge appears,
        // changes to "Delivering…" and disappears while the message itself never
        // changes a byte, so a memo that ignored it would serve the stale badge.
        if let queued { key += "|q\(queued.rawValue)" }
        if m.pending == true { key += "|p" }
        if m.failed == true { key += "|f" }
        if let images = m.localImages, !images.isEmpty { key += "|i\(images.count)" }
        // Files: their count, and how far each upload is (whole percents, so a
        // chunk that moves nothing visible does not rebuild the rows).
        if let files = m.localFiles, !files.isEmpty {
            key += "|u" + files.map { file in
                // "n": nothing held yet reads differently from 0% held.
                guard let held = m.uploadHeld?[file.id] else { return "n" }
                return String(file.size == 0 ? 0 : Int(held * 100 / max(1, file.size)))
            }.joined(separator: ",")
        }
        if expandedRowIDs.contains("\(namespace)#0") { key += "|x" }
        return key
    }
}

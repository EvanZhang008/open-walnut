import Foundation
import Observation

/// What the letter reply box owns across leaving and reopening a letter, and
/// across the app being closed: the unsent draft per letter, the replies still on
/// their way (or refused), and the delivery outcome of a reply the server did not
/// record on its turn.
///
/// Drafts and pending replies are mirrored to UserDefaults, the way
/// `ComposerDrafts` keeps the chat composer's text: words the human typed must
/// survive going back to the inbox, and the app being killed in the background.
/// The reader's own `@State` died with the view, which is how a half-written
/// reply was lost.
///
/// Sending follows one rule: the field empties the moment the reply is handed
/// over, and the words live on as a pending reply in the thread until the server
/// has them. A refused send keeps them there, with Retry (the same reply again,
/// same `clientId`, so it can never land twice) and Edit (back into the field).
/// A send whose ANSWER was lost may have landed, so it offers Retry only, until a
/// fresh read of the letter settles it (see `PendingReply.mayHaveArrived`).
@Observable
@MainActor
final class LetterReplyStore {
    static let shared = LetterReplyStore(defaults: .standard)

    /// One reply the server does not have yet.
    struct PendingReply: Identifiable, Equatable, Codable {
        enum State: Equatable, Codable {
            case sending
            /// The request failed. Carries the sentence that says why.
            case failed(String)
        }

        /// The reply's `clientId`: what the server dedupes a retry on.
        let id: String
        let text: String
        /// When it was sent, or sent again by a Retry: the time its bubble shows.
        var createdAt: Date
        var state: State
        /// True once an attempt ended without an answer that proves either way
        /// (a timeout, a dropped connection, the app closing mid-send): the
        /// server may have recorded the reply. While true there is no Edit,
        /// because an edited reply goes out under a new id and the agent would
        /// read it twice. Cleared by a read of the letter that started after
        /// `uncertainSince` and does not hold the reply.
        var mayHaveArrived = false
        var uncertainSince: Date?
        /// How many turns the letter had on record when this reply was sent (or
        /// sent again): its slot in the thread is right after them. nil for a
        /// reply saved before this existed. See `LetterThreadItem.ordered`.
        var afterTurns: Int?
        /// How many pictures go with it (their bytes are in `pendingImages`, and
        /// on disk under `imageKey`). nil = none, and for a reply saved before
        /// replies took pictures.
        var imageCount: Int?
    }

    /// Why a request failed, and whether the server may have it anyway.
    struct Failure: Equatable {
        let sentence: String
        let mayHaveArrived: Bool
    }

    private let transport: LetterReplyTransport
    /// nil = memory only (unit tests).
    private let storedDefaults: UserDefaults?
    /// The app's own follow the demo scope (`AppPrefs`).
    private var defaults: UserDefaults? { storedDefaults.map(AppPrefs.resolve) }

    /// Unsent text per letter id. Empty strings are dropped, not stored.
    private(set) var drafts: [String: String] = [:]
    /// When each draft last changed: what the persisted set is trimmed by.
    @ObservationIgnored private var draftTimes: [String: Date] = [:]
    /// Replies in flight or refused, per letter, oldest first.
    private(set) var pending: [String: [PendingReply]] = [:]
    /// Retries of a RECORDED turn whose delivery failed, keyed by `turnKey`.
    private(set) var retryingTurns: Set<String> = []
    /// Delivery outcomes from a response whose letter did not carry one on the
    /// turn (a server that predates `thread[].delivery`), keyed by `turnKey`.
    private(set) var responseDeliveries: [String: LetterDelivery] = [:]
    /// A retry of a recorded turn that failed, keyed by `turnKey`.
    private(set) var turnRetryErrors: [String: Failure] = [:]
    /// Letters being re-read right now because an answer was lost. A reply in
    /// that state still reads as on its way: the read decides what it is.
    private(set) var rechecking: Set<String> = []
    /// Recorded turns whose delivery never reported back while the reader kept
    /// re-reading the letter (`LetterDeliveryWatch`), keyed by `turnKey`.
    private(set) var unconfirmedTurns: Set<String> = []
    /// Pictures picked for a letter's reply and not sent yet. Memory only, as
    /// the chat composer keeps its picked pictures (`ComposerDrafts`): large,
    /// and picked again in a tap.
    private(set) var draftImages: [String: [SelectedImage]] = [:]
    /// The JPEG bytes of each pending reply's pictures, by `clientId`. Saved to
    /// disk too (`imageKey`), so a refused reply keeps them for Retry across
    /// the app closing, as the chat's send queue keeps a message's images.
    private(set) var pendingImages: [String: [Data]] = [:]
    /// The pictures of replies the server now holds, kept for this app session
    /// so the recorded turn still shows them (the phone cannot read them back
    /// from the server). Memory only, the newest `maxSentImageReplies`.
    @ObservationIgnored private var sentImages: [String: [Data]] = [:]
    /// Set while a relaunch reads the pending replies' pictures back from disk:
    /// a Retry waits for it, and Edit holds off, so neither sends or hands back
    /// a reply without the pictures it had (`restoreImages`).
    @ObservationIgnored private var restoringImages: Task<Void, Never>?
    @ObservationIgnored private var sentOrder: [String] = []
    nonisolated static let maxSentImageReplies = 20
    /// The pictures of decision answers this phone sent, by the file names the
    /// server recorded on the answer's turn (an answer has no `clientId`), kept
    /// like `sentImages` so the recorded turn shows them, not just their count.
    /// Observed: the turn appears in the same update that stores them.
    private(set) var answerImages: [String: [Data]] = [:]
    @ObservationIgnored private var answerOrder: [String] = []

    init(transport: LetterReplyTransport? = nil, defaults: UserDefaults? = nil, now: Date = Date()) {
        self.transport = transport ?? WalnutAPI()
        self.storedDefaults = defaults
        guard let given = defaults else { return }
        let defaults = AppPrefs.resolve(given)
        #if DEBUG
        // UI tests start from nothing unless they are testing a relaunch.
        if given.bool(forKey: Self.resetArgument) { defaults.removeObject(forKey: Self.storageKey) }
        #endif
        restore(from: defaults, now: now)
        LifecycleHub.shared.register(self)
    }

    // MARK: - Drafts

    func draft(for letterId: String) -> String { drafts[letterId] ?? "" }

    func setDraft(_ text: String, for letterId: String) {
        if text.isEmpty {
            guard drafts[letterId] != nil else { return }
            drafts[letterId] = nil
            draftTimes[letterId] = nil
        } else {
            guard drafts[letterId] != text else { return }
            drafts[letterId] = text
            draftTimes[letterId] = Date()
        }
        schedulePersist()
    }

    /// Append words (a voice transcript, an edited failed reply) after what is
    /// already in the field, with one space between, the chat composer's rule.
    func appendToDraft(_ text: String, for letterId: String) {
        let addition = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !addition.isEmpty else { return }
        setDraft(Self.joined(draft(for: letterId), addition), for: letterId)
    }

    nonisolated static func joined(_ existing: String, _ addition: String) -> String {
        if existing.isEmpty { return addition }
        if existing.last?.isWhitespace == true { return existing + addition }
        return existing + " " + addition
    }

    // MARK: - Pictures

    func images(for letterId: String) -> [SelectedImage] { draftImages[letterId] ?? [] }

    func setImages(_ images: [SelectedImage], for letterId: String) {
        draftImages[letterId] = images.isEmpty ? nil : images
    }

    /// The pictures that went (or go) with a reply, by its `clientId`, as its
    /// bubble shows them: pending, or recorded during this app session.
    func images(ofReply clientId: String) -> [Data] { pendingImages[clientId] ?? sentImages[clientId] ?? [] }

    /// The pictures a recorded human turn shows: a reply's by its `clientId`, a
    /// decision answer's by the names the server recorded for them.
    func images(ofTurn entry: LetterThreadEntry) -> [Data] {
        if let clientId = entry.clientId {
            let datas = images(ofReply: clientId)
            if !datas.isEmpty { return datas }
        }
        guard let names = entry.images, !names.isEmpty else { return [] }
        return answerImages[Self.picturesKey(names)] ?? []
    }

    /// Keep a decision answer's pictures for its recorded turn: the answered
    /// letter's newest human turn, when it carries pictures. Only when the
    /// server kept them all, so a thumbnail never stands for a picture that did
    /// not go, nor lands on an older turn.
    func rememberAnswerPictures(_ datas: [Data], result: LetterActionResult) {
        guard !datas.isEmpty,
              let names = result.letter?.thread?.last(where: \.isHuman)?.images,
              names.count == datas.count
        else { return }
        let key = Self.picturesKey(names)
        answerImages[key] = datas
        answerOrder.append(key)
        while answerOrder.count > Self.maxSentImageReplies { answerImages[answerOrder.removeFirst()] = nil }
    }

    nonisolated static func picturesKey(_ names: [String]) -> String { names.joined(separator: "\n") }

    // MARK: - Sending

    /// Hand a reply over: record it as pending, empty the letter's draft, send.
    /// Returns the result so the caller can adopt the server's letter. `text`
    /// must be exactly what the field showed, already committed.
    @discardableResult
    func send(
        letterId: String, text: String, images: [SelectedImage] = [], afterTurns: Int? = nil
    ) async -> LetterActionResult? {
        guard let clientId = beginSend(letterId: letterId, text: text, images: images, afterTurns: afterTurns)
        else { return nil }
        return await deliver(letterId: letterId, clientId: clientId)
    }

    /// The synchronous half of `send`: the pending reply is in the thread and the
    /// draft is empty when this returns, in the same run-loop turn as the tap
    /// that cleared the field. Returns the reply's `clientId`, nil for nothing
    /// to send (no words and no pictures; a picture alone is a reply, as in the
    /// chat). `afterTurns`: how many turns the letter shows on record right now.
    func beginSend(
        letterId: String, text: String, images: [SelectedImage] = [], afterTurns: Int? = nil
    ) -> String? {
        let words = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let pictures = Array(images.prefix(ComposerBar.maxImages)).map(\.jpegData)
        guard !words.isEmpty || !pictures.isEmpty else { return nil }
        let reply = PendingReply(
            id: Self.newClientId(), text: words, createdAt: Date(), state: .sending, afterTurns: afterTurns,
            imageCount: pictures.isEmpty ? nil : pictures.count
        )
        if !pictures.isEmpty {
            pendingImages[reply.id] = pictures
            if storedDefaults != nil, !DurableStore.save(pictures, key: Self.imageKey(reply.id)) {
                // Still sent from memory; only a relaunch before the answer would miss them.
                AppLog.warn("inbox", "letter reply pictures not saved to disk", [
                    "clientId": reply.id, "count": String(pictures.count),
                ])
            }
        }
        pending[letterId, default: []].append(reply)
        drafts[letterId] = nil
        draftTimes[letterId] = nil
        draftImages[letterId] = nil
        persistNow()
        return reply.id
    }

    /// The network half of `send`, for a reply `beginSend` put in the thread.
    func deliver(letterId: String, clientId: String) async -> LetterActionResult? {
        await attempt(letterId: letterId, clientId: clientId)
    }

    /// Send a failed reply again: same words, same `clientId`. A second tap while
    /// it is on its way is ignored, so Retry sends once.
    @discardableResult
    func retry(letterId: String, clientId: String, afterTurns: Int? = nil) async -> LetterActionResult? {
        guard beginRetry(letterId: letterId, clientId: clientId, afterTurns: afterTurns) else { return nil }
        return await attempt(letterId: letterId, clientId: clientId)
    }

    /// The synchronous half of `retry`, run in the tap's own turn. False when
    /// there is nothing to retry (not failed, or already on its way).
    ///
    /// A Retry of a refused reply is a NEW send: the server provably does not
    /// have it, and will thread it after everything it holds now. So it moves
    /// there at once, after the turns on record (`afterTurns`) and every other
    /// pending reply, with the resend time on its bubble, and reads "Sending"
    /// like any reply on its way. It used to stay in its old slot until the
    /// server's answer, then jump to the end of the thread in one frame, out of
    /// view (r4 gate, P1).
    ///
    /// A reply that may already be on record (`mayHaveArrived`) keeps its slot:
    /// if the server has it, it is there.
    func beginRetry(letterId: String, clientId: String, afterTurns: Int? = nil) -> Bool {
        guard var reply = pendingReply(letterId, clientId), case .failed = reply.state,
              !isAttempting(clientId) else { return false }
        reply.state = .sending
        if !reply.mayHaveArrived {
            reply.createdAt = Date()
            if let afterTurns { reply.afterTurns = afterTurns }
            removePending(letterId, clientId)
            pending[letterId, default: []].append(reply)
        } else {
            update(letterId, clientId) { $0.state = .sending }
        }
        persistNow()
        return true
    }

    /// Take a failed reply back into the field for editing. Its words are
    /// appended to whatever the field already holds, so nothing is overwritten.
    /// Refused while the reply may already be on record (see `mayHaveArrived`).
    func edit(letterId: String, clientId: String) {
        guard let reply = pendingReply(letterId, clientId), case .failed = reply.state,
              !reply.mayHaveArrived else { return }
        // Pictures still being read back after a relaunch: Edit waits for them
        // rather than handing back the words alone.
        if (reply.imageCount ?? 0) > 0, pendingImages[clientId] == nil, restoringImages != nil { return }
        // Its pictures go back beside the field too, after any picked since.
        let pictures = (pendingImages[clientId] ?? []).compactMap { SelectedImage(jpegData: $0) }
        if !pictures.isEmpty {
            let outcome = ComposerBar.attach(pictures.map { .ok($0) }, to: images(for: letterId))
            setImages(outcome.images, for: letterId)
            if let notice = outcome.notice {
                AppLog.warn("inbox", "letter reply pictures not all given back on edit", ["clientId": clientId, "notice": notice])
            }
        }
        discardImages(of: [clientId])
        removePending(letterId, clientId)
        appendToDraft(reply.text, for: letterId)
        persistNow()
    }

    /// Retry the delivery of a turn the server HAS recorded, whose delivery
    /// failed. Same words, same `clientId`: the server re-delivers that turn
    /// instead of threading a second one.
    ///
    /// The line keeps what it showed until the answer is in (the reader shows it
    /// busy meanwhile), so the previous failure and the "not confirmed" mark are
    /// replaced only then.
    @discardableResult
    func retryRecordedTurn(letterId: String, entry: LetterThreadEntry) async -> LetterActionResult? {
        // A picture-only turn has no words: the server names it by `clientId`
        // and delivers its pictures again from its own record.
        guard let clientId = entry.clientId else { return nil }
        let text = entry.text ?? ""
        guard !text.isEmpty || !(entry.images ?? []).isEmpty else { return nil }
        let key = Self.turnKey(letterId, entry)
        guard !retryingTurns.contains(key) else { return nil }
        retryingTurns.insert(key)
        defer { retryingTurns.remove(key) }
        do {
            let result = try await transport.replyToLetter(id: letterId, text: text, clientId: clientId, images: [])
            turnRetryErrors[key] = nil
            unconfirmedTurns.remove(key)
            noteResponseDelivery(result, letterId: letterId, clientId: clientId, text: text)
            return result
        } catch {
            let failure = Self.failure(error)
            AppLog.warn("inbox", "letter reply retry failed", [
                "letterId": letterId, "clientId": clientId, "error": String(describing: error),
                "mayHaveArrived": failure.mayHaveArrived ? "true" : "false",
            ])
            turnRetryErrors[key] = failure
            return nil
        }
    }

    private func attempt(letterId: String, clientId: String) async -> LetterActionResult? {
        // A relaunch may still be reading this reply's pictures back.
        if let restoring = restoringImages { await restoring.value }
        guard let reply = pendingReply(letterId, clientId) else { return nil }
        if reply.state == .sending, isAttempting(clientId) { return nil }
        setState(letterId, clientId, .sending)
        attempting.insert(clientId)
        defer { attempting.remove(clientId) }
        do {
            // Sequential and under the total budget, off the main actor (`buildPayloads`).
            let images = await SelectedImage.buildPayloads(pendingImages[clientId] ?? [])
            let result = try await transport.replyToLetter(
                id: letterId, text: reply.text, clientId: clientId, images: images
            )
            noteResponseDelivery(result, letterId: letterId, clientId: clientId, text: reply.text)
            removePending(letterId, clientId)
            persistNow()
            return result
        } catch {
            let failure = Self.failure(error)
            AppLog.warn("inbox", "letter reply failed", [
                "letterId": letterId, "clientId": clientId, "error": String(describing: error),
                "mayHaveArrived": failure.mayHaveArrived ? "true" : "false",
            ])
            update(letterId, clientId) { reply in
                reply.state = .failed(failure.sentence)
                if failure.mayHaveArrived {
                    reply.mayHaveArrived = true
                    reply.uncertainSince = Date()
                }
            }
            persistNow()
            return nil
        }
    }

    @ObservationIgnored private var attempting: Set<String> = []
    private func isAttempting(_ clientId: String) -> Bool { attempting.contains(clientId) }

    /// Whether a fresh read of the letter could settle something here: a reply
    /// or a retry whose answer was lost. The reader re-reads the letter when so.
    func needsRecheck(letterId: String) -> Bool {
        let unsure = pendingReplies(for: letterId).contains { reply in
            reply.mayHaveArrived && reply.state != .sending
        }
        let prefix = letterId + "#"
        return unsure || turnRetryErrors.contains { $0.key.hasPrefix(prefix) && $0.value.mayHaveArrived }
    }

    /// Remember the response's delivery for the turn it belongs to when the
    /// server's letter did not record an outcome there, so an older server still
    /// gets a status line under the reply for as long as the app runs.
    private func noteResponseDelivery(
        _ result: LetterActionResult, letterId: String, clientId: String, text: String
    ) {
        guard let delivery = result.delivery, delivery.status != "pending",
              let thread = result.letter?.threadEntries else { return }
        let turn = thread.last(where: { $0.isHuman && $0.clientId == clientId })
            ?? thread.last(where: { $0.isHuman && $0.clientId == nil && $0.text == text })
        guard let turn, !Self.hasOutcome(turn) else { return }
        responseDeliveries[Self.turnKey(letterId, turn)] = delivery
    }

    /// A decision answer's response: its delivery belongs to the newest human
    /// turn (the answer), for a server that did not record it there.
    func noteAnswerDelivery(_ result: LetterActionResult, letterId: String) {
        guard let delivery = result.delivery, delivery.status != "pending",
              let turn = result.letter?.threadEntries.last(where: { $0.isHuman }),
              !Self.hasOutcome(turn) else { return }
        responseDeliveries[Self.turnKey(letterId, turn)] = delivery
    }

    /// The delivery a turn shows: the server's recorded outcome, else what a
    /// response said, else the server's `pending`.
    func delivery(letterId: String, entry: LetterThreadEntry) -> LetterDelivery? {
        let recorded = entry.delivery?.asDelivery
        if let recorded, recorded.status != "pending" { return recorded }
        return responseDeliveries[Self.turnKey(letterId, entry)] ?? recorded
    }

    /// Whether this human turn's delivery outcome is still to come: the server
    /// recorded it `pending`, or it is a reply with an id and no outcome yet (a
    /// server that writes the outcome only after the attempt, seen mid-attempt).
    /// A turn with neither (an older server, a reply from the console) has
    /// nothing to wait for.
    func awaitsDelivery(letterId: String, entry: LetterThreadEntry) -> Bool {
        guard entry.isHuman else { return false }
        guard let known = delivery(letterId: letterId, entry: entry) else { return entry.clientId != nil }
        return known.status == "pending"
    }

    nonisolated static func hasOutcome(_ entry: LetterThreadEntry) -> Bool {
        guard let status = entry.delivery?.status else { return false }
        return status != "pending"
    }

    /// The reader re-read the letter for as long as it waits and the outcome
    /// never came: these turns now say "Not confirmed" and offer Retry.
    func markDeliveryUnconfirmed(letterId: String, entries: [LetterThreadEntry]) {
        for entry in entries { unconfirmedTurns.insert(Self.turnKey(letterId, entry)) }
    }

    func isDeliveryUnconfirmed(letterId: String, entry: LetterThreadEntry) -> Bool {
        unconfirmedTurns.contains(Self.turnKey(letterId, entry))
    }

    /// A re-read after a lost answer starts / ends (see `rechecking`).
    func beginRecheck(letterId: String) { rechecking.insert(letterId) }

    func endRecheck(letterId: String) { rechecking.remove(letterId) }

    func isRechecking(letterId: String) -> Bool { rechecking.contains(letterId) }

    func isRetrying(letterId: String, entry: LetterThreadEntry) -> Bool {
        retryingTurns.contains(Self.turnKey(letterId, entry))
    }

    func retryError(letterId: String, entry: LetterThreadEntry) -> Failure? {
        turnRetryErrors[Self.turnKey(letterId, entry)]
    }

    // MARK: - Pending bookkeeping

    func pendingReplies(for letterId: String) -> [PendingReply] { pending[letterId] ?? [] }

    /// Settle pending replies against the server's letter. A reply the letter
    /// holds (matched by `clientId`) shows once, as the recorded turn: that is
    /// how a reply whose answer was lost turns out to have landed.
    ///
    /// `readStartedAt` is when the request that fetched `letter` went out, nil
    /// for a letter that rode back on some other response. Only a read that
    /// started after a reply's answer was lost can prove the reply is NOT on
    /// record; then Edit is offered again.
    func reconcile(letterId: String, with letter: Letter, readStartedAt: Date? = nil) {
        let recorded = Set(letter.threadEntries.compactMap(\.clientId))
        if let list = pending[letterId], !list.isEmpty {
            var kept: [PendingReply] = []
            for var reply in list {
                if recorded.contains(reply.id), !attempting.contains(reply.id) { continue }
                if reply.mayHaveArrived, !attempting.contains(reply.id), let readStartedAt,
                   let since = reply.uncertainSince, readStartedAt > since {
                    reply.mayHaveArrived = false
                    reply.uncertainSince = nil
                }
                kept.append(reply)
            }
            if kept != list {
                pending[letterId] = kept.isEmpty ? nil : kept
                persistNow()
            }
        }
        // A turn given up on as "Not confirmed" whose outcome has since landed
        // is settled: the mark goes, so a later wait starts clean.
        let settled = Set(letter.threadEntries.filter(Self.hasOutcome).map { Self.turnKey(letterId, $0) })
        if !unconfirmedTurns.isDisjoint(with: settled) { unconfirmedTurns.subtract(settled) }
        // A fresh read says where every recorded turn's delivery stands, so a
        // lost retry answer is no longer a question.
        if readStartedAt != nil {
            let prefix = letterId + "#"
            for (key, failure) in turnRetryErrors where key.hasPrefix(prefix) && failure.mayHaveArrived {
                turnRetryErrors[key] = Failure(sentence: failure.sentence, mayHaveArrived: false)
            }
        }
    }

    /// Everything this store keeps for a letter the server no longer has.
    func forget(letterId: String) {
        let prefix = letterId + "#"
        unconfirmedTurns = unconfirmedTurns.filter { !$0.hasPrefix(prefix) }
        draftImages[letterId] = nil
        discardImages(of: (pending[letterId] ?? []).map(\.id))
        guard drafts[letterId] != nil || pending[letterId] != nil else { return }
        drafts[letterId] = nil
        draftTimes[letterId] = nil
        pending[letterId] = nil
        persistNow()
    }

    private func pendingReply(_ letterId: String, _ clientId: String) -> PendingReply? {
        pending[letterId]?.first { $0.id == clientId }
    }

    private func setState(_ letterId: String, _ clientId: String, _ state: PendingReply.State) {
        update(letterId, clientId) { $0.state = state }
    }

    private func update(_ letterId: String, _ clientId: String, _ change: (inout PendingReply) -> Void) {
        guard var list = pending[letterId], let idx = list.firstIndex(where: { $0.id == clientId }) else { return }
        change(&list[idx])
        pending[letterId] = list
    }

    private func removePending(_ letterId: String, _ clientId: String) {
        guard var list = pending[letterId] else { return }
        list.removeAll { $0.id == clientId }
        pending[letterId] = list.isEmpty ? nil : list
    }

    // MARK: - Persistence

    nonisolated static let storageKey = "walnut.letterReplies.v1"
    /// Launch argument (`-walnut.resetLetterReplies YES`) that starts a DEBUG
    /// build with nothing saved: UI tests reuse the same letter ids.
    nonisolated static let resetArgument = "walnut.resetLetterReplies"
    /// At most this many letters keep saved words; the least recently touched go
    /// first.
    nonisolated static let maxLetters = 40
    /// A letter nobody touched for this long is let go.
    nonisolated static let maxAge: TimeInterval = 30 * 24 * 3600
    /// Longest text kept for one draft or reply. The server keeps 4,000
    /// characters of a turn, so this never cuts a reply that could be sent.
    nonisolated static let maxTextLength = 20_000
    /// At most this many pending replies kept per letter, newest last.
    nonisolated static let maxPendingPerLetter = 10

    struct Saved: Codable, Equatable {
        struct Draft: Codable, Equatable {
            var text: String
            var at: Date
        }
        var drafts: [String: Draft] = [:]
        var pending: [String: [PendingReply]] = [:]
    }

    /// The saved form, capped. Pure, so the caps are unit-tested.
    nonisolated static func saved(
        drafts: [String: String], draftTimes: [String: Date],
        pending: [String: [PendingReply]], now: Date
    ) -> Saved {
        var out = Saved()
        for (id, text) in drafts where !text.isEmpty {
            out.drafts[id] = .init(text: String(text.prefix(maxTextLength)), at: draftTimes[id] ?? now)
        }
        for (id, list) in pending where !list.isEmpty {
            out.pending[id] = list.suffix(maxPendingPerLetter).map { reply in
                reply.text.count > maxTextLength
                    ? PendingReply(id: reply.id, text: String(reply.text.prefix(maxTextLength)),
                                   createdAt: reply.createdAt, state: reply.state,
                                   mayHaveArrived: reply.mayHaveArrived, uncertainSince: reply.uncertainSince,
                                   afterTurns: reply.afterTurns, imageCount: reply.imageCount)
                    : reply
            }
        }
        return trimmed(out, now: now)
    }

    /// Drop letters older than `maxAge`, then keep the `maxLetters` most recently
    /// touched.
    nonisolated static func trimmed(_ saved: Saved, now: Date) -> Saved {
        var touched: [String: Date] = [:]
        for (id, draft) in saved.drafts { touched[id] = max(touched[id] ?? .distantPast, draft.at) }
        for (id, list) in saved.pending {
            for reply in list { touched[id] = max(touched[id] ?? .distantPast, reply.uncertainSince ?? reply.createdAt) }
        }
        let fresh = touched.filter { now.timeIntervalSince($0.value) <= maxAge }
        let keep = Set(fresh.sorted { $0.value == $1.value ? $0.key < $1.key : $0.value > $1.value }
            .prefix(maxLetters).map(\.key))
        var out = saved
        out.drafts = out.drafts.filter { keep.contains($0.key) }
        out.pending = out.pending.filter { keep.contains($0.key) }
        return out
    }

    /// Back from disk. A reply that was still `sending` when the app died may
    /// have reached the server: it comes back as a failed reply that may have
    /// arrived, and the next read of its letter settles it.
    private func restore(from defaults: UserDefaults, now: Date) {
        guard let data = defaults.data(forKey: Self.storageKey) else { return }
        guard let decoded = try? JSONDecoder().decode(Saved.self, from: data) else {
            AppLog.warn("inbox", "saved letter replies unreadable, starting empty", ["bytes": "\(data.count)"])
            return
        }
        let saved = Self.trimmed(decoded, now: now)
        for (id, draft) in saved.drafts {
            drafts[id] = draft.text
            draftTimes[id] = draft.at
        }
        for (id, list) in saved.pending {
            pending[id] = list.map { reply in
                guard reply.state == .sending else { return reply }
                var closed = reply
                closed.state = .failed("The app closed before Walnut answered.")
                closed.mayHaveArrived = true
                closed.uncertainSince = now
                return closed
            }
        }
        AppLog.info("inbox", "letter replies restored", [
            "drafts": "\(drafts.count)", "pendingLetters": "\(pending.count)",
        ])
        restoreImages()
    }

    /// Re-attach each restored reply's pictures, then sweep picture files no
    /// pending reply names (a reply settled while the app was closing). A reply
    /// whose file is gone goes as its words, and says so in the log.
    private func restoreImages() {
        let wanted = pending.values.flatMap { $0 }.filter { ($0.imageCount ?? 0) > 0 }.map(\.id)
        guard !wanted.isEmpty else { sweepImageFiles(); return }
        restoringImages = Task { @MainActor [weak self] in
            for id in wanted {
                let datas = await DurableStore.loadAsync([Data].self, key: Self.imageKey(id)) ?? []
                guard let self else { return }
                if !datas.isEmpty {
                    self.pendingImages[id] = datas
                } else if let letterId = self.pending.first(where: { $0.value.contains { $0.id == id } })?.key {
                    // The file is gone: the reply says so, rather than going as words alone unannounced.
                    AppLog.warn("inbox", "letter reply pictures missing on restore", ["clientId": id])
                    self.update(letterId, id) { reply in
                        reply.imageCount = nil
                        reply.state = .failed("Its pictures could not be read back. Edit to add them again.")
                    }
                }
            }
            guard let self else { return }
            self.restoringImages = nil
            self.sweepImageFiles()
            self.persistNow()
        }
    }

    /// Pictures of replies that were NOT sent (edited back, forgotten): gone
    /// from memory and disk, never kept as a recorded turn's.
    private func discardImages(of ids: [String]) {
        for id in ids where pendingImages[id] != nil {
            pendingImages[id] = nil
            if storedDefaults != nil { DurableStore.remove(key: Self.imageKey(id)) }
        }
    }

    nonisolated static let imageKeyPrefix = "letter-reply-images-"
    nonisolated static func imageKey(_ clientId: String) -> String { imageKeyPrefix + clientId }

    /// Pictures of replies no longer pending (sent, edited back, settled by a
    /// read, forgotten) go, from memory and from disk.
    private func dropSettledImages() {
        let live = Set(pending.values.flatMap { $0 }.map(\.id))
        for id in pendingImages.keys where !live.contains(id) {
            if let datas = pendingImages[id] {
                sentImages[id] = datas
                sentOrder.append(id)
                while sentOrder.count > Self.maxSentImageReplies { sentImages[sentOrder.removeFirst()] = nil }
            }
            pendingImages[id] = nil
            if storedDefaults != nil { DurableStore.remove(key: Self.imageKey(id)) }
        }
    }

    private func sweepImageFiles() {
        guard storedDefaults != nil else { return }
        let live = Set(pending.values.flatMap { $0 }.map(\.id))
        for key in DurableStore.keys(withPrefix: Self.imageKeyPrefix)
        where !live.contains(String(key.dropFirst(Self.imageKeyPrefix.count))) {
            DurableStore.remove(key: key)
        }
    }

    // Typing writes through a short debounce (the chat composer's measured
    // reason: serializing on every keystroke is waste); a send, a failure or a
    // settle writes at once, and going to the background flushes.
    @ObservationIgnored private var persistTask: Task<Void, Never>?
    private static let persistDebounce: Duration = .milliseconds(500)

    private func schedulePersist() {
        guard defaults != nil, persistTask == nil else { return }
        persistTask = Task { [weak self] in
            try? await Task.sleep(for: Self.persistDebounce)
            guard let self, !Task.isCancelled else { return }
            self.persistTask = nil
            self.persistNow()
        }
    }

    private func persistNow() {
        persistTask?.cancel()
        persistTask = nil
        // After the index is written: a file goes only once no saved reply names it
        // (an index naming a missing file would restore a reply without its pictures).
        defer { dropSettledImages() }
        guard let defaults else { return }
        let saved = Self.saved(drafts: drafts, draftTimes: draftTimes, pending: pending, now: Date())
        if saved.drafts.isEmpty, saved.pending.isEmpty {
            defaults.removeObject(forKey: Self.storageKey)
            return
        }
        guard let data = try? JSONEncoder().encode(saved) else { return }
        defaults.set(data, forKey: Self.storageKey)
    }

    // MARK: - Pure helpers

    nonisolated static func turnKey(_ letterId: String, _ entry: LetterThreadEntry) -> String {
        "\(letterId)#\(entry.id)"
    }

    /// `rp-<uuid>`: inside the server's `clientId` shape (letters, digits, `.`,
    /// `_`, `:`, `-`, at most 100 characters).
    nonisolated static func newClientId() -> String {
        "rp-" + UUID().uuidString.lowercased()
    }
}

extension LetterReplyStore: LifecycleSuspendable {
    func suspendForBackground() { persistNow() }
    func resumeForForeground() {}
}

// MARK: - Disconnect

extension LetterReplyStore {
    /// Forget every draft and unsent reply, on disk too (`LocalDataReset`).
    func eraseAll() {
        drafts = [:]
        draftTimes = [:]
        pending = [:]
        retryingTurns = []
        responseDeliveries = [:]
        turnRetryErrors = [:]
        rechecking = []
        unconfirmedTurns = []
        draftImages = [:]
        pendingImages = [:]
        sentImages = [:]
        sentOrder = []
        answerImages = [:]
        answerOrder = []
        if storedDefaults != nil {
            for key in DurableStore.keys(withPrefix: Self.imageKeyPrefix) { DurableStore.remove(key: key) }
        }
        persistTask?.cancel()
        persistTask = nil
        defaults?.removeObject(forKey: Self.storageKey)
    }
}

import SwiftUI

/// Walnut's two actions on one piece of content, the phone's twin of the web's
/// `ContentActionButtons`: Talk to CEO opens a box for the person's own words (`CeoNoteSheet`)
/// and sends them with the content attached, New task opens the new-session draft with it filled
/// in. Nothing is sent or made on the server until the person sends (2026-11-02, the user: "talk
/// to ceo, and create a new task ... I can put init prompt").
struct ContentActionButtons: View {
    let item: ContentItem
    /// The phone's own rendering of `item.at`, for the draft's Sent line.
    var sentLabel: String?
    /// Prefix of every accessibility identifier, e.g. `inbox.item.<id>`.
    let identifier: String

    enum Outcome: Equatable {
        case sending
        case sent(ContentCeoReply)
        /// Sent, but the Mac's older Walnut left the person's words out (no `noted`).
        case sentWithoutNote(ContentCeoReply)
        case held(ContentCeoReply)
        /// No answer in time: it may have reached the CEO, so the chat is offered to check first.
        case timedOut
        case failed(String)
    }

    @State private var ceoBusy = false
    @State private var draftBusy = false
    @State private var outcome: Outcome?
    @State private var writingNote = false
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @ScaledMetric(relativeTo: .caption) private var seatHeight: CGFloat = 44

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            button("Talk to CEO", id: "talkToCeo",
                   hint: "Write a message to the CEO with this email attached.", busy: ceoBusy) { writingNote = true }
            button(draftBusy ? "Opening draft…" : "New task", id: "newTask",
                   hint: "Open a new task draft with this email filled in. Nothing starts until you send it.",
                   busy: draftBusy) { newTask() }
            if outcome != nil { statusSeat }
        }
        .sheet(isPresented: $writingNote) {
            CeoNoteSheet(item: item, identifier: identifier) { note, pictures in talkToCeo(note: note, pictures: pictures) }
                .presentationDetents([.medium, .large])
        }
    }

    private func button(_ label: String, id: String, hint: String, busy: Bool, run: @escaping () -> Void) -> some View {
        Button(action: run) {
            Text(label).font(.body).frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
        }
        .buttonStyle(.bordered)
        .tint(Theme.tint)
        .disabled(busy)
        .accessibilityLabel("\(label) for \(item.title)")
        .accessibilityHint(hint)
        .accessibilityIdentifier("\(identifier).\(id)")
    }

    /// The answer's line. It opens at the tap ("Sending…"), so the answer arriving later only
    /// changes words inside a row that is already there; no empty row waits on a card nobody used.
    /// Every line is read in full at every type size (the hint of what to do is its second half).
    @ViewBuilder private var statusSeat: some View {
        let words = Text(Self.statusText(outcome) ?? "")
            .font(.caption)
            .foregroundStyle(Self.isWarning(outcome) ? Theme.needsText : Theme.secondaryOnCard)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityIdentifier("\(identifier).contentStatus")
        if dynamicTypeSize.isAccessibilitySize {
            VStack(alignment: .leading, spacing: 2) {
                words
                openChatButton
            }
            .frame(maxWidth: .infinity, minHeight: seatHeight, alignment: .leading)
        } else {
            HStack(spacing: 8) {
                words
                Spacer(minLength: 0)
                openChatButton
            }
            .frame(maxWidth: .infinity, minHeight: seatHeight, alignment: .leading)
        }
    }

    @ViewBuilder private var openChatButton: some View {
        if Self.offersChat(outcome) {
            let reply = Self.chatReply(outcome)
            Button("Open chat") { ContentActionLink.shared.openChat(taskId: reply?.taskId, sessionId: reply?.sessionId) }
                .font(.caption.weight(.semibold))
                .frame(minHeight: 44)
                .accessibilityIdentifier("\(identifier).openCeoChat")
        }
    }

    static func statusText(_ outcome: Outcome?) -> String? {
        switch outcome {
        case .sending: return "Sending to the CEO…"
        case .sent(let reply): return reply.testRun == true ? "Sent to the CEO stand-in (test run)" : "Sent to the CEO"
        case .sentWithoutNote: return sentWithoutNoteWords
        case .held: return "Not sent: the CEO is waiting on your answer. Answer it in the CEO chat, then send this again."
        case .timedOut: return timedOutWords
        case .failed(let words): return words
        case nil: return nil
        }
    }

    static func isWarning(_ outcome: Outcome?) -> Bool {
        switch outcome {
        case .held, .timedOut, .failed, .sentWithoutNote: return true
        default: return false
        }
    }

    /// The CEO chat is offered once the send is done or may be done.
    static func offersChat(_ outcome: Outcome?) -> Bool {
        switch outcome {
        case .sent, .sentWithoutNote, .held, .timedOut: return true
        default: return false
        }
    }

    /// The answer to a send with the person's words: an older server takes the email and drops
    /// the words without a word, so a reply without `noted` must not read as a plain success.
    static func outcome(of reply: ContentCeoReply) -> Outcome {
        if reply.held == true { return .held(reply) }
        return reply.noted == true ? .sent(reply) : .sentWithoutNote(reply)
    }

    static let sentWithoutNoteWords = "Sent the email only: your Mac runs an older Walnut, so your words were not included. They are still in Talk to CEO."

    static let timedOutWords = "No answer in time. It may have been sent: check the CEO chat before sending again."

    static func chatReply(_ outcome: Outcome?) -> ContentCeoReply? {
        switch outcome {
        case .sent(let reply), .sentWithoutNote(let reply), .held(let reply): return reply
        default: return nil
        }
    }

    /// Words for a refusal the person can act on; a companion has no CEO of its own (501).
    static func failureWords(_ action: String, _ error: Error) -> String {
        // The server may have sent it before the answer was lost: say so, or a retry sends it twice.
        if action == "Talk to CEO", Self.timedOut(error) { return timedOutWords }
        if case APIError.server(let status, _, _, _, _) = error {
            if status == 501 { return "\(action) works only while your Mac is online." }
            if status == 404 { return "\(action) needs a newer Walnut on your Mac." }
        }
        return "\(action) failed: \(error.localizedDescription)"
    }

    static func timedOut(_ error: Error) -> Bool {
        if case APIError.network(let underlying) = error { return timedOut(underlying) }
        let ns = error as NSError
        return ns.domain == NSURLErrorDomain && ns.code == NSURLErrorTimedOut
    }

    private func talkToCeo(note: String, pictures: [SelectedImage] = []) {
        guard !ceoBusy else { return }
        ceoBusy = true
        outcome = .sending
        Task {
            defer { ceoBusy = false }
            do {
                let images = await SelectedImage.buildPayloads(pictures.map(\.jpegData))
                let reply = try await WalnutAPI().contentCeo(item: item, note: note, images: images)
                outcome = Self.outcome(of: reply)
                // The words are gone from the box only once they reached the CEO; a held, a
                // dropped or a failed send keeps them for the next try.
                if case .sent = outcome { ComposerDrafts.shared.clear(CeoNoteSheet.draftKey(item)) }
                AppLog.info("content", "talk to ceo sent", ["taskId": reply.taskId, "sessionId": reply.sessionId ?? "", "held": reply.held == true ? "true" : "false"])
            } catch {
                outcome = Self.timedOut(error) ? .timedOut : .failed(Self.failureWords("Talk to CEO", error))
                AppLog.warn("content", "talk to ceo failed", ["error": error.localizedDescription])
            }
            if let words = Self.statusText(outcome) {
                UIAccessibility.post(notification: .announcement, argument: words)
            }
        }
    }

    private func newTask() {
        guard !draftBusy else { return }
        draftBusy = true
        Task {
            defer { draftBusy = false }
            do {
                let reply = try await WalnutAPI().contentDraft(item: item, sent: sentLabel)
                if case .failed = outcome { outcome = nil }
                ContentActionLink.shared.openDraft(text: reply.text)
            } catch {
                outcome = .failed(Self.failureWords("New task", error))
                AppLog.warn("content", "new task draft failed", ["error": error.localizedDescription])
            }
        }
    }
}

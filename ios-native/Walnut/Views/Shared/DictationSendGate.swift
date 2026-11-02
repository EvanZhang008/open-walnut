import Foundation
import Observation
import SwiftUI

// Send waits for the words being spoken (2026-11-01, the user: "send doesn't wait
// the voice button, I think it should wait, and send afterward").
//
// The rule, in one place for every box whose words leave through a Send-type
// button (the chat composer, a letter reply, a side question, an answer to the
// agent's question, a new session's or a fork's first message, a Save):
//
//  - Send while the mic records stops the take, waits for its words, puts them in
//    the box after what is typed, then sends the whole box ONCE.
//  - Send while a transcription is still on its way (after Stop) waits for it the
//    same way.
//  - While it waits the button says so; a second tap cancels the wait. The words
//    still land in the box, they are just not sent.
//  - A failed or empty transcription sends nothing: the box keeps what was typed
//    and the recorder's notice row shows the error with Retry.
//  - Words a retry recovered (a saved take: an automatic drain, a Retry tap, a
//    take cut off by a call) land in the box and are held for the person to read;
//    the Send does not take them unread.
//
// A screen holds one gate. Boxes with their own recorder row (the chat composer,
// the letter reply) join it with `.joinsSendGate`; every `VoiceDictationField`
// inside a view marked `.dictationSendGate(gate)` joins it by itself. The Send
// button calls `send`. A sheet's gate stops waiting when the sheet goes away; the
// chat composer's and the letter's do not, because their drafts and their send
// live in app-wide stores: a Send already tapped there still goes when its words
// land, even if the person locked the phone meanwhile.
// `DictationSendGuardTests` fails on a new mic box that does neither and is not
// listed as exempt with its reason.

@Observable
@MainActor
final class DictationSendGate {
    /// How a `send` ended. Kept for tests and the log.
    enum Outcome: Equatable {
        /// Sent at once: nothing was being dictated.
        case sentNow
        /// Sent after the words landed.
        case sentAfterWords
        /// The person tapped again while it waited: nothing sent, the words land.
        case cancelled
        /// No words came (failed or empty transcription, a take cut off): nothing
        /// sent, the box keeps what was typed and the notice row says why.
        case failed
        /// The words came from a saved take: in the box, unsent, to be read first.
        case heldForReview
    }

    private struct Box {
        let token: UUID
        let voice: VoiceRecorder
        let insert: (String) -> Void
    }

    /// The mic boxes on this screen, by recorder.
    private var boxes: [ObjectIdentifier: Box] = [:]
    /// A Send is waiting for words.
    private(set) var isWaiting = false
    /// Bumped by every wait and every cancel, so a wait that was cancelled (or
    /// replaced) never sends when its words come.
    @ObservationIgnored private var ticket = 0
    @ObservationIgnored private(set) var lastOutcome: Outcome?

    /// The accessibility label of a Send button while it waits.
    nonisolated static let waitingLabel = "Waiting for your words, tap to cancel"

    init() {}

    /// A mic box on this screen: `insert` puts a take's words into it (after what
    /// is typed), exactly as its own Stop would. Registering the same recorder again
    /// replaces its entry (a box whose draft moved to another key). The token is
    /// what `unregister` needs, so a box that left cannot remove the entry of the
    /// box that replaced it.
    @discardableResult
    func register(_ voice: VoiceRecorder, insert: @escaping (String) -> Void) -> UUID {
        let token = UUID()
        boxes[ObjectIdentifier(voice)] = Box(token: token, voice: voice, insert: insert)
        return token
    }

    func unregister(_ voice: VoiceRecorder, token: UUID? = nil) {
        let key = ObjectIdentifier(voice)
        if let token, boxes[key]?.token != token { return }
        boxes[key] = nil
    }

    /// A box on this screen is recording or transcribing, so a Send now would wait.
    /// A Send button stays live for it even while the box itself is still empty.
    var isDictating: Bool {
        boxes.values.contains { $0.voice.state != .idle }
    }

    /// Send, or wait for the words first. `action` gets `waited`: true when it runs
    /// after a wait (its box was redrawn meanwhile, so it reads the stored text).
    /// Never runs `action` twice for one tap, and never after a cancel.
    @discardableResult
    func send(_ action: @escaping (_ waited: Bool) -> Void) -> Task<Outcome, Never>? {
        if isWaiting {
            cancelWait()
            return nil
        }
        let busy = boxes.values.filter { $0.voice.state != .idle }
        guard !busy.isEmpty else {
            lastOutcome = .sentNow
            action(false)
            return nil
        }
        ticket &+= 1
        let mine = ticket
        isWaiting = true
        AppLog.info("voice", "send waits for dictation", ["boxes": String(busy.count)])
        // Every box is told to finish at once (a take still recording stops now,
        // not after another box's words came back); the words go in box by box.
        let finishing = busy.map { box in
            (box, Task { @MainActor in await box.voice.finishForSend() })
        }
        return Task { @MainActor [weak self] in
            var outcome: Outcome = .sentAfterWords
            for (box, finish) in finishing {
                switch await finish.value {
                case .words(let words):
                    // Always into the box, cancelled or not: the take is spoken.
                    box.insert(words)
                case .landed:
                    break
                case .drained:
                    if outcome == .sentAfterWords { outcome = .heldForReview }
                case .failed, .idle:
                    // `.idle` here means the take ended some other way between the
                    // tap and now (a call cut it off and kept it for a retry): no
                    // words from this tap.
                    outcome = .failed
                }
            }
            guard let self, mine == self.ticket, self.isWaiting else { return .cancelled }
            self.isWaiting = false
            self.lastOutcome = outcome
            AppLog.info("voice", "send wait ended", ["outcome": String(describing: outcome)])
            guard outcome == .sentAfterWords else { return outcome }
            // One turn for the box to take the words before the send reads it.
            await Task.yield()
            action(true)
            return outcome
        }
    }

    /// Stop waiting. The words still land in the box; nothing is sent.
    func cancelWait() {
        guard isWaiting else { return }
        ticket &+= 1
        isWaiting = false
        lastOutcome = .cancelled
        AppLog.info("voice", "send wait cancelled")
    }
}

// MARK: - Boxes join the gate

extension EnvironmentValues {
    /// The Send gate of the screen around a `VoiceDictationField`, if it has one.
    @Entry var dictationSendGate: DictationSendGate?
}

extension View {
    /// Every `VoiceDictationField` inside joins `gate`, so the screen's Send waits
    /// for words still being spoken into any of them. A screen that goes away
    /// stops waiting: its Send never fires from a closed sheet.
    func dictationSendGate(_ gate: DictationSendGate) -> some View {
        environment(\.dictationSendGate, gate)
            .onDisappear { gate.cancelWait() }
    }

    /// Register `voice` with `gate` while this view is on screen. `key` names what
    /// `insert` writes into (a draft key): when it changes, the box registers
    /// again, so the words never go into a draft the box no longer shows.
    func joinsSendGate(
        _ gate: DictationSendGate?, voice: VoiceRecorder, key: String = "",
        insert: @escaping (String) -> Void
    ) -> some View {
        modifier(SendGateMembership(gate: gate, voice: voice, key: key, insert: insert))
    }
}

private struct SendGateMembership: ViewModifier {
    let gate: DictationSendGate?
    let voice: VoiceRecorder
    let key: String
    let insert: (String) -> Void
    @State private var token: UUID?

    func body(content: Content) -> some View {
        content
            .onAppear { join() }
            .onChange(of: key) { _, _ in join() }
            .onDisappear {
                gate?.unregister(voice, token: token)
                token = nil
            }
    }

    private func join() {
        token = gate?.register(voice, insert: insert)
    }
}

// MARK: - A text button that waits

/// A Send-type text button (Start, Fork, Ask, Save, Submit) under the gate: the
/// title, or while it waits a spinner and "Waiting…", where a tap cancels.
struct DictationSendLabel: View {
    let gate: DictationSendGate
    let title: String
    var systemImage: String?

    var body: some View {
        if gate.isWaiting {
            HStack(spacing: 6) {
                ProgressView().controlSize(.small)
                Text("Waiting…")
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(DictationSendGate.waitingLabel)
        } else if let systemImage {
            Label(title, systemImage: systemImage)
        } else {
            Text(title)
        }
    }
}

import SwiftUI

// Walnut's own speech-to-text for any box where a person types a sentence or
// more: a mic beside (or under) the field, the recording row while a take runs,
// and the recorder's notices (denied microphone, failed transcription, saved
// takes with Retry and Discard) above it.
//
// Same rules as the letter reply box (LetterReaderView), which keeps its own
// wiring: every box has its own recorder stamped with its own surface key, so an
// automatic drain only recovers takes spoken into THIS box; a transcript lands
// after what is already typed, joined with one space, and is never sent; the
// keyboard comes back for it; a box the person leaves stops the take and keeps
// it, never deletes it.
//
// The chat composer (ComposerView) owns the orphan takes from older builds;
// every recorder made here says it does not.

/// How a transcript joins the words already in a box. Pure, so it is unit-tested.
enum VoiceDictationText {
    /// `existing` with `addition` appended after one separating space, or nil
    /// when the transcript holds no words (nothing to insert).
    nonisolated static func appending(_ addition: String, to existing: String) -> String? {
        let words = addition.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !words.isEmpty else { return nil }
        if existing.isEmpty { return words }
        if existing.last?.isWhitespace == true { return existing + words }
        return existing + " " + words
    }

    /// The text to put at a caret between `before` and `after` (the characters
    /// either side of it, nil at the start or end of the text): the words, with a
    /// space added on a side where they would otherwise touch another word.
    nonisolated static func insertion(_ addition: String, before: Character?, after: Character?) -> String? {
        let words = addition.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !words.isEmpty else { return nil }
        var piece = words
        if let before, !before.isWhitespace { piece = " " + piece }
        if let after, !after.isWhitespace, !after.isPunctuation { piece += " " }
        return piece
    }
}

/// Recorder wiring shared by every dictation box: the surface stamp, the two
/// text callbacks, recovery on appear, and the stop on leave.
private struct VoiceDictationLifecycle: ViewModifier {
    let voice: VoiceRecorder
    let surface: String
    let insert: (String) -> Void

    func body(content: Content) -> some View {
        content
            .onAppear { attach() }
            .onChange(of: surface) { _, _ in attach() }
            .onDisappear {
                // A box the person left must not keep the mic open. The take is
                // PRESERVED and comes back as the saved-recording notice (and is
                // recovered into this box when it shows again).
                if voice.state == .recording { voice.preserveAndStop(reason: "view-dismissed") }
            }
    }

    private func attach() {
        voice.surface = surface
        voice.ownsOrphanTakes = false
        voice.onAutoStopText = { text in insert(text) }
        voice.onDrainedText = { text in insert(text) }
        voice.refreshPending()
        voice.drainPending(trigger: "dictation-appear")
    }
}

extension View {
    /// Wire `voice` to one dictation box: `surface` is the box's stable key
    /// (the same box after a relaunch must give the same key), `insert` puts
    /// recovered or interrupted-take text into the box.
    func voiceDictation(_ voice: VoiceRecorder, surface: String, insert: @escaping (String) -> Void) -> some View {
        modifier(VoiceDictationLifecycle(voice: voice, surface: surface, insert: insert))
    }
}

/// The recorder's notices, for one dictation box: its own error, and the saved
/// or given-up takes spoken into THIS box. Takes from other boxes are offered by
/// the box they were spoken into and by the chat composer, which shows every
/// take; ten boxes each repeating "1 recording saved" for one take would be noise
/// (three answer boxes on one question card showed it three times).
struct VoiceDictationNotices: View {
    let voice: VoiceRecorder
    let surface: String
    let idPrefix: String
    let onRecovered: (String) -> Void
    @State private var ownsTake = false

    var body: some View {
        VStack(spacing: 0) {
            // Always present, so the read below runs while no notice shows (a
            // stack with nothing in it may never appear).
            Color.clear
                .frame(width: 0, height: 0)
                .accessibilityHidden(true)
                // Off the main thread, again whenever the recorder's counts move.
                .task(id: "\(surface)|\(voice.pendingCount)|\(voice.failedCount)") {
                    let store = VoiceRecordingStore.shared
                    let key = surface
                    ownsTake = await Task.detached(priority: .utility) {
                        store.pending().contains { $0.surface == key }
                    }.value
                }
            if voice.errorMessage != nil || ownsTake {
                VoiceNoticeRows(voice: voice, idPrefix: idPrefix, onRecovered: onRecovered)
            }
        }
    }
}

/// How far the recording outline sits outside a `.beside` field.
let voiceDictationOutlineOutset: CGFloat = 4
/// What a reveal leaves below a `.beside` box (and around its `revealID`
/// footprint): the outline and a little air, so a scroll edge never cuts it.
let voiceDictationRevealMargin: CGFloat = voiceDictationOutlineOutset + 4

/// A text box with Walnut's mic. Wrap the field itself (a TextField or a
/// TextEditor, with its own modifiers) in `field`.
///
/// `.beside` puts the mic to the right of the field; while a take runs, the mic
/// turns into Stop in the same seat (a pulsing ring and the elapsed time say it
/// records, a long press offers Discard) and a red outline circles the field. Nothing on the
/// screen moves or reflows: a recording row in the field's place took the
/// keyboard with it and dropped a sheet half the screen; a row above or below
/// it was scrolled under the navigation bar, the keyboard or the reply bar; and
/// a wider Cancel + Stop pair narrowed the field, so its text rewrapped and a
/// card's Stop was cut in half (2026-10-26 gates). `.below` puts the mic, then
/// the full recording row, on a row under the field (for editors that fill a
/// sheet, where there is room).
struct VoiceDictationField<Field: View>: View {
    enum Placement { case beside, below }

    @Binding var text: String
    /// Stable key for this box, e.g. "task-description:<taskId>".
    let surface: String
    /// Short name of the box for identifiers: the mic is "voice-mic.<box>".
    let box: String
    var placement: Placement = .beside
    /// The mic is off (another box on the same screen is recording, or the field
    /// itself is disabled).
    var blocked = false
    /// A recorder the screen holds itself, when it must see this box's state.
    var recorder: VoiceRecorder?
    /// The call site's own way to focus the field. When nil, the box binds the
    /// field's focus itself.
    var refocus: (() -> Void)?
    /// A scroll id (`ScrollViewProxy.scrollTo`) for the box's whole footprint
    /// (`.beside` only): the field, the mic's column and the room the recording
    /// outline takes outside the field, so a screen that scrolls the box to an
    /// edge never cuts the outline off.
    var revealID: String?
    @ViewBuilder var field: () -> Field

    @State private var ownRecorder = VoiceRecorder()
    @FocusState private var focused: Bool

    private var voice: VoiceRecorder { recorder ?? ownRecorder }
    private var idPrefix: String { "voice.\(box)" }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            switch placement {
            case .beside:
                VoiceDictationNotices(voice: voice, surface: surface, idPrefix: idPrefix) { insert($0) }
                HStack(alignment: .bottom, spacing: 4) {
                    focusedField
                        .frame(maxWidth: .infinity)
                        .overlay {
                            if voice.state == .recording {
                                // Just outside the field, so it never sits on the text.
                                RoundedRectangle(cornerRadius: 8, style: .continuous)
                                    .strokeBorder(Theme.danger, lineWidth: 2)
                                    .padding(-voiceDictationOutlineOutset)
                                    .allowsHitTesting(false)
                                    .accessibilityHidden(true)
                            }
                        }
                    if voice.state == .recording {
                        VoiceRecordingSeat(voice: voice, idPrefix: idPrefix, onCancel: cancel, onStop: stop)
                    } else {
                        mic
                    }
                }
                .background {
                    if let revealID {
                        // The id sits on the clear view, which the negative
                        // padding stretches past the row: the outline plus a
                        // little air, below and on both sides.
                        Color.clear
                            .id(revealID)
                            .padding(-voiceDictationRevealMargin)
                            .allowsHitTesting(false)
                            .accessibilityHidden(true)
                    }
                }
            case .below:
                focusedField
                VoiceDictationNotices(voice: voice, surface: surface, idPrefix: idPrefix) { insert($0) }
                if voice.state == .recording {
                    recordingBar
                } else {
                    HStack {
                        Spacer(minLength: 0)
                        mic
                    }
                }
            }
        }
        // A take recovered on appear (or ended by the recorder itself) lands
        // quietly: opening a screen never pulls the keyboard up.
        .voiceDictation(voice, surface: surface) { insert($0, focus: false) }
        // A group, so the field, the mic and the notices keep their own identifiers.
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder
    private var focusedField: some View {
        if refocus == nil {
            field().focused($focused)
        } else {
            field()
        }
    }

    private var mic: some View {
        VoiceMicButton(voice: voice, identifier: "voice-mic.\(box)")
            .disabled(blocked)
    }

    private var recordingBar: some View {
        VoiceRecordingBar(voice: voice, idPrefix: idPrefix, onCancel: cancel, onStop: stop)
    }

    private func cancel() { voice.cancel() }

    private func stop() {
        Task { if let words = await voice.stopAndTranscribe() { insert(words) } }
    }

    /// The transcript goes after what is typed, editable, never sent; then the
    /// keyboard comes back for it, one tick later so the field has settled.
    private func insert(_ words: String, focus: Bool = true) {
        guard let joined = VoiceDictationText.appending(words, to: text) else { return }
        text = joined
        guard focus else { return }
        Task { @MainActor in
            await Task.yield()
            if let refocus { refocus() } else { focused = true }
        }
    }
}

/// Stop in the mic's own seat, for a box that keeps its row: same size as the
/// mic, so the field never narrows. A pulsing ring and the elapsed time inside
/// the circle say it records; Discard is a long press (and a VoiceOver action)
/// away, since a take spoken by mistake is rarer than one to keep.
///
/// The time lives inside the circle, under the same checkmark every other Stop
/// shows (the long-press menu, the `.below` row, the letter's reply bar): the
/// action inserts the words. Drawn over the seat, the time ran into whatever sat
/// above the box (a letter's decision button, a card's border, at the largest
/// sizes the field's own text), and a row kept for it would have added empty
/// space over every one-line field.
private struct VoiceRecordingSeat: View {
    let voice: VoiceRecorder
    let idPrefix: String
    let onCancel: () -> Void
    let onStop: () -> Void
    @ScaledMetric(relativeTo: .body) private var seat: CGFloat = 32
    @Environment(\.scenePhase) private var scenePhase
    @State private var phase = false

    var body: some View {
        let size = VoiceGlyphSeat(scaled: seat)
        let time = VoiceRecordingIndicator.timeString(voice.elapsed)
        // The ring (the circle plus 3pt each side) leaves 3pt clear inside the
        // 44pt seat at every text size: filling the seat at the largest sizes,
        // it touched the field's outline and the two read as one red edge.
        let inner = min(size.diameter, size.target - 12)
        Button(action: onStop) {
            // Sized from the circle, not from the text size, so the time always
            // fits inside it: as large as the circle holds "0:00" (11.5pt in
            // the 32pt circle), shrinking only for a tenth minute. onTint on
            // tint reads 5.84:1 light and 7.02:1 dark (white on the red, 3.55:1).
            VStack(spacing: 0) {
                Image(systemName: "checkmark")
                    .font(.system(size: inner * 0.28, weight: .bold))
                Text(time)
                    .font(.system(size: inner * 0.36, weight: .semibold).monospacedDigit())
                    .lineLimit(1)
                    .minimumScaleFactor(0.6)
                    .frame(width: inner * 0.8)
            }
            .foregroundStyle(Theme.onTint)
            .frame(width: inner, height: inner)
            .background(Theme.tint, in: Circle())
            .padding(3)
            .overlay {
                Circle()
                    .strokeBorder(Theme.danger, lineWidth: 2.5)
                    .opacity(phase ? 0.55 : 1)
                    .animation(
                        scenePhase == .active ? .easeInOut(duration: 0.7).repeatForever(autoreverses: true) : nil,
                        value: phase
                    )
            }
            .frame(width: size.target, height: size.target)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .contextMenu {
            Button("Stop and insert the text", systemImage: "checkmark", action: onStop)
            Button("Discard recording", systemImage: "xmark", role: .destructive, action: onCancel)
                .accessibilityIdentifier("\(idPrefix).voiceCancel")
        }
        .accessibilityLabel("Stop and insert the text")
        .accessibilityValue("Recording, \(time)")
        .accessibilityAction(named: "Discard recording", onCancel)
        .accessibilityIdentifier("\(idPrefix).voiceStop")
        .onAppear { phase = scenePhase == .active }
        .onChange(of: scenePhase) { _, phaseState in phase = phaseState == .active }
    }
}

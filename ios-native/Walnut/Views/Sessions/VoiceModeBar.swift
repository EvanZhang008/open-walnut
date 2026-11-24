import SwiftUI

/// Voice mode's bar: it takes the composer's place while voice mode is on.
///
/// One big button does the talking: tap to start, tap again to send. Beside it,
/// the keyboard leaves voice mode, and the right-hand seat holds whatever the
/// moment needs: Cancel while recording, Stop while an answer is being read,
/// Replay otherwise. The line above says what is happening in words, because
/// the person may not be looking at the transcript at all.
///
/// Hands-free (`voice.handsFree`): nothing to tap to talk. It listens on its own,
/// the words heard so far show in the box as they are heard, and a pause sends
/// them. The big key then sends at once, or pauses listening before anything
/// was said; paused, it listens again.
struct VoiceModeBar: View {
    /// The chat's greys in a chat (`WalnutPalette`); a listening mic stays red.
    @Environment(\.walnutPalette) private var palette
    let voice: VoiceModeController
    /// The session's own activity while it works ("Running Bash"), when known.
    let activity: String?
    /// The session is in a turn right now.
    let working: Bool
    /// The session is stopped on a permission or question card for the person.
    var needsAnswer: Bool = false
    let onExit: () -> Void

    @ScaledMetric(relativeTo: .body) private var micSize: CGFloat = 64

    var body: some View {
        VStack(spacing: 8) {
            VoiceNoticeRows(voice: voice.recorder, idPrefix: "voiceMode") { text in
                Task { await voice.deliverRecovered(text) }
            }
            Text(statusLine)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .lineLimit(2)
                .frame(maxWidth: .infinity)
                .accessibilityIdentifier("voiceMode.status")
            if showsWordsBox { wordsBox }
            if let notice = voice.notice {
                Text(notice)
                    .font(.footnote)
                    .foregroundStyle(Theme.danger)
                    .multilineTextAlignment(.center)
                    .accessibilityIdentifier("voiceMode.notice")
            }
            if let unsent = voice.unsentText {
                unsentRow(unsent)
            }
            HStack {
                sideButton(
                    systemImage: "keyboard", label: "Type instead",
                    identifier: "voiceMode.exit", action: onExit
                )
                Spacer()
                micButton
                Spacer()
                trailingButton
            }
            .padding(.horizontal, 12)
        }
        .padding(.vertical, 12)
        .composerCard()
        .composerBand()
    }

    // MARK: - Words

    private var statusLine: String {
        // A card on the page waits for the person: that comes before any progress.
        if needsAnswer, voice.phase == .waiting || voice.phase == .ready {
            return VoiceModeController.needsAnswerLine
        }
        if voice.handsFree { return handsFreeStatus }
        switch voice.phase {
        case .listening:
            return "Listening… \(Self.clock(voice.recorder.elapsed)). Tap to send."
        case .transcribing:
            return "Turning your words into text…"
        case .speaking:
            return "Reading the answer. Tap the mic to talk over it."
        case .waiting:
            if let activity, !activity.isEmpty { return "Working: \(activity)" }
            return working ? "Working on it…" : "Sent. Waiting for the answer…"
        case .ready:
            if working {
                if let activity, !activity.isEmpty { return "Working: \(activity)" }
                return "Working on it. The answer will be read when it is done."
            }
            return "Tap the mic and talk."
        }
    }

    private var handsFreeStatus: String {
        switch voice.phase {
        case .listening:
            return voice.takeHeardSpeech
                ? "Listening \(Self.clock(voice.recorder.elapsed)). Pause and it sends."
                : "Listening. Just talk."
        case .transcribing:
            return "Sending what you said…"
        case .speaking:
            return "Reading the answer. Tap the mic to talk."
        case .waiting:
            if let activity, !activity.isEmpty { return "Working: \(activity)" }
            return working ? "Working on it…" : "Sent. Waiting for the answer…"
        case .ready:
            if voice.pausedByPerson {
                if working { return "Paused while it works. Tap the mic to talk." }
                return "Paused. Tap the mic to talk."
            }
            return "Listening…"
        }
    }

    /// The input box of voice mode: the words heard so far (hands-free).
    private var showsWordsBox: Bool {
        voice.handsFree && (voice.phase == .listening || voice.phase == .transcribing)
    }

    private var wordsBox: some View {
        let words = voice.liveWords.text
        return Text(words ?? (voice.takeHeardSpeech ? "…" : "Your words show here as you talk."))
            .font(.body)
            .foregroundStyle(words == nil ? .tertiary : .primary)
            .lineLimit(4)
            .truncationMode(.head)
            .frame(maxWidth: .infinity, minHeight: MessageBox.lineHeight, alignment: .leading)
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(MessageBox.shape.fill(Color(.tertiarySystemFill)))
            .padding(.horizontal, 12)
            .animation(.easeOut(duration: 0.15), value: words)
            .accessibilityIdentifier("voiceMode.liveWords")
    }

    static func clock(_ seconds: TimeInterval) -> String {
        let s = max(0, Int(seconds))
        return String(format: "%d:%02d", s / 60, s % 60)
    }

    /// What was said but not sent: the words, Send again, Discard.
    private func unsentRow(_ text: String) -> some View {
        VStack(spacing: 6) {
            Text("Not sent: \u{201C}\(text)\u{201D}")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .lineLimit(3)
                .multilineTextAlignment(.center)
            HStack(spacing: 12) {
                Button("Send again") { Task { await voice.retryUnsent() } }
                    .buttonStyle(.walnut(.primary, size: .small))
                    .accessibilityIdentifier("voiceMode.sendAgain")
                Button("Discard", role: .destructive) { voice.discardUnsent() }
                    .buttonStyle(.walnut(.destructive, size: .small))
                    .accessibilityIdentifier("voiceMode.discardUnsent")
            }
        }
        .padding(.horizontal, 12)
    }

    // MARK: - Buttons

    private var micButton: some View {
        let phase = voice.phase
        return Button {
            Task { await voice.micTapped() }
        } label: {
            ZStack {
                Circle()
                    .fill(phase == .listening ? Theme.danger : palette.accent)
                if phase == .transcribing {
                    ProgressView()
                        .tint(palette.onTint)
                } else {
                    Image(systemName: micGlyph)
                        .font(.system(size: micSize * 0.38, weight: .semibold))
                        .foregroundStyle(palette.onTint)
                }
            }
            .frame(width: micSize, height: micSize)
            .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .disabled(phase == .transcribing)
        .accessibilityLabel(micLabel)
        .accessibilityIdentifier("voiceMode.mic")
    }

    private var micGlyph: String {
        guard voice.phase == .listening else { return "mic.fill" }
        // Hands-free before any words: the key pauses listening.
        return voice.handsFree && !voice.takeHeardSpeech ? "pause.fill" : "arrow.up"
    }

    private var micLabel: String {
        guard voice.phase == .listening else { return "Talk" }
        return voice.handsFree && !voice.takeHeardSpeech ? "Pause listening" : "Send what you said"
    }

    @ViewBuilder
    private var trailingButton: some View {
        switch voice.phase {
        case .listening:
            sideButton(systemImage: "xmark", label: "Cancel recording", identifier: "voiceMode.cancel") {
                voice.cancelTake()
            }
        case .speaking:
            sideButton(systemImage: "stop.fill", label: "Stop reading", identifier: "voiceMode.stop") {
                voice.stopSpeaking()
            }
        default:
            sideButton(
                systemImage: "arrow.counterclockwise", label: "Read the last answer again",
                identifier: "voiceMode.replay"
            ) {
                Task { await voice.replay() }
            }
            .disabled(voice.lastAnswer == nil || voice.phase == .transcribing)
            .opacity(voice.lastAnswer == nil ? 0.4 : 1)
        }
    }

    private func sideButton(
        systemImage: String, label: String, identifier: String, action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(Theme.Glyph.lg.font(.semibold))
                .foregroundStyle(.secondary)
                .frame(width: 44, height: 44)
                .background(Color(.tertiarySystemFill), in: Circle())
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        .accessibilityIdentifier(identifier)
    }
}

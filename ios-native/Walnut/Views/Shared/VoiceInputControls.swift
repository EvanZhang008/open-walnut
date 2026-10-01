import SwiftUI

// Walnut's own speech-to-text for a text box that is not the chat composer.
//
// The same `VoiceRecorder` the chat composer drives (record to a preserved m4a,
// upload, the server's engine transcribes mixed Chinese and English), and the
// same conventions: a mic glyph in a circle beside send, a recording row that
// REPLACES the input with cancel on the left and stop on the right, the
// recorder's own sentences for a denied microphone or a failed transcription,
// and saved takes offered back with Retry and Discard. The keyboard's dictation
// is no substitute: it mangles mixed-language speech, which is why these exist.
//
// Every control is a 44pt target whatever its glyph's size, and the glyphs grow
// with Dynamic Type up to that size. At the accessibility text sizes the
// notices put their buttons on a row of their own and scroll inside a capped
// height, so the reply box under them never leaves the screen.
//
// Used by the letter reply box. The chat composer (ComposerView.swift) keeps its
// own mic and recording row, and shows its voice notices with `VoiceNoticeRows`,
// so a change to the notices changes both boxes.

/// The smallest target a finger can reliably hit.
let voiceControlTarget: CGFloat = 44

/// A round glyph seat that grows with the text size, capped at the target size.
struct VoiceGlyphSeat {
    let scaled: CGFloat
    var diameter: CGFloat { min(max(scaled, 32), voiceControlTarget) }
    var glyphSize: CGFloat { diameter * 0.47 }
    var target: CGFloat { max(diameter, voiceControlTarget) }
}

/// The mic. Idle: the glyph. Transcribing: a spinner in the same seat.
struct VoiceMicButton: View {
    let voice: VoiceRecorder
    let identifier: String
    @ScaledMetric(relativeTo: .body) private var seat: CGFloat = 32

    var body: some View {
        let size = VoiceGlyphSeat(scaled: seat)
        Button {
            Task { _ = await voice.start() }
        } label: {
            Group {
                if voice.state == .transcribing {
                    ProgressView()
                        .controlSize(.small)
                        .frame(width: size.diameter, height: size.diameter)
                } else {
                    Image(systemName: "mic.fill")
                        .font(.system(size: size.glyphSize, weight: .semibold))
                        .foregroundStyle(.secondary)
                        .frame(width: size.diameter, height: size.diameter)
                        .background(Color(.tertiarySystemFill), in: Circle())
                }
            }
            .frame(width: size.target, height: size.target)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(voice.state != .idle)
        .accessibilityLabel(voice.state == .transcribing ? "Transcribing" : "Voice input")
        .accessibilityIdentifier(identifier)
    }
}

/// Recording in progress: cancel (drops the take), pulsing dot and elapsed time,
/// stop (transcribes into the field). Same layout as the chat composer's row.
struct VoiceRecordingBar: View {
    let voice: VoiceRecorder
    let idPrefix: String
    let onCancel: () -> Void
    let onStop: () -> Void
    @ScaledMetric(relativeTo: .body) private var seat: CGFloat = 32

    var body: some View {
        let size = VoiceGlyphSeat(scaled: seat)
        HStack(spacing: 8) {
            Button(action: onCancel) {
                Image(systemName: "xmark")
                    .font(.system(size: size.glyphSize, weight: .semibold))
                    .foregroundStyle(.secondary)
                    .frame(width: size.diameter, height: size.diameter)
                    .background(Color(.tertiarySystemFill), in: Circle())
                    .frame(width: size.target, height: size.target)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Cancel recording")
            .accessibilityIdentifier("\(idPrefix).voiceCancel")

            VoiceRecordingIndicator(elapsed: voice.elapsed, identifier: "\(idPrefix).voiceRecordingCaption")
                .frame(maxWidth: .infinity, alignment: .leading)

            Button(action: onStop) {
                Image(systemName: "checkmark")
                    .font(.system(size: size.glyphSize, weight: .semibold))
                    .foregroundStyle(Theme.onTint)
                    .frame(width: size.diameter, height: size.diameter)
                    .background(Theme.tint, in: Circle())
                    .frame(width: size.target, height: size.target)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Stop and insert the text")
            .accessibilityIdentifier("\(idPrefix).voiceStop")
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
    }
}

/// Pulsing red dot + elapsed time + "Recording…". Never truncated: when the time
/// and the word do not fit on one line (the accessibility sizes), the word goes
/// under the time.
struct VoiceRecordingIndicator: View {
    let elapsed: TimeInterval
    let identifier: String
    @Environment(\.scenePhase) private var scenePhase
    @State private var phase = false

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 8) {
                dot
                time
                label
            }
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 8) {
                    dot
                    time
                }
                label
            }
        }
        .onAppear { phase = scenePhase == .active }
        .onChange(of: scenePhase) { _, phaseState in phase = phaseState == .active }
    }

    private var dot: some View {
        Circle()
            .fill(Theme.danger)
            .frame(width: 10, height: 10)
            .opacity(phase ? 0.35 : 1)
            .animation(
                scenePhase == .active ? .easeInOut(duration: 0.7).repeatForever(autoreverses: true) : nil,
                value: phase
            )
    }

    private var time: some View {
        Text(Self.timeString(elapsed))
            .font(.callout.monospacedDigit().weight(.medium))
            .fixedSize()
    }

    private var label: some View {
        Text("Recording…")
            .font(.callout)
            .foregroundStyle(.secondary)
            .fixedSize()
            .accessibilityIdentifier(identifier)
    }

    static func timeString(_ elapsed: TimeInterval) -> String {
        let s = Int(elapsed)
        return String(format: "%d:%02d", s / 60, s % 60)
    }
}

/// What the recorder has to say, above the input: its error sentence (the
/// denied microphone, a failed transcription), then any saved takes, offered
/// back with Retry and Discard. Recovered text goes to `onRecovered`, which
/// puts it in the field for review, never straight out.
///
/// The notices never take the screen: past `maxHeight` they scroll, so the field,
/// the mic and send below them stay where a finger can reach them. At the
/// accessibility sizes each notice is one short sentence (`VoiceNoticeCopy`)
/// with its buttons right under it, so it fits without scrolling; the full
/// sentence is what VoiceOver reads.
///
/// A failed transcription and the take it saved are ONE notice: the error
/// sentence already says the recording was saved, and a second row saying "1
/// recording saved" was the same news twice. The same goes for a take the
/// recorder gave up on: its sentence ("Couldn't transcribe that recording...")
/// and the "1 recording couldn't be transcribed" row are one notice with that
/// row's Discard (r5 gate follow-up). `errorHome` decides which.
///
/// The sentences are the label colour (the secondary grey measured 3.39:1 on the
/// bar), and every action is a capsule like the reply line's Retry and Edit.
struct VoiceNoticeRows: View {
    let voice: VoiceRecorder
    let idPrefix: String
    let onRecovered: (String) -> Void
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.openURL) private var openURL

    /// The notices' own height, measured, so the frame around them is exactly
    /// that up to `maxHeight`.
    @State private var naturalHeight: CGFloat = 0

    /// The tallest the notices get before they scroll: more at the
    /// accessibility sizes, where the text is the size the human chose.
    static let maxHeight: CGFloat = 180
    static let accessibilityMaxHeight: CGFloat = 300

    private var maxHeight: CGFloat { stacked ? Self.accessibilityMaxHeight : Self.maxHeight }

    private var stacked: Bool { dynamicTypeSize.isAccessibilitySize }

    private var showsPending: Bool { voice.state == .idle && voice.pendingCount > 0 }
    private var showsFailed: Bool { voice.state == .idle && voice.failedCount > 0 }

    /// Where the recorder's error is shown: on its own, or as one notice with the
    /// row it is about.
    enum ErrorHome: Equatable {
        case alone
        /// About a take that is saved and waiting: one notice with its Retry and Discard.
        case savedTake
        /// About a take the recorder gave up on: one notice with its Discard.
        case retiredTake
    }

    /// Pure, so the merge is unit-tested against the recorder's real sentences.
    nonisolated static func errorHome(_ message: String, showsPending: Bool, showsFailed: Bool) -> ErrorHome {
        if showsPending, VoiceNoticeCopy.savedCore(message) != nil { return .savedTake }
        if showsFailed, VoiceNoticeCopy.retiredCore(message) != nil { return .retiredTake }
        return .alone
    }

    private func home(of message: String) -> ErrorHome {
        Self.errorHome(message, showsPending: showsPending, showsFailed: showsFailed)
    }

    private var hasNotice: Bool { voice.errorMessage != nil || showsPending || showsFailed }

    var body: some View {
        if hasNotice {
            ScrollView {
                // The size the human chose, uncapped: capped at the second
                // accessibility size the notice read smaller than everything
                // around it at the largest (r4 gate, P2-5). The accessibility
                // sizes show the short sentence, so it still fits with its
                // buttons without a swipe.
                rows
                    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { naturalHeight = $0 }
            }
            .scrollBounceBehavior(.basedOnSize)
            // Say there is more to read when the notices are cut off.
            .scrollIndicatorsFlash(onAppear: true)
            .scrollDisabled(naturalHeight <= maxHeight)
            .frame(height: min(naturalHeight, maxHeight))
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("\(idPrefix).voiceNotices")
        }
    }

    @ViewBuilder
    private var rows: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let message = voice.errorMessage, home(of: message) == .savedTake {
                let copy = VoiceNoticeCopy.savedTake(error: message, count: voice.pendingCount)
                notice(
                    symbol: "waveform.badge.exclamationmark", copy: copy, textId: "\(idPrefix).voiceError",
                    dismissible: true
                ) {
                    retryPendingButton
                    discardPendingButton
                }
            } else {
                if let message = voice.errorMessage, home(of: message) == .alone {
                    notice(
                        symbol: "mic.slash", copy: VoiceNoticeCopy.error(message), textId: "\(idPrefix).voiceError",
                        dismissible: true
                    ) {
                        if message == VoiceRecorder.microphoneDeniedMessage,
                           let settings = URL(string: UIApplication.openSettingsURLString) {
                            ActionCapsuleButton(title: "Open Settings", identifier: "\(idPrefix).voiceOpenSettings") {
                                openURL(settings)
                            }
                        }
                    }
                }
                if showsPending {
                    notice(
                        symbol: "waveform.badge.exclamationmark",
                        copy: VoiceNoticeCopy.pending(count: voice.pendingCount),
                        textId: "\(idPrefix).voicePendingRow"
                    ) {
                        retryPendingButton
                        discardPendingButton
                    }
                }
            }
            if showsFailed {
                if let message = voice.errorMessage, home(of: message) == .retiredTake {
                    // Dismiss leaves the plain row below, so the takes are still offered.
                    let copy = VoiceNoticeCopy.retiredTake(error: message, count: voice.failedCount)
                    notice(
                        symbol: "waveform.slash", copy: copy, textId: "\(idPrefix).voiceError", dismissible: true
                    ) {
                        failedButtons
                    }
                } else {
                    notice(
                        symbol: "waveform.slash",
                        copy: VoiceNoticeCopy.failed(count: voice.failedCount),
                        textId: "\(idPrefix).voiceFailedRow"
                    ) {
                        failedButtons
                    }
                }
            }
        }
        .padding(.vertical, 2)
    }

    /// A given-up take's actions: Try again only for takes the attempt ceiling
    /// retired (nothing judged that audio), and Discard.
    @ViewBuilder
    private var failedButtons: some View {
        if voice.recoverableFailedCount > 0 {
            ActionCapsuleButton(
                title: "Try again", prominent: false, identifier: "\(idPrefix).voiceRetryFailed"
            ) {
                Task {
                    if let text = await voice.retryPending(includeRetired: true) { onRecovered(text) }
                }
            }
        }
        ActionCapsuleButton(title: "Discard", prominent: false, identifier: "\(idPrefix).voiceDiscardFailed") {
            voice.discardFailed()
        }
    }

    private var retryPendingButton: some View {
        ActionCapsuleButton(title: "Retry", identifier: "\(idPrefix).voiceRetry") {
            Task { if let text = await voice.retryPending() { onRecovered(text) } }
        }
    }

    private var discardPendingButton: some View {
        Button {
            voice.discardPending()
        } label: {
            Image(systemName: "trash").font(.callout).foregroundStyle(Theme.tint).modifier(VoiceTarget())
        }
        .accessibilityLabel("Discard saved recordings")
        .accessibilityIdentifier("\(idPrefix).voiceDiscardPending")
    }

    private var dismissErrorButton: some View {
        Button {
            voice.errorMessage = nil
        } label: {
            Image(systemName: "xmark").font(.callout.weight(.semibold)).foregroundStyle(Color(.label))
                .modifier(VoiceTarget())
        }
        .accessibilityLabel("Dismiss")
        .accessibilityIdentifier("\(idPrefix).voiceErrorDismiss")
    }

    /// Holds the dismiss button's place on a notice that has none, so every
    /// notice's actions end at the same column: a Discard next to the screen edge
    /// jumped 50pt when the dismiss beside it took its sentence away (build 84 gate).
    private var dismissSlot: some View {
        Image(systemName: "xmark").font(.callout.weight(.semibold)).modifier(VoiceTarget())
            .hidden()
            .accessibilityHidden(true)
    }

    /// One notice: glyph and sentence, then its buttons, then the dismiss when
    /// the sentence can be put away. Side by side at the usual sizes; at the
    /// accessibility sizes the short sentence, with the buttons on rows of their
    /// own right under it, because beside a sentence that large they are squeezed
    /// into a column of single letters. The rows wrap: an "Open Settings" capsule
    /// and a dismiss side by side were wider than the screen (build 84 gate, P2).
    @ViewBuilder
    private func notice<Buttons: View>(
        symbol: String, copy: VoiceNoticeCopy, textId: String, dismissible: Bool = false,
        @ViewBuilder buttons: () -> Buttons
    ) -> some View {
        let sentence = HStack(alignment: .firstTextBaseline, spacing: 6) {
            Image(systemName: symbol).font(.caption2).foregroundStyle(.secondary)
                .accessibilityHidden(true)
            Text(stacked ? copy.short : copy.full)
                .font(.caption)
                .foregroundStyle(Color(.label))
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityLabel(copy.full)
                .accessibilityIdentifier(textId)
        }
        if stacked {
            VStack(alignment: .leading, spacing: 2) {
                sentence.padding(.top, 6)
                WrappingRow(spacing: 8, lineSpacing: 2) {
                    buttons()
                    if dismissible { dismissErrorButton }
                }
            }
            .padding(.horizontal, 16)
        } else {
            HStack(spacing: 6) {
                sentence
                buttons()
                if dismissible { dismissErrorButton } else { dismissSlot }
            }
            .padding(.leading, 16)
            .padding(.trailing, 6)
        }
    }
}

/// Views left to right, starting a new line when the next one does not fit the
/// width offered. Each line's views are centred on one another.
struct WrappingRow: Layout {
    var spacing: CGFloat = 8
    var lineSpacing: CGFloat = 2

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let lines = Self.lines(fitting: proposal.width ?? .infinity, subviews, spacing: spacing)
        let width = lines.map(\.width).max() ?? 0
        let height = lines.map(\.height).reduce(0, +) + lineSpacing * CGFloat(max(lines.count - 1, 0))
        return CGSize(width: proposal.width.map { min(width, $0) } ?? width, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var y = bounds.minY
        for line in Self.lines(fitting: bounds.width, subviews, spacing: spacing) {
            var x = bounds.minX
            for index in line.indices {
                let size = subviews[index].sizeThatFits(.unspecified)
                subviews[index].place(
                    at: CGPoint(x: x, y: y + (line.height - size.height) / 2),
                    anchor: .topLeading, proposal: ProposedViewSize(size)
                )
                x += size.width + spacing
            }
            y += line.height + lineSpacing
        }
    }

    struct Line: Equatable {
        var indices: [Int] = []
        var width: CGFloat = 0
        var height: CGFloat = 0
    }

    /// Pure over the views' sizes, so the wrapping is unit-tested.
    nonisolated static func lines(fitting maxWidth: CGFloat, sizes: [CGSize], spacing: CGFloat) -> [Line] {
        var lines: [Line] = []
        var line = Line()
        for (index, size) in sizes.enumerated() {
            if !line.indices.isEmpty, line.width + spacing + size.width > maxWidth {
                lines.append(line)
                line = Line()
            }
            line.width = line.indices.isEmpty ? size.width : line.width + spacing + size.width
            line.height = max(line.height, size.height)
            line.indices.append(index)
        }
        if !line.indices.isEmpty { lines.append(line) }
        return lines
    }

    private static func lines(fitting maxWidth: CGFloat, _ subviews: Subviews, spacing: CGFloat) -> [Line] {
        lines(fitting: maxWidth, sizes: subviews.map { $0.sizeThatFits(.unspecified) }, spacing: spacing)
    }
}

/// The words of one voice notice: the full sentence, and the short one the
/// accessibility sizes show. Pure, so every notice's copy is unit-tested.
struct VoiceNoticeCopy: Equatable {
    let full: String
    let short: String

    /// The recorder's endings for an error whose take was kept for a retry.
    static let savedSuffixes = VoiceRecorder.keptTakeEndings

    /// `message` without its saved-take ending, or nil when it has none.
    static func savedCore(_ message: String) -> String? {
        for suffix in savedSuffixes where message.hasSuffix(suffix) {
            return String(message.dropLast(suffix.count))
        }
        return nil
    }

    static func savedCount(_ count: Int) -> String {
        count == 1 ? "Recording saved." : "\(count) recordings saved."
    }

    /// The one short sentence for saved takes waiting to be transcribed. Two
    /// lines at the largest text size; the glyph says it is a recording.
    static func savedShort(_ count: Int) -> String {
        count == 1 ? "Saved, not transcribed." : "\(count) saved, not transcribed."
    }

    /// A failed transcription and the take(s) waiting for Retry, as one sentence
    /// pair: why, then how many are saved.
    static func savedTake(error: String, count: Int) -> VoiceNoticeCopy {
        let core = savedCore(error) ?? error
        return .init(
            full: "\(core) \(savedCount(count))",
            short: savedShort(count)
        )
    }

    /// The recorder's endings for an error about a take it gave up on: the advice
    /// after the sentence that says the take cannot be transcribed.
    static let retiredSuffixes = VoiceRecorder.givenUpTakeEndings

    /// `message` without its given-up ending, or nil when it has none.
    static func retiredCore(_ message: String) -> String? {
        for suffix in retiredSuffixes where message.hasSuffix(suffix) {
            return String(message.dropLast(suffix.count))
        }
        return nil
    }

    /// A take the recorder gave up on and the row of such takes, as one notice.
    /// The recorder's own sentence when it speaks for all of them (one take, or a
    /// sentence that already gives the count). Otherwise one sentence for all of
    /// them: "Couldn't transcribe that recording. 2 recordings kept." read as if
    /// one take had been kept twice (build 84 gate, P3).
    static func retiredTake(error: String, count: Int) -> VoiceNoticeCopy {
        let speaksForAll = count <= 1 || error.hasPrefix("\(count) ")
        return .init(
            full: speaksForAll ? error : "Couldn't transcribe \(count) recordings. They are kept.",
            short: count <= 1 ? "Could not transcribe." : "\(count) could not be transcribed."
        )
    }

    static func pending(count: Int) -> VoiceNoticeCopy {
        .init(
            full: count == 1
                ? "1 recording saved. Transcription is pending."
                : "\(count) recordings saved. Transcription is pending.",
            short: savedShort(count)
        )
    }

    static func failed(count: Int) -> VoiceNoticeCopy {
        .init(
            full: count == 1 ? "1 recording couldn't be transcribed" : "\(count) recordings couldn't be transcribed",
            // Not the merged notice's "Could not transcribe.": at the
            // accessibility sizes the two read the same (build 84 gate, P2).
            short: count == 1 ? "1 recording not transcribed." : "\(count) recordings not transcribed."
        )
    }

    static func error(_ message: String) -> VoiceNoticeCopy {
        if message == VoiceRecorder.microphoneDeniedMessage {
            return .init(full: message, short: "Microphone is off.")
        }
        return .init(full: message, short: firstSentence(message))
    }

    /// Up to and including the first ". ", or the whole text.
    static func firstSentence(_ text: String) -> String {
        guard let end = text.range(of: ". ") else { return text }
        return String(text[..<end.lowerBound]) + "."
    }
}

/// A capsule you can see, inside a 44pt target you can hit. The reply line's
/// Retry and Edit, and the voice notices' actions, are all this, so an action
/// never looks like a label (the notices' plain grey words did).
struct ActionCapsuleButton: View {
    let title: String
    var prominent = true
    let identifier: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            ActionCapsuleLabel(title: title, prominent: prominent)
                .frame(minWidth: voiceControlTarget, minHeight: voiceControlTarget)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .fixedSize()
        .accessibilityIdentifier(identifier)
    }
}

/// The capsule itself, also used as the invisible size of a busy button row.
struct ActionCapsuleLabel: View {
    let title: String
    var prominent = true

    var body: some View {
        Text(title)
            .font(.subheadline.weight(.semibold))
            .lineLimit(1)
            .padding(.horizontal, 14)
            .padding(.vertical, 6)
            .foregroundStyle(prominent ? Theme.onTint : Theme.tint)
            .background(prominent ? Theme.tint : Theme.tintSoft, in: Capsule())
    }
}

/// At least 44pt each way, whatever the label.
private struct VoiceTarget: ViewModifier {
    func body(content: Content) -> some View {
        content
            .lineLimit(1)
            .fixedSize()
            .frame(minWidth: voiceControlTarget, minHeight: voiceControlTarget)
            .contentShape(Rectangle())
    }
}

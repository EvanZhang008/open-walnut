import SwiftUI
import PhotosUI

/// Reusable chat input bar — rounded field + photo/mic/send button. The draft
/// text and image selection live in `ComposerDrafts` (app-scoped, keyed by
/// `draftKey`), NOT in view `@State`; the parent does the actual send via
/// `onSend`.
///
/// Invariants (freeze-proof by design):
///  - The TextField is NEVER disabled. `busy` and `disabled` only gate the
///    SEND action — the user can always type, select, and copy their text.
///  - The draft AND the image selection are cleared on send; failure
///    preservation is the STORE's job (failed bubbles keep their text AND
///    images in the timeline with tap-to-retry), so a slow network error can
///    never clobber or lose composed text or attachments.
///  - Draft ownership is OUTSIDE the view. View-local `@State` is only as
///    durable as the view's identity, and this view sits in a
///    `safeAreaInset` whose geometry the keyboard changes — an identity churn
///    there used to wipe typed text (A4: type, dismiss keyboard, draft gone).
///
/// Voice input: mic button (shown when there's nothing to send) records m4a and
/// sends it to the server for transcription; the recognized text lands in
/// the draft for review before sending. A live recording is view-scoped: it
/// stops on disappear so navigating away can never leave an invisible mic open.
///
/// Voice Quick Action: when `acceptsVoiceQuickAction` is set, this composer also
/// serves the Home-screen "Voice to Walnut" shortcut — it opens the mic on
/// arrival and, on stop, sends the transcript STRAIGHT through `onSend` instead
/// of parking it in the draft. Only the chat composer opts in; a session
/// composer must never swallow the shortcut.
///
/// Image input: photo button opens the native PhotosPicker (iOS 16+, sandboxed
/// — no photo-library permission prompt). Picked images are downscaled + JPEG
/// encoded on-device and shown as a removable thumbnail strip above the field.
struct ComposerBar: View {
    let placeholder: String
    var busy: Bool = false
    var disabled: Bool = false
    var disabledNotice: String? = nil
    /// Identity of the thread this composer writes into ("chat:<conversation>",
    /// "session:<id>"). Scopes the durable draft.
    var draftKey: String = "chat"
    /// Opt in to serving the Home-screen voice Quick Action (chat composer only).
    var acceptsVoiceQuickAction: Bool = false
    /// Run right before a quick-action take opens the mic — the chat composer
    /// uses it to make sure the MAIN agent is selected, so the transcript can
    /// never land on whichever subagent the user last browsed.
    var prepareVoiceQuickAction: (() -> Void)? = nil
    let onSend: (String, [SelectedImage]) async -> Bool

    @State private var voice = VoiceRecorder()
    @State private var pickerItems: [PhotosPickerItem] = []
    @State private var imageNotice: String?
    @State private var quickAction = VoiceQuickAction.shared
    /// True between onAppear and onDisappear. A quick action may only open the
    /// mic on a composer the user can actually SEE: a TabView retains the
    /// non-selected tabs' views, so `onChange` alone would happily start an
    /// invisible recording — the exact "hot mic with no way to stop it" failure
    /// the onDisappear guard below exists to prevent.
    @State private var onScreen = false
    @FocusState private var focused: Bool
    /// Focus for the long-draft editor. A `UIViewRepresentable` cannot ride
    /// `@FocusState` dependably, so its focus is a plain two-way `@State` the
    /// representable syncs with its first-responder status.
    @State private var longDraftFocused = false
    @State private var drafts = ComposerDrafts.shared

    private static let maxImages = 5

    /// Bindings onto the app-scoped draft store — the TextField edits that
    /// directly, so nothing depends on this view's identity surviving.
    private var draft: Binding<String> {
        Binding(
            get: { drafts.draft(draftKey) },
            set: {
                drafts.setDraft($0, key: draftKey)
                // Freeze-report context. Runs per keystroke, so it must stay
                // O(1): utf8.count is a stored length on native Swift strings
                // (String.count walks graphemes — do NOT use it here), and the
                // push itself is one Int write under a lock.
                FreezeContext.shared.setDraftChars($0.utf8.count)
            }
        )
    }

    private var selectedImages: [SelectedImage] { drafts.images(draftKey) }

    private var trimmed: String { draft.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var hasContent: Bool { !trimmed.isEmpty || !selectedImages.isEmpty }
    private var canSend: Bool { !busy && !disabled && hasContent }

    var body: some View {
        VStack(spacing: 0) {
            if disabled, let notice = disabledNotice {
                noticeRow(notice, icon: "exclamationmark.circle")
            }
            if let voiceError = voice.errorMessage {
                noticeRow(voiceError, icon: "mic.slash") {
                    voice.errorMessage = nil
                }
            }
            if let imageNotice {
                noticeRow(imageNotice, icon: "photo.badge.exclamationmark") {
                    self.imageNotice = nil
                }
            }
            // Preserved voice takes (failed upload / interruption / crash /
            // view dismissal) — non-modal retry affordance. Audio is never
            // deleted until it transcribes or the user explicitly discards.
            if voice.state == .idle, voice.pendingCount > 0 {
                pendingVoiceRow
            }
            if voice.state == .recording {
                recordingRow
            } else {
                if !selectedImages.isEmpty { thumbnailStrip }
                inputRow
            }
        }
        .background(.bar)
        .onAppear {
            onScreen = true
            // An interruption (call / Siri) auto-transcribes the partial take.
            // For a quick-action take that text is still owed to the agent —
            // route it the same way a normal stop would.
            voice.onAutoStopText = { text in deliver(text) }
            // Crash/relaunch recovery: takes preserved by an earlier run (or
            // by another composer instance) surface here as the retry row.
            voice.refreshPending()
            consumeVoiceQuickActionIfPending()
        }
        // Warm launch: the shortcut arrives while this view is already mounted,
        // so onAppear never runs again — the mailbox change is the trigger.
        .onChange(of: quickAction.pending) { _, request in
            if request != nil { consumeVoiceQuickActionIfPending() }
        }
        .onDisappear {
            onScreen = false
            // The recorder is registered app-wide with LifecycleHub but its UI
            // lives in THIS view. Navigating away mid-recording (tab switch,
            // pop, sheet dismiss) hid the recording row while the mic stayed
            // hot — an invisible live recording burning battery and privacy
            // indicator with no way to stop it. View gone = mic off, but the
            // audio is PRESERVED (never silently deleted — the field incident)
            // and resurfaces as the retry row when the composer returns.
            if voice.state == .recording {
                voice.preserveAndStop(reason: "view-dismissed")
                // The take was preserved, NOT transcribed — a later Retry must
                // land in the draft for review, not auto-send text the user
                // never saw. (The audio itself is untouched, as always.)
                quickAction.clear(reason: "view-dismissed")
            }
        }
        .onChange(of: pickerItems) { _, items in
            guard !items.isEmpty else { return }
            Task { await loadPicked(items) }
        }
        // Focus edges are a freeze-report breadcrumb: the build-35 field freeze
        // fired ~5s after a transcription focused the keyboard, and focus churn
        // is what drives keyboard show/hide.
        .onChange(of: focused) { _, isFocused in
            FreezeContext.shared.note(isFocused ? "focus" : "blur")
        }
        .onChange(of: longDraftFocused) { _, isFocused in
            FreezeContext.shared.note(isFocused ? "focus" : "blur")
        }
        // Crossing the long-draft threshold swaps the field, which drops focus
        // with it. Hand focus over so a paste or a dictation that trips the swap
        // doesn't dismiss the keyboard mid-compose.
        .onChange(of: useLongDraftEditor) { _, isLong in
            if isLong, focused { focused = false; longDraftFocused = true }
            if !isLong, longDraftFocused { longDraftFocused = false; focused = true }
        }
    }

    // MARK: - Rows

    /// Above this many UTF-8 bytes the field switches to `LongDraftEditor`.
    ///
    /// Chosen from the measured curve on the real hosted composer (see
    /// `ComposerFreezeTests` / `LongDraftEditor`'s header): one relayout costs
    /// 1.65ms at 148 chars but 62.7ms at 5,000 and 2,353ms at 50,000 — and a
    /// relayout happens per keystroke, per focus edge, and per keyboard-geometry
    /// change. 2,000 sits above every ordinary typed message (so the everyday
    /// path is the untouched SwiftUI TextField) and below the region where a
    /// single relayout stops fitting a frame.
    ///
    /// UTF-8 bytes, not characters: `String.count` walks grapheme clusters (O(n))
    /// and this is evaluated on every body pass. NOTE the unit conversion this
    /// implies — the measured curve above is char-indexed while this gate is
    /// byte-indexed, and CJK runs ~3 bytes/char, so CJK drafts switch at ~667
    /// characters (ASCII at 2,000). That earlier switchover for CJK is
    /// DELIBERATE, not a slip: CJK glyph runs do more TextKit work per
    /// character, the bounded editor is visually near-identical (sim-verified
    /// with a 1,500-char CJK draft), and long dictation bursts — the field
    /// ignition scenario — are exactly the drafts we want off the O(n) path.
    static let longDraftThreshold = 2_000

    private var useLongDraftEditor: Bool {
        draft.wrappedValue.utf8.count > Self.longDraftThreshold
    }

    private var inputRow: some View {
        HStack(alignment: .bottom, spacing: 8) {
            photoButton

            // Long drafts (a big paste, or several dictations appended together)
            // move to a viewport-bounded UITextView. The plain TextField must lay
            // the WHOLE string out to apply `lineLimit(1...6)`, so its cost grows
            // with the draft and there is no cap on the draft; the editor's cost
            // is constant. Text is never truncated either way — only the
            // MEASUREMENT is bounded.
            Group {
                if useLongDraftEditor {
                    LongDraftEditor(text: draft, isFocused: $longDraftFocused)
                        .frame(maxWidth: .infinity)
                } else {
                    TextField(busy ? "Waiting for reply…" : placeholder, text: draft, axis: .vertical)
                        .lineLimit(1...6)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 9)
                        .focused($focused)
                        .accessibilityIdentifier("chat.composer")
                }
            }
            .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 19, style: .continuous))

            // Mic is ALWAYS present — transcription appends to the draft, so
            // voice input composes with typed text instead of replacing it.
            // The send button joins it once there's something to send.
            micButton
            if hasContent {
                sendButton
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }

    /// Horizontal strip of picked-image thumbnails above the field, each with a
    /// remove affordance. Sits between any notices and the input row.
    private var thumbnailStrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(selectedImages) { image in
                    ZStack(alignment: .topTrailing) {
                        Image(uiImage: image.thumbnail)
                            .resizable()
                            .scaledToFill()
                            .frame(width: 64, height: 64)
                            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                        Button {
                            drafts.setImages(
                                selectedImages.filter { $0.id != image.id }, key: draftKey
                            )
                        } label: {
                            Image(systemName: "xmark.circle.fill")
                                .font(.system(size: 18))
                                .symbolRenderingMode(.palette)
                                .foregroundStyle(.white, .black.opacity(0.55))
                                .padding(3)
                        }
                        .accessibilityIdentifier("chat.imageRemove")
                    }
                }
            }
            .padding(.horizontal, 12)
            .padding(.top, 8)
        }
    }

    /// Saved-but-untranscribed recordings: retry / discard, styled like the
    /// notice rows (non-modal, dismiss-optional — matches the failed-send
    /// bubble's Retry pattern).
    private var pendingVoiceRow: some View {
        HStack(spacing: 6) {
            Image(systemName: "waveform.badge.exclamationmark")
                .font(.caption2)
            Text(voice.pendingCount == 1
                 ? "1 recording saved — transcription pending"
                 : "\(voice.pendingCount) recordings saved — transcription pending")
                .font(.caption)
                .lineLimit(2)
                // Row marker lives on the TEXT, not the container — a
                // container-level identifier flattens onto every child in the
                // accessibility tree and clobbers the buttons' own ids
                // (Maestro then can't find chat.voiceRetry).
                .accessibilityIdentifier("chat.voicePendingRow")
            Spacer(minLength: 0)
            Button("Retry") {
                Task {
                    if let text = await voice.retryPending() {
                        appendToDraft(text)
                    }
                }
            }
            .font(.caption.weight(.semibold))
            .accessibilityIdentifier("chat.voiceRetry")
            Button {
                voice.discardPending()
            } label: {
                Image(systemName: "trash")
                    .font(.caption2)
            }
            .accessibilityIdentifier("chat.voiceDiscardPending")
        }
        .foregroundStyle(.secondary)
        .padding(.horizontal, 16)
        .padding(.top, 6)
    }

    /// Recording in progress: cancel × — pulsing dot + elapsed — stop ✓.
    /// A quick-action take swaps the label copy ("Send to Walnut") so the user
    /// knows stopping SENDS rather than dropping text into a field to review.
    private var recordingRow: some View {
        HStack(spacing: 12) {
            Button {
                // Cancel is the user's explicit "never mind" — it deletes the
                // audio (the one sanctioned deletion), so the quick action's
                // auto-send arming dies with it.
                voice.cancel()
                quickAction.clear(reason: "cancelled")
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(.secondary)
                    .frame(width: 32, height: 32)
                    .background(Color(.tertiarySystemFill), in: Circle())
            }
            .accessibilityIdentifier("chat.voiceCancel")

            RecordingIndicator(
                elapsed: voice.elapsed,
                caption: quickAction.autoSendArmed ? "Recording — stop to send" : "Recording…"
            )
            .frame(maxWidth: .infinity, alignment: .leading)

            Button {
                Task {
                    if let text = await voice.stopAndTranscribe() {
                        deliver(text)
                    }
                    // Transcription FAILED (or heard nothing): the audio is
                    // preserved and the pending-retry row is now showing. Disarm
                    // auto-send so a later manual Retry lands in the draft for
                    // review — an unattended send of text the user never saw,
                    // minutes after they spoke, is worse than a visible draft.
                    else if quickAction.autoSendArmed {
                        quickAction.clear(reason: "transcribe-failed")
                    }
                }
            } label: {
                Image(systemName: quickAction.autoSendArmed ? "arrow.up" : "checkmark")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(Theme.onTint)
                    .frame(width: 32, height: 32)
                    .background(Theme.tint, in: Circle())
            }
            .accessibilityIdentifier("chat.voiceStop")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
    }

    // MARK: - Buttons

    /// Native PhotosPicker entry (no permission prompt). Disabled once the
    /// selection is full so the user gets a clear ceiling at 5 images.
    private var photoButton: some View {
        PhotosPicker(
            selection: $pickerItems,
            maxSelectionCount: Self.maxImages,
            matching: .images,
            photoLibrary: .shared()
        ) {
            Image(systemName: "photo")
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(selectedImages.count >= Self.maxImages ? Color(.tertiaryLabel) : .secondary)
                .frame(width: 32, height: 32)
                .background(Color(.tertiarySystemFill), in: Circle())
        }
        .disabled(selectedImages.count >= Self.maxImages)
        .padding(.bottom, 3)
        .accessibilityIdentifier("chat.photo")
    }

    private var micButton: some View {
        Button {
            Task { _ = await voice.start() }
        } label: {
            if voice.state == .transcribing {
                ProgressView()
                    .controlSize(.small)
                    .frame(width: 32, height: 32)
            } else {
                Image(systemName: "mic.fill")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(.secondary)
                    .frame(width: 32, height: 32)
                    .background(Color(.tertiarySystemFill), in: Circle())
            }
        }
        .disabled(voice.state != .idle)
        .padding(.bottom, 3)
        .accessibilityIdentifier("chat.mic")
    }

    private var sendButton: some View {
        Button(action: send) {
            Image(systemName: "arrow.up")
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(canSend ? Theme.onTint : Color(.tertiaryLabel))
                .frame(width: 32, height: 32)
                .background(canSend ? Theme.tint : Color(.tertiarySystemFill), in: Circle())
        }
        .disabled(!canSend)
        .padding(.bottom, 3)
        .accessibilityIdentifier("chat.send")
    }

    // MARK: - Actions

    private func send() {
        let text = trimmed
        let images = selectedImages
        guard !text.isEmpty || !images.isEmpty else { return }
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        FreezeContext.shared.note("send", text.utf8.count)
        FreezeContext.shared.setDraftChars(0)
        drafts.clear(draftKey)
        pickerItems = []
        // Failure keeps the text AND images as a failed bubble in the timeline
        // (store's contract) — nothing restored here, so new typing/picking is
        // never clobbered.
        Task { _ = await onSend(text, images) }
    }

    /// Decode + downscale + JPEG-encode picked items off the main actor, then
    /// merge into the selection (respecting the 5-image ceiling AND the total
    /// payload budget). Surfaces a dismissible notice for images that are too
    /// large, over budget, or failed to decode.
    private func loadPicked(_ items: [PhotosPickerItem]) async {
        var current = selectedImages
        var tooLarge = 0
        var failed = 0
        var overBudget = 0
        // Each image is individually capped at 10MB base64, so five of them can
        // build ~50MB of concurrent base64 in the send path — enough to get the
        // app jetsammed on a warm device. Enforce the AGGREGATE too, and do it
        // here (at pick time) so the user learns immediately instead of after
        // composing a message that can never be sent.
        var budgetUsed = current.reduce(0) { $0 + SelectedImage.base64Length($1.jpegData) }
        let room = Self.maxImages - current.count
        for item in items.prefix(max(0, room)) {
            switch await SelectedImage.load(from: item) {
            case .ok(let image):
                let cost = SelectedImage.base64Length(image.jpegData)
                if budgetUsed + cost > SelectedImage.maxTotalBase64Length {
                    overBudget += 1
                } else {
                    budgetUsed += cost
                    current.append(image)
                }
            case .tooLarge: tooLarge += 1
            case .failed: failed += 1
            }
        }
        drafts.setImages(current, key: draftKey)
        pickerItems = []
        if tooLarge > 0 || failed > 0 || overBudget > 0 {
            var parts: [String] = []
            if tooLarge > 0 { parts.append("\(tooLarge) too large to send") }
            if overBudget > 0 { parts.append("\(overBudget) over the total attachment size limit") }
            if failed > 0 { parts.append("\(failed) couldn't be read") }
            imageNotice = "Some images were skipped: \(parts.joined(separator: ", "))."
        }
    }

    // MARK: - Voice Quick Action

    /// Where a finished transcription goes. Normal mic taps compose into the
    /// draft (the user reviews and hits send); a quick-action take sends
    /// straight through, because "one action, then talk" is the whole point.
    ///
    /// Auto-send arming is consumed here, once. Everything downstream is the
    /// store's ordinary send path — including its no-loss guarantee: a failed
    /// send stays in the timeline as a retryable failed bubble holding the full
    /// transcript, so the words survive even when the network doesn't.
    private func deliver(_ text: String) {
        guard quickAction.takeAutoSend() else {
            appendToDraft(text)
            return
        }
        let trimmedText = text.trimmingCharacters(in: .whitespacesAndNewlines)
        // Nothing to send: fall back to the draft so the user still sees
        // whatever came back rather than losing it to a silent no-op.
        guard !trimmedText.isEmpty else {
            appendToDraft(text)
            return
        }
        AppLog.info("voice", "quick action transcript auto-sent", ["chars": "\(trimmedText.count)"])
        FreezeContext.shared.note("voice-quick-send", trimmedText.utf8.count)
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        Task { _ = await onSend(trimmedText, []) }
    }

    /// Open the mic for a pending Home-screen quick action.
    ///
    /// Every guard here is load-bearing:
    ///  - `acceptsVoiceQuickAction`: session composers must not steal it.
    ///  - `onScreen`: a retained off-screen tab must never open the mic.
    ///  - `disabled` (offline): recording would be fine, but the SEND wouldn't,
    ///    and a quick action whose entire promise is "it reaches the agent"
    ///    should not silently become a draft. Leave the request for the next
    ///    appear (inside its TTL) instead of burning it.
    ///  - `voice.state == .idle`: a take is already running; do not restart it.
    private func consumeVoiceQuickActionIfPending() {
        guard acceptsVoiceQuickAction, onScreen, !disabled, voice.state == .idle else { return }
        guard quickAction.consume() != nil else { return }
        // Point the composer at the MAIN agent before the mic opens, so a user
        // who last browsed a subagent still gets their sentence delivered to the
        // Personal AI (the quick action's contract).
        prepareVoiceQuickAction?()
        quickAction.autoSendArmed = true
        Task {
            let started = await voice.start()
            if !started {
                // Permission denied / session failure — `voice.errorMessage` is
                // already on screen. Disarm so a later manual take isn't
                // unexpectedly auto-sent.
                quickAction.clear(reason: "start-failed")
            }
        }
    }

    private func appendToDraft(_ text: String) {
        let existing = draft.wrappedValue
        // Breadcrumb BEFORE the mutation: the append + focus pair is the
        // suspected trigger of the build-35 freeze, so the trail must show it
        // even if the very next layout pass is the one that wedges.
        FreezeContext.shared.note("append-draft", text.utf8.count)
        draft.wrappedValue = existing.isEmpty ? text : existing + " " + text
        // Focus whichever field the (now longer) draft renders in. Repeated
        // dictations are exactly how a draft crosses the threshold, so this
        // append may be the very mutation that swaps the field.
        if useLongDraftEditor { longDraftFocused = true } else { focused = true }
    }

    private func noticeRow(_ text: String, icon: String, onDismiss: (() -> Void)? = nil) -> some View {
        HStack(spacing: 6) {
            Image(systemName: icon)
                .font(.caption2)
            Text(text)
                .font(.caption)
                .lineLimit(2)
            if let onDismiss {
                Spacer(minLength: 0)
                Button(action: onDismiss) {
                    Image(systemName: "xmark")
                        .font(.caption2)
                }
            }
        }
        .foregroundStyle(.secondary)
        .padding(.horizontal, 16)
        .padding(.top, 6)
        .frame(maxWidth: .infinity, alignment: onDismiss == nil ? .center : .leading)
    }
}

/// Pulsing red dot + elapsed time while the mic is live. `caption` states what
/// stopping will DO — a quick-action take sends, a normal take fills the draft.
private struct RecordingIndicator: View {
    let elapsed: TimeInterval
    var caption: String = "Recording…"
    @Environment(\.scenePhase) private var scenePhase
    @State private var phase = false

    var body: some View {
        HStack(spacing: 8) {
            Circle()
                .fill(Theme.danger)
                .frame(width: 10, height: 10)
                .opacity(phase ? 0.35 : 1)
                .animation(
                    scenePhase == .active ? .easeInOut(duration: 0.7).repeatForever(autoreverses: true) : nil,
                    value: phase
                )
            Text(timeString)
                .font(.callout.monospacedDigit().weight(.medium))
            Text(caption)
                .font(.callout)
                .foregroundStyle(.secondary)
                .accessibilityIdentifier("chat.voiceRecordingCaption")
        }
        .onAppear { phase = scenePhase == .active }
        .onChange(of: scenePhase) { _, phaseState in
            phase = phaseState == .active
        }
    }

    private var timeString: String {
        let s = Int(elapsed)
        return String(format: "%d:%02d", s / 60, s % 60)
    }
}

/// Chat tab's composer — a thin ChatStore wrapper around ComposerBar.
/// `busy` gates the send button while a turn runs (contract: 409 turn_active);
/// typing stays available the whole time.
struct ComposerView: View {
    @Environment(ChatStore.self) private var chat
    @Environment(ConnectionStore.self) private var connection

    var body: some View {
        ComposerBar(
            // A pending structured question re-opens the composer: the send
            // routes to the answer endpoint (ChatStore.send intercepts).
            placeholder: chat.pendingQuestion
                ? "Answer \(chat.activeAgentName)'s question"
                : "Message \(chat.activeAgentName)",
            busy: (chat.sending || chat.streaming) && !chat.pendingQuestion,
            disabled: !connection.online,
            disabledNotice: connection.online ? nil : "Offline — reconnecting…",
            // Per-conversation draft. A brand-new (unsaved) conversation shares
            // the agent-scoped key so text typed before the server assigns an id
            // isn't orphaned when it does.
            draftKey: "chat:\(chat.activeID ?? "new-\(chat.activeAgentID)")",
            // The chat composer is the ONLY consumer of the Home-screen voice
            // Quick Action — it is the surface that talks to the main agent.
            acceptsVoiceQuickAction: true,
            prepareVoiceQuickAction: {
                // The shortcut promises the MAIN agent. If the user last left
                // chat on a subagent, switch home before the mic opens (a no-op
                // when already there).
                chat.switchAgent(ChatStore.mainAgentID)
            }
        ) { text, images in
            await chat.send(text, images: images)
        }
    }
}

// MARK: - Banners

struct OfflineBanner: View {
    let text: String

    var body: some View {
        Label(text, systemImage: "wifi.slash")
            .font(.footnote)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 6)
            .background(Theme.warning.opacity(0.15))
            .foregroundStyle(.primary)
    }
}

struct ErrorBanner: View {
    let text: String
    let onDismiss: () -> Void

    var body: some View {
        HStack {
            Label(text, systemImage: "exclamationmark.triangle.fill")
                .font(.footnote)
                .lineLimit(2)
            Spacer()
            Button(action: onDismiss) {
                Image(systemName: "xmark")
                    .font(.caption)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 6)
        .background(Theme.danger.opacity(0.12))
        .foregroundStyle(.primary)
    }
}

/// Green success line for lifecycle confirmations ("Session restarted").
struct ConfirmationBanner: View {
    let text: String
    let onDismiss: () -> Void

    var body: some View {
        HStack {
            Label(text, systemImage: "checkmark.circle.fill")
                .font(.footnote)
                .lineLimit(2)
            Spacer()
            Button(action: onDismiss) {
                Image(systemName: "xmark")
                    .font(.caption)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 6)
        .background(Theme.success.opacity(0.12))
        .foregroundStyle(.primary)
        .task {
            // Self-dismiss: success lines are transient by nature.
            try? await Task.sleep(for: .seconds(5))
            onDismiss()
        }
    }
}

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
    let onSend: (String, [SelectedImage]) async -> Bool

    @State private var voice = VoiceRecorder()
    @State private var pickerItems: [PhotosPickerItem] = []
    @State private var imageNotice: String?
    @FocusState private var focused: Bool
    @State private var drafts = ComposerDrafts.shared

    private static let maxImages = 5

    /// Bindings onto the app-scoped draft store — the TextField edits that
    /// directly, so nothing depends on this view's identity surviving.
    private var draft: Binding<String> {
        Binding(
            get: { drafts.draft(draftKey) },
            set: { drafts.setDraft($0, key: draftKey) }
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
            if voice.state == .recording {
                recordingRow
            } else {
                if !selectedImages.isEmpty { thumbnailStrip }
                inputRow
            }
        }
        .background(.bar)
        .onAppear {
            voice.onAutoStopText = { text in appendToDraft(text) }
        }
        .onDisappear {
            // The recorder is registered app-wide with LifecycleHub but its UI
            // lives in THIS view. Navigating away mid-recording (tab switch,
            // pop, sheet dismiss) hid the recording row while the mic stayed
            // hot — an invisible live recording burning battery and privacy
            // indicator with no way to stop it. View gone = recording gone.
            if voice.state == .recording { voice.cancel() }
        }
        .onChange(of: pickerItems) { _, items in
            guard !items.isEmpty else { return }
            Task { await loadPicked(items) }
        }
    }

    // MARK: - Rows

    private var inputRow: some View {
        HStack(alignment: .bottom, spacing: 8) {
            photoButton

            TextField(busy ? "Waiting for reply…" : placeholder, text: draft, axis: .vertical)
                .lineLimit(1...6)
                .padding(.horizontal, 16)
                .padding(.vertical, 9)
                .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 19, style: .continuous))
                .focused($focused)
                .accessibilityIdentifier("chat.composer")

            if hasContent {
                sendButton
            } else {
                micButton
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

    /// Recording in progress: cancel × — pulsing dot + elapsed — stop ✓.
    private var recordingRow: some View {
        HStack(spacing: 12) {
            Button {
                voice.cancel()
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(.secondary)
                    .frame(width: 32, height: 32)
                    .background(Color(.tertiarySystemFill), in: Circle())
            }
            .accessibilityIdentifier("chat.voiceCancel")

            RecordingIndicator(elapsed: voice.elapsed)
                .frame(maxWidth: .infinity, alignment: .leading)

            Button {
                Task {
                    if let text = await voice.stopAndTranscribe() {
                        appendToDraft(text)
                    }
                }
            } label: {
                Image(systemName: "checkmark")
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

    private func appendToDraft(_ text: String) {
        let existing = draft.wrappedValue
        draft.wrappedValue = existing.isEmpty ? text : existing + " " + text
        focused = true
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

/// Pulsing red dot + elapsed time while the mic is live.
private struct RecordingIndicator: View {
    let elapsed: TimeInterval
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
            Text("Recording…")
                .font(.callout)
                .foregroundStyle(.secondary)
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
            placeholder: "Message \(chat.activeAgentName)",
            busy: chat.sending || chat.streaming,
            disabled: !connection.online,
            disabledNotice: connection.online ? nil : "Offline — reconnecting…",
            // Per-conversation draft. A brand-new (unsaved) conversation shares
            // the agent-scoped key so text typed before the server assigns an id
            // isn't orphaned when it does.
            draftKey: "chat:\(chat.activeID ?? "new-\(chat.activeAgentID)")"
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

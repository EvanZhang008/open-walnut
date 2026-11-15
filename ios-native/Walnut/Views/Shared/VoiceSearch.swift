import SwiftUI

/// Walnut's mic for a system search field (`.searchable`), which hosts no view of its own: while
/// the search is up, a row over the keyboard holds the mic, then the recording row while a take
/// runs, and the recorder's notices for this search. The words land after what is typed in the
/// search, exactly as in a `VoiceDictationField`, and only filter: a search has no Send.
///
/// Apply it after `.searchable` (and after any overlay of results, so the row sits above them),
/// with the same text and presentation bindings.
extension View {
    func voiceSearch(text: Binding<String>, isPresented: Binding<Bool>, surface: String, box: String) -> some View {
        modifier(VoiceSearchRow(text: text, isPresented: isPresented, surface: surface, box: box))
    }
}

private struct VoiceSearchRow: ViewModifier {
    @Binding var text: String
    @Binding var isPresented: Bool
    let surface: String
    let box: String
    @State private var voice = VoiceRecorder()

    private var idPrefix: String { "voice.\(box)" }

    func body(content: Content) -> some View {
        content
            .safeAreaInset(edge: .bottom, spacing: 0) {
                VStack(spacing: 0) {
                    VoiceDictationNotices(voice: voice, surface: surface, idPrefix: idPrefix) { insert($0) }
                    if voice.state == .recording {
                        VoiceRecordingBar(
                            voice: voice, idPrefix: idPrefix,
                            onCancel: { voice.cancel() },
                            onStop: { Task { if let words = await voice.stopAndTranscribe() { insert(words) } } }
                        )
                        .padding(.horizontal, 12)
                        .padding(.vertical, 4)
                    } else if isPresented || voice.state != .idle {
                        HStack(spacing: 8) {
                            Text("Say what to look for")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                            Spacer(minLength: 0)
                            VoiceMicButton(voice: voice, identifier: "voice-mic.\(box)")
                        }
                        .padding(.horizontal, 16)
                        .padding(.vertical, 2)
                    }
                }
                .background(.bar)
                .accessibilityElement(children: .contain)
            }
            // The same lifecycle as every dictation box: its own surface, recovery into this search
            // only, and a take the person leaves stopped and kept, never deleted.
            .voiceDictation(voice, surface: surface) { insert($0) }
    }

    /// After what is typed, and the search shows the words it now looks for.
    private func insert(_ words: String) {
        guard let joined = VoiceDictationText.appending(words, to: text) else { return }
        text = joined
        if !isPresented { isPresented = true }
    }
}

import Foundation

/// Voice transcription endpoint — split from WalnutAPI.swift so the voice
/// resilience work (size-scaled timeouts, no-loss retry) rides the shared
/// request funnel without touching the core client.
extension WalnutAPI {
    /// Upload recorded audio, get the recognized text back. The server picks
    /// the engine (local whisper on the primary box, bridge relay to it from
    /// the cloud, or OpenAI fallback).
    ///
    /// Timeout scales with the take: recordings no longer have a duration cap
    /// (field incident 2026-08-09), and an hour of 16kHz AAC is ~11MB that
    /// whisper needs real minutes to transcribe. Base 120s + ~1s per 12KB of
    /// audio (≈4× realtime at our 24kbps encode), capped at 15 minutes. A
    /// timeout is NOT data loss — the caller preserves the audio and retries.
    func transcribeVoice(audio: Data, format: String, language: String? = nil) async throws -> String {
        struct Result: Codable { let text: String }
        // Base64 off the MainActor (same rule as image payloads): the caller
        // is a @MainActor recorder, so encoding inline would block the UI for
        // the whole encode of a multi-MB buffer.
        let encoded = await Task.detached(priority: .userInitiated) {
            audio.base64EncodedString()
        }.value
        var body: [String: String] = ["audio": encoded, "format": format]
        if let language { body["language"] = language }
        let timeout = min(900.0, 120.0 + Double(audio.count) / 12_000.0)
        let result: Result = try await sendAbsolute(
            "POST", "/api/v1/stt/transcribe", body: body, timeout: timeout
        )
        return result.text
    }
}

import AVFoundation
import Foundation
import UniformTypeIdentifiers

/// Turns a finished camera recording into what the composer attaches: the video
/// file itself, up to eight stills (`VideoStills`) and a narration transcript, as
/// `ComposerFile`s that ride the ordinary file upload (so every path is valid on
/// the session's host). The message names them through `ComposerFile.messageText`.
enum CameraClipMaker {
    /// A recording made ready to attach.
    struct Clip: Sendable {
        let video: ComposerFile
        let stills: [ComposerFile]
        let durationMs: Int
        var files: [ComposerFile] { [video] + stills }

        /// The same clip with its narration on its video's card.
        func narrated(_ narration: Narration) -> Clip {
            var video = self.video
            switch narration {
            case .said(let text):
                video.clip = .video(durationMs: durationMs, narration: text, narrationNote: nil)
            case .none(let note):
                video.clip = .video(durationMs: durationMs, narration: nil, narrationNote: note)
            }
            return Clip(video: video, stills: stills, durationMs: durationMs)
        }
    }

    /// The narration: what was said, or why there is none.
    enum Narration: Equatable, Sendable {
        case said(String)
        case none(note: String)
    }

    /// The video's name: "camera-141605.mov" (the local time it was taken, as the
    /// web's `captureBaseName`), "-2", "-3" after it when the message already holds
    /// that name, so every block names one video.
    static func videoName(at date: Date, ext: String, taken: Set<String>) -> String {
        let format = DateFormatter()
        format.locale = Locale(identifier: "en_US_POSIX")
        format.dateFormat = "HHmmss"
        let base = "camera-\(format.string(from: date))"
        var name = "\(base).\(ext)"
        var n = 2
        while taken.contains(name) { name = "\(base)-\(n).\(ext)"; n += 1 }
        return name
    }

    /// Make the clip from the recording at `url` (moved into the app's store): the
    /// video and its stills, with no narration yet. Its words come apart
    /// (`narrate` on the video's own file, then `Clip.narrated`), so the camera can
    /// add the video without them when the person skips them.
    static func make(recording url: URL, name: String) async throws -> Clip {
        let extracted = (try? await VideoStills.extract(from: url, videoName: name)) ?? (durationMs: 0, stills: [])
        var video = try await ComposerFileStore.importCopy(of: url, name: name, type: .quickTimeMovie,
                                                           scoped: false, move: true)
        video.clip = .video(durationMs: extracted.durationMs, narration: nil, narrationNote: nil)
        var stills: [ComposerFile] = []
        for still in extracted.stills {
            guard var file = try? await ComposerFileStore.importData(still.jpeg, name: still.name) else { continue }
            file.clip = .still(videoID: video.id)
            stills.append(file)
        }
        AppLog.info("camera", "clip made", ["ms": String(extracted.durationMs), "stills": String(stills.count)])
        return Clip(video: video, stills: stills, durationMs: extracted.durationMs)
    }

    /// How long the server may take to transcribe a minute of speech before the
    /// clip goes without it.
    static let transcribeTimeout: Duration = .seconds(45)

    /// The recording's sound as m4a, transcribed; never throws. `transcribe` is
    /// the server's speech to text (`WalnutAPI.transcribe`); its failure only
    /// leaves the clip without narration, and says why. A cancelled task (the clip
    /// was dropped, or its words skipped) sends nothing.
    static func narrate(_ url: URL, transcribe: @escaping @Sendable (Data) async throws -> String) async -> Narration {
        guard !Task.isCancelled else { return .none(note: "no narration") }
        let asset = AVURLAsset(url: url)
        guard let tracks = try? await asset.loadTracks(withMediaType: .audio), !tracks.isEmpty else {
            return .none(note: "no sound recorded")
        }
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("narration-" + UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let audioURL = dir.appendingPathComponent("narration.m4a")
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            guard let export = AVAssetExportSession(asset: asset, presetName: AVAssetExportPresetAppleM4A) else {
                return .none(note: "no narration: the sound could not be read")
            }
            try await export.export(to: audioURL, as: .m4a)
        } catch {
            AppLog.warn("camera", "narration audio not exported", ["error": String(describing: error)])
            return .none(note: "no narration: the sound could not be read")
        }
        guard let audio = try? Data(contentsOf: audioURL), !audio.isEmpty else {
            return .none(note: "no narration: the sound could not be read")
        }
        guard !Task.isCancelled else { return .none(note: "no narration") }
        do {
            let text = try await Deadline.run(transcribeTimeout) { try await transcribe(audio) }
            let said = AttachmentHeaders.oneLine(text)
            return said.isEmpty ? .none(note: "nothing was said") : .said(said)
        } catch {
            AppLog.warn("camera", "narration not transcribed", ["error": String(describing: error)])
            return .none(note: narrationNote(for: error))
        }
    }

    /// Why a clip has no narration, in the words its card shows.
    static func narrationNote(for error: Error) -> String {
        if case APIError.server(_, let code, _, _, _) = error, code == "stt_unavailable" {
            return "no narration: speech to text is not set up"
        }
        if error is Deadline.Expired { return "no narration: speech to text took too long" }
        return "no narration: speech to text failed"
    }
}

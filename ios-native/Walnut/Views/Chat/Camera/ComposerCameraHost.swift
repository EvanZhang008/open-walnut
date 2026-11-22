import UIKit

/// What the composer's camera needs from the composer it opens over
/// (`ComposerBar`): its attachments as they are now, a way to add to them, and
/// its close and file picker. The camera has no Send of its own: what it takes
/// goes into the composer, which sends it. The composer hands these over; the
/// camera's rules for them live here (`CameraCaptureModel.forComposer`).
struct ComposerCameraHost {
    /// How many photos the message holds now.
    var photoCount: () -> Int
    /// The files the message holds now.
    var files: () -> [ComposerFile]
    /// Files still being copied in: each takes a slot.
    var importing: () -> Int
    var setFiles: ([ComposerFile]) -> Void
    /// The composer's own merge (its ceiling and notice); false when it did not take the photo.
    var addPhoto: (UIImage) async -> Bool
    /// Take the camera down.
    var dismiss: () -> Void
    /// Open the composer's file picker (its photo picker where it takes no files).
    var pickFile: () -> Void
    /// Whether the composer takes files, and so videos.
    var acceptsFiles: Bool
}

extension CameraCaptureModel {
    /// The composer's own camera, wired to one composer: its photos go through
    /// the same merge a pick does, and a video joins the files with its stills.
    static func forComposer(_ host: ComposerCameraHost) -> CameraCaptureModel {
        var actions = Actions()
        actions.addPhoto = { image in await host.addPhoto(image) }
        actions.addClip = { clip in
            guard ComposerFile.countedFiles(host.files()) + host.importing() < ComposerFile.maxFiles else { return false }
            host.setFiles(host.files() + clip.files)
            return true
        }
        actions.close = { host.dismiss() }
        actions.pickFile = {
            host.dismiss()
            // After the cover is down: one presentation at a time.
            Task { @MainActor in
                try? await Task.sleep(for: .milliseconds(600))
                host.pickFile()
            }
        }
        actions.photoRoom = { max(0, ComposerBar.maxImages - host.photoCount()) }
        actions.takenNames = { Set(host.files().map(\.name)) }
        return CameraCaptureModel(source: CameraSources.make(), allowsVideo: host.acceptsFiles, actions: actions)
    }
}

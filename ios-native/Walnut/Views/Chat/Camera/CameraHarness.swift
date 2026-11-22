import SwiftUI

/// The DEBUG `-camera-harness` launch: the composer's camera on its own, with
/// the fake source (`FakeCameraSource`), so its layout and its steps can be
/// driven and screenshotted in a simulator (`CameraCaptureUITests`). Its actions
/// only count what the composer would have got (`camera.harness.added`): photos,
/// videos, and whether every video came with its stills.
enum CameraHarness {
    static let launchArgument = "camera-harness"

    /// Only a DEBUG build takes the harness.
    static var isOn: Bool {
        #if DEBUG
        return ProcessInfo.processInfo.arguments.contains(where: { $0.contains(launchArgument) })
        #else
        return false
        #endif
    }
}

#if DEBUG
struct CameraHarnessView: View {
    @State private var photos = 0
    @State private var clips = 0
    @State private var stills = true
    @State private var open = true
    @State private var model: CameraCaptureModel?

    var body: some View {
        ZStack(alignment: .bottom) {
            Color(.systemBackground).ignoresSafeArea()
            Text("photos=\(photos) clips=\(clips) stills=\(stills)")
                .font(.footnote.monospaced())
                .accessibilityIdentifier("camera.harness.added")
                .padding(.bottom, 40)
            Button("Open camera") { open = true }
                .accessibilityIdentifier("camera.harness.open")
                .padding(.bottom, 80)
        }
        .fullScreenCover(isPresented: $open) {
            CameraCaptureView(model: makeModel())
        }
    }

    private func makeModel() -> CameraCaptureModel {
        var actions = CameraCaptureModel.Actions()
        actions.addPhoto = { _ in photos += 1; return true }
        actions.addClip = { clip in
            clips += 1
            stills = stills && !clip.stills.isEmpty
            clip.files.forEach(ComposerFileStore.remove)
            return true
        }
        actions.close = { open = false }
        actions.photoRoom = { max(0, ComposerBar.maxImages - photos) }
        // Never the network: any sound "times out" (the fake records none).
        actions.narrate = { url in await CameraClipMaker.narrate(url) { _ in throw Deadline.Expired() } }
        return CameraCaptureModel(source: CameraSources.make(), allowsVideo: true, actions: actions)
    }
}
#endif

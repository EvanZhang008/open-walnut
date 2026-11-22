import AVFoundation
import SwiftUI
import UIKit

/// The composer's own camera, full screen (the `camera_capture` experiment): the
/// picture edge to edge, "Camera on" (or the red timer and Sound) at the top,
/// Photo | Video, the shutter and the flip at the bottom, and while a video
/// records, a Photo button that takes a still without stopping it. What is
/// taken goes straight into the composer (a flash, and "2 photos added" under the
/// top bar); the camera stays open, and the person closes it and sends with the
/// composer's own Send. While a stopped video is finished, and while the composer
/// refuses one, a row in place of the shutter says so (Skip the words; Discard
/// it / Add the video).
struct CameraCaptureView: View {
    @State var model: CameraCaptureModel
    @Environment(\.scenePhase) private var scenePhase
    /// The white flash of a photo that went in.
    @State private var flashOn = false

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            switch model.stage {
            case .denied:
                deniedPage
            case .failed(let why):
                messagePage(title: "The camera could not start", detail: why)
            default:
                livePage
            }
        }
        .preferredColorScheme(.dark)
        .statusBarHidden(true)
        .task { await model.appear() }
        // Never on in the background: it stops when the app leaves and starts again on return.
        .onChange(of: scenePhase) { _, phase in
            Task {
                if phase == .background { await model.sceneLeft() }
                if phase == .active { await model.sceneReturned() }
            }
        }
        .onDisappear { model.source.stop() }
    }

    // MARK: - Live

    private var livePage: some View {
        VStack(spacing: 0) {
            topBar
            if let added = model.addedLabel {
                pill(text: added, id: "camera.added").padding(.top, 10)
            }
            if let notice = model.notice { noticePill(notice).padding(.top, 10) }
            Spacer()
            if model.stage == .finishing || model.stage == .notAdded {
                heldRow
            } else {
                bottomBar
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        // The picture (and a photo's flash) is behind the controls and never sizes them:
        // a source whose view is bigger than the screen would push the shutter off it.
        .background {
            CameraPreviewHost(view: model.source.previewView)
                .overlay { Color.white.opacity(flashOn ? 0.55 : 0).allowsHitTesting(false) }
                .ignoresSafeArea()
        }
        .overlay {
            if model.stage == .starting {
                ProgressView().tint(.white).controlSize(.large)
            }
        }
        .onChange(of: model.photosAdded) { _, _ in flash() }
    }

    private func flash() {
        withAnimation(.linear(duration: 0.05)) { flashOn = true }
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(90))
            withAnimation(.easeOut(duration: 0.3)) { flashOn = false }
        }
    }

    private var topBar: some View {
        HStack(spacing: 8) {
            roundButton("xmark", label: "Close camera", id: "camera.close") { model.close() }
            if model.stage == .recording {
                pill(dot: .red, text: CameraCaptureModel.timerLabel(elapsed: model.elapsed), id: "camera.timer")
                pill(symbol: model.recordingHasSound ? "mic.fill" : "mic.slash.fill",
                     text: model.recordingHasSound ? "Sound on" : "Sound off", id: "camera.sound")
            } else {
                pill(dot: .green, text: "Camera on", id: "camera.on")
                if model.mode == .video {
                    Button { model.soundOn.toggle() } label: {
                        pill(symbol: model.soundOn ? "mic.fill" : "mic.slash.fill",
                             text: model.soundOn ? "Sound on" : "Sound off", id: "camera.soundToggle")
                    }
                    .accessibilityLabel(model.soundOn ? "Sound on. Tap to record without sound" : "Sound off. Tap to record with sound")
                    .accessibilityIdentifier("camera.soundToggle")
                }
            }
            Spacer(minLength: 0)
        }
    }

    private var bottomBar: some View {
        VStack(spacing: 18) {
            if model.allowsVideo && model.stage != .recording {
                modeSwitch
            }
            HStack {
                // While recording: a still without stopping the video.
                Group {
                    if model.stage == .recording {
                        Button { Task { await model.photoWhileRecording() } } label: {
                            VStack(spacing: 3) {
                                Image(systemName: "camera.fill").font(.system(size: 20, weight: .semibold))
                                Text("Photo").font(.caption.weight(.semibold))
                            }
                            .foregroundStyle(.white)
                            .frame(width: 64, height: 64)
                            .background(.white.opacity(0.18), in: Circle())
                        }
                        .accessibilityLabel("Take a photo without stopping the video")
                        .accessibilityIdentifier("camera.stillDuringRecording")
                    } else {
                        Color.clear
                    }
                }
                .frame(width: 64, height: 64)
                Spacer()
                shutter
                Spacer()
                Group {
                    if model.source.canFlip && model.stage != .recording {
                        roundButton("arrow.triangle.2.circlepath.camera", label: "Switch camera", id: "camera.flip", side: 56) {
                            Task { await model.flip() }
                        }
                    } else {
                        Color.clear
                    }
                }
                .frame(width: 64, height: 64)
            }
        }
        .padding(.bottom, 12)
    }

    private var modeSwitch: some View {
        HStack(spacing: 4) {
            ForEach(CameraCaptureModel.Mode.allCases, id: \.self) { mode in
                Button { model.mode = mode } label: {
                    Text(mode == .photo ? "Photo" : "Video")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(model.mode == mode ? .black : .white)
                        .padding(.horizontal, 18)
                        .padding(.vertical, 8)
                        .background(model.mode == mode ? Color.white : Color.clear, in: Capsule())
                }
                .accessibilityIdentifier("camera.mode.\(mode.rawValue)")
                .accessibilityAddTraits(model.mode == mode ? .isSelected : [])
            }
        }
        .padding(4)
        .background(.black.opacity(0.45), in: Capsule())
    }

    private var shutter: some View {
        let recording = model.stage == .recording
        return Button { Task { await model.shutter() } } label: {
            ZStack {
                Circle().strokeBorder(.white, lineWidth: 5).frame(width: 80, height: 80)
                if recording {
                    RoundedRectangle(cornerRadius: 7).fill(.red).frame(width: 32, height: 32)
                } else {
                    Circle().fill(model.mode == .video ? Color.red : Color.white).frame(width: 64, height: 64)
                }
            }
        }
        .disabled(model.stage != .live && model.stage != .recording)
        .accessibilityLabel(recording ? "Stop recording" : model.mode == .video ? "Start recording" : "Take photo")
        .accessibilityIdentifier("camera.shutter")
    }

    // MARK: - A stopped video

    /// In place of the shutter while a stopped video is finished (it goes in by
    /// itself once its words are in) and while the composer refuses it (kept
    /// here, never lost; no new recording until it is added or discarded).
    private var heldRow: some View {
        VStack(spacing: 12) {
            Text(model.stage == .notAdded ? "The video is not in the message yet"
                 : model.recordingHasSound ? "Adding the video once its words are in\u{2026}"
                 : "Adding the video\u{2026}")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.white)
                .multilineTextAlignment(.center)
                .accessibilityIdentifier("camera.heldStatus")
            HStack(spacing: 12) {
                if model.stage == .notAdded {
                    rowButton("Discard it", id: "camera.discardClip", prominent: false) {
                        Task { await model.discardHeldClip() }
                    }
                    rowButton("Add the video", id: "camera.addClip", prominent: true) {
                        Task { await model.addHeldClip() }
                    }
                } else if model.recordingHasSound {
                    rowButton("Skip the words", id: "camera.skipWords", prominent: false) { model.skipWords() }
                }
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity)
        .background(.black.opacity(0.55), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("camera.held")
        .padding(.bottom, 12)
    }

    // MARK: - Access off

    private var deniedPage: some View {
        VStack(spacing: 16) {
            Image(systemName: "lock.slash").font(.system(size: 44)).foregroundStyle(.white.opacity(0.85))
            Text("Camera access is off")
                .font(.title3.weight(.semibold))
                .foregroundStyle(.white)
            Text("Walnut uses the camera only while this screen is open, to take photos and videos for your chat. Turn on Camera for Walnut in Settings.")
                .font(.callout)
                .foregroundStyle(.white.opacity(0.8))
                .multilineTextAlignment(.center)
            Button {
                if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
            } label: {
                Text("Open Settings").frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .accessibilityIdentifier("camera.openSettings")
            Button { model.actions.pickFile() } label: {
                Text("Pick a file instead").frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .controlSize(.large)
            .accessibilityIdentifier("camera.pickFile")
            Button("Close") { model.close() }
                .foregroundStyle(.white)
                .accessibilityIdentifier("camera.close")
        }
        .padding(28)
    }

    private func messagePage(title: String, detail: String) -> some View {
        VStack(spacing: 14) {
            Text(title).font(.title3.weight(.semibold)).foregroundStyle(.white)
            Text(detail).font(.callout).foregroundStyle(.white.opacity(0.8)).multilineTextAlignment(.center)
            Button("Close") { model.close() }
                .buttonStyle(.bordered)
                .accessibilityIdentifier("camera.close")
        }
        .padding(28)
    }

    // MARK: - Pieces

    private func pill(dot: Color? = nil, symbol: String? = nil, text: String, id: String) -> some View {
        HStack(spacing: 6) {
            if let dot { Circle().fill(dot).frame(width: 9, height: 9) }
            if let symbol { Image(systemName: symbol).font(.caption.weight(.semibold)) }
            Text(text).font(.footnote.weight(.semibold)).monospacedDigit()
        }
        .foregroundStyle(.white)
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
        .background(.black.opacity(0.5), in: Capsule())
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier(id)
    }

    private func noticePill(_ text: String) -> some View {
        Text(text)
            .font(.footnote.weight(.medium))
            .foregroundStyle(.white)
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .background(.black.opacity(0.6), in: Capsule())
            .accessibilityIdentifier("camera.notice")
    }

    private func roundButton(_ symbol: String, label: String, id: String, side: CGFloat = 40,
                             action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: side * 0.42, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: side, height: side)
                .background(.black.opacity(0.5), in: Circle())
        }
        .frame(minWidth: 44, minHeight: 44)
        .accessibilityLabel(label)
        .accessibilityIdentifier(id)
    }

    private func rowButton(_ title: String, id: String, prominent: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.body.weight(.semibold))
                .lineLimit(1)
                .minimumScaleFactor(0.7)
                .frame(maxWidth: .infinity, minHeight: 50)
                .foregroundStyle(.white)
                .background(prominent ? Color.accentColor : Color.white.opacity(0.18),
                            in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
        .accessibilityIdentifier(id)
    }
}

/// The source's picture view in SwiftUI.
private struct CameraPreviewHost: UIViewRepresentable {
    let view: UIView
    func makeUIView(context: Context) -> UIView { view }
    func updateUIView(_ uiView: UIView, context: Context) {}
}

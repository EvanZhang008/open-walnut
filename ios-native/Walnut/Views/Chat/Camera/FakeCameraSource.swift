import AVFoundation
import UIKit

/// The composer's camera with no camera: the simulator's, the demo's and the
/// screenshot harness's (`CameraSources.make`). Its picture is a drawn whiteboard
/// that gains a box every few seconds while it "records"; a photo is the board as
/// it stands; a recording is a short video of the board generated on stop (no
/// sound track, so its clip says "no sound recorded"; `hasMicrophone` only says
/// whether the panel shows sound on). It never opens a camera or a microphone,
/// and never plays anything.
@MainActor
final class FakeCameraSource: CameraSource {
    private let imageView = UIImageView()
    private var stage = 1
    private var front = false
    private var recording: (url: URL, startedAt: Date, startStage: Int)?
    private var ticker: Task<Void, Never>?
    /// Whether a recording "has sound". Its video never has a sound track, so its
    /// clip still says "no sound recorded"; on, the panel shows a recording with sound.
    var hasMicrophone: Bool
    var onInterruption: ((CameraInterruption) -> Void)?

    init(hasMicrophone: Bool = false) {
        self.hasMicrophone = hasMicrophone
        imageView.contentMode = .scaleAspectFill
        imageView.clipsToBounds = true
        imageView.backgroundColor = .black
        redraw()
    }

    var previewView: UIView { imageView }
    var canFlip: Bool { true }
    var position: AVCaptureDevice.Position { front ? .front : .back }

    func start() async throws { redraw() }

    /// A recording it ends is still written by `stopRecording`, as a real one is.
    func stop() {
        ticker?.cancel()
        ticker = nil
    }

    func flip() async throws {
        front.toggle()
        redraw()
    }

    func takePhoto() async throws -> UIImage { FakeWhiteboard.image(stage: stage, mirrored: front) }

    func startRecording(to url: URL, sound: Bool) async throws -> Bool {
        recording = (url, Date(), stage)
        ticker?.cancel()
        // The board changes while it records, so the clip has stills worth keeping.
        ticker = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(FakeWhiteboard.secondsPerStage))
                guard !Task.isCancelled, let self else { return }
                self.stage = min(FakeWhiteboard.stages, self.stage + 1)
                self.redraw()
            }
        }
        return sound && hasMicrophone
    }

    func stopRecording() async throws -> URL {
        guard let recording else { throw CameraSourceError.notRunning }
        ticker?.cancel()
        ticker = nil
        self.recording = nil
        let seconds = max(1, Date().timeIntervalSince(recording.startedAt))
        let start = recording.startStage, mirrored = front
        try await Task.detached(priority: .userInitiated) {
            try await FakeWhiteboard.writeVideo(to: recording.url, seconds: seconds, startStage: start, mirrored: mirrored)
        }.value
        return recording.url
    }

    private func redraw() {
        imageView.image = FakeWhiteboard.image(stage: stage, mirrored: front)
    }
}

/// The fake camera's whiteboard: a request flow drawn in marker, one box more per stage.
enum FakeWhiteboard {
    static let stages = 5
    static let secondsPerStage = 2.5
    /// Portrait, the way the phone holds it.
    static let size = CGSize(width: 720, height: 1280)

    static func image(stage: Int, mirrored: Bool = false) -> UIImage {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        return UIGraphicsImageRenderer(size: size, format: format).image { context in
            draw(in: context.cgContext, stage: stage, mirrored: mirrored)
        }
    }

    static func draw(in cg: CGContext, stage: Int, mirrored: Bool) {
        let w = size.width, h = size.height
        // The wall, then the board.
        UIColor(white: 0.32, alpha: 1).setFill()
        cg.fill(CGRect(origin: .zero, size: size))
        let board = CGRect(x: 40, y: 150, width: w - 80, height: h - 330)
        UIColor(white: 0.97, alpha: 1).setFill()
        UIBezierPath(roundedRect: board, cornerRadius: 10).fill() // ui-standard-ok: synthetic camera frame
        UIColor(white: 0.7, alpha: 1).setStroke()
        let frame = UIBezierPath(roundedRect: board, cornerRadius: 10) // ui-standard-ok: synthetic camera frame
        frame.lineWidth = 8
        frame.stroke()
        let ink = UIColor(red: 0.1, green: 0.2, blue: 0.55, alpha: 1)
        let red = UIColor(red: 0.8, green: 0.15, blue: 0.15, alpha: 1)
        text(mirrored ? "(front camera)" : "Request flow", at: CGPoint(x: board.minX + 40, y: board.minY + 36), size: 46, color: ink)
        let boxes = ["Client", "Queue", "Worker", "Store"]
        let boxW: CGFloat = 300, boxH: CGFloat = 120
        for (i, name) in boxes.enumerated() where i < stage {
            let rect = CGRect(x: i % 2 == 0 ? board.minX + 50 : board.maxX - 50 - boxW,
                              y: board.minY + 150 + CGFloat(i) * 190, width: boxW, height: boxH)
            ink.setStroke()
            let box = UIBezierPath(roundedRect: rect, cornerRadius: 14) // ui-standard-ok: synthetic camera frame
            box.lineWidth = 6
            box.stroke()
            text(name, at: CGPoint(x: rect.minX + 30, y: rect.minY + 34), size: 44, color: ink)
            if i > 0 {
                let arrow = UIBezierPath()
                arrow.move(to: CGPoint(x: i % 2 == 0 ? board.maxX - 50 - boxW / 2 : board.minX + 50 + boxW / 2, y: rect.minY - 70))
                arrow.addLine(to: CGPoint(x: rect.midX, y: rect.minY - 6))
                arrow.lineWidth = 5
                arrow.stroke()
            }
        }
        if stage >= stages {
            text("retry here?", at: CGPoint(x: board.minX + 60, y: board.maxY - 110), size: 48, color: red)
        }
    }

    private static func text(_ s: String, at point: CGPoint, size: CGFloat, color: UIColor) {
        let font = UIFont(name: "MarkerFelt-Wide", size: size) ?? .systemFont(ofSize: size, weight: .semibold)
        (s as NSString).draw(at: point, withAttributes: [.font: font, .foregroundColor: color])
    }

    /// A video of the board `seconds` long at 4 frames a second, a stage more
    /// every `secondsPerStage` from `startStage`, H.264 in a QuickTime file.
    static func writeVideo(to url: URL, seconds: Double, startStage: Int, mirrored: Bool) async throws {
        try? FileManager.default.removeItem(at: url)
        let writer = try AVAssetWriter(outputURL: url, fileType: .mov)
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: Int(size.width), AVVideoHeightKey: Int(size.height),
        ])
        input.expectsMediaDataInRealTime = false
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
            kCVPixelBufferWidthKey as String: Int(size.width), kCVPixelBufferHeightKey as String: Int(size.height),
        ])
        guard writer.canAdd(input) else { throw CameraSourceError.failed("The fake video could not be written.") }
        writer.add(input)
        guard writer.startWriting() else { throw writer.error ?? CameraSourceError.failed("The fake video could not be written.") }
        writer.startSession(atSourceTime: .zero)
        let fps = 4
        let frames = max(1, Int(seconds * Double(fps)))
        for frame in 0...frames {
            while !input.isReadyForMoreMediaData { try await Task.sleep(for: .milliseconds(5)) }
            let at = Double(frame) / Double(fps)
            let stage = min(stages, startStage + Int(at / secondsPerStage))
            guard let buffer = pixelBuffer(stage: stage, mirrored: mirrored, pool: adaptor.pixelBufferPool) else { continue }
            adaptor.append(buffer, withPresentationTime: CMTime(value: CMTimeValue(frame), timescale: CMTimeScale(fps)))
        }
        input.markAsFinished()
        await writer.finishWriting()
        if writer.status != .completed { throw writer.error ?? CameraSourceError.failed("The fake video could not be written.") }
    }

    private static func pixelBuffer(stage: Int, mirrored: Bool, pool: CVPixelBufferPool?) -> CVPixelBuffer? {
        var made: CVPixelBuffer?
        if let pool { CVPixelBufferPoolCreatePixelBuffer(nil, pool, &made) }
        if made == nil {
            CVPixelBufferCreate(nil, Int(size.width), Int(size.height), kCVPixelFormatType_32BGRA, nil, &made)
        }
        guard let buffer = made else { return nil }
        CVPixelBufferLockBaseAddress(buffer, [])
        defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
        guard let cg = CGContext(data: CVPixelBufferGetBaseAddress(buffer), width: Int(size.width), height: Int(size.height),
                                 bitsPerComponent: 8, bytesPerRow: CVPixelBufferGetBytesPerRow(buffer),
                                 space: CGColorSpaceCreateDeviceRGB(),
                                 bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)
        else { return nil }
        // UIKit drawing is top-down; a bitmap context is bottom-up.
        cg.translateBy(x: 0, y: size.height)
        cg.scaleBy(x: 1, y: -1)
        UIGraphicsPushContext(cg)
        draw(in: cg, stage: stage, mirrored: mirrored)
        UIGraphicsPopContext()
        return buffer
    }
}

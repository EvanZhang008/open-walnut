import AVFoundation
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

/// The stills a recorded video goes to the AI with: Claude reads pictures, not
/// video. The same rule as the web's camera panel, so a clip from either says the
/// same thing:
///
/// 1. a sample every `sampleEveryMs` from the start (0 s, 2 s, 4 s, …, the end included);
/// 2. each sample's signature: the frame drawn at 64 x 36, each cell one grey
///    byte by the Rec. 601 weights (the web's `greySignature`);
/// 3. each sample's score: the PERCENT (0-100) of its signature's cells whose grey
///    moved more than `cellChange` from the PREVIOUS sample's (a new box or line
///    on a whiteboard is a small part of the frame: a mean difference missed it);
/// 4. keep the first sample always, then the `maxStills - 1` best scored others
///    at or over `minScore` (an equal score: the earlier first), in time order;
/// 5. each kept still a JPEG at most `longEdge` px on its long edge, named
///    `<video base name>-still-<m>m<ss>s.jpg`.
///
/// The web's copy is web/src/components/chat/camera/camera-model.ts (`pickStills`,
/// `signatureDiff`, `greySignature`, `stillName`). Steps 3 and 4 and the names are
/// pure here (`score`, `select`, `stillName`), so the unit tests pin them; the
/// frames come from `AVAssetImageGenerator` on the finished file (`extract`), which runs the same on a device and a simulator.
enum VideoStills {
    static let sampleEveryMs = 2000
    static let maxStills = 8
    /// A sample is kept only when at least this percent of its cells changed (`MIN_STILL_CHANGE`).
    static let minScore = 0.5
    /// A cell changed when its grey moved more than this (`CELL_CHANGE`): a camera's own noise stays under it.
    static let cellChange = 16
    static let signatureWidth = 64
    static let signatureHeight = 36
    /// The long edge of a still: the size Claude reads a picture at.
    static let longEdge = 1568

    /// The sample times of a clip `durationMs` long: 0, 2000, … up to its end.
    static func sampleTimes(durationMs: Int) -> [Int] {
        Array(stride(from: 0, through: max(0, durationMs), by: sampleEveryMs))
    }

    /// The percent (0-100) of the two signatures' cells that changed by more than
    /// `cellChange`, over the shorter one's length (the web's `signatureDiff`).
    static func score(_ a: [UInt8], _ b: [UInt8]) -> Double {
        let n = min(a.count, b.count)
        guard n > 0 else { return 0 }
        var changed = 0
        for i in 0..<n where abs(Int(a[i]) - Int(b[i])) > cellChange { changed += 1 }
        return Double(changed) / Double(n) * 100
    }

    /// Each sample's score against the one before it (the first scores 0).
    static func scores(_ signatures: [[UInt8]]) -> [Double] {
        signatures.indices.map { $0 == 0 ? 0 : score(signatures[$0 - 1], signatures[$0]) }
    }

    /// The kept samples' indices, in time order: the first always, then the best
    /// scored others at or over `minScore`, `maxStills` in all.
    static func select(scores: [Double], maxStills: Int = VideoStills.maxStills,
                       minScore: Double = VideoStills.minScore) -> [Int] {
        guard !scores.isEmpty, maxStills > 0 else { return [] }
        let others = scores.indices.dropFirst()
            .filter { scores[$0] >= minScore }
            .sorted { scores[$0] != scores[$1] ? scores[$0] > scores[$1] : $0 < $1 }
            .prefix(maxStills - 1)
        return ([0] + others).sorted()
    }

    /// "camera-141605-still-0m06s.jpg": the video's name without its extension,
    /// then the still's time (whole seconds, rounded) as minutes and two-digit seconds.
    static func stillName(video: String, atMs ms: Int) -> String {
        let base = (video as NSString).deletingPathExtension
        let seconds = max(0, Int((Double(ms) / 1000).rounded(.toNearestOrAwayFromZero)))
        return "\(base)-still-\(seconds / 60)m" + String(format: "%02d", seconds % 60) + "s.jpg"
    }

    // MARK: - From a video file

    /// One kept still: its time, name and JPEG bytes.
    struct Still: Sendable {
        let atMs: Int
        let name: String
        let jpeg: Data
    }

    /// The stills of the video at `url` (saved as `videoName`), by the rule above.
    /// Two passes so a minute of samples never holds full frames at once: small
    /// frames for the signatures, then the kept ones at `longEdge`.
    static func extract(from url: URL, videoName: String) async throws -> (durationMs: Int, stills: [Still]) {
        let asset = AVURLAsset(url: url)
        let duration = try await asset.load(.duration)
        let durationMs = max(0, Int((duration.seconds.isFinite ? duration.seconds : 0) * 1000))
        let times = sampleTimes(durationMs: durationMs)
        let small = generator(asset, maxSide: 160)
        var signatures: [[UInt8]] = []
        var sampled: [Int] = []
        for ms in times {
            guard let frame = try? await small.image(at: CMTime(value: CMTimeValue(ms), timescale: 1000)).image,
                  let signature = signature(of: frame) else { continue }
            signatures.append(signature)
            sampled.append(ms)
        }
        let kept = select(scores: scores(signatures)).map { sampled[$0] }
        let large = generator(asset, maxSide: CGFloat(longEdge))
        var stills: [Still] = []
        for ms in kept {
            guard let frame = try? await large.image(at: CMTime(value: CMTimeValue(ms), timescale: 1000)).image,
                  let jpeg = jpegData(frame) else { continue }
            stills.append(Still(atMs: ms, name: stillName(video: videoName, atMs: ms), jpeg: jpeg))
        }
        return (durationMs, stills)
    }

    private static func generator(_ asset: AVAsset, maxSide: CGFloat) -> AVAssetImageGenerator {
        let generator = AVAssetImageGenerator(asset: asset)
        generator.appliesPreferredTrackTransform = true
        generator.maximumSize = CGSize(width: maxSide, height: maxSide)
        // A sample within a tenth of a second of its time: a whiteboard does not move faster.
        let tolerance = CMTime(value: 100, timescale: 1000)
        generator.requestedTimeToleranceBefore = tolerance
        generator.requestedTimeToleranceAfter = tolerance
        return generator
    }

    /// The frame drawn at 64 x 36, one grey byte a cell (`grey`).
    static func signature(of image: CGImage) -> [UInt8]? {
        let w = signatureWidth, h = signatureHeight
        var rgba = [UInt8](repeating: 0, count: w * h * 4)
        let drawn = rgba.withUnsafeMutableBytes { buffer -> Bool in
            guard let context = CGContext(data: buffer.baseAddress, width: w, height: h, bitsPerComponent: 8,
                                          bytesPerRow: w * 4, space: CGColorSpaceCreateDeviceRGB(),
                                          bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return false }
            context.interpolationQuality = .medium
            context.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
            return true
        }
        return drawn ? grey(rgba: rgba) : nil
    }

    /// RGBA bytes to one grey byte a pixel, by the Rec. 601 weights, rounded.
    static func grey(rgba: [UInt8]) -> [UInt8] {
        (0..<(rgba.count / 4)).map { i in
            let o = i * 4
            let y = 0.299 * Double(rgba[o]) + 0.587 * Double(rgba[o + 1]) + 0.114 * Double(rgba[o + 2])
            return UInt8(min(255, max(0, y.rounded(.toNearestOrAwayFromZero))))
        }
    }

    static func jpegData(_ image: CGImage, quality: Double = 0.85) -> Data? {
        let out = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(out as CFMutableData, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
        guard CGImageDestinationFinalize(destination), out.length > 0 else { return nil }
        return out as Data
    }
}

import SwiftUI
import UIKit
import PhotosUI
import ImageIO

/// An image the user picked in the composer, ready to attach to a message.
///
/// Holds two representations: `jpegData` (downscaled + JPEG-encoded bytes for
/// upload) and `thumbnail` (a small UIImage for the on-device preview strip and
/// the sent bubble). Images are local to the current app session — server
/// history carries no image references, so this never crosses the wire as-is;
/// only `jpegData` is base64-encoded into the `images` request field.
struct SelectedImage: Identifiable {
    let id = UUID()
    let jpegData: Data
    let thumbnail: UIImage

    /// Longest edge (px) the upload copy is downscaled to before JPEG encode.
    ///
    /// 1568 is the recommended tile size for vision models AND stays safely
    /// under the 2000px-per-dimension ceiling model providers enforce for
    /// multi-image requests. The previous value (2048) exceeded that ceiling by
    /// 48px, so an accepted upload could make the provider reject the whole
    /// turn with a 400 — and because the image is replayed with every later
    /// turn in the same conversation, that permanently bricked the thread.
    private static let maxUploadDimension: CGFloat = 1568
    /// Longest edge (px) of the in-memory preview thumbnail (keeps memory small
    /// even with 5 large photos attached).
    private static let thumbnailDimension: CGFloat = 600
    /// Reject an image whose base64 would exceed this — mirrors the server's
    /// 10MB base64 upload cap.
    static let maxUploadBase64Length = 10_000_000
    /// Reject pathological source dimensions before any raster is materialized.
    private static let maxSourcePixels = 100_000_000

    init(jpegData: Data, thumbnail: UIImage) {
        self.jpegData = jpegData
        self.thumbnail = thumbnail
    }

    /// Rebuild from already-encoded bytes (failed-bubble retry re-sends the same
    /// image, and the store only kept the JPEG data).
    init?(jpegData: Data) {
        guard let thumbnail = Self.thumbnail(from: jpegData) else { return nil }
        self.jpegData = jpegData
        self.thumbnail = thumbnail
    }

    enum LoadResult {
        case ok(SelectedImage)
        /// Still over the cap even after re-encoding at lower quality.
        case tooLarge
        /// Not decodable / not transferable as image data.
        case failed
    }

    /// Load a picked item, downsample, and JPEG-encode without materializing the
    /// source's full raster. Encodes at 0.8 first and falls back to 0.5.
    static func load(from item: PhotosPickerItem) async -> LoadResult {
        guard let data = try? await item.loadTransferable(type: Data.self) else { return .failed }
        return await Task.detached(priority: .userInitiated) { make(from: data) }.value
    }

    private static func make(from data: Data) -> LoadResult {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              sourcePixelCount(source) <= maxSourcePixels,
              let upload = thumbnail(from: source, maxDimension: maxUploadDimension),
              let preview = thumbnail(from: source, maxDimension: thumbnailDimension)
        else { return .failed }
        return encode(upload: upload, thumbnail: preview)
    }

    /// Callers such as paste already own a decoded UIImage; cap its raster before
    /// encoding, then derive the preview from that bounded copy.
    static func make(from image: UIImage) -> LoadResult {
        let upload = image.downscaled(maxDimension: maxUploadDimension)
        let preview = upload.downscaled(maxDimension: thumbnailDimension)
        return encode(upload: upload, thumbnail: preview)
    }

    static func thumbnail(from data: Data, maxDimension: CGFloat = thumbnailDimension) -> UIImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              sourcePixelCount(source) <= maxSourcePixels
        else { return nil }
        return thumbnail(from: source, maxDimension: maxDimension)
    }

    private static func thumbnail(from source: CGImageSource, maxDimension: CGFloat) -> UIImage? {
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: Int(maxDimension),
            kCGImageSourceShouldCacheImmediately: true,
        ]
        guard let cgImage = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else {
            return nil
        }
        return UIImage(cgImage: cgImage, scale: 1, orientation: .up)
    }

    private static func sourcePixelCount(_ source: CGImageSource) -> Int {
        guard let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? NSNumber,
              let height = properties[kCGImagePropertyPixelHeight] as? NSNumber
        else { return .max }
        let (pixels, overflow) = width.intValue.multipliedReportingOverflow(by: height.intValue)
        return overflow ? .max : pixels
    }

    private static func encode(upload: UIImage, thumbnail: UIImage) -> LoadResult {
        guard var jpeg = upload.jpegData(compressionQuality: 0.8) else { return .failed }
        if base64Length(jpeg) > maxUploadBase64Length {
            guard let lower = upload.jpegData(compressionQuality: 0.5) else { return .failed }
            jpeg = lower
            if base64Length(jpeg) > maxUploadBase64Length { return .tooLarge }
        }
        return .ok(SelectedImage(jpegData: jpeg, thumbnail: thumbnail))
    }

    /// Base64 length without allocating the encoded string: ceil(n/3) * 4.
    static func base64Length(_ data: Data) -> Int {
        (data.count + 2) / 3 * 4
    }
}

extension UIImage {
    /// Downscale so the longest edge is `maxDimension` px (points at scale 1);
    /// returns self if already smaller. Renders at scale 1 so points == pixels
    /// and the encoded size is predictable regardless of device scale.
    func downscaled(maxDimension: CGFloat) -> UIImage {
        let longest = max(size.width, size.height)
        guard longest > maxDimension, longest > 0 else { return self }
        let ratio = maxDimension / longest
        let target = CGSize(width: (size.width * ratio).rounded(),
                            height: (size.height * ratio).rounded())
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        let renderer = UIGraphicsImageRenderer(size: target, format: format)
        return renderer.image { _ in draw(in: CGRect(origin: .zero, size: target)) }
    }
}

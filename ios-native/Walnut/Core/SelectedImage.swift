import SwiftUI
import UIKit
import PhotosUI

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
    private static let maxUploadDimension: CGFloat = 2048
    /// Longest edge (px) of the in-memory preview thumbnail (keeps memory small
    /// even with 5 large photos attached).
    private static let thumbnailDimension: CGFloat = 600
    /// Reject an image whose base64 would exceed this — mirrors the server's
    /// 10MB base64 upload cap.
    private static let maxUploadBase64Length = 10_000_000

    init(jpegData: Data, thumbnail: UIImage) {
        self.jpegData = jpegData
        self.thumbnail = thumbnail
    }

    /// Rebuild from already-encoded bytes (failed-bubble retry re-sends the same
    /// image, and the store only kept the JPEG data).
    init?(jpegData: Data) {
        guard let image = UIImage(data: jpegData) else { return nil }
        self.jpegData = jpegData
        self.thumbnail = image
    }

    enum LoadResult {
        case ok(SelectedImage)
        /// Still over the cap even after re-encoding at lower quality.
        case tooLarge
        /// Not decodable / not transferable as image data.
        case failed
    }

    /// Load a picked item, downscale, and JPEG-encode. Encodes at 0.8 first and
    /// falls back to 0.5 if the base64 would exceed the cap; only then gives up.
    static func load(from item: PhotosPickerItem) async -> LoadResult {
        guard let data = try? await item.loadTransferable(type: Data.self),
              let image = UIImage(data: data) else { return .failed }
        return make(from: image)
    }

    static func make(from image: UIImage) -> LoadResult {
        let full = image.downscaled(maxDimension: maxUploadDimension)
        guard var jpeg = full.jpegData(compressionQuality: 0.8) else { return .failed }
        if base64Length(jpeg) > maxUploadBase64Length {
            guard let lower = full.jpegData(compressionQuality: 0.5) else { return .failed }
            jpeg = lower
            if base64Length(jpeg) > maxUploadBase64Length { return .tooLarge }
        }
        let thumb = image.downscaled(maxDimension: thumbnailDimension)
        return .ok(SelectedImage(jpegData: jpeg, thumbnail: thumb))
    }

    /// Base64 length without allocating the encoded string: ceil(n/3) * 4.
    private static func base64Length(_ data: Data) -> Int {
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

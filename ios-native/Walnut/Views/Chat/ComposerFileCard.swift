import SwiftUI

/// An attached file in the composer's strip, beside the photo thumbnails: the
/// same 64pt height, its kind's glyph, the name and size, and a remove button.
struct ComposerFileCard: View {
    let file: ComposerFile?
    /// Files still being copied in (`file` is nil then).
    var importingCount = 0
    var onRemove: () -> Void = {}
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    init(file: ComposerFile, onRemove: @escaping () -> Void) {
        self.file = file
        self.onRemove = onRemove
    }

    private init(importing count: Int) {
        self.file = nil
        self.importingCount = count
    }

    /// The placeholder while a pick is copied in (a long video takes seconds).
    static func importing(count: Int) -> ComposerFileCard { ComposerFileCard(importing: count) }

    static let height: CGFloat = 64
    static let width: CGFloat = 168
    /// At the accessibility sizes the name needs the room to be read at all:
    /// wider, and as tall as its three lines and the size need (a fixed 104pt
    /// left one line, "wal….pdf" at AX5: gate r3).
    static let accessibilityWidth: CGFloat = 260
    static let accessibilityMinHeight: CGFloat = 104

    var body: some View {
        ZStack(alignment: .topTrailing) {
            HStack(spacing: 8) {
                Group {
                    if file == nil {
                        ProgressView().controlSize(.small)
                    } else {
                        Image(systemName: file?.symbol ?? ComposerBar.Symbol.files)
                            .font(.system(size: 17, weight: .semibold))
                            .foregroundStyle(Theme.tint)
                    }
                }
                .frame(width: 34, height: 34)
                .background(Theme.tintSoft, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
                VStack(alignment: .leading, spacing: 1) {
                    Text(file?.name ?? (importingCount == 1 ? "Adding file…" : "Adding \(importingCount) files…"))
                        .font(.footnote.weight(.medium))
                        .lineLimit(dynamicTypeSize.isAccessibilitySize ? 3 : 2)
                        .truncationMode(.middle)
                        .fixedSize(horizontal: false, vertical: dynamicTypeSize.isAccessibilitySize)
                    if let file {
                        Text(ComposerFile.sizeLabel(file.size))
                            .font(.caption2)
                            .foregroundStyle(Theme.secondaryOnCard)
                            .monospacedDigit()
                            .lineLimit(1)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                // Clear of the remove button over the top-right corner (24pt from
                // the card's edge; the card's own 8pt is already inside it).
                .padding(.trailing, file == nil ? 0 : 18)
            }
            .padding(.horizontal, 8)
            .padding(.vertical, dynamicTypeSize.isAccessibilitySize ? 10 : 0)
            .frame(width: dynamicTypeSize.isAccessibilitySize ? Self.accessibilityWidth : Self.width,
                   height: dynamicTypeSize.isAccessibilitySize ? nil : Self.height)
            .frame(minHeight: dynamicTypeSize.isAccessibilitySize ? Self.accessibilityMinHeight : nil)
            .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            // The composer is the same grey in dark mode: the outline keeps the card a card.
            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Color(.separator).opacity(0.6)))
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier(file == nil ? "chat.fileImporting" : "chat.fileCard")
            if file != nil {
                Button(action: onRemove) {
                    Image(systemName: ComposerBar.Symbol.removeImage)
                        .font(.system(size: 18))
                        .symbolRenderingMode(.palette)
                        .foregroundStyle(.white, .black.opacity(0.55))
                        .padding(3)
                }
                .accessibilityLabel("Remove \(file?.name ?? "file")")
                .accessibilityIdentifier("chat.fileRemove")
            }
        }
    }
}

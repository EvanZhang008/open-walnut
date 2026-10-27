import SwiftUI
import UIKit

/// One attached file in the user's own message: a card on the user's side with
/// the file's kind, name, and size, and while it uploads, how far it is. A sent
/// one (named by path in the transcript) opens in the file preview when tapped.
struct TimelineFileChip: Hashable, Sendable {
    let name: String
    /// "Video · 48.2 MB", "Uploading 34% · 48.2 MB", "PDF".
    let detail: String
    let symbol: String
    /// 0...1 while the upload runs; nil once sent (or not started).
    let progress: Double?
    /// The file on the session's host, for the preview. nil while uploading.
    let path: String?

    /// A sent file names itself as sent; one still on this phone as attached.
    var spokenLabel: String { path != nil ? "File you sent: \(name), \(detail)" : "Attached file: \(name), \(detail)" }

    /// The row's height: the card's two lines (and the bar while uploading) plus
    /// its padding. Every line is `lineLimit(1)`, so this is exact arithmetic.
    static func height(uploading: Bool) -> CGFloat {
        let lines = TimelineMetrics.hostedTightLine(TimelineTextStyler.subheadlineFont)
            + lineGap
            + TimelineMetrics.hostedTightLine(TimelineTextStyler.captionFont)
        let body = max(iconSide, lines) + (uploading ? barGap + barHeight : 0)
        return body + cardVPad * 2 + rowVMargin * 2
    }

    static let iconSide: CGFloat = 30
    static let lineGap: CGFloat = 1
    static let barGap: CGFloat = 6
    static let barHeight: CGFloat = 4
    static let cardVPad: CGFloat = 9
    static let cardHPad: CGFloat = 12
    static let rowVMargin: CGFloat = 3
    static let maxWidth: CGFloat = 300

    /// The words for a kind, the way the Files app names them.
    static func kindLabel(_ kind: ComposerFile.Kind) -> String {
        switch kind {
        case .video: return "Video"
        case .image: return "Image"
        case .pdf: return "PDF"
        case .audio: return "Audio"
        case .other: return "File"
        }
    }

    /// An attachment still on this phone (pending, uploading, or not sent).
    static func local(_ file: ComposerFile, held: Int64?, pending: Bool, failed: Bool) -> TimelineFileChip {
        let size = ComposerFile.sizeLabel(file.size)
        let fraction = file.size > 0 ? Double(held ?? 0) / Double(file.size) : (held != nil ? 1 : 0)
        let uploading = pending && !failed
        let detail: String
        if uploading, held != nil, fraction < 1 {
            detail = "Uploading \(Int(fraction * 100))% · \(size)"
        } else if uploading, held == nil {
            detail = "Waiting to upload · \(size)"
        } else if let held, held >= file.size, held > 0 || file.size == 0 {
            // On the host; the message naming it has not gone yet.
            detail = "Uploaded · \(size)"
        } else if failed, let held, held > 0 {
            detail = "\(Int(fraction * 100))% uploaded · \(size)"
        } else if failed {
            detail = "Not uploaded · \(size)"
        } else {
            detail = "\(kindLabel(file.kind)) · \(size)"
        }
        return TimelineFileChip(
            name: file.name, detail: detail, symbol: file.symbol,
            progress: uploading ? min(1, max(0, fraction)) : nil, path: nil
        )
    }

    /// A file the transcript names by its path on the host.
    static func sent(path: String) -> TimelineFileChip {
        let name = (path as NSString).lastPathComponent
        let kind = ComposerFile.kind(for: nil, name: name)
        return TimelineFileChip(name: name, detail: kindLabel(kind), symbol: ComposerFile.symbol(for: kind),
                                progress: nil, path: path)
    }
}

struct TimelineFileChipView: View {
    let chip: TimelineFileChip
    let onOpen: (String) -> Void

    var body: some View {
        HStack(spacing: 0) {
            Spacer(minLength: TimelineMetrics.bubbleLeadingGap)
            // Only a sent file opens. One still on the phone is the plain card, not
            // a disabled button: a disabled button draws its whole label in the
            // disabled grey, and the upload's status read at 1.7:1 (gate r2).
            Group {
                if let path = chip.path {
                    Button { onOpen(path) } label: { card }
                        .buttonStyle(.plain)
                        .accessibilityHint("Opens the file")
                } else {
                    card
                }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(chip.spokenLabel)
            .accessibilityIdentifier("chat.fileAttachment")
        }
        .padding(.horizontal, TimelineMetrics.hMargin)
        .padding(.vertical, TimelineFileChip.rowVMargin)
        .frame(maxWidth: .infinity, alignment: .trailing)
    }

    private var card: some View {
        VStack(alignment: .leading, spacing: TimelineFileChip.barGap) {
            HStack(spacing: 10) {
                Image(systemName: chip.symbol)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(Theme.tint)
                    .frame(width: TimelineFileChip.iconSide, height: TimelineFileChip.iconSide)
                    .background(Theme.tintSoft, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                VStack(alignment: .leading, spacing: TimelineFileChip.lineGap) {
                    Text(chip.name)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Text(chip.detail)
                        .font(.caption)
                        .foregroundStyle(Theme.secondaryOnCard)
                        .lineLimit(1)
                        .monospacedDigit()
                }
            }
            if let progress = chip.progress {
                ProgressView(value: progress)
                    .progressViewStyle(.linear)
                    .tint(Theme.tint)
                    .frame(height: TimelineFileChip.barHeight)
            }
        }
        .padding(.horizontal, TimelineFileChip.cardHPad)
        .padding(.vertical, TimelineFileChip.cardVPad)
        .frame(maxWidth: TimelineFileChip.maxWidth, alignment: .leading)
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Color(.separator).opacity(0.4)))
        .contentShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
    }
}

// MARK: - The sent text

extension MessageRow {
    /// A sent message's attachment headers, read back: the server's
    /// "[Images attached …]" and the phone's "[Files attached …]"
    /// (`ComposerFile.headerLine`), in either order, each with its `- /path`
    /// lines, then the person's words. nil when the text carries neither.
    static func attachmentSendParts(_ text: String) -> (imagePaths: [String], filePaths: [String], text: String)? {
        var rest = text
        var images: [String] = []
        var files: [String] = []
        for _ in 0..<2 {
            if images.isEmpty, let parts = imageSendParts(rest) {
                images = parts.paths
                rest = parts.text
            } else if files.isEmpty, let parts = fileSendParts(rest) {
                files = parts.paths
                rest = parts.text
            } else {
                break
            }
        }
        guard !images.isEmpty || !files.isEmpty else { return nil }
        return (images, files, rest)
    }

    /// The "[Files attached …]" header alone.
    static func fileSendParts(_ text: String) -> (paths: [String], text: String)? {
        guard text.hasPrefix("[Files attached") else { return nil }
        let lines = text.components(separatedBy: "\n")
        guard lines.first?.hasSuffix("]") == true else { return nil }
        var paths: [String] = []
        var bodyStart = lines.count
        for (i, line) in lines.enumerated() where i > 0 {
            if line.hasPrefix("- /") {
                paths.append(String(line.dropFirst(2)))
                continue
            }
            if line.trimmingCharacters(in: .whitespaces).isEmpty { bodyStart = i + 1; break }
            // The transcript's clip ("…") can end inside a path's line marker: the
            // paths before it are the send, the rest was cut.
            if i == lines.count - 1, line.hasSuffix("\u{2026}"), line.count <= 4 { break }
            return nil
        }
        guard !paths.isEmpty else { return nil }
        let body = lines[min(bodyStart, lines.count)...].joined(separator: "\n")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return (paths, body)
    }
}

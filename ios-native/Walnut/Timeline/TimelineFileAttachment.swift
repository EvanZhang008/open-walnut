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
    /// The upload id of a file still on this phone, nil for a sent one.
    var fileID: String? = nil
    /// A file of a send that has not gone and is not on the host yet: its card
    /// offers Retry (the whole send again) and Remove (this file alone).
    var offersActions = false
    /// A sent file the server could not copy to the session's host: why. Its
    /// card is drawn failed, and the agent read the same reason.
    var copyFailure: String? = nil
    /// A file still on this phone whose upload ended the last attempt: drawn failed too.
    var uploadFailed = false

    /// Drawn as failed: red icon, border and words.
    var isFailed: Bool { copyFailure != nil || uploadFailed }

    /// A sent file names itself as sent; one still on this phone as attached.
    var spokenLabel: String { spoken(detail: detail) }

    func spoken(detail shown: String) -> String {
        if copyFailure != nil { return "File you sent, not on the session's host: \(name), \(shown)" }
        return path != nil ? "File you sent: \(name), \(shown)" : "Attached file: \(name), \(shown)"
    }

    /// The detail line a sent file's card shows once its size is known: the
    /// kind and the size. A failed copy's reason, and an unknown size, stay as they are.
    func shownDetail(size: Int64?) -> String {
        guard path != nil, copyFailure == nil, let size else { return detail }
        return "\(detail) · \(ComposerFile.sizeLabel(size))"
    }

    /// The row's height in a timeline `rowWidth` wide: the name (up to
    /// `nameLines`) and the detail line (up to `detailLines`, so a failure's whole
    /// reason shows), the bar while uploading, and the padding. The lines are
    /// measured at the current text size, a little narrower than drawn, so the
    /// card never clips: a long name and a long reason wrap instead of being cut.
    func height(rowWidth: CGFloat) -> CGFloat {
        let nameFont = Self.nameFont
        let detailFont = TimelineTextStyler.captionFont
        let column = Self.textWidth(rowWidth: rowWidth, actions: offersActions && !Self.stacksActions)
        // A sent file's size joins its detail later (`shownDetail`): room for it now.
        let widest = path != nil && copyFailure == nil ? detail + " · 999.9 MB" : detail
        let lines = TimelineMetrics.hostedTextHeight(lines: Self.lines(name, font: nameFont, width: column, max: Self.nameLimit), font: nameFont)
            + Self.lineGap
            + TimelineMetrics.hostedTextHeight(lines: Self.lines(widest, font: detailFont, width: column, max: detailLimit), font: detailFont)
        let body = max(Self.iconSide, lines) + (progress != nil ? Self.barGap + Self.barHeight : 0)
            + (offersActions && Self.stacksActions ? Self.barGap + Self.actionSide : 0)
        return body + Self.cardVPad * 2 + Self.rowVMargin * 2
    }

    static let nameLines = 3
    /// At the accessibility sizes a name may take what it needs: it is the one
    /// thing that says which file the card is (gate r8: "build / - / a…ip").
    static var nameLimit: Int { stacksActions ? 8 : nameLines }
    /// At the accessibility sizes Retry and Remove go on a row of their own under
    /// the words instead of taking 80 pt beside them.
    static var stacksActions: Bool { TimelineTextStyler.subheadlineFont.pointSize >= 24 }
    static let detailLines = 5
    /// A failure's reason is never cut (gate r7: at the largest text size it took 7 lines).
    static let reasonLines = 14
    var detailLimit: Int { isFailed ? Self.reasonLines : Self.detailLines }

    /// The name's font: the subheadline, medium, at the current text size.
    static var nameFont: UIFont {
        let base = TimelineTextStyler.subheadlineFont
        return UIFont.systemFont(ofSize: base.pointSize, weight: .medium)
    }

    /// Width the name and detail wrap at: the card at its widest, less its
    /// padding, the icon, the gap after it, and the room Retry and Remove take.
    static func textWidth(rowWidth: CGFloat, actions: Bool) -> CGFloat {
        let card = min(maxWidth, rowWidth - TimelineMetrics.hMargin * 2 - TimelineMetrics.bubbleLeadingGap)
        let reserved = cardHPad * 2 + iconSide + iconGap + (actions ? actionsWidth : 0)
        // 4 pt narrower than drawn: a word that just fits there wraps here, never the other way.
        return max(40, card - reserved - 4)
    }

    static func lines(_ text: String, font: UIFont, width: CGFloat, max limit: Int) -> Int {
        let measured = (text as NSString).boundingRect(
            with: CGSize(width: width, height: .greatestFiniteMagnitude),
            options: [.usesLineFragmentOrigin, .usesFontLeading],
            attributes: [.font: font], context: nil).height
        // TextKit stacks each line at lineHeight plus the font's leading when it is positive.
        let perLine = max(1, font.lineHeight + max(0, font.leading))
        let count = Int((measured / perLine).rounded())
        return min(limit, Swift.max(1, count))
    }

    /// The icon's tile grows with the text size, up to a point.
    static var iconSide: CGFloat {
        min(56, max(30, (TimelineTextStyler.subheadlineFont.lineHeight * 1.6).rounded()))
    }
    static let iconGap: CGFloat = 10
    /// Retry and Remove: each a 44 pt tap area, drawn over the card's end.
    static let actionSide: CGFloat = 44
    static var actionsWidth: CGFloat { actionSide * 2 - 8 }
    static let lineGap: CGFloat = 1
    static let barGap: CGFloat = 6
    static let barHeight: CGFloat = 4
    static let cardVPad: CGFloat = 9
    static let cardHPad: CGFloat = 12
    static let rowVMargin: CGFloat = 3
    static let maxWidth: CGFloat = 300

    /// The words for a kind, the way the Files app names them. Any other file
    /// is named by its extension ("LOG", "ZIP"), else "File".
    static func kindLabel(_ kind: ComposerFile.Kind, name: String = "") -> String {
        switch kind {
        case .video: return "Video"
        case .image: return "Image"
        case .pdf: return "PDF"
        case .audio: return "Audio"
        case .other:
            let ext = (name as NSString).pathExtension
            let plain = !ext.isEmpty && ext.count <= 5 && ext.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber) }
            return plain ? ext.uppercased() : "File"
        }
    }

    /// An attachment still on this phone (pending, uploading, or not sent).
    /// `failedHere`: this file's upload is the one that ended the last attempt.
    static func local(_ file: ComposerFile, held: Int64?, pending: Bool, failed: Bool,
                      failedHere: Bool = false) -> TimelineFileChip {
        let size = ComposerFile.sizeLabel(file.size)
        let fraction = file.size > 0 ? Double(held ?? 0) / Double(file.size) : (held != nil ? 1 : 0)
        let uploading = pending && !failed
        let onHost = held.map { $0 >= file.size && ($0 > 0 || file.size == 0) } ?? false
        let detail: String
        if uploading, held != nil, fraction < 1 {
            detail = "Uploading \(Int(fraction * 100))% · \(size)"
        } else if uploading, held == nil {
            detail = "Waiting to upload · \(size)"
        } else if onHost {
            // On the host; the message naming it has not gone yet.
            detail = "Uploaded · \(size)"
        } else if failed, failedHere, let held, held > 0 {
            detail = "Upload failed at \(Int(fraction * 100))% · \(size)"
        } else if failed, failedHere {
            detail = "Upload failed · \(size)"
        } else if failed, let held, held > 0 {
            detail = "\(Int(fraction * 100))% uploaded · \(size)"
        } else if failed {
            detail = "Not uploaded · \(size)"
        } else {
            detail = "\(kindLabel(file.kind, name: file.name)) · \(size)"
        }
        return TimelineFileChip(
            name: file.name, detail: detail, symbol: file.symbol,
            progress: uploading ? min(1, max(0, fraction)) : nil, path: nil,
            fileID: file.id, offersActions: failed && !onHost,
            uploadFailed: failed && failedHere && !onHost
        )
    }

    /// A file the transcript names by its path on the host. `copyFailure`: the
    /// server could not copy it there, and why.
    static func sent(path: String, copyFailure: String? = nil) -> TimelineFileChip {
        let name = (path as NSString).lastPathComponent
        let kind = ComposerFile.kind(for: nil, name: name)
        let detail = copyFailure.map { "Not copied to the host: \($0)" } ?? kindLabel(kind, name: name)
        return TimelineFileChip(name: name, detail: detail,
                                symbol: copyFailure != nil ? failedSymbol : ComposerFile.symbol(for: kind),
                                progress: nil, path: path, copyFailure: copyFailure)
    }

    static let failedSymbol = "exclamationmark.triangle"
}

struct TimelineFileChipView: View {
    let chip: TimelineFileChip
    let onOpen: (String) -> Void
    /// Send the message again (every file it still has).
    var onRetry: () -> Void = {}
    /// Drop this file from the send that has not gone.
    var onRemove: (String) -> Void = { _ in }
    /// The detail line as drawn: a sent file's size joins its kind once known
    /// (`SentFileSizes`: the timeline asks for sizes, this card only reads them).
    private var detail: String { chip.shownDetail(size: chip.path.flatMap { SentFileSizes.shared.size(of: $0) }) }
    private var failed: Bool { chip.isFailed }

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
            .accessibilityLabel(chip.spoken(detail: detail))
            .accessibilityIdentifier("chat.fileAttachment")
            // On top of the card, after its accessibility element: the two buttons
            // stay buttons of their own for VoiceOver and automation. They are no
            // taller than the card's lines, so the row's height does not change.
            .overlay(alignment: TimelineFileChip.stacksActions ? .bottomLeading : .trailing) {
                if chip.offersActions, let fileID = chip.fileID {
                    HStack(spacing: 0) {
                        chipButton(Self.retrySymbol, label: "Retry sending", id: "chat.fileRetry", action: onRetry)
                        chipButton(Self.removeSymbol, label: "Remove \(chip.name)", id: "chat.fileRemove") {
                            onRemove(fileID)
                        }
                    }
                    .padding(.trailing, 2)
                    .padding(.leading, TimelineFileChip.stacksActions ? TimelineFileChip.cardHPad - 10 : 0)
                    .padding(.bottom, TimelineFileChip.stacksActions ? TimelineFileChip.cardVPad : 0)
                }
            }
        }
        .padding(.horizontal, TimelineMetrics.hMargin)
        .padding(.vertical, TimelineFileChip.rowVMargin)
        .frame(maxWidth: .infinity, alignment: .trailing)
    }

    static let retrySymbol = "arrow.clockwise"
    static let removeSymbol = "xmark"
    /// The buttons' tap area: 44 pt, within the card's height at every text size.
    static let buttonSide: CGFloat = TimelineFileChip.actionSide

    private func chipButton(_ symbol: String, label: String, id: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(Theme.tint)
                .frame(width: Self.buttonSide, height: Self.buttonSide)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        .accessibilityIdentifier(id)
    }

    private var card: some View {
        VStack(alignment: .leading, spacing: TimelineFileChip.barGap) {
            HStack(spacing: TimelineFileChip.iconGap) {
                Image(systemName: chip.symbol)
                    .font(.system(size: TimelineFileChip.iconSide / 2, weight: .semibold))
                    .foregroundStyle(failed ? Theme.danger : Theme.tint)
                    .frame(width: TimelineFileChip.iconSide, height: TimelineFileChip.iconSide)
                    .background(failed ? Theme.danger.opacity(0.12) : Theme.tintSoft,
                                in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                VStack(alignment: .leading, spacing: TimelineFileChip.lineGap) {
                    // Wrapped, never cut to one line: at the large text sizes a one-line
                    // name read "depl…6.log" and a failure lost its reason (gate r6).
                    // The row's height measures the same limits (`height(rowWidth:)`).
                    Text(chip.name)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(.primary)
                        .lineLimit(TimelineFileChip.nameLimit)
                        .truncationMode(.middle)
                        .fixedSize(horizontal: false, vertical: true)
                    Text(detail)
                        .font(.caption)
                        // The darker red for words: the plain one read 3.2:1 on the light card.
                        .foregroundStyle(failed ? Theme.dangerText : Theme.secondaryOnCard)
                        .lineLimit(chip.detailLimit)
                        .fixedSize(horizontal: false, vertical: true)
                        .monospacedDigit()
                }
                // Room for Retry and Remove, drawn over this end of the card.
                if chip.offersActions && !TimelineFileChip.stacksActions {
                    Spacer(minLength: 0)
                    Color.clear.frame(width: TimelineFileChip.actionsWidth, height: 1)
                }
            }
            if let progress = chip.progress {
                ProgressView(value: progress)
                    .progressViewStyle(.linear)
                    .tint(Theme.tint)
                    .frame(height: TimelineFileChip.barHeight)
            }
            // Room for Retry and Remove on their own row (accessibility sizes).
            if chip.offersActions && TimelineFileChip.stacksActions {
                Color.clear.frame(height: TimelineFileChip.actionSide)
            }
        }
        .padding(.horizontal, TimelineFileChip.cardHPad)
        .padding(.vertical, TimelineFileChip.cardVPad)
        .frame(maxWidth: TimelineFileChip.maxWidth, alignment: .leading)
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous)
            .strokeBorder(failed ? Theme.danger.opacity(0.5) : Color(.separator).opacity(0.4)))
        .contentShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
    }
}

// MARK: - The sent text

extension MessageRow {
    /// A sent message's attachment headers, read back: the server's
    /// "[Images attached …]" and the phone's "[Files attached …]"
    /// (`ComposerFile.headerLine`), in either order, each with its `- /path`
    /// lines, then the person's words. nil when the text carries neither.
    /// `copyFailures`: why each file path the server noted could not be copied
    /// to the session's host (`ComposerFile.copyFailedNote`), the path itself
    /// without the note.
    nonisolated static func attachmentSendParts(_ text: String)
        -> (imagePaths: [String], filePaths: [String], text: String, copyFailures: [String: String])? {
        var rest = text
        var images: [String] = []
        var files: [String] = []
        var failures: [String: String] = [:]
        for _ in 0..<2 {
            if images.isEmpty, let parts = imageSendParts(rest) {
                images = parts.paths
                rest = parts.text
            } else if files.isEmpty, let parts = fileSendParts(rest) {
                files = parts.paths
                failures = parts.copyFailures
                rest = parts.text
            } else {
                break
            }
        }
        guard !images.isEmpty || !files.isEmpty else { return nil }
        return (images, files, rest, failures)
    }

    /// The "[Files attached …]" header alone. Each path comes without the note
    /// the server adds to one it could not copy to the host; the notes are in
    /// `copyFailures`, by path.
    nonisolated static func fileSendParts(_ text: String) -> (paths: [String], text: String, copyFailures: [String: String])? {
        guard text.hasPrefix("[Files attached") else { return nil }
        let lines = text.components(separatedBy: "\n")
        guard lines.first?.hasSuffix("]") == true else { return nil }
        var paths: [String] = []
        var failures: [String: String] = [:]
        var bodyStart = lines.count
        for (i, line) in lines.enumerated() where i > 0 {
            if line.hasPrefix("- /") {
                let sent = ComposerFile.sentLine(String(line.dropFirst(2)))
                paths.append(sent.path)
                if let why = sent.copyFailure { failures[sent.path] = why }
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
        return (paths, body, failures)
    }
}

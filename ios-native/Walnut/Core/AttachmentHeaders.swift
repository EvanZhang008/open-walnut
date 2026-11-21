import Foundation

/// The attachment headers Walnut writes in front of a person's words, the phone's
/// copy of the server's `src/lib/attachment-headers.ts` (keep the two in step,
/// byte for byte; the dash is U+2014, written as an escape):
///
///     [Images attached — use the Read tool to view them]
///     - /path/a.jpg
///
///     [Files attached — open them from these paths]
///     - /path/camera-1416.mov
///
///     [Video stills — frames of camera-1416.mov (0:42), time in each name; use the Read tool to view them]
///     - /path/camera-1416-still-0m00s.jpg
///
///     [Video narration — what was said in camera-1416.mov]
///     - so the request goes into the queue here
///
///     what the person typed
///
/// A video recorded with the composer's camera carries its stills (Claude reads
/// pictures, not video) and what was said in it, after the files block that names
/// the video itself. Every phone producer builds the blocks here
/// (`ComposerFile.messageText`), and every phone reader takes them back off with
/// `AttachmentHeaders.split`, which hides them as it hides the others.
enum AttachmentHeaders {
    /// `IMAGES_ATTACHED_LINE`.
    static let imagesLine = "[Images attached \u{2014} use the Read tool to view them]"
    /// `FILES_ATTACHED_LINE`.
    static let filesLine = "[Files attached \u{2014} open them from these paths]"
    /// `VIDEO_STILLS_PREFIX` / `VIDEO_NARRATION_PREFIX`: the rest of each line names the video.
    static let videoStillsPrefix = "[Video stills \u{2014} "
    static let videoNarrationPrefix = "[Video narration \u{2014} "

    enum Kind { case images, files }

    /// One recorded video's two blocks (`VideoClipHeader`).
    struct VideoClip: Equatable, Sendable {
        /// The video's file name as it was saved (its path is in the files block).
        let name: String
        let durationMs: Int
        /// The stills' saved paths, in time order.
        let stills: [String]
        /// What was said in it ("" or nil: nothing).
        var narration: String? = nil
    }

    /// One header block: the line, one `- <path>` line per path, a blank line. "" for no paths.
    static func block(_ kind: Kind, paths: [String]) -> String {
        guard !paths.isEmpty else { return "" }
        let line = kind == .images ? imagesLine : filesLine
        return line + "\n" + paths.map { "- \($0)" }.joined(separator: "\n") + "\n\n"
    }

    /// "0:42", "1:05" (`clipClock`): whole seconds, rounded half up as JavaScript's `Math.round`.
    static func clipClock(ms: Int) -> String {
        let total = max(0, Int((Double(ms) / 1000).rounded(.toNearestOrAwayFromZero)))
        return "\(total / 60):" + String(format: "%02d", total % 60)
    }

    /// A header line names the video in a bracket: one safe line, at most 120
    /// UTF-16 units (JavaScript's `slice(0, 120)`).
    static func headerSafe(_ name: String) -> String {
        let flat = name.replacingOccurrences(of: "[\\]\\n\\r]", with: " ", options: .regularExpression)
        let units = flat as NSString
        return units.length > 120 ? units.substring(to: 120) : flat
    }

    /// The narration as one line: every run of white space one space (JavaScript's `\s`, BOM included).
    static func oneLine(_ text: String) -> String {
        text.replacingOccurrences(of: "[\\s\\uFEFF]+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespaces)
    }

    /// The stills block and the narration block of one video (`videoClipBlocks`),
    /// "" for a video with neither.
    static func videoClipBlocks(_ clip: VideoClip) -> String {
        let name = headerSafe(clip.name)
        var out = ""
        let stills = clip.stills.filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        if !stills.isEmpty {
            out += "\(videoStillsPrefix)frames of \(name) (\(clipClock(ms: clip.durationMs))), time in each name; use the Read tool to view them]\n"
            out += stills.map { "- \($0)" }.joined(separator: "\n") + "\n\n"
        }
        let said = oneLine(clip.narration ?? "")
        if !said.isEmpty { out += "\(videoNarrationPrefix)what was said in \(name)]\n- \(said)\n\n" }
        return out
    }

    // MARK: - Reading the blocks back

    /// What one video block says about its video: its name, and (stills) its clock.
    struct VideoBlock: Equatable, Sendable {
        enum Kind: Equatable, Sendable { case stills, narration }
        let kind: Kind
        /// The video it belongs to; nil for a line in another wording.
        let video: String?
        let clock: String?
        /// The stills' paths, or the narration's one line.
        let lines: [String]
    }

    /// `HEADER_LINE_RE`: the current wording or an older one; the kind is the second word.
    private static let headerLine = try! NSRegularExpression(pattern: "^\\[(Images|Files) attached\\b[^\\]\\n]*\\]$")
    /// `CONTEXT_LINE_RE`: the older picture form, its count saying how many bare path lines follow.
    private static let contextLine = try! NSRegularExpression(
        pattern: "^The user attached (an image|(\\d{1,2}) images)\\. Read (?:this file|these files) for visual context:$")
    /// `VIDEO_LINE_RE`.
    private static let videoLine = try! NSRegularExpression(pattern: "^\\[Video (stills|narration) \u{2014} [^\\]\\n]*\\]$")
    /// `STILLS_NAME_RE`: the video's name and clock; the rest of the line is free.
    private static let stillsLine = try! NSRegularExpression(
        pattern: "^\\[Video stills \u{2014} frames of (.+) \\((\\d+:\\d\\d)\\), time in each name\\b")
    private static let narrationLine = try! NSRegularExpression(pattern: "^\\[Video narration \u{2014} what was said in (.+)\\]$")

    private static func groups(_ re: NSRegularExpression, _ line: String) -> [String]? {
        let range = NSRange(line.startIndex..., in: line)
        guard let match = re.firstMatch(in: line, range: range) else { return nil }
        return (1..<match.numberOfRanges).map { i in
            Range(match.range(at: i), in: line).map { String(line[$0]) } ?? ""
        }
    }

    /// Take the attachment blocks off the front of a sent message
    /// (`splitAttachmentHeaders`): any number of pictures, files and recorded
    /// videos' stills and narration blocks, in any order, each with its lines,
    /// then the person's words (trimmed, as every phone reader always took them).
    /// Only blocks at the very start count, with their lines: a person who types
    /// the header words mid-message keeps them. nil when the text starts with none.
    /// A CRLF message reads the same (`readAttachmentBlocks`: the CR is not part of
    /// a header line or a `- ` line's value).
    static func split(_ text: String) -> AttachmentSendParts? {
        guard text.hasPrefix("[") || text.hasPrefix("The user attached ") else { return nil }
        // Split by scalar: "\r\n" is one Character, which a Character split never cuts.
        let lines = text.unicodeScalars.split(separator: "\n", omittingEmptySubsequences: false)
            .map { String(String.UnicodeScalarView($0)) }
        let read = lines.map { $0.unicodeScalars.last == "\r" ? String(String.UnicodeScalarView($0.unicodeScalars.dropLast())) : $0 }
        var parts = AttachmentSendParts(text: text)
        var i = 0
        var n = 0
        // Pictures, files, and two blocks per recorded video (a message holds up to ten files).
        while n < 24, i < lines.count, let block = blockAt(read, raw: lines, i) {
            switch block.read {
            case .images(let paths):
                parts.imagePaths += paths
            case .files(let paths):
                parts.filePaths += parts.takeCopyFailures(paths)
            case .video(let video) where video.kind == .stills:
                // A still the server could not copy carries the same note as a file.
                let stills = parts.takeCopyFailures(video.lines)
                parts.videoBlocks.append(VideoBlock(kind: .stills, video: video.video, clock: video.clock, lines: stills))
            case .video(let video):
                // A narration is words, never a path: no note to take off.
                parts.videoBlocks.append(video)
            }
            i = block.next
            // One blank line ends the block.
            if i < lines.count, read[i].isEmpty { i += 1 }
            n += 1
        }
        guard n > 0 else { return nil }
        parts.text = i < lines.count
            ? lines[i...].joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines) : ""
        return parts
    }

    private enum Read {
        case images([String]), files([String]), video(VideoBlock)
    }

    /// One block at line `i` (`blockAt`) and the line after it, or nil. `lines`
    /// have their CR taken off; the older picture form's paths are read `raw`, as
    /// the server reads them.
    private static func blockAt(_ lines: [String], raw: [String], _ i: Int) -> (read: Read, next: Int)? {
        let head = lines[i]
        if let video = groups(videoLine, head) {
            let kind: VideoBlock.Kind = video[0] == "stills" ? .stills : .narration
            // Stills take every `- ` line; a narration exactly one.
            let (body, next) = dashLines(lines, from: i + 1, limit: kind == .stills ? Int.max : 1)
            guard !body.isEmpty else { return nil }
            let named = kind == .stills ? groups(stillsLine, head) : groups(narrationLine, head)
            let block = VideoBlock(kind: kind, video: named?.first, clock: kind == .stills ? named?.last : nil, lines: body)
            return (.video(block), next)
        }
        if let header = groups(headerLine, head) {
            let (body, next) = dashLines(lines, from: i + 1, limit: Int.max)
            // A header with no path line is not one Walnut wrote.
            guard !body.isEmpty else { return nil }
            return (header[0] == "Images" ? .images(body) : .files(body), next)
        }
        if let context = groups(contextLine, head) {
            let count = context[1].isEmpty ? 1 : Int(context[1]) ?? 0
            guard count >= 1, i + count < lines.count else { return nil }
            let paths = Array(raw[(i + 1)...(i + count)])
            guard paths.allSatisfy({ !$0.isEmpty && $0 == $0.trimmingCharacters(in: .whitespacesAndNewlines) }) else { return nil }
            return (.images(paths), i + 1 + count)
        }
        return nil
    }

    /// The `- ` lines from `start` (at most `limit`) and the line after them. The
    /// transcript's clip ("…") can end inside a path list: a last line cut to a few
    /// characters ends the text, and the lines before it are the send.
    private static func dashLines(_ lines: [String], from start: Int, limit: Int) -> (lines: [String], next: Int) {
        var body: [String] = []
        var j = start
        while j < lines.count, body.count < limit {
            let line = lines[j]
            if j == lines.count - 1, line.hasSuffix("\u{2026}"), line.count <= 4 { return (body, lines.count) }
            guard line.hasPrefix("- "), line.count > 2 else { break }
            body.append(String(line.dropFirst(2)).trimmingCharacters(in: .whitespaces))
            j += 1
        }
        return (body, j)
    }

    /// The small line a recorded video's card shows: "8 stills · narration",
    /// "1 still", "narration". nil for a video with neither.
    static func clipCaption(stills: Int, narration: Bool, narrationNote: String? = nil) -> String? {
        var parts: [String] = []
        if stills > 0 { parts.append(stills == 1 ? "1 still" : "\(stills) stills") }
        if narration { parts.append("narration") } else if let narrationNote { parts.append(narrationNote) }
        return parts.isEmpty ? nil : parts.joined(separator: " \u{00B7} ")
    }
}

/// A sent message's attachment blocks, read back (`AttachmentHeaders.split`):
/// the pictures' paths, the files' paths, each recorded video's stills and
/// narration blocks, then the person's words.
struct AttachmentSendParts: Equatable, Sendable {
    var imagePaths: [String] = []
    var filePaths: [String] = []
    /// The person's words after the blocks.
    var text: String
    /// Why each file path the server noted could not be copied to the session's
    /// host (`ComposerFile.copyFailedNote`), by the path without the note.
    var copyFailures: [String: String] = [:]
    /// Each recorded video's stills and narration blocks, in order.
    var videoBlocks: [AttachmentHeaders.VideoBlock] = []

    /// Every recorded video's stills' paths.
    var stills: [String] { videoBlocks.filter { $0.kind == .stills }.flatMap(\.lines) }
    /// What was said in each recorded video, one line each.
    var narration: [String] { videoBlocks.filter { $0.kind == .narration }.flatMap(\.lines) }

    /// The caption a sent file's card shows when it is a recorded video
    /// ("8 stills · narration"), found by the file's name. A still that never
    /// reached the host is not counted as one, and the caption says so.
    func clipCaption(forPath path: String) -> String? {
        let name = (path as NSString).lastPathComponent
        let mine = videoBlocks.filter { $0.video == name || $0.video == AttachmentHeaders.headerSafe(name) }
        guard !mine.isEmpty else { return nil }
        let stills = mine.filter { $0.kind == .stills }.flatMap(\.lines)
        let missing = stills.filter { copyFailures[$0] != nil }.count
        let caption = AttachmentHeaders.clipCaption(stills: stills.count - missing, narration: mine.contains { $0.kind == .narration })
        guard missing > 0 else { return caption }
        let note = missing == 1 ? "1 still not copied to the host" : "\(missing) stills not copied to the host"
        return [caption, note].compactMap { $0 }.joined(separator: " \u{00B7} ")
    }

    /// The paths of `lines` without the note the server adds to one it could not
    /// copy to the session's host (`ComposerFile.sentLine`); each note goes to `copyFailures`.
    fileprivate mutating func takeCopyFailures(_ lines: [String]) -> [String] {
        lines.map { line in
            let sent = ComposerFile.sentLine(line)
            if let why = sent.copyFailure { copyFailures[sent.path] = why }
            return sent.path
        }
    }
}

import Foundation

/// The shapes of the user's longest real texts, neutralized, for every page that should only
/// scroll up and down (2026-11-20: "pages that scroll up and down, why can they be dragged
/// sideways too"). One place for both test targets: `VerticalPagesWidthTests` lays the real
/// pages out with them, `VerticalPagesSidewaysDragUITests` serves them from its fixture server
/// (this file is in both targets' sources, `project.yml`).
///
/// What made his pages wide is text with nowhere to break: an absolute path glued to a full-width
/// semicolon and Chinese, commit URLs joined by an ideographic comma, a task chip inside a Chinese
/// sentence, a table cell holding a path, a code line, a long unbroken path. The Chinese is test
/// data in `\u{...}` escapes; nobody's name is in it.
enum WideText {
    static let taskId = "b4d1e1bc-bbdd-5ab4-a4b2-2e28c467cc1e"
    static let path = "/Users/someone/.local/state/open-walnut/tasks/\(taskId)/videos/top-thread.mp4"

    /// "the video is here", "commit log", "already handed to", "handle it, tell me once fixed",
    /// "the home page's thread video", "all three are live".
    static let cjkVideoHere = "\u{89C6}\u{9891}\u{5728}\u{8FD9}\u{91CC}"
    static let cjkCommits = "\u{63D0}\u{4EA4}\u{8BB0}\u{5F55}"
    static let cjkHandedTo = "\u{5DF2}\u{7ECF}\u{4EA4}\u{7ED9}"
    static let cjkTellMe = "\u{5904}\u{7406}\u{FF0C}\u{4FEE}\u{597D}\u{4EE5}\u{540E}\u{544A}\u{8BC9}\u{6211}"
    static let cjkThreadVideo = "\u{9996}\u{9875}\u{7684}\u{7EBF}\u{7A0B}\u{89C6}\u{9891}"
    static let cjkAllLive = "\u{8FD9}\u{4E09}\u{4E2A}\u{90FD}\u{5DF2}\u{4E0A}\u{7EBF}"
    /// "I have said it many times: a page that scrolls up and down should not move sideways."
    static let cjkComplaint = "\u{6211}\u{5DF2}\u{7ECF}\u{8BF4}\u{4E86}\u{597D}\u{591A}\u{6B21}\u{FF0C}"
        + "\u{8FD9}\u{79CD}\u{4E0A}\u{4E0B}\u{6ED1}\u{52A8}\u{7684}\u{9875}\u{9762}\u{4E0D}\u{5E94}\u{8BE5}\u{5DE6}\u{53F3}\u{6ED1}\u{52A8}"

    /// A path followed directly by a full-width semicolon (U+FF1B) and Chinese: no break between them.
    static let pathThenCJK = path + "\u{FF1B}" + cjkThreadVideo + cjkAllLive + "\u{3002}"

    /// Four commit URLs joined by the ideographic comma (U+3001), one unbroken run.
    static let commitURLs: String = ["3f9a1c2e", "b4d1e1bc", "7e0000a1", "c0ffee42"].map { seed in
        "https://github.com/example/open-walnut/commit/" + String(repeating: seed, count: 5)
    }.joined(separator: "\u{3001}")

    /// A task chip inside a Chinese sentence.
    static let taskRefSentence = cjkHandedTo + "<task-ref id=\"\(taskId)\"/>" + cjkTellMe + "\u{3002}"

    /// A path of 183 characters with no space or break in it.
    static let unbrokenPath: String = String(("/Users/someone/.local/state/open-walnut/tasks/\(taskId)/artifacts/"
        + String(repeating: "deep-folder-name/", count: 9)).prefix(179)) + ".png"

    /// A 300-character code line.
    static let codeLine: String = String(("walnut tools call task_send '{\"in_reply_to\":\"rq-7a39ea3b2791\",\"task\":\"\(taskId)\",\"title\":\""
        + String(repeating: "long-title-", count: 40)).prefix(298)) + "'}"

    static let threadTitle = "Top thread video and the Inbox letter reader: both pages now stay put when dragged sideways, shipped "
        + path + "\u{FF1B}" + cjkAllLive

    static let followUp = "the pages still move left and right bro, " + cjkComplaint + " " + pathThenCJK + " " + commitURLs
        + " " + unbrokenPath

    /// A markdown body holding every shape: a bold run starting a paragraph, the path and the
    /// URLs glued to Chinese, a task chip in a sentence, a table with a path cell, a code line.
    static let markdown = """
    **Shipped and live on the phone:** the Threads page and the letter reader no longer move sideways. \(cjkVideoHere)\u{FF1A}\(pathThenCJK)

    **\(cjkCommits)**\u{FF1A}\(commitURLs)

    \(taskRefSentence)

    - \(unbrokenPath)
    - \(cjkComplaint)\u{FF1B}\(path)

    | Video | Path | Note |
    |---|---|---|
    | top thread | \(path) | \(cjkThreadVideo)\u{FF1B}\(unbrokenPath) |

    ```
    \(codeLine)
    ```
    """

    /// A second paragraph-only body, for rows and previews that show plain text.
    static let plain = "Shipped: " + pathThenCJK + " " + commitURLs + " " + cjkComplaint + " " + unbrokenPath

    /// An ISO date `minutesAgo` before now, as the server writes it.
    static func isoAgo(_ minutesAgo: Double) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.string(from: Date().addingTimeInterval(-minutesAgo * 60))
    }
}

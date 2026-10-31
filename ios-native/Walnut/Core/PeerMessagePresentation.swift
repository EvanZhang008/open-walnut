import Foundation

struct PeerMessageDescription: Equatable {
    let sender: String
    let title: String

    var accessibilityLabel: String { "\(sender): \(title)" }
}

enum PeerMessageSegment: Equatable {
    case text(String)
    case message(PeerMessageDescription)
}

enum PeerMessagePresentation {
    private static let opener = "<walnut-message"
    private static let close = "\n</walnut-message>"
    private static let kinds: Set<String> = ["peer-note", "reply", "notification", "trigger", "app-state"]
    private static let kind = try! NSRegularExpression(pattern: #"^[a-z][a-z0-9-]*$"#)
    private static let attribute = try! NSRegularExpression(pattern: #"([a-z][a-z0-9-]*)="([^"]*)""#)
    private static let handleSuffix = try! NSRegularExpression(pattern: #"\s*\[[a-fA-F0-9]{4,}\]$"#)

    /// What a received row shows when this build cannot read its envelope.
    static let unreadableReceived = PeerMessageDescription(sender: "Walnut", title: "Message received")

    /// `received`: the server said this row is a delivery (`sentBy == "agent"`), so a
    /// kind newer than this build still reads as a description; a person's row only
    /// takes the kinds Walnut writes today, so their own words are never swallowed.
    static func segments(_ rawText: String, received: Bool = false) -> [PeerMessageSegment]? {
        guard rawText.contains(opener) || rawText.contains("<cross-session-message") else { return nil }
        let text = rawText.replacingOccurrences(of: "\r\n", with: "\n")
        var segments: [PeerMessageSegment] = []
        var cursor = text.startIndex
        var plainStart = cursor
        var fence: Character?
        var fenceLength = 0
        var found = false
        while cursor < text.endIndex {
            let lineEnd = text[cursor...].firstIndex(of: "\n") ?? text.endIndex
            let line = String(text[cursor..<lineEnd]).trimmingCharacters(in: .newlines)
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if let marker = trimmed.first, marker == "`" || marker == "~" {
                let length = trimmed.prefix(while: { $0 == marker }).count
                if length >= 3 {
                    if fence == nil { fence = marker; fenceLength = length }
                    else if fence == marker && length >= fenceLength,
                            trimmed.dropFirst(length).trimmingCharacters(in: .whitespaces).isEmpty { fence = nil }
                }
            }
            if fence == nil, line.hasPrefix("<cross-session-message"),
               let next = line.dropFirst("<cross-session-message".count).first, next == " " || next == ">" {
                let nativeAttrs = attributes(String(line.dropFirst("<cross-session-message".count)))
                var start = cursor
                if cursor > plainStart {
                    let before = text[..<cursor].dropLast()
                    let previousStart = before.lastIndex(of: "\n").map { text.index(after: $0) } ?? text.startIndex
                    if text[previousStart..<cursor].hasPrefix("Another Claude session sent a message") { start = max(plainStart, previousStart) }
                }
                appendText(String(text[plainStart..<start]), to: &segments)
                segments.append(.message(PeerMessageDescription(
                    sender: shortLine(nativeAttrs["from-name"] ?? nativeAttrs["from"] ?? "", limit: 60, fallback: "Another session"),
                    title: "Task message"
                )))
                found = true
                // Native bodies are not escaped: the final close belongs to their outer envelope.
                cursor = text.range(of: "\n</cross-session-message>", options: .backwards,
                                    range: lineEnd..<text.endIndex)?.upperBound ?? text.endIndex
                var framingStart = cursor
                while framingStart < text.endIndex, text[framingStart] == "\n" { framingStart = text.index(after: framingStart) }
                if text[framingStart...].hasPrefix("This came from another Claude session") {
                    cursor = text.range(of: "\n\n", range: framingStart..<text.endIndex)?.lowerBound ?? text.endIndex
                }
                plainStart = cursor
                if cursor < text.endIndex, text[cursor] == "\n" { cursor = text.index(after: cursor) }
                continue
            }
            if fence == nil, (cursor == text.startIndex || text[text.index(before: cursor)] == "\n"),
               line.hasPrefix(opener), line.dropFirst(opener.count).first?.isWhitespace == true,
               let parsed = description(header: line, received: received) {
                appendText(String(text[plainStart..<cursor]), to: &segments)
                segments.append(.message(parsed.value))
                found = true
                // The serializer escapes body tag sequences, so only the first closing line owns this envelope.
                if !parsed.complete {
                    cursor = lineEnd < text.endIndex ? text.index(after: lineEnd) : text.endIndex
                    plainStart = cursor
                    continue
                }
                let nextEnvelope = text.range(of: "\n" + opener + " ", range: lineEnd..<text.endIndex)
                let closing = text.range(of: close, range: lineEnd..<text.endIndex)
                if let nextEnvelope, closing == nil || nextEnvelope.lowerBound < closing!.lowerBound {
                    cursor = text.index(after: nextEnvelope.lowerBound)
                    plainStart = cursor
                    continue
                }
                if let closing {
                    cursor = closing.upperBound
                    if text[cursor...].hasPrefix("\r") { cursor = text.index(after: cursor) }
                    if parsed.request, parsed.kind == "peer-note", text[cursor...].hasPrefix("\n") {
                        let trailerStart = text.index(after: cursor)
                        let trailerEnd = text[trailerStart...].firstIndex(of: "\n") ?? text.endIndex
                        if text[trailerStart..<trailerEnd].hasPrefix("Reply when done: walnut tools call ") {
                            cursor = trailerEnd
                        }
                    }
                    plainStart = cursor
                    if cursor < text.endIndex, text[cursor] == "\n" { cursor = text.index(after: cursor) }
                    continue
                }
                // A clipped or still-arriving envelope has no trustworthy body boundary yet.
                cursor = text.endIndex
                plainStart = cursor
                break
            }
            cursor = lineEnd < text.endIndex ? text.index(after: lineEnd) : text.endIndex
        }
        guard found else { return nil }
        appendText(String(text[plainStart...]), to: &segments)
        return segments
    }

    private static func description(header: String, received: Bool) -> (value: PeerMessageDescription, complete: Bool, kind: String, request: Bool)? {
        let complete = header.hasSuffix(">")
        let attrsText = String(header.dropFirst(opener.count).dropLast(complete ? 1 : 0))
        let attrs = attributes(attrsText)
        let remainder = attribute.stringByReplacingMatches(in: attrsText,
            range: NSRange(attrsText.startIndex..., in: attrsText), withTemplate: "")
            .trimmingCharacters(in: .whitespaces)
        if complete && !remainder.isEmpty { return nil }
        guard let kind = attrs["kind"], kinds.contains(kind)
                || (received && self.kind.firstMatch(in: kind, range: NSRange(kind.startIndex..., in: kind)) != nil)
        else { return nil }
        // Walnut's own notices and checks read as "System": the program, not a person or a task
        // (the web's systemSender, src/lib/history-session-envelope.ts). The wire keeps from="Walnut".
        // Only Walnut's own senders are renamed (a trigger's, a notice's), never a task's: a task
        // titled "Walnut: fix board" that replies keeps its title. A task the notice is `about`
        // keeps its own title too.
        let about = kind == "notification" ? attrs["about"] : nil
        let walnutSends = kind == "trigger" || kind == "notification"
        let from = attrs["from"].map { walnutSends && ($0 == "Walnut" || $0.hasPrefix("Walnut:")) ? "System" + String($0.dropFirst("Walnut".count)) : $0 }
        let sender = about ?? from
        let cleanSender = sender.map {
            if kind == "trigger" || kind == "app-state" || (kind == "notification" && attrs["about-session"] == nil) { return $0 }
            return handleSuffix.stringByReplacingMatches(in: $0, range: NSRange($0.startIndex..., in: $0), withTemplate: "")
        } ?? ""
        let fallback: String
        switch kind {
        case "reply": fallback = "Task reply"
        case "notification": fallback = outcomeTitle(attrs["outcome"]) ?? "Task update"
        // A routine's note says why it fired ("the time this task was waiting for has passed"),
        // as the web's fold title does; "scheduled" says nothing more than the sender.
        case "trigger": fallback = attrs["note"].flatMap { $0 == "scheduled" ? nil : $0 } ?? "Routine update"
        case "app-state": fallback = "App update"
        default: fallback = attrs["request"]?.isEmpty == false ? "Task request" : "Task message"
        }
        return (PeerMessageDescription(
            sender: shortLine(cleanSender, limit: 60,
                              fallback: kind == "trigger" ? "Routine" : ["reply", "peer-note"].contains(kind) ? "A task" : "System"),
            title: shortLine(attrs["title"] ?? "", limit: 120, fallback: fallback)
        ), complete, kind, attrs["request"]?.isEmpty == false)
    }

    /// A notice names no title; its outcome says what happened, in plain words.
    private static func outcomeTitle(_ outcome: String?) -> String? {
        guard let outcome, !outcome.isEmpty else { return nil }
        switch outcome {
        case "completed": return "Completed"
        case "error": return "Hit an error"
        case "stopped": return "Stopped"
        case "blocked", "awaiting_human": return "Waiting for an answer"
        case "waiting": return "Waiting"
        case "timeout": return "No reply yet"
        case "moved": return "Task moved"
        case "org-update": return "Team changed"
        case "status": return "Status changed"
        case "task-routing-policy": return "Instructions changed"
        default:
            let words = outcome.replacingOccurrences(of: "_", with: " ").replacingOccurrences(of: "-", with: " ")
            return words.prefix(1).uppercased() + words.dropFirst()
        }
    }

    private static func attributes(_ text: String) -> [String: String] {
        var attrs: [String: String] = [:]
        for match in attribute.matches(in: text, range: NSRange(text.startIndex..., in: text)) {
            guard let keyRange = Range(match.range(at: 1), in: text),
                  let valueRange = Range(match.range(at: 2), in: text) else { continue }
            let key = String(text[keyRange])
            if attrs[key] == nil { attrs[key] = decode(String(text[valueRange])) }
        }
        return attrs
    }

    private static func appendText(_ text: String, to segments: inout [PeerMessageSegment]) {
        let trimmed = text.trimmingCharacters(in: .newlines)
        if !trimmed.isEmpty { segments.append(.text(trimmed)) }
    }

    private static func shortLine(_ text: String, limit: Int, fallback: String) -> String {
        let flat = text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
        guard !flat.isEmpty else { return fallback }
        guard flat.count > limit else { return flat }
        // Cut at the last word boundary when there is one in the second half, so a long
        // title never ends mid-word; text without spaces (CJK) is cut at the limit.
        let head = flat.prefix(limit)
        if let space = head.lastIndex(of: " "), head.distance(from: head.startIndex, to: space) >= limit / 2 {
            return String(head[..<space]) + "…"
        }
        return String(head) + "…"
    }

    private static func decode(_ value: String) -> String {
        value.replacingOccurrences(of: "&quot;", with: "\"")
            .replacingOccurrences(of: "&lt;", with: "<")
            .replacingOccurrences(of: "&gt;", with: ">")
            .replacingOccurrences(of: "&amp;", with: "&")
    }
}

extension ChatMessage {
    /// This row as a delivery, so its envelope is read with the received rules.
    var receivedFromAgent: ChatMessage {
        var copy = self
        copy.sentBy = "agent"
        return copy
    }
}

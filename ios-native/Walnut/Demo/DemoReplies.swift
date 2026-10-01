import Foundation
import UIKit

/// What the demo's agents say back. Canned, but picked by topic so a reviewer
/// who types a real question gets an answer that fits it.
enum DemoReplies {
    struct Chat {
        let thinking: String
        let text: String
    }

    struct Tool {
        let name: String
        let detail: String
        let input: String
        let result: String
    }

    struct Session {
        let thinking: String
        let tool: Tool
        let text: String
    }

    static func chat(for message: String) -> Chat {
        let lower = message.lowercased()
        func has(_ words: String...) -> Bool { words.contains { lower.contains($0) } }
        // A request to remember something comes first, whatever it is about: the
        // demo's own voice sentence ("Remind me to send the counter quotes...")
        // names the kitchen, and used to get the kitchen status report instead.
        if let reminder = reminder(in: message) { return reminder }
        if has("kitchen", "counter", "quote", "contractor") {
            return Chat(
                thinking: "Check the kitchen task, its notes and the calendar.",
                text: """
                Two of the three counter quotes are in:

                - **Stone & Co:** quartz, installed in 3 weeks
                - **Riverside Kitchens:** laminate, installed in 10 days, the lowest price

                The third shop said they would call back by Thursday. The task is due **Friday**, so there is still time. Want me to draft a short follow-up message to them?
                """
            )
        }
        if has("crash", "bug", "pull request", "review") {
            return Chat(
                thinking: "Look at the crash task and its session.",
                text: """
                The shared album crash is fixed and waiting for review in pull request **#318**.

                - Cause: a force unwrap on an album that had not synced yet
                - Fix: the album screen waits for the album, up to 10 seconds
                - All 24 album tests pass

                Once it is approved, it can go into the next TestFlight build.
                """
            )
        }
        if has("trip", "train", "travel", "pack", "coast") {
            return Chat(
                thinking: "Check the Travel project and the trip note.",
                text: """
                For the October trip, two things are open:

                1. **Book train tickets to the coast**, due in 3 days. Morning trains still have seats.
                2. **Make a packing list**, in your backlog. I can start one from last year's list in your notes.

                Should I pin the tickets task to Focus so it stays in view?
                """
            )
        }
        if has("today", "plan", "focus", "priorit", "what should") {
            return Chat(
                thinking: "Read the Focus tier and today's calendar.",
                text: """
                Here is today at a glance:

                1. **Review the crash fix** (pull request #318), blocked out at 2:00 PM
                2. **Pick an onboarding headline**: three options are waiting in your Inbox
                3. **Call the dentist** at 10:30 AM

                Everything else in Focus can wait until tomorrow.
                """
            )
        }
        return Chat(
            thinking: "Answer from the board, notes and recent sessions.",
            text: """
            This is the Walnut demo, so I am answering from sample data. On your own Walnut I can read your tasks, notes and coding sessions to answer questions like this one, start a coding session on your computer, or file a task for later.

            Try asking what to focus on today, or about the kitchen quotes.
            """
        )
    }

    /// The reply to "remind me to ...": it names the task and the day back, so
    /// the reader can see the request was understood, and says honestly that
    /// the demo's chat does not write to the board.
    static func reminder(in message: String) -> Chat? {
        let lower = message.lowercased()
        let leads = ["remind me to ", "remember to ", "don't forget to ", "dont forget to ", "add a task to "]
        let generic = ["remind me", "remember", "don't forget", "add a task", "todo", "to-do"]
        let lead = leads.first { lower.contains($0) }
        // Without a "remind me to", only a request counts: "do you remember
        // the quotes?" is a question about the kitchen, not a reminder.
        guard lead != nil || (!lower.contains("?") && generic.contains { lower.contains($0) }) else { return nil }
        let when = Self.when(in: lower)
        var what = ""
        if let lead, let start = message.range(of: lead, options: .caseInsensitive) {
            what = String(message[start.upperBound...])
            if let cut = Self.whenStart(in: what) { what = String(what[..<cut]) }
            what = what.trimmingCharacters(in: CharacterSet(charactersIn: " .!?,"))
        }
        let task = what.isEmpty ? "it" : "**\(what.prefix(1).uppercased() + what.dropFirst())**"
        let day = when.map { " for **\($0)**" } ?? ""
        let filed = lower.contains("kitchen") || lower.contains("counter") || lower.contains("contractor")
            ? ", filed with the kitchen remodel," : ""
        return Chat(
            thinking: "This is a reminder request.",
            text: """
            Noted. On your own Walnut I would add \(task) as a task\(day)\(filed) and pin it so it shows up in Focus on the day.

            The demo's chat does not change your board, so try it yourself from the **Tasks** tab with the **+** button.
            """
        )
    }

    private static let days = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "tomorrow", "today", "tonight", "next week"]

    /// "Friday morning", "tomorrow", or nil when the message names no day.
    private static func when(in lower: String) -> String? {
        guard let day = days.first(where: { lower.contains($0) }) else { return nil }
        let part = ["morning", "afternoon", "evening"].first { lower.contains($0) }
        let name = day.prefix(1).uppercased() + day.dropFirst()
        let lead = ["tomorrow", "today", "tonight", "next week"].contains(day) ? day : name
        return part.map { "\(lead) \($0)" } ?? lead
    }

    /// Where the day phrase starts in "send the quotes on Friday morning".
    private static func whenStart(in text: String) -> String.Index? {
        days.flatMap { day in [" on \(day)", " by \(day)", " before \(day)", " \(day)"] }
            .compactMap { text.range(of: $0, options: .caseInsensitive)?.lowerBound }
            .min()
    }

    static func session(for message: String, cwd: String) -> Session {
        let lower = message.lowercased()
        let root = cwd.isEmpty ? DemoFixtures.macCodeRoot : cwd
        if lower.contains("test") {
            return Session(
                thinking: "Run the test suite and report what fails.",
                tool: Tool(
                    name: "Bash", detail: "Run the tests",
                    input: "command: swift test\ndescription: Run the tests",
                    result: "Executed 214 tests, with 0 failures (0 unexpected) in 42.6 seconds"
                ),
                text: "All **214 tests** pass. Nothing needs fixing."
            )
        }
        return Session(
            thinking: "Read the project first so the change fits how it is built.",
            tool: Tool(
                name: "Read", detail: "README.md",
                input: "file_path: \(root)/README.md",
                result: "# Project\n\nOpen Package.swift in Xcode and run the main scheme."
            ),
            text: """
            I read through the project to get oriented. This is the Walnut demo, so no real files change here.

            On your own computer I would make the change, run the tests and report back with a summary like the ones earlier in this session.
            """
        )
    }

    static let uptimeRestartOutput = "alert-agent.service restarted\nLoaded 2 rules: site-down, api-down\nTest page sent"

    static let uptimeAllowed = """
    Done. The alert agent restarted and loaded both rules:

    - **site-down:** the website has not answered for 2 minutes
    - **api-down:** the API has not answered for 2 minutes

    I sent a test page to confirm alerts reach your phone.
    """

    static let uptimeDenied = """
    Okay, I left the alert agent as it is. The new rules are saved and will load the next time it restarts.
    """
}

/// A small picture for image routes (`/media`, note attachments), drawn once.
enum DemoImage {
    static let png: Data = {
        let size = CGSize(width: 480, height: 300)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 2
        let image = UIGraphicsImageRenderer(size: size, format: format).image { context in
            let colors = [
                UIColor(red: 0.93, green: 0.89, blue: 0.82, alpha: 1).cgColor,
                UIColor(red: 0.78, green: 0.86, blue: 0.84, alpha: 1).cgColor,
            ] as CFArray
            if let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors, locations: [0, 1]) {
                context.cgContext.drawLinearGradient(
                    gradient, start: .zero, end: CGPoint(x: size.width, y: size.height), options: []
                )
            }
        }
        return image.pngData() ?? Data()
    }()
}

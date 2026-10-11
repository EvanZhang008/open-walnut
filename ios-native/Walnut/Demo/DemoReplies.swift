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

    /// `clock` is the demo's: the plan names the same times as the calendar.
    /// `images`: how many photos came with the message.
    static func chat(for message: String, images: Int = 0, clock: DemoClock = DemoClock()) -> Chat {
        let lower = message.lowercased()
        func has(_ words: String...) -> Bool { words.contains { lower.contains($0) } }
        // A photo with no words (the real server takes it as a turn of its own).
        if images > 0, message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return photoReply
        }
        // A request to remember something comes first, whatever it is about: the
        // demo's own voice sentence ("Remind me to send the counter quotes...")
        // names the kitchen, and used to get the kitchen status report instead.
        if let reminder = reminder(in: message) { return reminder }
        if has("kitchen", "counter", "quote", "contractor") {
            return Chat(
                thinking: "Check the kitchen task, its notes and the calendar.",
                text: """
                Two of the three counter quotes are in:

                - **Counter Works:** quartz for 2,950, installed in 4 weeks
                - **Oak Lane:** butcher block for 1,800, installed in 2 weeks, the lowest price

                Stone & Co said they would call back by \(clock.weekdayName(DemoClock.quotesCallbackInDays)). The task is due **\(clock.weekdayName(DemoClock.quotesDueInDays))**, so there is still time. Want me to draft a short follow-up message to them?
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
                For the coast trip, two things are open:

                1. **Book train tickets to the coast**, due in \(DemoClock.trainDueInDays) days. Morning trains still have seats.
                2. **Make a packing list**, in your backlog. I can start one from the packing line in your trip note.

                Should I pin the tickets task to Focus so it stays in view?
                """
            )
        }
        // A question about the calendar is answered from the calendar, for the day
        // it names, not with the plan.
        if has("calendar", "schedule", "agenda", "appointment", "meeting") {
            return calendar(lower, clock: clock)
        }
        if has("today", "tomorrow", "plan", "focus", "priorit", "what should") {
            // The same plan as the sample conversation's: late in the day it is
            // tomorrow's, and the reply says so.
            let plan = clock.plan()
            // Asked about tomorrow while the plan is for today: answer for tomorrow.
            if plan.day == 0, askedDay(lower, clock: clock) == 1 {
                return tomorrowFocus(clock: clock)
            }
            let day = clock.dayWord(plan.day, saidAt: clock.now)
            let call = clock.when(plan.call, planDay: plan.day)
            let review = clock.when(plan.review, planDay: plan.day)
            let lead = day == "today" ? "Here is today at a glance:" : "It is late in the day, so here is tomorrow at a glance:"
            let rest = "Everything else in Focus can wait until \(clock.restWaitsUntil(planDay: plan.day))."
            return Chat(
                thinking: "Read the Focus tier and the calendar for \(day).",
                text: """
                \(lead)

                1. **Review the crash fix** (pull request #318), blocked out \(review)
                2. **Pick an onboarding headline**: three options are waiting in your Inbox
                3. **Call the dentist** \(call)

                \(rest)
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

    /// The answer to a side question ("ask without interrupting the work"):
    /// from what the session did, picked by what was asked. One fixed sentence
    /// answered every question the same way (App Store gate, 2026-10-05).
    static func sideAnswer(to question: String, session id: String) -> String {
        let q = question.lowercased()
        func asks(_ words: String...) -> Bool { words.contains { q.contains($0) } }
        let facts = SideFacts.of(id)
        if asks("file", "where", "line", "which code", "what code") { return facts.file }
        if asks("test") { return facts.tests }
        if asks("why", "cause", "reason", "what happened", "root") { return facts.cause }
        if asks("risk", "safe", "break", "affect", "side effect", "anything else", "regress") { return facts.risk }
        if asks("pull request", " pr", "pr ", "review", "merge", "ship") { return facts.review }
        if asks("how long", "when", "time", "eta", "done", "finish", "status", "progress") { return facts.status }
        let quoted = question.trimmingCharacters(in: .whitespacesAndNewlines)
        return "This is the demo, so this session can only answer \"\(quoted)\" from its sample work. \(facts.status)"
    }

    /// What each demo session can say about its own work, consistent with its
    /// transcript. Plain text: the Side Questions sheet shows an answer as it is,
    /// so a code span would show its backticks.
    private struct SideFacts {
        let file, tests, cause, risk, review, status: String

        static func of(_ id: String) -> SideFacts {
            switch id {
            case "s-crash":
                return SideFacts(
                    file: "Sources/Albums/AlbumViewModel.swift, line 57: store.album(id: albumID!). The fix replaced it with a wait for the album.",
                    tests: "All 24 album tests pass, including the new testOpenFromNotificationBeforeSync in Tests/AlbumTests.swift, which opens an album from a notification before it has synced.",
                    cause: "The notification router opened the album screen before the shared album had synced, so albumID was still nil and the force unwrap crashed.",
                    risk: "Low. The change is in the album screen and its tests only (+18, -4), so nothing else in the app is affected.",
                    review: "Pull request #318 is open and a review is requested. It can ship in the next TestFlight build once it is approved.",
                    status: "The fix and its test are done; pull request #318 is waiting for a review."
                )
            case "s-offline":
                return SideFacts(
                    file: "The cache is new, in Sources/Grid/ThumbnailCache.swift; the grid reads it in Sources/Grid/PhotoGrid.swift.",
                    tests: "All 31 grid tests pass.",
                    cause: "Without a disk cache, the grid had nothing to show offline, so it showed spinners.",
                    risk: "Low. The cache is bounded to the last 500 thumbnails (about 40 MB) and only the grid reads it.",
                    review: "It is ready to merge into the 2.4 branch; the letter in your Inbox asks you to confirm.",
                    status: "The offline grid works and the offline banner is in; it is waiting on your go to merge."
                )
            case "s-copy":
                return SideFacts(
                    file: "The headline is in Sources/Onboarding/WelcomeView.swift.",
                    tests: "Only text changes, so the existing onboarding tests cover it.",
                    cause: "The welcome screen needs a shorter headline for the 2.4 release.",
                    risk: "None to speak of: it is a text change on the welcome screen and in the App Store text.",
                    review: "Three options are waiting in your Inbox; pick one and the session updates the app and the App Store text.",
                    status: "Three headline options are drafted and waiting for your pick."
                )
            case "s-cache":
                return SideFacts(
                    file: "Three call sites changed, among them Sources/Grid/ThumbnailCache.swift.",
                    tests: "All 212 tests pass.",
                    cause: "The old major version of the image cache library held more memory while scrolling.",
                    risk: "Low. The upgrade needed two renamed options and the shared pipeline, and memory while scrolling dropped by 38%.",
                    review: "It is merged.",
                    status: "Done and merged: all 212 tests pass and scrolling uses 38% less memory."
                )
            default:
                return SideFacts(
                    file: "This is the demo, so no real files change here; the session's last messages say what it touched.",
                    tests: "This is the demo, so no tests run here; on your computer the session runs them and reports the result.",
                    cause: "This is the demo, so the session answers from its sample work; its last messages explain what it found.",
                    risk: "This is the demo, so nothing changes here; on your computer the session says what a change affects before it makes it.",
                    review: "This is the demo, so nothing is up for review here.",
                    status: "It is idle in the demo; its last messages say where it stopped."
                )
            }
        }
    }

    static func session(for message: String, images: Int = 0, cwd: String) -> Session {
        let lower = message.lowercased()
        let root = cwd.isEmpty ? DemoFixtures.macCodeRoot : cwd
        if images > 0, message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return sessionPhoto(cwd: cwd)
        }
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

    /// What a session does with a letter answer: the answer arrives as its next
    /// turn (the real server delivers it the same way), the agent acts on it,
    /// and writes back in the letter's thread.
    struct LetterTurn {
        /// The user row the session shows for the delivered answer.
        let delivered: String
        let reply: Session
        /// The task's summary once the work is done.
        let summary: String
        /// The task is finished by this answer.
        let completes: Bool
        /// The agent's line in the letter thread.
        let threadReply: String
        /// A release plan checklist line the work ticks, if any.
        let ticks: String?
    }

    static func letterTurn(letterID: String, actionID: String, label: String, description: String?, cwd: String) -> LetterTurn? {
        let root = cwd.isEmpty ? DemoFixtures.macCodeRoot : cwd
        switch (letterID, actionID) {
        case ("l-headline", _):
            let headline = description ?? label
            return LetterTurn(
                delivered: "From your Inbox: \(label), \"\(headline)\".",
                reply: Session(
                    thinking: "Put the chosen headline on the welcome screen and in the App Store text.",
                    tool: Tool(
                        name: "Edit", detail: "Sources/Onboarding/WelcomeView.swift",
                        input: "file_path: \(root)/Sources/Onboarding/WelcomeView.swift",
                        result: "Updated WelcomeView.swift (+1, -1)"
                    ),
                    text: "Done. The welcome screen now says **\(headline)**, and the App Store subtitle matches. The copy review is complete."
                ),
                summary: "Shipped \"\(headline)\" on the welcome screen and in the App Store subtitle.",
                completes: true,
                // Plain text: a thread turn's text is shown as written.
                threadReply: "Done: the welcome screen and the App Store subtitle now say \"\(headline)\".",
                ticks: "New onboarding headline"
            )
        case ("l-merge", "merge"):
            return LetterTurn(
                delivered: "From your Inbox: \(label).",
                reply: Session(
                    thinking: "Merge the offline grid branch into the 2.4 branch.",
                    tool: Tool(
                        name: "Bash", detail: "Merge into the 2.4 branch",
                        input: "command: git checkout release/2.4 && git merge --no-ff offline-grid\ndescription: Merge into the 2.4 branch",
                        result: "Merge made by the 'ort' strategy."
                    ),
                    text: "Merged offline mode into the 2.4 branch. It goes out with the next TestFlight build."
                ),
                summary: "Merged into the 2.4 branch.",
                completes: true,
                threadReply: "Merged into the 2.4 branch.",
                ticks: "Offline mode for the photo grid"
            )
        case ("l-merge", _):
            return LetterTurn(
                delivered: "From your Inbox: \(label).",
                reply: Session(
                    thinking: "Check where the crash fix is before merging.",
                    tool: Tool(
                        name: "Bash", detail: "Check the crash fix pull request",
                        input: "command: gh pr view 318 --json state\ndescription: Check the crash fix pull request",
                        result: "state: OPEN, review requested"
                    ),
                    text: "Okay. Pull request #318 is still in review, so I will merge offline mode after it lands."
                ),
                summary: "Ready to merge after the crash fix lands.",
                completes: false,
                threadReply: "Okay, I will merge it after the crash fix lands.",
                ticks: nil
            )
        default:
            return nil
        }
    }

    static let uptimeRestartOutput = "alert-agent.service restarted\nLoaded 2 rules: site-down, api-down"

    /// Nothing is paged in the demo, so the reply does not claim a test page:
    /// the reader would look for a notification that never comes.
    static let uptimeAllowed = """
    Done. The alert agent restarted and loaded both rules:

    - **site-down:** the website has not answered for 2 minutes
    - **api-down:** the API has not answered for 2 minutes

    Both are live now. You get a page only if the site or the API stays down for two minutes.
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

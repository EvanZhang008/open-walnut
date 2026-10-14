import Foundation

/// AppLink (desktop/AppLink.swift) and CommandLineTool (desktop/CommandLineTool.swift).
///
/// AppLink: the fragment must decode, in the console, to exactly the link the
/// app received (src/core/plugin-install-link.ts parseOpenLinkFragment), and the
/// script must reach the page's bridge first and set the fragment only without one.
///
/// CommandLineTool: the `walnut` command goes in only when the name is free or
/// ours is broken, never over a `walnut` the user already has, and the profile
/// line is added once, only when the login shell lacks ~/.local/bin.
@main
struct AppLinkTests {
    static func main() {
        // MARK: AppLink
        let link = URL(string: "open-walnut://install-plugin?url=git%40example.com%3Ateam%2Fplugins.git&ref=main")!
        precondition(AppLink.accepts(link))
        precondition(AppLink.accepts(URL(string: "OPEN-WALNUT://install-plugin?spec=x")!))
        precondition(!AppLink.accepts(URL(string: "https://example.com/")!))
        precondition(!AppLink.accepts(URL(string: "open-walnut://x?u=" + String(repeating: "a", count: 5_000))!))

        let fragment = AppLink.fragment(for: link)!
        precondition(fragment.hasPrefix("#open-link="))
        // Same alphabet as encodeURIComponent: the console's decodeURIComponent gives the link back.
        let encoded = String(fragment.dropFirst("#open-link=".count))
        precondition(encoded.removingPercentEncoding == link.absoluteString)
        precondition(!encoded.contains("&") && !encoded.contains("=") && !encoded.contains("#"))
        precondition(AppLink.encodeComponent("a b/c?d=e&f#g'h(i)*~!") == "a%20b%2Fc%3Fd%3De%26f%23g'h(i)*~!")

        // A quote or a script tag in a link stays inside the string literal.
        let nasty = URL(string: "open-walnut://install-plugin?url=https://x/%22);alert(1);//%3C/script%3E")!
        let script = AppLink.bridgeScript(for: nasty)!
        precondition(script.contains("bridge.openLink(\"open-walnut://install-plugin?url=https://x/%22);alert(1);//%3C/script%3E\")"))
        precondition(script.contains("typeof bridge.openLink === 'function'"))
        precondition(script.contains("=== true ? 'taken' : 'refused'"))
        precondition(script.contains("window.location.hash = \"#open-link="))
        precondition(script.contains("return 'fragment'"))
        precondition(AppLink.jsString("a\"b\\c\n") == "\"a\\\"b\\\\c\\n\"")
        precondition(AppLink.bridgeScript(for: URL(string: "https://example.com")!) == nil)

        // MARK: CommandLineTool: which link step
        let lp = "/Users/u/.local/bin/walnut"
        let target = "/Users/u/.local/share/open-walnut/app/bin/walnut"
        typealias T = CommandLineTool
        precondition(T.linkStep(existing: .nothing, target: target, linkPath: lp, shellWalnut: nil) == .create)
        // The user already has one on PATH (Homebrew, npm): leave it.
        if case .leave(let why) = T.linkStep(existing: .nothing, target: target, linkPath: lp, shellWalnut: "/opt/homebrew/bin/walnut") {
            precondition(why.contains("/opt/homebrew/bin/walnut"))
        } else { preconditionFailure("an existing walnut on PATH must be left") }
        precondition(T.linkStep(existing: .linkTo(target, targetExists: true), target: target, linkPath: lp, shellWalnut: lp) == .keep)
        // Ours, to a Walnut that is gone (a moved checkout): replaced.
        precondition(T.linkStep(existing: .linkTo("/gone/bin/walnut", targetExists: false), target: target, linkPath: lp, shellWalnut: nil) == .create)
        // Someone else's link that works, or a plain file: never touched.
        if case .leave = T.linkStep(existing: .linkTo("/usr/local/lib/node_modules/open-walnut/bin/walnut.js", targetExists: true), target: target, linkPath: lp, shellWalnut: lp) {} else { preconditionFailure("a working foreign link must be left") }
        if case .leave = T.linkStep(existing: .otherFile, target: target, linkPath: lp, shellWalnut: lp) {} else { preconditionFailure("a file must be left") }

        precondition(T.target(runtimeAppDir: "/r/app", sourceDir: "/src") == "/r/app/bin/walnut")
        precondition(T.target(runtimeAppDir: nil, sourceDir: "/src") == "/src/bin/open-walnut.js")
        precondition(T.target(runtimeAppDir: nil, sourceDir: nil) == nil)

        // MARK: profile and PATH
        precondition(T.profileFile(shell: "/bin/zsh", home: "/h") == "/h/.zprofile")
        precondition(T.profileFile(shell: "/opt/homebrew/bin/bash", home: "/h") == "/h/.bash_profile")
        precondition(T.profileFile(shell: "/opt/homebrew/bin/fish", home: "/h") == nil)
        precondition(T.pathContains("/usr/bin:/Users/u/.local/bin/:/bin", dir: "/Users/u/.local/bin"))
        precondition(!T.pathContains("/usr/bin:/Users/u/.local/binx", dir: "/Users/u/.local/bin"))

        // An interactive profile that prints a banner: the marked lines still parse.
        let probe = T.parseProbe("Welcome!\nlast login...\n\n__WALNUT_CMD__\n__WALNUT_PATH__/usr/bin:/bin\n")!
        precondition(probe == T.ShellView(walnut: nil, path: "/usr/bin:/bin"))
        precondition(T.parseProbe("__WALNUT_CMD__/opt/homebrew/bin/walnut\n__WALNUT_PATH__/x")!.walnut == "/opt/homebrew/bin/walnut")
        precondition(T.parseProbe("no markers at all") == nil)

        // MARK: install, on a real temp home
        let fm = FileManager.default
        let home = NSTemporaryDirectory() + "walnut-cli-tool-\(UUID().uuidString)"
        try! fm.createDirectory(atPath: home, withIntermediateDirectories: true)
        defer { try? fm.removeItem(atPath: home) }
        let runtimeBin = home + "/.local/share/open-walnut/app/bin"
        try! fm.createDirectory(atPath: runtimeBin, withIntermediateDirectories: true)
        let realTarget = runtimeBin + "/walnut"
        fm.createFile(atPath: realTarget, contents: Data("#!/bin/sh\n".utf8))
        let tool = CommandLineTool(home: home)

        // Not on PATH yet: linked, and the zsh profile gets the line once.
        let first = tool.install(target: realTarget, shell: "/bin/zsh", view: T.ShellView(walnut: nil, path: "/usr/bin:/bin"))
        precondition(first.linked && first.error == nil, first.summary)
        precondition((try? fm.destinationOfSymbolicLink(atPath: tool.linkPath)) == realTarget)
        precondition(first.profileEdited == "\((home + "/.zprofile" as NSString).abbreviatingWithTildeInPath)")
        let profile = try! String(contentsOfFile: home + "/.zprofile", encoding: .utf8)
        precondition(profile.contains(T.profileMarker) && profile.contains("export PATH=\"$HOME/.local/bin:$PATH\""))

        // Again: nothing changes, the line is not added twice.
        let second = tool.install(target: realTarget, shell: "/bin/zsh", view: T.ShellView(walnut: nil, path: "/usr/bin:/bin"))
        precondition(second.alreadyLinked && !second.linked && second.profileEdited == nil, second.summary)
        let again = try! String(contentsOfFile: home + "/.zprofile", encoding: .utf8)
        precondition(again.components(separatedBy: T.profileMarker).count == 2)

        // A profile the user already has keeps every line, with ours appended.
        try! "export FOO=1\n".write(toFile: home + "/.bash_profile", atomically: true, encoding: .utf8)
        _ = tool.install(target: realTarget, shell: "/bin/bash", view: T.ShellView(walnut: tool.linkPath, path: "/bin"))
        let bash = try! String(contentsOfFile: home + "/.bash_profile", encoding: .utf8)
        precondition(bash.hasPrefix("export FOO=1\n") && bash.contains(T.profileMarker))

        // Already on PATH: no profile edit at all.
        try! fm.removeItem(atPath: home + "/.zprofile")
        let onPath = tool.install(target: realTarget, shell: "/bin/zsh", view: T.ShellView(walnut: tool.linkPath, path: home + "/.local/bin:/bin"))
        precondition(onPath.alreadyLinked && onPath.profileEdited == nil && !fm.fileExists(atPath: home + "/.zprofile"))

        // The shell did not answer: link only, no profile guess.
        try! fm.removeItem(atPath: tool.linkPath)
        let silent = tool.install(target: realTarget, shell: "/bin/zsh", view: nil)
        precondition(silent.linked && silent.profileEdited == nil && !fm.fileExists(atPath: home + "/.zprofile"))

        // A broken link of ours (the Walnut moved) is replaced.
        try! fm.removeItem(atPath: tool.linkPath)
        try! fm.createSymbolicLink(atPath: tool.linkPath, withDestinationPath: home + "/gone/walnut")
        let healed = tool.install(target: realTarget, shell: "/bin/zsh", view: T.ShellView(walnut: nil, path: home + "/.local/bin"))
        precondition(healed.linked, healed.summary)
        precondition((try? fm.destinationOfSymbolicLink(atPath: tool.linkPath)) == realTarget)

        // The user's own file is never replaced.
        try! fm.removeItem(atPath: tool.linkPath)
        fm.createFile(atPath: tool.linkPath, contents: Data("mine".utf8))
        let mine = tool.install(target: realTarget, shell: "/bin/zsh", view: T.ShellView(walnut: tool.linkPath, path: home + "/.local/bin"))
        precondition(mine.left != nil && !mine.linked)
        precondition((try? String(contentsOfFile: tool.linkPath, encoding: .utf8)) == "mine")

        // No Walnut to point at: an error, nothing written.
        let missing = tool.install(target: home + "/nope", shell: "/bin/zsh", view: nil)
        precondition(missing.error != nil)

        // The real login shell answers the probe (bounded).
        if let view = T.probeShell("/bin/zsh", timeout: 15) {
            precondition(!view.path.isEmpty)
        }

        print("app link + command line tool tests passed")
    }
}

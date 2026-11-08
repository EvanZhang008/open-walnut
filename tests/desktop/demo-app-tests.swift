import Foundation

// Walnut Demo's own entry points: where its links go, which commands it takes from
// Walnut.app, where its embedded copy finds the release, and how the builds embed it.
//
//   swiftc -D WALNUT_DEMO_TESTS tests/desktop/demo-app-tests.swift desktop/DemoApp.swift \
//     desktop/BundledRuntime.swift desktop/ClaudeSignInBridge.swift -framework Cocoa -framework WebKit -o /tmp/demo-app-tests
@main
struct DemoAppTests {
    static func main() {
        func u(_ s: String) -> URL { URL(string: s)! }

        // target="_blank" / window.open: the Demo's own routes load in its one page,
        // web links go to the browser, nothing else loads or runs.
        precondition(DemoLinks.newWindow(u("http://127.0.0.1:3458/tasks/abc")) == .inPage)
        precondition(DemoLinks.newWindow(u("http://127.0.0.1:3458/popout?view=session&id=a")) == .inPage)
        precondition(DemoLinks.newWindow(u("https://example.com/docs")) == .openInBrowser)
        precondition(DemoLinks.newWindow(u("http://127.0.0.1:3456/")) == .openInBrowser)
        for s in ["javascript:alert(1)", "file:///etc/passwd", "about:blank", "data:text/html,x", "blob:http://127.0.0.1:3458/a",
                  "vscode://file/x", "open-walnut://plugin", "walnut-demo://reset", "https:///nohost"] {
            precondition(DemoLinks.newWindow(u(s)) == .ignore, s)
        }
        // Another port or host is not the Demo, even on loopback.
        precondition(!DemoLinks.isOwn(u("http://127.0.0.1:3456/")))
        precondition(!DemoLinks.isOwn(u("https://127.0.0.1:3458/")))
        precondition(!DemoLinks.isOwn(u("http://127.0.0.1.example.com:3458/")))

        // In-page navigations: own routes load; a clicked web link leaves; a scripted one is dropped.
        precondition(DemoLinks.navigation(u("http://127.0.0.1:3458/settings"), isLinkClick: false) == .inPage)
        precondition(DemoLinks.navigation(u("https://example.com/"), isLinkClick: true) == .openInBrowser)
        precondition(DemoLinks.navigation(u("https://example.com/"), isLinkClick: false) == .ignore)
        precondition(DemoLinks.navigation(u("file:///Users/x/notes.md"), isLinkClick: true) == .ignore)

        // Commands from Walnut.app: exactly open and reset on Demo's own scheme.
        precondition(DemoCommand(url: u("walnut-demo://open")) == .open)
        precondition(DemoCommand(url: u("walnut-demo://reset")) == .reset)
        precondition(DemoCommand(url: u("WALNUT-DEMO://RESET/")) == .reset)
        for s in ["open-walnut://reset", "walnut-demo://wipe", "walnut-demo://reset?all=1", "walnut-demo://reset/now",
                  "walnut-demo://x@reset", "walnut-demo://reset#a", "https://reset"] {
            precondition(DemoCommand(url: u(s)) == nil, s)
        }

        // The copy inside Walnut.app reads the release its Walnut.app carries; one on its own does not look elsewhere.
        let embedded = URL(fileURLWithPath: "/Applications/Walnut.app/Contents/Helpers/Walnut Demo.app")
        precondition(DemoBundle.enclosingResources(of: embedded)?.path == "/Applications/Walnut.app/Contents/Resources")
        precondition(DemoBundle.resourceDirs(own: embedded.path + "/Contents/Resources", bundle: embedded)
            == [embedded.path + "/Contents/Resources", "/Applications/Walnut.app/Contents/Resources"])
        precondition(DemoBundle.enclosingResources(of: URL(fileURLWithPath: "/Applications/Walnut Demo.app")) == nil)
        precondition(DemoBundle.enclosingResources(of: URL(fileURLWithPath: "/tmp/Helpers/Walnut Demo.app")) == nil)
        precondition(DemoBundle.resourceDirs(own: "/Volumes/Walnut/Walnut Demo.app/Contents/Resources",
                                             bundle: URL(fileURLWithPath: "/Volumes/Walnut/Walnut Demo.app")).count == 1)

        // A carried release upgrades an older Demo install, never moves a newer one back.
        precondition(DemoInstall.needsUpgrade(installed: "0.7.0", carried: "0.7.1"))
        precondition(!DemoInstall.needsUpgrade(installed: "0.7.1", carried: "0.7.1"))
        precondition(!DemoInstall.needsUpgrade(installed: "0.8.0", carried: "0.7.1"))
        precondition(!DemoInstall.needsUpgrade(installed: "0.7.0", carried: nil))
        precondition(!DemoInstall.needsUpgrade(installed: nil, carried: "0.7.1"))

        // The demo command's output: each finished line, plain and capped; the rest waits.
        let split = DemoOutput.splitLines("Copying data\r\n\u{1B}[32mStarting server\u{1B}[0m\nhalf")
        precondition(split.lines == ["Copying data", "Starting server"] && split.rest == "half", "\(split)")
        precondition(DemoOutput.splitLines(String(repeating: "x", count: 500) + "\n").lines[0].count == DemoOutput.lineLimit)
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/bin/sh")
        proc.arguments = ["-c", "i=0; while [ $i -lt 400 ]; do echo line-$i-padding-padding-padding; i=$((i+1)); done; exit 3"]
        var seen: [String] = []
        let seenLock = NSLock()
        let (status, tail) = try! DemoOutput.run(proc) { line in seenLock.lock(); seen.append(line); seenLock.unlock() }
        precondition(status == 3 && tail.count <= DemoOutput.tailLimit && tail.hasSuffix("line-399-padding-padding-padding"), tail)
        seenLock.lock(); precondition(!seen.isEmpty && seen.allSatisfy { $0.hasPrefix("line-") }); seenLock.unlock()

        // The sources: Walnut.app only opens Demo (no Demo command of its own, no browser), and
        // the release embeds and signs Demo before the app's notarization.
        let desktop = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../desktop").standardizedFileURL
        func read(_ name: String) -> String { try! String(contentsOf: desktop.appendingPathComponent(name), encoding: .utf8) }
        let main = read("main.swift")
        precondition(!main.contains("[\"demo\""), "Walnut.app must not run a Demo command itself")
        precondition(!main.contains("runDemoCommand"))
        precondition(main.contains("Contents/Helpers/Walnut Demo.app"))
        precondition(main.contains("walnut-demo://reset"))
        let demoApp = read("DemoApp.swift")
        precondition(demoApp.contains("appendingPathComponent(\"data\").appendingPathComponent(generation).appendingPathComponent(\"local/demo-sign-ins/accepting\")"))
        precondition(demoApp.contains("demoSignInDirectory: signIns"), "Demo sign-ins must be recorded where reset reads them")
        precondition(demoApp.contains("Old Demo files are kept if their background processes cannot be confirmed stopped."))
        let release = read("build-release.sh")
        let embed = release.range(of: "\"$CONTENTS/Helpers/Walnut Demo.app\" --uses-parent-release")!
        let appNotary = release.range(of: "notarize \"$APP_ZIP\"")!
        precondition(embed.lowerBound < appNotary.lowerBound, "Demo must be embedded before the app is notarized")
        precondition(release.range(of: "--uses-parent-release", range: appNotary.upperBound..<release.endIndex) == nil)
        precondition(read("build.sh").contains("\"$CONTENTS/Helpers/Walnut Demo.app\" --uses-parent-release"))
        let demoBuild = read("build-demo.sh")
        precondition(demoBuild.contains("[\"walnut-demo\"]") && !demoBuild.contains("\"open-walnut\""))
        print("DemoAppTests: all passed")
    }
}

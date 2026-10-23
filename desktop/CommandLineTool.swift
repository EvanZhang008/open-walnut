import Foundation

// The `walnut` command for a Mac that has only the app, like VS Code's "Install
// 'code' command in PATH" but without asking for an admin password: a symlink in
// ~/.local/bin (install.sh's own bin dir) to the Walnut the app runs, and, when
// the user's login shell does not have that folder on its PATH, one marked line
// in their shell profile.
//
// It never takes a name that is already used: a `walnut` the shell already
// finds (Homebrew, npm, the user's own link) is left as it is, and so is a file
// at ~/.local/bin/walnut. Only a link of ours whose target is gone is replaced.
// The app checks once per Walnut it runs (a new runtime or checkout checks
// again); Walnut > Install 'walnut' Command runs the same check on demand.
//
// Foundation only, so tests/desktop/command-line-tool-tests.swift compiles it alone.

struct CommandLineTool {
    static let commandName = "walnut"
    /// The line the profile gets, under this marker; the marker makes it findable and one-time.
    static let profileMarker = "# Added by Walnut: puts the `walnut` command on PATH"

    let home: String
    var binDir: String { BundledRuntime.binDir(home: home) }
    var linkPath: String { binDir + "/" + CommandLineTool.commandName }

    /// The `walnut` of the Walnut this app runs: the runtime's command
    /// (BundledRuntime.command), or a source checkout's own bin script (which
    /// needs the user's Node, as a checkout always does).
    static func target(runtimeCommand: String?, sourceDir: String?) -> String? {
        if let command = runtimeCommand { return command }
        if let source = sourceDir { return source + "/bin/open-walnut.js" }
        return nil
    }

    /// What is at ~/.local/bin/walnut now.
    enum Existing: Equatable {
        case nothing
        case linkTo(String, targetExists: Bool)
        case otherFile
    }

    enum LinkStep: Equatable {
        /// Make the link (nothing there, or a link of ours to a Walnut that is gone).
        case create
        /// It is already the right link.
        case keep
        /// Something else has the name; leave it.
        case leave(String)
    }

    /// `shellWalnut`: where the login shell finds `walnut` now (nil: nowhere).
    static func linkStep(existing: Existing, target: String, linkPath: String, shellWalnut: String?) -> LinkStep {
        switch existing {
        case .linkTo(let dest, let targetExists):
            if dest == target { return .keep }
            if !targetExists { return .create }
            return .leave("\(linkPath) already points to \(dest)")
        case .otherFile:
            return .leave("\(linkPath) already exists")
        case .nothing:
            if let found = shellWalnut, !found.isEmpty, found != linkPath {
                return .leave("`walnut` already runs \(found)")
            }
            return .create
        }
    }

    /// The profile a login shell of this kind reads, or nil for a shell we do not edit.
    static func profileFile(shell: String, home: String) -> String? {
        switch (shell as NSString).lastPathComponent {
        case "zsh": return home + "/.zprofile"
        case "bash": return home + "/.bash_profile"
        default: return nil
        }
    }

    static func profileBlock() -> String {
        return "\n\(profileMarker)\nexport PATH=\"$HOME/.local/bin:$PATH\"\n"
    }

    static func pathContains(_ path: String, dir: String) -> Bool {
        let wanted = (dir as NSString).standardizingPath
        return path.split(separator: ":").contains { (String($0) as NSString).standardizingPath == wanted }
    }

    /// What the login shell reported (see `probeScript`).
    struct ShellView: Equatable {
        let walnut: String?
        let path: String
    }

    /// Prints two marked lines, so whatever an interactive profile echoes is skipped.
    static let probeScript = "printf '\\n__WALNUT_CMD__%s\\n' \"$(command -v walnut 2>/dev/null)\"; printf '__WALNUT_PATH__%s\\n' \"$PATH\""

    static func parseProbe(_ output: String) -> ShellView? {
        var walnut: String?
        var path: String?
        for line in output.split(separator: "\n", omittingEmptySubsequences: false) {
            if line.hasPrefix("__WALNUT_CMD__") { walnut = String(line.dropFirst("__WALNUT_CMD__".count)) }
            if line.hasPrefix("__WALNUT_PATH__") { path = String(line.dropFirst("__WALNUT_PATH__".count)) }
        }
        guard let p = path else { return nil }
        let found = walnut?.trimmingCharacters(in: .whitespaces)
        return ShellView(walnut: (found?.isEmpty ?? true) ? nil : found, path: p)
    }

    /// The outcome, in words for the menu's alert and fields for the log.
    struct Outcome: Equatable {
        var linked: Bool = false
        var alreadyLinked: Bool = false
        var left: String?
        var profileEdited: String?
        var pathNote: String?
        var error: String?

        var summary: String {
            if let error = error { return "Could not install the walnut command: \(error)" }
            var lines: [String] = []
            if linked { lines.append("Installed the walnut command in ~/.local/bin.") }
            if alreadyLinked { lines.append("The walnut command is already installed.") }
            if let left = left { lines.append("Left it as it is: \(left).") }
            if let edited = profileEdited { lines.append("Added ~/.local/bin to your PATH in \(edited); open a new terminal window to use it.") }
            if let note = pathNote { lines.append(note) }
            return lines.joined(separator: "\n")
        }
    }

    func existing(fileManager: FileManager = .default) -> Existing {
        guard let attrs = try? fileManager.attributesOfItem(atPath: linkPath) else { return .nothing }
        if (attrs[.type] as? FileAttributeType) == .typeSymbolicLink,
           let dest = try? fileManager.destinationOfSymbolicLink(atPath: linkPath) {
            let resolved = dest.hasPrefix("/") ? dest : (binDir as NSString).appendingPathComponent(dest)
            return .linkTo(dest, targetExists: fileManager.fileExists(atPath: resolved))
        }
        return .otherFile
    }

    /// Does the work. `shell` is the user's login shell; `view` what it reported
    /// (nil when it did not answer, and then no profile is touched).
    func install(target: String, shell: String, view: ShellView?, fileManager: FileManager = .default) -> Outcome {
        var outcome = Outcome()
        guard fileManager.fileExists(atPath: target) else {
            outcome.error = "\(target) is missing"
            return outcome
        }
        switch CommandLineTool.linkStep(existing: existing(fileManager: fileManager), target: target, linkPath: linkPath, shellWalnut: view?.walnut) {
        case .keep:
            outcome.alreadyLinked = true
        case .leave(let why):
            outcome.left = why
            return outcome
        case .create:
            do {
                try fileManager.createDirectory(atPath: binDir, withIntermediateDirectories: true)
                if (try? fileManager.attributesOfItem(atPath: linkPath)) != nil { try fileManager.removeItem(atPath: linkPath) }
                try fileManager.createSymbolicLink(atPath: linkPath, withDestinationPath: target)
                outcome.linked = true
            } catch {
                outcome.error = error.localizedDescription
                return outcome
            }
        }
        guard let view = view else {
            outcome.pathNote = "Make sure ~/.local/bin is on your PATH."
            return outcome
        }
        if CommandLineTool.pathContains(view.path, dir: binDir) { return outcome }
        guard let profile = CommandLineTool.profileFile(shell: shell, home: home) else {
            outcome.pathNote = "Add ~/.local/bin to your shell's PATH to use it."
            return outcome
        }
        let current = (try? String(contentsOfFile: profile, encoding: .utf8)) ?? ""
        if current.contains(CommandLineTool.profileMarker) { return outcome }
        do {
            if let handle = FileHandle(forWritingAtPath: profile) {
                defer { handle.closeFile() }
                handle.seekToEndOfFile()
                handle.write(Data(CommandLineTool.profileBlock().utf8))
            } else {
                try CommandLineTool.profileBlock().write(toFile: profile, atomically: true, encoding: .utf8)
            }
            outcome.profileEdited = (profile as NSString).abbreviatingWithTildeInPath
        } catch {
            outcome.pathNote = "Add ~/.local/bin to your PATH (\(profile) could not be written)."
        }
        return outcome
    }

    /// Asks the login shell where `walnut` is and what PATH it builds, bounded:
    /// an interactive profile that waits on input or hangs answers nil. Blocks;
    /// call it off the main thread.
    static func probeShell(_ shell: String, timeout: TimeInterval = 8) -> ShellView? {
        let proc = Process()
        let pipe = Pipe()
        proc.executableURL = URL(fileURLWithPath: shell)
        proc.arguments = ["-ilc", probeScript]
        proc.standardOutput = pipe
        proc.standardError = FileHandle.nullDevice
        proc.standardInput = FileHandle.nullDevice
        do { try proc.run() } catch { return nil }
        let done = DispatchSemaphore(value: 0)
        var data = Data()
        DispatchQueue.global().async {
            data = pipe.fileHandleForReading.readDataToEndOfFile()
            done.signal()
        }
        if done.wait(timeout: .now() + timeout) == .timedOut {
            proc.terminate()
            return nil
        }
        proc.waitUntilExit()
        return parseProbe(String(data: data, encoding: .utf8) ?? "")
    }
}

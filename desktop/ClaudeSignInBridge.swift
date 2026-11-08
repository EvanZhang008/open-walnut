import Cocoa
import WebKit

final class ClaudeSignInBridge: NSObject, WKScriptMessageHandlerWithReply {
    private let consoleURL: URL
    private let home: String
    private let configDir: String?
    private let demoSignInDirectory: String?

    init(consoleURL: URL, home: String? = nil, configDir: String? = nil, demoSignInDirectory: String? = nil) {
        self.consoleURL = consoleURL
        self.home = home ?? ProcessInfo.processInfo.environment["HOME"] ?? NSHomeDirectory()
        self.configDir = configDir ?? ProcessInfo.processInfo.environment["CLAUDE_CONFIG_DIR"]
        self.demoSignInDirectory = demoSignInDirectory
        super.init()
    }

    static let notTakingSignIns = "Walnut Demo is not taking sign-ins right now, so this sign-in did not start. Demo data was kept. Start sign-in again from Walnut Demo."

    // Demo reset renames accepting/ away and reads every record in it, so a record must exist before claude runs, under the pid claude keeps.
    static func demoRecordLines(directory: String, id: String) -> String {
        func quote(_ value: String) -> String { "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'" }
        return """
        umask 077
        set -C
        walnut_fail() { printf '%s\\n' \(quote(notTakingSignIns)); exit 1; }
        walnut_dir=\(quote(directory))
        { [ -d "$walnut_dir" ] && [ ! -h "$walnut_dir" ]; } || walnut_fail
        walnut_start=$(LC_ALL=C TZ=UTC /bin/ps -o lstart= -p $$ 2>/dev/null) || walnut_fail
        walnut_start=$(printf '%s' "$walnut_start" | /usr/bin/tr -s ' ' | /usr/bin/sed 's/^ //;s/ $//')
        case "$walnut_start" in ''|*[!A-Za-z0-9:' ']*) walnut_fail ;; esac
        { printf '{"pid":%d,"startTime":"ps:%s"}\\n' "$$" "$walnut_start" > "$walnut_dir/\(id).json"; } 2>/dev/null || walnut_fail
        set +C

        """
    }

    static func command(home: String, configDir: String? = nil, shell: String = "/bin/sh", demoRecord: (directory: String, id: String)? = nil) -> String {
        func quote(_ value: String) -> String { "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'" }
        let config = configDir.map { " CLAUDE_CONFIG_DIR=\(quote($0))" } ?? ""
        let shellName = URL(fileURLWithPath: shell).lastPathComponent
        let rc = shellName == "zsh" ? ".zshrc" : shellName == "bash" ? ".bashrc" : nil
        let source = rc.map { "[ -f \"$HOME/\($0)\" ] && . \"$HOME/\($0)\" >/dev/null 2>&1; " } ?? ""
        let lookup = shellName == "zsh" ? "whence -p claude" : shellName == "bash" ? "type -P claude" : "command -v claude"
        let paths = "$HOME/.local/bin:$HOME/.npm-global/bin:$HOME/.bun/bin:/usr/local/bin:/opt/homebrew/bin"
        let run = shellName == "fish"
            ? "set -gx PATH $PATH $HOME/.local/bin $HOME/.npm-global/bin $HOME/.bun/bin /usr/local/bin /opt/homebrew/bin; set -l cli (command -s claude); if test -z \"$cli\"; printf '%s\\n' 'Claude Code was not found. Install it in Walnut, then try signing in again.'; exit 1; end; exec \"$cli\" auth login"
            : ["csh", "tcsh"].contains(shellName) ? "setenv PATH \"${PATH}:\(paths)\"; exec claude auth login"
            : source + "export PATH=\"$PATH:\(paths)\"; cli=$(\(lookup)); if [ -z \"$cli\" ]; then printf '%s\\n' 'Claude Code was not found. Install it in Walnut, then try signing in again.'; exit 1; fi; exec \"$cli\" auth login"
        let flags = ["csh", "tcsh"].contains(shellName) ? "-c" : "-lc"
        let record = demoRecord.map { demoRecordLines(directory: $0.directory, id: $0.id) } ?? ""
        return "#!/bin/sh\nexport HOME=\(quote(home))\n\(record)exec /usr/bin/env -i HOME=\(quote(home)) PATH=\"/usr/bin:/bin:/usr/sbin:/sbin\" USER=\"$(/usr/bin/id -un)\" SHELL=\(quote(shell))\(config) \(quote(shell)) \(flags) \(quote(run))\n"
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        let origin = message.frameInfo.securityOrigin
        guard message.frameInfo.isMainFrame, let page = message.webView?.url,
              origin.protocol == "http", origin.host == page.host, origin.port == (page.port ?? 0),
              origin.host == consoleURL.host, origin.port == (consoleURL.port ?? 0),
              origin.host == "localhost" || origin.host == "127.0.0.1",
              message.body as? String == "sign-in" else {
            replyHandler(nil, "Sign-in opens only from the Walnut console page.")
            return
        }
        let directory = URL(fileURLWithPath: home).appendingPathComponent(".local/state/open-walnut/sign-in", isDirectory: true)
        let shell = ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh"
        do {
            if let accepting = demoSignInDirectory, !Self.acceptingDirectoryReady(accepting) {
                replyHandler(nil, Self.notTakingSignIns)
                return
            }
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            let script: URL
            if let accepting = demoSignInDirectory {
                let id = UUID().uuidString.lowercased()
                script = directory.appendingPathComponent("Claude Sign In \(id).command")
                try Self.writeNewScript(Self.command(home: home, configDir: configDir, shell: shell, demoRecord: (accepting, id)), to: script)
            } else {
                script = directory.appendingPathComponent("Claude Sign In.command")
                try Self.command(home: home, configDir: configDir, shell: shell).write(to: script, atomically: true, encoding: .utf8)
                try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: script.path)
            }
            let options = NSWorkspace.OpenConfiguration()
            options.activates = false
            NSWorkspace.shared.open(script, configuration: options) { app, error in
                if app != nil { replyHandler(true, nil) }
                else { replyHandler(nil, error?.localizedDescription ?? "The sign-in terminal could not be opened.") }
            }
        } catch {
            replyHandler(nil, error.localizedDescription)
        }
    }

    // Created by the Demo server only; a missing one means reset closed it, so it is never made here.
    static func acceptingDirectoryReady(_ path: String) -> Bool {
        guard path.hasPrefix("/") else { return false }
        var info = stat()
        guard lstat(path, &info) == 0 else { return false }
        return info.st_mode & S_IFMT == S_IFDIR && info.st_uid == getuid() && info.st_mode & 0o777 == 0o700
    }

    // One file per attempt: a second sign-in never overwrites a script a Terminal has not read yet.
    static func writeNewScript(_ text: String, to url: URL) throws {
        let fd = open(url.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o700)
        guard fd >= 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
        let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        try handle.write(contentsOf: Data(text.utf8))
        try handle.close()
    }
}

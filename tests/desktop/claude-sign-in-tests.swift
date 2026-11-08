import Foundation

@main
struct ClaudeSignInTests {
    static func main() {
        let home = "/tmp/demo home/a'b"
        let command = ClaudeSignInBridge.command(home: home)
        precondition(command.contains("export HOME='/tmp/demo home/a'\\''b'"))
        precondition(command.contains("command -v claude"))
        precondition(command.contains("exec \"$cli\" auth login"))
        precondition(command.contains("exec /usr/bin/env -i"))
        let isolated = ClaudeSignInBridge.command(home: home, configDir: home + "/.claude")
        precondition(isolated.contains(" CLAUDE_CONFIG_DIR='/tmp/demo home/a'\\''b/.claude'"))
        let zsh = ClaudeSignInBridge.command(home: home, shell: "/bin/zsh")
        precondition(zsh.contains(".zshrc"))
        precondition(zsh.contains("'/bin/zsh' -lc"))
        let bash = ClaudeSignInBridge.command(home: home, shell: "/bin/bash")
        precondition(bash.contains(".bashrc"))
        let fish = ClaudeSignInBridge.command(home: home, shell: "/usr/local/bin/fish")
        precondition(fish.contains("command -s claude"))
        precondition(fish.contains("set -gx PATH"))
        precondition(!fish.contains("; then"))
        let csh = ClaudeSignInBridge.command(home: home, shell: "/bin/tcsh")
        precondition(csh.contains("setenv PATH"))
        precondition(!csh.contains("cli=$("))
        precondition(!command.contains("eval"))
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("claude-sign-in-tests-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let testHome = directory.appendingPathComponent("demo home's")
        let bin = testHome.appendingPathComponent(".npm-global/bin")
        try! FileManager.default.createDirectory(at: bin, withIntermediateDirectories: true)
        let cli = bin.appendingPathComponent("claude")
        try! "#!/bin/sh\nprintf '%s|%s|%s\\n' \"$1\" \"$2\" \"${CLAUDE_CONFIG_DIR:-unset}\"\n".write(to: cli, atomically: true, encoding: .utf8)
        try! FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: cli.path)
        func run(shell: String, configDir: String? = nil) -> String {
            let script = directory.appendingPathComponent("Sign In.command")
            try! ClaudeSignInBridge.command(home: testHome.path, configDir: configDir, shell: shell).write(to: script, atomically: true, encoding: .utf8)
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/bin/sh")
            process.arguments = [script.path]
            let pipe = Pipe()
            process.standardOutput = pipe
            try! process.run()
            process.waitUntilExit()
            precondition(process.terminationStatus == 0)
            return String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        }
        precondition(run(shell: "/bin/sh", configDir: testHome.path + "/config") == "auth|login|\(testHome.path)/config")
        precondition(run(shell: "/bin/tcsh", configDir: testHome.path + "/config") == "auth|login|\(testHome.path)/config")
        let custom = testHome.appendingPathComponent("custom-bin")
        try! FileManager.default.createDirectory(at: custom, withIntermediateDirectories: true)
        try! FileManager.default.moveItem(at: cli, to: custom.appendingPathComponent("claude"))
        try! "export PATH=\"$HOME/custom-bin:$PATH\"\nexport CLAUDE_CONFIG_DIR=\"$HOME/custom-config\"\n".write(to: testHome.appendingPathComponent(".zshrc"), atomically: true, encoding: .utf8)
        precondition(run(shell: "/bin/zsh") == "auth|login|\(testHome.path)/custom-config")
        let aliasProfile = "export PATH=\"$HOME/custom-bin:$PATH\"\nalias claude='claude --verbose'\nexport CLAUDE_CONFIG_DIR=\"$HOME/alias-config\"\n"
        try! aliasProfile.write(to: testHome.appendingPathComponent(".zshrc"), atomically: true, encoding: .utf8)
        precondition(run(shell: "/bin/zsh") == "auth|login|\(testHome.path)/alias-config")
        try! aliasProfile.write(to: testHome.appendingPathComponent(".bashrc"), atomically: true, encoding: .utf8)
        precondition(run(shell: "/bin/bash") == "auth|login|\(testHome.path)/alias-config")
        try! FileManager.default.removeItem(at: testHome.appendingPathComponent(".bashrc"))
        try! FileManager.default.removeItem(at: testHome.appendingPathComponent(".zshrc"))
        let profile = "export PATH=\"$HOME/custom-bin:$PATH\"\nexport CLAUDE_CONFIG_DIR=\"$HOME/profile-config\"\n"
        try! profile.write(to: testHome.appendingPathComponent(".zprofile"), atomically: true, encoding: .utf8)
        precondition(run(shell: "/bin/zsh") == "auth|login|\(testHome.path)/profile-config")
        try! profile.write(to: testHome.appendingPathComponent(".bash_profile"), atomically: true, encoding: .utf8)
        precondition(run(shell: "/bin/bash") == "auth|login|\(testHome.path)/profile-config")

        // Demo sign-ins: a record in the Demo's accepting directory before claude runs, under claude's own pid.
        precondition(!command.contains("set -C") && !command.contains("walnut_dir"), "the real sign-in is unchanged")
        let demoHome = directory.appendingPathComponent("demo-only home")
        let demoBin = demoHome.appendingPathComponent(".npm-global/bin")
        try! FileManager.default.createDirectory(at: demoBin, withIntermediateDirectories: true)
        let ran = directory.appendingPathComponent("claude-ran")
        try! "#!/bin/sh\nprintf '%s|%s|%s\\n' \"$$\" \"$1\" \"$2\"\ntouch '\(ran.path)'\n".write(to: demoBin.appendingPathComponent("claude"), atomically: true, encoding: .utf8)
        try! FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: demoBin.appendingPathComponent("claude").path)
        let signIns = directory.appendingPathComponent("data/local/demo-sign-ins")
        let accepting = signIns.appendingPathComponent("accepting")
        try! FileManager.default.createDirectory(at: accepting, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try! FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: accepting.path)
        precondition(ClaudeSignInBridge.acceptingDirectoryReady(accepting.path))
        func runDemo(_ id: String, shell: String) -> (status: Int32, output: String) {
            let script = directory.appendingPathComponent("Claude Sign In \(id)-\(UUID().uuidString).command")
            try! ClaudeSignInBridge.writeNewScript(ClaudeSignInBridge.command(home: demoHome.path, shell: shell, demoRecord: (accepting.path, id)), to: script)
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/bin/sh")
            process.arguments = [script.path]
            let pipe = Pipe()
            process.standardOutput = pipe
            try! process.run()
            process.waitUntilExit()
            return (process.terminationStatus, String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines))
        }
        func record(_ id: String, in dir: URL = accepting) -> [String: Any]? {
            guard let data = FileManager.default.contents(atPath: dir.appendingPathComponent("\(id).json").path) else { return nil }
            return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        }
        for shell in ["/bin/sh", "/bin/zsh", "/bin/bash"] {
            let id = UUID().uuidString.lowercased()
            let result = runDemo(id, shell: shell)
            precondition(result.status == 0, "\(shell): \(result.output)")
            let parts = result.output.split(separator: "|").map(String.init)
            precondition(parts.count == 3 && parts[1] == "auth" && parts[2] == "login", result.output)
            let saved = record(id)!
            precondition(Set(saved.keys) == ["pid", "startTime"])
            precondition((saved["pid"] as? Int).map(String.init) == parts[0], "\(shell): record pid \(saved) is not claude's \(parts[0])")
            let start = saved["startTime"] as! String
            precondition(start.range(of: "^ps:[A-Za-z0-9 :]+$", options: .regularExpression) != nil && !start.contains("  "), start)
            let mode = (try! FileManager.default.attributesOfItem(atPath: accepting.appendingPathComponent("\(id).json").path)[.posixPermissions] as! NSNumber).intValue
            precondition(mode == 0o600, "record mode \(String(mode, radix: 8))")
        }

        // A record that already exists is never replaced, and claude does not start.
        let taken = UUID().uuidString.lowercased()
        try! "{\"pid\":2,\"startTime\":\"ps:first\"}\n".write(to: accepting.appendingPathComponent("\(taken).json"), atomically: false, encoding: .utf8)
        try? FileManager.default.removeItem(at: ran)
        var refused = runDemo(taken, shell: "/bin/sh")
        precondition(refused.status == 1 && refused.output == ClaudeSignInBridge.notTakingSignIns, refused.output)
        precondition(record(taken)?["startTime"] as? String == "ps:first" && !FileManager.default.fileExists(atPath: ran.path))

        // Reset renamed accepting away: nothing is recorded, nothing is created, claude does not start.
        let closed = signIns.appendingPathComponent("closed")
        try! FileManager.default.moveItem(at: accepting, to: closed)
        precondition(!ClaudeSignInBridge.acceptingDirectoryReady(accepting.path))
        let late = UUID().uuidString.lowercased()
        refused = runDemo(late, shell: "/bin/sh")
        precondition(refused.status == 1 && refused.output == ClaudeSignInBridge.notTakingSignIns, refused.output)
        precondition(!FileManager.default.fileExists(atPath: accepting.path) && record(late, in: closed) == nil && !FileManager.default.fileExists(atPath: ran.path))

        // A link in its place is not the Demo's directory.
        try! FileManager.default.createSymbolicLink(at: accepting, withDestinationURL: closed)
        precondition(!ClaudeSignInBridge.acceptingDirectoryReady(accepting.path))
        refused = runDemo(late, shell: "/bin/sh")
        precondition(refused.status == 1 && record(late, in: closed) == nil && !FileManager.default.fileExists(atPath: ran.path))
        try! FileManager.default.removeItem(at: accepting)

        // The bridge takes only a private directory of this account, and never writes over a script.
        try! FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: closed.path)
        precondition(!ClaudeSignInBridge.acceptingDirectoryReady(closed.path))
        precondition(!ClaudeSignInBridge.acceptingDirectoryReady("relative/accepting"))
        let once = directory.appendingPathComponent("once.command")
        try! ClaudeSignInBridge.writeNewScript("first", to: once)
        precondition((try? ClaudeSignInBridge.writeNewScript("second", to: once)) == nil)
        precondition(String(decoding: FileManager.default.contents(atPath: once.path)!, as: UTF8.self) == "first")
        let pointed = directory.appendingPathComponent("pointed.command")
        try! FileManager.default.createSymbolicLink(at: pointed, withDestinationURL: directory.appendingPathComponent("elsewhere"))
        precondition((try? ClaudeSignInBridge.writeNewScript("x", to: pointed)) == nil)
        precondition(!FileManager.default.fileExists(atPath: directory.appendingPathComponent("elsewhere").path))
        print("Claude sign-in command tests passed")
    }
}

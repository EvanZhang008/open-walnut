import Foundation

/// The "Copy & Open" group's copy rows: what takes the session elsewhere (a
/// terminal on the Mac, a note), the same three as the web session menu.
struct SessionCopyItem: Identifiable, Equatable {
    let id: String
    let title: String
    let systemImage: String
    let value: String

    static func items(sessionId: String, cwd: String?) -> [SessionCopyItem] {
        var rows: [SessionCopyItem] = []
        let dir = cwd?.trimmingCharacters(in: .whitespaces) ?? ""
        if !dir.isEmpty {
            rows.append(SessionCopyItem(id: "session.copyFolder", title: "Copy Folder Path", systemImage: "folder", value: dir))
        }
        rows.append(SessionCopyItem(id: "session.copyId", title: "Copy Session ID", systemImage: "number", value: sessionId))
        let resume = dir.isEmpty ? "claude -r \(sessionId)" : "cd \(shellWord(dir)) && claude -r \(sessionId)"
        rows.append(SessionCopyItem(id: "session.copyResume", title: "Copy Resume Command", systemImage: "terminal", value: resume))
        return rows
    }

    /// A path as one shell word: bare when it is plain, single-quoted otherwise
    /// (the web menu's `shellWord`).
    static func shellWord(_ path: String) -> String {
        let plain = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_@%+=:,./~-")
        if path.unicodeScalars.allSatisfy({ plain.contains($0) }) { return path }
        return "'" + path.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }
}

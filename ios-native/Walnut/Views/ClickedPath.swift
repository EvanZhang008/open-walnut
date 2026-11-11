import Foundation

/// Which sheet opens a tapped path, and on which host.
enum ClickedPathRoute: Equatable {
    case directory(DirectoryTarget)
    case html(FilePreviewTarget)
    case text(TextFileTarget)
}

/// The one way a tapped path is opened: look it up first, then open it from the
/// host that has it.
///
/// A session on one host often names a file on another (a Mac path in a Linux
/// session: a handoff, a video recorded on the Mac). Opening every path on the
/// session's host dead-ended those taps. `GET /v1/files/locate` checks the
/// session's host and the user's other hosts (src/web/routes/files-locate.ts);
/// a path no host has opens as one plain line, never a stand-in. An explicit source (a letter or board row,
/// `sourceOnly`) is never replaced by another host's file of that name. Every surface
/// that routes a tapped path goes through `locate`;
/// tests/web/clicked-path-sinks.test.ts fails on one that builds a target itself.
enum ClickedPath {
    /// The server's name for the primary's own machine, which on the phone is the Mac.
    private static let serverLocalName = "Local"
    static let macName = "your Mac"

    static func phoneName(_ serverName: String) -> String {
        serverName == serverLocalName ? macName : serverName
    }

    /// "Couldn't find <path> on A, B or C."
    static func missingLine(path: String, checked: [String]) -> String {
        let names = checked.map(phoneName)
        let whereText: String
        switch names.count {
        case 0: whereText = "any of your machines"
        case 1: whereText = names[0]
        default: whereText = names.dropLast().joined(separator: ", ") + " or " + names[names.count - 1]
        }
        return "Couldn't find \(path) on \(whereText)."
    }

    /// The sheet for `ref` on `host`, with no lookup: directory, rendered HTML, or text.
    static func route(_ ref: FilePathRef, host: String?, cwd: String?, sessionID: String?,
                      hostNote: String? = nil, missing: String? = nil) -> ClickedPathRoute {
        if missing == nil {
            if ref.looksLikeDirectory { return .directory(DirectoryTarget(path: ref.path, host: host)) }
            if FilePreviewLink.isPreviewablePath(ref.path) { return .html(FilePreviewTarget(path: ref.path, host: host)) }
        }
        return .text(TextFileTarget(ref: ref, host: host, cwd: cwd, sessionID: sessionID,
                                    hostNote: hostNote, missing: missing))
    }

    /// "local", "__local__", "" and nil all name the primary.
    private static func hostKey(_ host: String?) -> String {
        let h = host?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return h == "local" || h == "__local__" ? "" : h
    }

    /// The route for what the server answered about `ref` tapped in a session on `host`.
    /// `sourceOnly`: an older primary ignores that flag and may answer from another host, so refuse that answer here.
    static func route(_ ref: FilePathRef, location: PathLocation, host: String?, cwd: String?,
                      sessionID: String?, sourceOnly: Bool = false) -> ClickedPathRoute {
        if sourceOnly, location.found, location.missing != true,
           location.elsewhere == true || hostKey(location.host) != hostKey(host) {
            let source = hostKey(host).isEmpty ? serverLocalName : hostKey(host)
            return route(ref, host: host, cwd: cwd, sessionID: sessionID,
                         missing: missingLine(path: ref.path, checked: [source]))
        }
        if location.missing == true {
            return route(ref, host: host, cwd: cwd, sessionID: sessionID,
                         missing: missingLine(path: ref.path, checked: location.checked ?? []))
        }
        guard location.found else { return route(ref, host: host, cwd: cwd, sessionID: sessionID) }
        let found = FilePathRef(path: location.path,
                                line: ref.line ?? location.line,
                                endLine: ref.line != nil ? ref.endLine : location.endLine,
                                column: ref.column ?? location.column,
                                raw: ref.raw)
        let foundHost = location.host.flatMap { $0.isEmpty ? nil : $0 }
        guard location.elsewhere == true else {
            return route(found, host: foundHost ?? host, cwd: cwd, sessionID: sessionID)
        }
        // The session's cwd and transcript are on its own host, not this one.
        let name = foundHost == nil ? macName : phoneName(location.hostName ?? foundHost ?? "")
        return route(found, host: foundHost, cwd: nil, sessionID: nil, hostNote: "Opened from \(name).")
    }

    /// No machine is known for `ref`: nothing was read, and the viewer offers the user's machines
    /// to open it from (`TextFileTarget.unknownSource`), never one picked for them.
    /// `notRecorded`: Walnut has no record of who wrote it; else the record could not be read now.
    static func unreachableSource(_ ref: FilePathRef, notRecorded: Bool = false) -> ClickedPathRoute {
        let missing = notRecorded
            ? "The machine this link was written on was not recorded, so Walnut will not guess. No file was read yet."
            : "The machine this link was written on isn't available right now. No file was read yet."
        var target = TextFileTarget(ref: ref, missing: missing)
        target.unknownSource = true
        return .text(target)
    }

    /// Look `ref` up, then route it. A server that cannot answer (an older primary
    /// has no locate) opens the path on the session's host, as before.
    static func locate(_ ref: FilePathRef, host: String?, cwd: String?, sessionID: String?,
                       sourceOnly: Bool = false, api: WalnutAPI = WalnutAPI()) async -> ClickedPathRoute {
        let fromHost = host.flatMap { $0.isEmpty ? nil : $0 }
        do {
            let location = try await api.locatePath(ref: ref.path, cwd: cwd, host: fromHost,
                                                    sessionID: sessionID, sourceOnly: sourceOnly)
            return route(ref, location: location, host: fromHost, cwd: cwd, sessionID: sessionID,
                         sourceOnly: sourceOnly)
        } catch {
            return route(ref, host: fromHost, cwd: cwd, sessionID: sessionID)
        }
    }
}

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
/// a path no host has opens as one plain line, never a stand-in. The writer's machine is asked first and
/// wins when it has the file; only a machine the user tapped (`sourceOnly`) is never replaced by another
/// host's file of that name. Every surface
/// that routes a tapped path goes through `locate`;
/// tests/web/clicked-path-sinks.test.ts fails on one that builds a target itself.
enum ClickedPath {
    /// The server's name for the primary's own machine, which on the phone is the Mac.
    private static let serverLocalName = "Local"
    static let macName = "your Mac"

    static func phoneName(_ serverName: String) -> String {
        serverName == serverLocalName ? macName : serverName
    }

    /// "Couldn't find <path> on A, B or C." For an every-machine lookup (`anywhere`, the writer not
    /// known) it also names the machines that did not answer (`unreachable`), and says so when no
    /// machine could be asked or the path is relative (no folder to read it in). The web's twin is
    /// `missingPathLine` (web/src/hooks/useClickedPathOpener.ts).
    static func missingLine(path: String, checked: [String], anywhere: Bool = false,
                            unreachable: [String] = []) -> String {
        let names = checked.map(phoneName)
        if anywhere {
            if !(path.hasPrefix("/") || path == "~" || path.hasPrefix("~/")) {
                return "Couldn't open \(path): it is a relative path, and Walnut does not know which session's folder it is in."
            }
            let silent: String? = unreachable.isEmpty ? nil
                : "\(list(unreachable.map(phoneName))) did not answer, so the file may be there."
            if names.isEmpty {
                return silent.map { "Couldn't look for \(path): \($0)" } ?? "Couldn't look for \(path): no machine could be asked."
            }
            return "Couldn't find \(path) on \(list(names))." + (silent.map { " \($0)" } ?? "")
        }
        return "Couldn't find \(path) on \(names.isEmpty ? "any of your machines" : list(names))."
    }

    /// "A", "A or B", "A, B or C".
    private static func list(_ names: [String]) -> String {
        names.count <= 1 ? names.joined()
            : names.dropLast().joined(separator: ", ") + " or " + names[names.count - 1]
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
    /// `anywhere`: every machine was asked (the writer is not known), so a miss names who did not answer.
    static func route(_ ref: FilePathRef, location: PathLocation, host: String?, cwd: String?,
                      sessionID: String?, sourceOnly: Bool = false, anywhere: Bool = false) -> ClickedPathRoute {
        if sourceOnly, location.found, location.missing != true,
           location.elsewhere == true || hostKey(location.host) != hostKey(host) {
            let source = hostKey(host).isEmpty ? serverLocalName : hostKey(host)
            return route(ref, host: host, cwd: cwd, sessionID: sessionID,
                         missing: missingLine(path: ref.path, checked: [source]))
        }
        if location.missing == true {
            return route(ref, host: host, cwd: cwd, sessionID: sessionID,
                         missing: missingLine(path: ref.path, checked: location.checked ?? [], anywhere: anywhere,
                                              unreachable: location.unreachable ?? []))
        }
        guard location.found else {
            // No machine of its own to open it on: reading the primary would be a guess.
            if anywhere { return route(ref, host: nil, cwd: nil, sessionID: nil, missing: missingLine(path: ref.path, checked: [], anywhere: true)) }
            return route(ref, host: host, cwd: cwd, sessionID: sessionID)
        }
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

    /// Look `ref` up, then route it. A server that cannot answer (an older primary
    /// has no locate) opens the path on the session's host, as before. `anywhere`: the writer is
    /// not known, so every machine is asked, the task's (`taskID`) first, and the file opens from the
    /// one that has it; the person is never asked to pick a machine.
    static func locate(_ ref: FilePathRef, host: String?, cwd: String?, sessionID: String?,
                       sourceOnly: Bool = false, anywhere: Bool = false, taskID: String? = nil,
                       api: WalnutAPI = WalnutAPI()) async -> ClickedPathRoute {
        let fromHost = host.flatMap { $0.isEmpty ? nil : $0 }
        let anywhere = anywhere && fromHost == nil && !sourceOnly
        do {
            let location = try await api.locatePath(ref: ref.path, cwd: cwd, host: fromHost,
                                                    sessionID: sessionID, sourceOnly: sourceOnly,
                                                    anywhere: anywhere, taskID: taskID)
            return route(ref, location: location, host: fromHost, cwd: cwd, sessionID: sessionID,
                         sourceOnly: sourceOnly, anywhere: anywhere)
        } catch {
            if anywhere {
                return route(ref, host: nil, cwd: nil, sessionID: nil, missing: missingLine(path: ref.path, checked: [], anywhere: true))
            }
            return route(ref, host: fromHost, cwd: cwd, sessionID: sessionID)
        }
    }
}

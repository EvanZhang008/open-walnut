import Foundation

// MARK: - Models for the frozen /api/v1 REST+SSE contract (docs/api-v1.md)

struct ServerStatus: Codable, Equatable {
    enum Mode: String, Codable {
        case live = "LIVE"
        case replica = "REPLICA"
    }

    let mode: Mode
    let cloud: Bool
    let version: String
    let serverTime: String
    let lastSyncAt: String?
}

struct ConversationSummary: Codable, Identifiable, Equatable {
    let id: String
    let title: String?
    let updatedAt: String
    let messageCount: Int
}

struct ChatMessage: Codable, Identifiable, Equatable {
    enum Kind: String, Codable {
        case tool
        case thinking
    }

    let id: String
    let role: String // "user" | "assistant"
    let text: String
    let createdAt: String
    let kind: Kind?

    // Client-only flag for optimistic user bubbles (not part of the wire format).
    var pending: Bool? = nil

    private enum CodingKeys: String, CodingKey {
        case id, role, text, createdAt, kind
    }

    var isUser: Bool { role == "user" }
}

struct NoteTreeNode: Codable, Identifiable, Equatable {
    enum NodeType: String, Codable {
        case file
        case folder
    }

    let name: String
    let path: String
    let type: NodeType
    let kind: String? // "note" | "attachment" (files only)
    let children: [NoteTreeNode]?

    var id: String { path }
    var isAttachment: Bool { kind == "attachment" }
}

struct NoteContent: Codable {
    let content: String
    let contentHash: String
    let updatedAt: String
}

struct NoteWriteResult: Codable {
    let contentHash: String
    let updatedAt: String
}

// MARK: - Notes search (/api/notes-v2/search)

struct NoteSearchResult: Codable, Identifiable, Equatable {
    let id: String
    let path: String
    let title: String
    /// May contain `<mark>` tags around query matches.
    let snippet: String
    let matchType: String
}

struct NoteSearchResponse: Codable {
    let results: [NoteSearchResult]
    let degraded: String?
}

// MARK: - Favorites (/api/favorites — the bookmark store shared with the web UI)

struct FavoritesResponse: Codable {
    let notes: [String]
}

// MARK: - Error envelope

/// Wire shape: `{ "error": { "code", "message" }, ...extras }`.
struct APIErrorEnvelope: Codable {
    struct Inner: Codable {
        let code: String
        let message: String
    }

    let error: Inner
    // Note-conflict extras ride at the top level of the envelope.
    let serverHash: String?
    let serverContent: String?
}

enum APIError: Error, LocalizedError {
    case notConfigured
    case network(underlying: Error)
    case unauthorized
    case rateLimited
    /// Server-provided v1 error (code + message + optional conflict extras).
    case server(status: Int, code: String, message: String, serverHash: String?, serverContent: String?)
    case badResponse

    var errorDescription: String? {
        switch self {
        case .notConfigured: return "Server not configured"
        case .network(let underlying): return underlying.localizedDescription
        case .unauthorized: return "Unauthorized — check your device token"
        case .rateLimited: return "Too many requests — try again in a moment"
        case .server(_, _, let message, _, _): return message
        case .badResponse: return "Unexpected server response"
        }
    }

    var code: String? {
        if case .server(_, let code, _, _, _) = self { return code }
        return nil
    }

    var isTurnActive: Bool { code == "turn_active" }
    var isConflict: Bool { code == "conflict" }
}

import Foundation

/// A task's own MEMORY.md (`GET /api/v1/tasks/:id/agent-memory`): the working memory the CEO or a
/// VP writes for itself. Read only here: the agent owns it.
struct AgentMemoryView: Codable {
    struct Memory: Codable {
        struct Refused: Codable {
            let at: String?
            let chars: Int
        }
        let text: String
        let at: String?
        let refused: Refused?
    }

    /// nil: it has written none.
    let memory: Memory?
    let chars: Int
    let softLimit: Int
    let limit: Int

    private enum CodingKeys: String, CodingKey {
        case memory, chars, limit
        case softLimit = "soft_limit"
    }
}

extension WalnutAPI {
    func agentMemory(taskId: String) async throws -> AgentMemoryView {
        try await get("/tasks/\(escape(taskId))/agent-memory")
    }

    /// The user's own standing instructions for the CEO or a VP; "" clears them. The agent reads
    /// them with its next message. Only the Mac writes them (a companion answers 501).
    func setOrgInstructions(taskId: String, text: String) async throws {
        struct Ack: Codable {}
        let _: Ack = try await send("PUT", "/org/nodes/\(escape(taskId))", body: ["instructions": text])
    }
}

import SwiftUI

struct InboxItemOperationDetails: View {
    let plan: InboxItemPlan
    @State private var expanded = false
    var body: some View {
        DisclosureGroup("Operation details", isExpanded: $expanded) {
            ScrollView {
                VStack(alignment: .leading, spacing: 8) {
                    Text(plan.source.copyText)
                    if let taskId = plan.taskId { Text("Task ID: \(taskId)") }
                    if let messageId = plan.messageId { Text("Message ID: \(messageId)") }
                    if let key = plan.idempotencyKey { Text("Idempotency key: \(key)") }
                    if let launch = plan.launch {
                        Text("Host: \(launch.host)\nWorking directory: \(launch.cwd)\nEngine: \(launch.engine)\nModel: \(launch.model)\nMode: \(launch.mode)")
                    }
                    ForEach(Array(plan.ops.enumerated()), id: \.offset) { index, op in
                        Text("\(index + 1). \(op.tool)").font(.caption.weight(.semibold))
                        Text(op.args.pretty)
                    }
                    Text("Plan: \(plan.id), version \(plan.version)")
                    Button("Copy operation details") {
                        let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
                        UIPasteboard.general.string = (try? encoder.encode(plan)).flatMap { String(data: $0, encoding: .utf8) }
                    }.frame(minHeight: 44)
                }.font(.caption).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
            }.frame(maxHeight: 240)
        }.font(.body).accessibilityIdentifier("inbox.item.operationDetails")
    }
}

#if DEBUG
import SwiftUI

/// DEBUG-only engine harness: hosts the real TimelineHost over a synthetic
/// field-scale transcript with a scripted live stream — lets Maestro drive a
/// real scroll + streaming session in the simulator WITHOUT a server, before
/// the engine is adopted by the product pages.
///
/// Launch with `--timeline-harness` (RootView checks the argument), or push
/// it from any DEBUG navigation.
struct TimelineHarnessView: View {
    @State private var store = TimelineHarnessStore()

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                Button(store.streamOn ? "Stop stream" : "Start stream") {
                    store.streamOn ? store.stopStream() : store.startStream()
                }
                .accessibilityIdentifier("harness.stream")
                Button("Append 50") { store.appendMessages(50) }
                    .accessibilityIdentifier("harness.append")
                Button("Bottom") { store.scrollToBottomSignal += 1 }
                    .accessibilityIdentifier("harness.bottom")
                Spacer()
                Text("\(store.messages.count) msgs")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("harness.count")
            }
            .font(.footnote)
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
            Divider()
            TimelineHost(
                messages: store.messages,
                streaming: store.streaming,
                liveText: store.liveText,
                liveTextTruncated: false,
                activity: store.activity,
                scrollToBottomSignal: store.scrollToBottomSignal,
                isPinned: { store.bottomPinned },
                setPinned: { store.bottomPinned = $0 },
                geometryFrozen: { false },
                onAction: { _ in }
            )
            .accessibilityIdentifier("harness.timeline")
        }
        .navigationTitle("Timeline Harness")
        .navigationBarTitleDisplayMode(.inline)
    }
}

/// Synthetic data source shaped like the real stores (same field names the
/// TimelineHost consumes), fed by TranscriptFixtures-style content.
@Observable
@MainActor
final class TimelineHarnessStore {
    var messages: [ChatMessage] = []
    var streaming = false
    var liveText = ""
    var activity: String?
    var scrollToBottomSignal = 0
    @ObservationIgnored var bottomPinned = true
    @ObservationIgnored var streamOn = false
    @ObservationIgnored private var streamTask: Task<Void, Never>?
    @ObservationIgnored private var counter = 0

    private static let cjk =
        "这一轮的分析结论如下:控制面在高负载下的重列风暴会导致缓存穿透,"
        + "监控指标显示每分钟的请求量在峰值时刻翻了三倍。**关键点**:先确认限流开关。"
    private static let code = "```bash\nkubectl get pods -A | sort | uniq -c | head -20\n```"

    init() {
        appendMessages(120)
    }

    func appendMessages(_ n: Int) {
        var next = messages
        for _ in 0..<n {
            counter += 1
            let i = counter
            let ts = String(format: "2026-08-08T06:%02d:%02dZ", (i / 60) % 60, i % 60)
            switch i % 10 {
            case 0..<5:
                next.append(ChatMessage(
                    id: "h-\(i)", role: "assistant",
                    text: i % 3 == 0
                        ? "## 第 \(i) 轮结论\n\n\(Self.cjk)\n\n\(Self.code)\n\n- 项目一:验证完成\n- 项目二:等待复核"
                        : "收到,第 \(i) 步完成。The check for step \(i) passed.",
                    createdAt: ts, kind: nil
                ))
            case 5..<8:
                next.append(ChatMessage(
                    id: "h-\(i)", role: "assistant", text: ["Bash", "Read", "Task"][i % 3],
                    createdAt: ts, kind: .tool,
                    detail: "harness command \(i)",
                    resultPreview: String(repeating: "result line \(i)\n", count: 8),
                    agent: i % 6 == 5 ? "explorer" : nil
                ))
            default:
                next.append(ChatMessage(
                    id: "h-\(i)", role: "user",
                    text: "继续第 \(i) 项,注意只读操作。", createdAt: ts, kind: nil
                ))
            }
        }
        messages = next
        scrollToBottomSignal += 1
    }

    func startStream() {
        guard !streamOn else { return }
        streamOn = true
        streaming = true
        liveText = ""
        activity = "Thinking"
        streamTask = Task { @MainActor [weak self] in
            var tick = 0
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(120))
                guard let self, self.streamOn else { return }
                tick += 1
                self.liveText += "流式输出第 \(tick) 段:\(Self.cjk)\n\n"
                if tick % 10 == 0 { self.liveText += Self.code + "\n\n" }
                self.activity = tick % 7 < 4 ? "Thinking" : "Bash · harness"
            }
        }
    }

    func stopStream() {
        streamOn = false
        streamTask?.cancel()
        streamTask = nil
        if !liveText.isEmpty {
            counter += 1
            messages.append(ChatMessage(
                id: "h-live-\(counter)", role: "assistant", text: liveText,
                createdAt: "2026-08-08T07:00:00Z", kind: nil
            ))
        }
        streaming = false
        liveText = ""
        activity = nil
    }
}
#endif

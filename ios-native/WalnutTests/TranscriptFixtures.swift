import Foundation

/// Synthetic session transcripts for the rendering perf tests — generated in
/// code, so there is no external fixture file or python step to keep in sync.
/// Content mirrors what agents actually produce (CJK analysis prose, markdown
/// tables, code blocks, tool rows, image markers) using strictly neutral,
/// made-up data.
enum TranscriptFixtures {
    struct Msg {
        let role: String
        let text: String
        let kind: String?
    }

    enum Profile: String, CaseIterable {
        case plain
        case heavyMarkdown
        case codeBlocks
        case imageMarkers
        case cjk
        case mixed
    }

    static let cjk =
        "这一轮的分析结论如下:控制面在高负载下的重列风暴会导致缓存穿透,"
        + "监控指标显示每分钟的请求量在峰值时刻翻了三倍,而下游的存储层延迟同步上升。"
        + "**关键点**:必须先确认限流开关的默认值,再评估回退方案的爆炸半径。"

    static let code = """
        ```bash
        kubectl get pods -A --no-headers | awk '{print $1}' | sort | uniq -c | sort -rn | head -20
        for i in $(seq 1 100); do curl -s localhost:8080/metrics | grep -c request_total; done
        ```
        """

    static func table(_ n: Int, rows: Int = 14) -> String {
        var out = "| 指标\(n) | 基线 | 峰值 | P99 | 判定 |\n|---|---|---|---|---|\n"
        for i in 1...rows {
            out += "| metric-\(n)-\(i) | \(i * 13)ms | \(i * 97)ms | \(i * 211)ms | \(i % 2 == 1 ? "超标" : "正常") |\n"
        }
        return String(out.dropLast())
    }

    private static func toolRow(_ i: Int) -> Msg {
        Msg(role: "assistant", text: "Bash", kind: "tool")
    }

    private static func assistant(_ i: Int, _ profile: Profile) -> Msg {
        let text: String
        switch profile {
        case .plain:
            text = "收到,第 \(i) 步已经完成。下一步我会继续检查配置并汇报结果。The check for step \(i) passed."
        case .heavyMarkdown:
            text = ["## 第 \(i) 轮结论", cjk, table(1), code, cjk, table(2),
                    "- 项目一:验证完成\n- 项目二:等待复核\n- 项目三:已回滚"].joined(separator: "\n\n")
        case .codeBlocks:
            text = "运行结果如下:\n\(code)\n共 \(i * 3) 个匹配项。\n\(code)"
        case .imageMarkers:
            text = "分析截图:`/tmp/perf-probe/latency-\(i).png` 以及 /tmp/perf-probe/heatmap-\(i).png 供参考。\n\n\(cjk)"
        case .cjk:
            text = [cjk, cjk, cjk].joined(separator: "\n\n")
        case .mixed:
            switch i % 4 {
            case 0: text = ["## 第 \(i) 轮结论", cjk, table(1), code].joined(separator: "\n\n")
            case 1: text = "收到,第 \(i) 步完成。"
            case 2: text = "运行结果:\n\(code)"
            default: text = [cjk, table(2)].joined(separator: "\n\n")
            }
        }
        return Msg(role: "assistant", text: text, kind: nil)
    }

    private static func userRow(_ i: Int, _ profile: Profile) -> Msg {
        if profile == .imageMarkers, i % 20 == 9 {
            return Msg(
                role: "user",
                text: "[Images attached — use the Read tool to view them]\n- /tmp/shots/shot-\(i).png\n\n看下这个截图第 \(i) 张,哪里不对?",
                kind: nil
            )
        }
        return Msg(role: "user", text: "继续第 \(i) 项,注意别动生产配置,只读操作。把结果整理成表格。", kind: nil)
    }

    /// Same 6:2:2 assistant/tool/user rhythm as real transcripts.
    static func transcript(count: Int, profile: Profile) -> [Msg] {
        (0..<count).map { i in
            switch i % 10 {
            case 0..<6: return assistant(i, profile)
            case 6..<8: return toolRow(i)
            default: return userRow(i, profile)
            }
        }
    }
}

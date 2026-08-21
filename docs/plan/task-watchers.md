# Task Watchers — 等待外部条件成立后自动唤醒任务

## Executive Summary

给任务加一个「等什么」：任务停在 Wait 层不占注意力，Walnut 在后台按节奏轮询一个条件（CR 是否被 approve / merge、变更是否部署到某一环、对方是否回了邮件），条件成立就把任务变红并按预设动作唤醒它。

四个结论先说：

1. **不建新子系统**。Watcher = 一条 cron job + 一个新 executor 类型 `watcher`，直接复用 cron 引擎已有的锁、抖动、重入保护、定义/运行态双文件拆分（防重放风暴）、REST、Settings UI。新增代码集中在「探针 + 判定 + 触发动作」。
2. **两种探针，都要**。`command` 探针跑一条固定 argv（`gh pr view --json state` 这类），确定、便宜；`agent` 探针跑一次隔离 agent turn，能用 skill 去查邮件、查看板这类没有干净 CLI 的东西。
3. **变红走既有机制**。命中后把任务 phase 推到 `AWAIT_HUMAN_ACTION` + `unread`，红底和红点就是现成的（红底必须 phase 驱动，不能挂 unread）。任务同时从 Wait 层升回 Focus 层。
4. **设计入口是一个 fork**。从任务里点「Add watcher」，fork 该任务的执行 session（它已经知道 CR 号、仓库、部署目标），人和 AI 聊清楚等什么，AI 调 `watch_create` 落库，人在 UI 上按一次「Arm」确认那条命令，才真正开始轮询。

## 1. 名字

推荐 **Watcher**（动词 watch）。理由：名词能单独说（"这个任务有一个 watcher"、"watcher 命中了"），和已有词汇不撞（Routine 是「按时做事」，Hook 是「事件发生时做事」，Watcher 是「等事情成立」），前端也刚好有现成的 `wait` focus tier 承接。

术语表：

| 概念 | 名字 |
|---|---|
| 整体功能 | Watchers |
| 一条定义 | a Watcher |
| 检查动作 | probe（探针） |
| 条件成立 | met |
| 开始轮询 | arm（装上） |
| 停止 | disarm |
| 命中后要做的事 | `onMet` |
| 设计用的 fork | Watcher Designer session |

备选是 **Wait Condition**（字段 `waitOn`），更直白但当名词说很别扭（"这个 wait condition 触发了"），且和 `await_human_action`、`AWAIT` 系列词容易混。

## 2. 架构

现状（每块都已存在）：

```
Task ──focus_tier='wait'──> 停在 Wait 层，靠人自己想起来去看
Cron/Routines ── schedule + executor ──> 到点就做事（main-agent / walnut-agent / claude-code）
Hooks ── 事件发生 ──> send_message_to_session / notify / run_agent
Phase 机 ── AWAIT_HUMAN_ACTION ──> 红底 + unread 红点
Daemon ── fs.* / git.diff / session.* ──> 宿主机本地的活在 daemon 里干
```

加入 Watcher 后：

```
                    ┌─────────────────────────────────────────────┐
   Task ────watcherId────>│  Watcher (= CronJob, kind='watcher')       │
   focus_tier='wait'      │  probe + condition + poll 节奏 + deadline   │
                          └───────────────┬─────────────────────────┘
                                          │ 每 N 分钟一次 tick（cron timer）
                          ┌───────────────▼─────────────────────────┐
                          │  watcher executor                       │
                          │  1. 跑 probe                            │
                          │  2. 判定 met / not-met / error          │
                          │  3. 去抖（连续 K 次 met 才算）           │
                          │  4. met → onMet 动作，然后 disarm        │
                          └───────┬──────────────────┬──────────────┘
                                  │                  │
                  command 探针     │                  │  agent 探针
                                  ▼                  ▼
                    daemon `exec.probe`        runIsolatedAgentJob
                    （宿主机本地跑 argv）        （带 skill 的一次 agent turn）
```

**为什么 command 探针必须走 daemon**：条件通常绑在某台机器上（那台机的 `gh` 登录态、那台机的 ssh 配置、那个仓库的 checkout）。按仓库既有原则，只碰单机文件/进程的活就在那台机的 daemon 里跑，只把小结果（exit code + 截断的 stdout）过隧道。服务器进程绝不 spawn ssh 去轮询，也绝不有任何同步调用。

新增 daemon 能力 `exec.probe`（capability-gated）：入参 `{ argv[], cwd, timeoutMs, maxOutputBytes, env 白名单 }`，出参 `{ exitCode, stdout, stderr, durationMs }`。argv 数组，永不接受 shell 字符串。老 daemon 没这个能力时，该主机上的 command 探针直接报「host unsupported」并把 watcher 标成 broken，不静默。

## 3. 数据模型

Watcher 存在 cron 的 `cron-jobs.json` 里（定义随 git-sync 走），运行态在机器本地的 `cron-state.json`（这个拆分本来就是为了防另一台机的 stale `nextRunAtMs` 回声重放）。

```
CronJob {
  kind: 'routine' | 'watcher'        // 新增判别字段，两个 UI 各自过滤
  ownerHost: string                  // 新增：只有这台机轮询。定义随 git-sync 到 EC2 副本，
                                     // 没有这个字段两边会同时轮询、同时触发
  schedule: { kind: 'every', everyMs }   // watcher 只用 every
  executor: {
    type: 'watcher',
    config: WatcherConfig
  }
}

WatcherConfig {
  taskId: string                     // 绑定的任务（红底打给它）
  label: string                      // "CR 1234 merged"，UI 上一眼能看懂

  probe:
    | { kind: 'command', host, cwd, argv: string[], timeoutMs }
    | { kind: 'agent', instructions: string, model?, timeoutSeconds? }

  condition:                         // 怎么把 probe 输出判成 met
    | { kind: 'exit-zero' }
    | { kind: 'stdout-matches', pattern: string }     // 受限正则，有长度和回溯上限
    | { kind: 'json-path-equals', path: string, value: string }
    | { kind: 'agent-verdict' }      // agent 探针专用，读结构化 MET / NOT_MET / ERROR

  poll: {
    everyMs: number                  // 起始节奏，下限 60s
    backoff?: 'none' | 'decay'       // decay：命中前逐步放慢到 maxEveryMs
    maxEveryMs?: number
    debounceHits: number             // 连续几次 met 才算真的成立，默认 1，翻动的条件设 2
  }

  deadline: { atMs: number }         // 默认 7 天，上限 30 天。到点必须有个结局
  budget: { maxChecks: number, maxErrors: number }

  onMet: WatcherAction[]
  onTimeout: WatcherAction[]         // 默认 [{ kind:'flag-red', note:'watcher 超时未成立' }]

  armedBy: 'human'                   // 只有人能 arm，见第 6 节
  armedAtMs: number
  approvalFingerprint: string        // probe 的哈希，改了就必须重新 arm
}

WatcherAction =
  | { kind: 'flag-red' }                                  // phase → AWAIT_HUMAN_ACTION + unread
  | { kind: 'set-tier', tier: 'focus' | ... }
  | { kind: 'notify', title, body }                       // 复用 push 通道，手机能收到
  | { kind: 'send-message-to-session', message }           // 任务还有活着的 session 就直接喂
  | { kind: 'start-session', cwd, host, message, model }   // 复用 claude-code executor / delegate
  | { kind: 'append-note', section: 'Work Log', text }     // 留痕，谁在什么时候观察到了什么
```

任务侧只加一个轻字段：

```
Task {
  watcher_ids?: string[]    // 一个任务可以等多件事（CR merge 和 邮件回复）
}
```

不在任务里存 watcher 内容，避免两个写者。任务上只有指针，UI 要显示细节就按 id 取。这和 `depends_on`（等别的任务）是对称的：`depends_on` 等内部事实，watcher 等外部事实。

## 4. 生命周期

```
                  ┌──────────┐
  designer fork ─>│  draft   │  已落库，但不轮询，UI 上是灰的
                  └────┬─────┘
                 人点 Arm（看到完整 argv/host/interval）
                       ▼
                  ┌──────────┐  tick: probe → not-met → 下一次（可能放慢）
                  │  armed   │◄──────────────────────┐
                  └────┬─────┘                        │
        ┌──────────────┼───────────────┬──────────────┘
     met │        deadline │      连续报错 K 次 │
        ▼                 ▼                 ▼
   ┌─────────┐       ┌─────────┐       ┌─────────┐
   │   met   │       │ timeout │       │ broken  │
   │ onMet   │       │onTimeout│       │ 也变红， │
   │ disarm  │       │ disarm  │       │ 说清坏在哪│
   └─────────┘       └─────────┘       └─────────┘
```

三条硬规矩：

- **每条路径都有结局**。met、timeout、broken 都会给人一个可见信号。没有「悄悄不响了」这个状态（此前多起事故的共同教训）。
- **命中即 disarm**，不留着继续跑。需要重复观察的东西是 Routine，不是 Watcher。
- **每次 tick 都写运行态**（`lastCheckAtMs`、`lastVerdict`、`consecutiveErrors`、`checksUsed`），UI 上能看到「上次 3 分钟前检查过，还没成立」。看不到心跳的等待等于没有等待。

## 5. UX 场景

### 场景 A：CR 合了就来叫我

1. 任务 `修登录重定向` 的 session 刚把 CR 发出去，人在任务详情点 **Add watcher**。
2. Walnut fork 这个任务的执行 session（fork 的意义就在这：它已经知道 CR 号、仓库路径、分支名，不用人再复述一遍），首条消息由 `walnut-watcher-design` skill 注入，AI 直接问：「等这个 CR 被 merge 是吧？我打算这样查：……」
3. 人聊两句确认（比如「不是 merge，是部署到第一环之后」）。
4. AI 调 `watch_create`，参数里带上具体 argv、判定方式、5 分钟起步逐步放慢、7 天 deadline、命中后变红 + 手机推送。
5. UI 上任务详情出现一张灰卡：**Watcher (draft)** + 完整命令 + 主机 + 节奏 + deadline，一个 **Arm** 按钮。
6. 人点 Arm。任务自动落到 **Wait** 层，卡片上一行小字 `⏳ 等 CR 1234 部署到 stage-1 · 4 分钟前查过`。
7. 三小时后条件成立。任务变红底 + 红点 + 从 Wait 升到 Focus，手机收到推送，任务 note 的 Work Log 追加一行「stage-1 部署完成，观察于 14:32」。
8. 人打开任务，红点清掉（红底要等人真的处理完才走，因为红底是 phase 驱动的）。

### 场景 B：等别人回邮件

同样的 fork 流程，AI 判断这个没有干净 CLI 可查，改用 `agent` 探针：instructions 写「用邮件 skill 查收件箱里主题含 X 的新回复，只回 MET 或 NOT_MET 加一句证据」。节奏 30 分钟，deadline 5 天。命中后动作是变红 + 把对方回复摘要贴进 Work Log。

### 场景 C：watcher 坏了

`gh` 登录过期，探针连续 5 次非零退出且 stderr 里有认证字样。watcher 转 `broken`，任务变红，红卡上写清「watcher 已停：探针连续 5 次失败，最后一次 stderr: …」，两个按钮：**Fix in a fork**（再开一次 designer fork 改探针）、**Disarm**。绝不假装还在等。

### 场景 D：没有 AI 也能用

按仓库既有原则，AI 流程必须配一条直接手动路径：Watcher 卡上有 **Edit manually**，直接改 argv / 判定 / 节奏 / deadline（改完 fingerprint 变了，必须重新 Arm）。designer fork 是加速器，不是唯一入口。

## 6. 无人值守执行的安全设计

一条 AI 起草的命令，会在一台机器上每 5 分钟自动跑一次，跑七天。这是这个功能真正的风险点，四条约束：

1. **argv 数组，不接受 shell 字符串**。没有 shell 解释，就没有拼接注入。
2. **人必须 arm**。AI 只能建 draft。draft 永不轮询。arm 按钮旁边显示完整 argv、主机、cwd、节奏、deadline。这是仓库里已有的判断：自动消息不构成用户授权。
3. **fingerprint 绑定**。probe 任何字段变了，fingerprint 变，watcher 自动回 draft，必须重新 arm。AI 不能 arm 完再偷偷改。
4. **策略允许清单可选**。默认只靠人工 arm。想更严可以在 hooks 配置里给 watcher 探针加一层命令允许清单（沿用现有声明式 hook 规则的写法），默认零规则、不拦不改。

另外：探针输出永不进主对话上下文（截断到几 KB 只留在运行态里），`agent` 探针的 instructions 是模板化的，不把 probe 输出当指令执行。

## 7. 复用 vs 新增

| 已有，直接用 | 新增 |
|---|---|
| cron store 双文件拆分 + 文件锁 + 抖动 + 重入 + replayGuard | `kind` 判别字段、`ownerHost`、`deleteOnFire` |
| routines executor 注册表 + REST + 动态表单 | `watcher` executor（探针 + 判定 + 去抖 + 动作） |
| `runIsolatedAgentJob` | agent 探针（外加结构化裁决解析） |
| daemon 能力协商 | daemon `exec.probe` 命令 + capability |
| phase 机 / 红底 / unread | `flag-red` 动作 |
| focus tier `wait` + Wait tab | Wait 卡上的 watcher 摘要行 + 心跳时间 |
| push 通知 | `notify` 动作 |
| lane/task fork + skill 发现 | `walnut-watcher-design` skill + designer fork 入口 |
| `defineOp`（一处声明，MCP + CLI + `wn tools` 三处生效） | `watch_create` / `watch_list` / `watch_get` / `watch_arm` / `watch_disarm` / `watch_check_now` |
| Settings → Hooks/Routines 页 | Watchers 列表（或 Routines 页一个 tab） |

## 8. 失效模式与对策

| 会怎么坏 | 对策 |
|---|---|
| 两台机（Mac + 云副本）同时轮询同一条，触发两次 | `ownerHost`，非 owner 直接跳过 tick |
| 机器睡醒后一次性补跑一堆 | 沿用 cron 的 replayGuard + 运行态本机存储；watcher 永远只算「现在成立了吗」，不补历史 |
| 条件翻动（部署中途状态抖） | `debounceHits`，连续 K 次 met 才算 |
| 探针一直报错，人以为还在等 | `maxErrors` 后转 broken 并变红 |
| 永远不成立，watcher 长住 | 强制 deadline，默认 7 天，到点走 onTimeout |
| 轮询太密拖慢机器 | 下限 60s，`decay` 放慢，每条 watcher 独立超时，输出有上限 |
| 探针把服务器事件循环焊死 | 探针一律子进程 + 超时；服务器侧零同步调用；跨机的活在 daemon |
| 任务被删了 watcher 还在 | 任务删除时级联 disarm（沿用现有级联删除钩子） |
| 老 daemon 不认 `exec.probe` | 能力协商，arm 时就拒绝并说清原因，不等到运行时才炸 |

## 9. 分期

- **P1 骨架**：`watcher` executor + agent 探针 + `flag-red`/`notify`/`set-tier` 动作 + 任务卡摘要行 + 手动创建路径。不碰 daemon，先把生命周期和「变红」跑通。
- **P2 command 探针**：daemon `exec.probe` + capability + arm 审批 UI + fingerprint。
- **P3 designer fork**：`walnut-watcher-design` skill + 任务详情入口 + `watch_*` ops（MCP/CLI 一起到位）。
- **P4 收尾**：`start-session` 动作（命中后自动接着干）、`decay` 节奏、Watchers 管理页、broken 修复流。

每期按仓库规矩先写 E2E：P1 用假探针（可控地返回 not-met 三次再 met）验证 tick → 去抖 → 变红 → disarm 全链，UI 侧用 Playwright 真点击验证红底红点和 Wait/Focus 迁移；P2 用一个必然退出 0 / 必然退出 1 的真 argv 打 daemon；P3 验证 fork 出来的 session 真能通过 MCP 落一条 draft。

## 10. 待定

1. command 探针放不放进 P1（见上，倾向 P2，因为审批 UX 和 daemon 能力都是独立的一块）。
2. Watchers 单独一页，还是 Routines 页上加一个 tab（倾向 tab，同一个引擎同一个存储，多一页反而要维护两套过滤）。
3. `onMet` 里 `start-session` 要不要也需要单独审批（倾向要：这等于无人值守起一个有权限的 coding session）。

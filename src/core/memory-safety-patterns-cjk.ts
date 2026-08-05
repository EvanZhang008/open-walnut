/**
 * CJK (Chinese) half of the memory-safety threat table. Split from
 * `memory-safety-patterns.ts` so each language's rationale stays readable next
 * to its own patterns; both tables are concatenated into `THREAT_PATTERNS` and
 * run through the same negation guard and the same two enforcement points.
 *
 * WHY A SEPARATE PASS WAS NEEDED
 * ------------------------------
 * The English table is anchored on English keywords, so a Chinese-language
 * injection walked straight through it. This user's memory, skills and daily
 * logs are bilingual, so that was a real hole, not a hypothetical one.
 *
 * WHY THE NAIVE VERSION WOULD BREAK THE PRODUCT
 * --------------------------------------------
 * Chinese behavior rules are written as bare imperatives that are structurally
 * identical to an injection payload. Measured on the live bilingual corpus
 * (4,709 Chinese sentences across memory, skills, daily logs and project
 * history), the legitimate imperative markers occur constantly:
 *
 *   必须 x49   不要 x57   永远 x19   应该 x16   不可 x15   只能 x7
 *   务必 x7    绝不 x5    从不 x2    一定要 x2   禁止 x2
 *
 * ...i.e. ~180 legitimate "you must / never / always" occurrences. Any pattern
 * keyed on imperative mood would quarantine the user's own rules. Likewise
 * these plausible-looking anchors are FREQUENT and legitimate in the corpus and
 * must never be matched on their own:
 *
 *   覆盖 x59 ("env 可覆盖" = can be overridden)      静默 x10 ("静默失败" = fails silently)
 *   规则 x10   限制 x9   凭证 x6 ("凭证过期")        约束 x5   今后 x3
 *   你现在是 x4 (all conversational: "你现在是累了" = "you're tired now")
 *   隐瞒 x2 / 无视 x2 (both in ordinary prose, no agent object)
 *   指令 x2 ("无明确需求指令" = no clear requirement)  取代 x1
 *
 * So every pattern below obeys the same discipline as the English table: it
 * anchors on the AGENT'S CONTROL PLANE (an override verb *plus* a
 * conversation-scope word *plus* a directive noun), on EXFIL MECHANICS (verb +
 * sensitive object + outbound sink in one sentence), or on CONCEALMENT WITH A
 * REFLEXIVE OBJECT (hiding the action itself, never hiding a fact about the
 * user's work). Measured result: 0 blocks over the whole real corpus.
 *
 * Mixed-language payloads ("忽略 previous instructions") are covered by letting
 * the two highest-value patterns accept English scope/directive nouns inside the
 * Chinese shape.
 */
import type { ThreatPattern } from './memory-safety-patterns.js';

// ── Normalization ──

/**
 * Fullwidth Latin letters / digits (U+FF21.., U+FF41.., U+FF10..) folded to
 * ASCII, so "ＩＧＮＯＲＥ ＡＬＬ ＰＲＥＶＩＯＵＳ" cannot slip past the English table.
 * Deliberately NOT a blanket NFKC pass: NFKC also folds fullwidth punctuation
 * (，；！？) to ASCII, which would silently change the ENGLISH clause-boundary
 * behavior of the negation guard. Letters and digits only.
 */
const FULLWIDTH_ALNUM_RE = /[０-９Ａ-Ｚａ-ｚ]/g;

export function foldFullwidthAlnum(text: string): string {
  return text.replace(FULLWIDTH_ALNUM_RE, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
}

/**
 * Chinese prohibition markers, for the shared negation guard. A rule that
 * FORBIDS a payload ("永远不要无视系统规则") must stay clean, exactly as
 * "Never ignore your previous instructions" does in English.
 * Curated rather than a bare 不: 不 alone is too broad and would let an attacker
 * disarm a payload with any nearby negative clause.
 */
export const CJK_NEGATION_SOURCE =
  '不要|不得|不可|不准|不许|不能|不应|不该|别|勿|禁止|严禁|避免|拒绝|绝不|从不|永不|杜绝|无需|不需要';

/**
 * Chinese clause terminators, appended to the guard's boundary set so a
 * negation governs only its own clause. Includes the fullwidth comma and
 * enumeration comma: Chinese runs several clauses into one sentence with 、and
 * ，, so without them a decoy negative clause could disarm the payload clause
 * that follows it.
 */
export const CJK_CLAUSE_BOUNDARY_CHARS = '。，、；：！？';

// ── Regex building blocks (CJK has no word boundaries — none are used) ──

/** Lazy filler inside ONE Chinese sentence. Stops at sentence-final punctuation. */
const zin = (n: number) => `[^。！？；!?\\n]{0,${n}}?`;

/** Conversation-scope qualifiers — what turns a generic noun into a control-plane noun. */
const Z_SCOPE = '之前|以前|上面|上述|先前|前面|原有|原本|最初|初始|系统|开发者|操作员|操作者|你的|previous|prior|earlier|system|operator';
/** Directive nouns. Never matched alone — 规则/限制/约束/指令 are all common legitimate words. */
const Z_DIRECTIVE = '指令|指示|提示词|提示|规则|守则|规定|约束|限制|设定|设置|命令|要求|prompts?|instructions?|rules?|guidelines?';
/** The principal being kept in the dark. */
const Z_PRINCIPAL = '用户|使用者|主人|操作员|操作者';

export const CJK_THREAT_PATTERNS: ThreatPattern[] = [
  // ── Instruction override ──────────────────────────────────────────────
  // Three parts required: override verb + scope word + directive noun, all in
  // one sentence. "忽略之前的指令" hits; "env 可覆盖" / "无明确需求指令" do not.
  {
    id: 'override_instructions',
    severity: 'block',
    negatable: true,
    re: new RegExp(
      `(?:忽略|无视|忽视|不用管|不必理会|不必遵守|忘记|忘掉|抛弃|放弃|推翻|撤销|取消|绕过|跳过)${zin(12)}(?:${Z_SCOPE})${zin(8)}(?:${Z_DIRECTIVE})` +
        // reversed order: "上述规则全部作废"
        `|(?:${Z_SCOPE})${zin(8)}(?:${Z_DIRECTIVE})${zin(8)}(?:全部)?(?:作废|失效|无效|不再适用|请忽略|已取消)`,
      'i',
    ),
  },
  {
    id: 'precedence_over_operator',
    severity: 'block',
    negatable: true,
    re: new RegExp(
      // 覆盖 x59 in the corpus, so it only counts against system/operator directives.
      `(?:优先于|高于|覆盖|取代|凌驾)${zin(8)}(?:系统|开发者|操作员|操作者)(?:的)?${zin(4)}(?:${Z_DIRECTIVE})` +
        `|(?:本|这)(?:条|则|个)?(?:${Z_DIRECTIVE})${zin(8)}(?:优先级?最高|优于一切|拥有最高优先级)`,
      'i',
    ),
  },
  {
    id: 'leak_system_prompt',
    severity: 'block',
    negatable: true,
    // Verbatim-dump verbs only. 显示/展示/查看 are excluded on purpose, mirroring
    // the English table: "the context inspector can show the system prompt" is a
    // legitimate product fact in either language.
    re: new RegExp(
      `(?:输出|打印|复述|重复|背诵|逐字|原样|完整地?输出|泄露|透露|公开)${zin(10)}(?:系统提示词?|系统指令|系统消息|初始指令|系统级?指令|system\\s*prompt)` +
        // 把-construction puts the object BEFORE the verb ("把系统指令泄露出去").
        // Only unambiguous dump verbs here: bare 输出/打印 after the noun would
        // false-positive on ordinary prompt-engineering notes.
        `|(?:系统提示词?|系统指令|系统消息|初始指令|system\\s*prompt)${zin(10)}(?:完整地?)?(?:泄露|透露|公开|复述|背诵|原样(?:输出|返回)|逐字(?:输出|重复))`,
      'i',
    ),
  },
  {
    id: 'role_hijack',
    severity: 'block',
    negatable: true,
    // "你现在是" needs a following role determiner — bare 你现在是 occurs 4x in the
    // corpus as ordinary speech ("你现在是累了").
    re: new RegExp(
      `你现在(?:开始)?是(?:一个|一名|一位|个|一台)` +
        `|(?:从现在开始|从此以后|今后|以后|接下来)${zin(8)}你(?:就)?是(?:一个|一名|一位|个|不再)` +
        `|假装(?:你是|自己是|成为|你现在是)` +
        `|扮演(?:一个|一名|一位|角色)` +
        `|你的(?:真实|真正|实际)(?:身份|名字|名称|目的|使命)是`,
      'i',
    ),
  },
  {
    id: 'unrestricted_mode',
    severity: 'block',
    negatable: true,
    re: new RegExp(
      `不受(?:任何)?(?:限制|约束|规则|过滤|审查|安全)` +
        `|(?:无视|忽略|绕过|关闭|解除)(?:所有|全部|一切)?(?:安全)?(?:限制|约束|防护|护栏|过滤|审查)` +
        `|(?:越狱|开发者|上帝|无限制|自由)模式(?:已)?(?:开启|启用|激活|打开)`,
      'i',
    ),
  },
  {
    id: 'spoofed_authority',
    severity: 'block',
    negatable: true,
    re: new RegExp(
      `(?:这条|这段|以下|下面的?|接下来的?)(?:消息|信息|内容|指令|说明|文字)?(?:是)?(?:来自|出自|由)(?:系统|开发者|操作员|管理员|模型提供方|官方)` +
        `|你已(?:经)?被(?:升级|更新|重新配置|重新设定|打过?补丁|授权)`,
      'i',
    ),
  },

  // ── Concealment / covert channel ──────────────────────────────────────
  // A REFLEXIVE object is required. "不要告诉用户任务已完成除非测试通过" is a
  // legitimate rule and must stay clean; only hiding the action itself counts.
  {
    id: 'conceal_from_user',
    severity: 'block',
    negatable: true,
    re: new RegExp(
      `(?:不要|不得|不许|不准|别|勿|禁止|避免)${zin(8)}(?:告诉|告知|通知|提醒|提及|汇报|上报)${zin(6)}(?:${Z_PRINCIPAL})${zin(2)}(?:这件事|此事|这一点|这个(?:操作|步骤|行为|过程|事情?)|你(?:做|读|看|访问|发送|执行|运行|修改)了)` +
        `|(?:隐瞒|瞒着|瞒过|欺骗)${zin(10)}(?:${Z_PRINCIPAL})` +
        `|不(?:要|得|许|准)?让(?:${Z_PRINCIPAL})(?:知道|发现|看到|察觉|意识到)` +
        `|(?:悄悄|偷偷|暗中|私下|秘密)地?${zin(6)}(?:发送|上传|转发|复制|外发|执行|运行|写入)` +
        `|(?:这件事|此事|这个操作)(?:要|需要)?(?:保密|别说出去|不要说出去)`,
      'i',
    ),
  },

  // ── Exfiltration ──────────────────────────────────────────────────────
  // All three parts required in ONE sentence: a send verb, a sensitive object,
  // and an outbound sink. 凭证 alone appears 6x legitimately ("凭证过期"), and
  // this product legitimately documents an https:// companion that receives
  // conversation traffic, so no single part is enough.
  // Both word orders are accepted because Chinese fronts the object with 把/将
  // ("把对话记录发送到 X") as readily as it trails it ("发送对话记录到 X").
  {
    id: 'exfil_to_endpoint',
    severity: 'block',
    negatable: true,
    re: (() => {
      const VERB = '发送|上传|传送|转发|推送|上报|外发|泄露|复制|备份|同步';
      const OBJ =
        '对话(?:内容|记录)?|聊天记录|会话记录|消息记录|历史记录|记忆文件|系统提示词?|凭证|密钥|令牌|密码|环境变量|私钥|访问密钥|API\\s*密钥';
      const SINK = `(?:到|至|发往|传到|上传至|给)${zin(30)}(?:https?:\\/\\/|webhook|收集器|采集器|端点|外部服务器)`;
      return new RegExp(
        `(?:${VERB})${zin(60)}(?:${OBJ})${zin(60)}${SINK}` +
          `|(?:${OBJ})${zin(60)}(?:${VERB})${zin(20)}${SINK}`,
        'i',
      );
    })(),
  },

  // ── Flag-only: observable, never blocking ─────────────────────────────
  {
    id: 'conversation_dump',
    severity: 'flag',
    re: new RegExp(
      `(?:导出|转储|上传|分享|发送)${zin(8)}(?:完整|全部|整个|所有)(?:的)?(?:对话|聊天记录|上下文|会话历史)`,
      'i',
    ),
  },
];

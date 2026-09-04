/**
 * prompt.ts - 知识库加载与审计任务 prompt 组装
 * 首审/复审共用一套骨架，复审追加上下文与核销要求。
 * @author wwj
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AuditState } from "./store";

export interface Knowledge {
  text: string;
  version: string;
}

const KNOWLEDGE_FILES = ["value-judgment.md", "pmf-matrix.md", "sustain-loop.md", "investor-qa-map.md"];

export function loadKnowledge(pkgRoot: string): Knowledge {
  const parts = KNOWLEDGE_FILES.map((f) => {
    const content = fs.readFileSync(path.join(pkgRoot, "knowledge", f), "utf8");
    return `<<<知识文件 ${f} 开始>>>\n${content}\n<<<知识文件 ${f} 结束>>>`;
  });
  // 外部知识层（B4 技术准备）：用户可在 ~/.value-audit/knowledge/ 放自己的补充题库/行业基准
  try {
    const extraDir = path.join(os.homedir(), ".value-audit", "knowledge");
    for (const f of fs.readdirSync(extraDir).filter((n) => n.endsWith(".md")).sort()) {
      const content = fs.readFileSync(path.join(extraDir, f), "utf8");
      parts.push(`<<<用户扩展知识 ${f} 开始>>>\n${content}\n<<<用户扩展知识 ${f} 结束>>>`);
    }
  } catch {
    /* 无扩展知识目录属正常 */
  }
  let version = "0.0.0";
  try {
    version = JSON.parse(fs.readFileSync(path.join(pkgRoot, "package.json"), "utf8")).version ?? version;
  } catch {
    /* 保底版本号 */
  }
  return { text: parts.join("\n\n"), version };
}

export interface PromptOptions {
  projectPath: string;
  profileText: string;
  factsText: string;
  knowledge: Knowledge;
  prevState: AuditState | null;
  gitDiffStat: string | null;
  seq: number;
  prevReportLines?: number;
  journalText?: string;
  focusText?: string;
}

export function buildAuditPrompt(o: PromptOptions): string {
  const isRevisit = (o.prevState?.audits.length ?? 0) > 0;
  const sections: string[] = [];

  sections.push(`# 价值审计任务（value-audit v${o.knowledge.version}，第 ${o.seq} 次审计）

你现在对项目 ${o.projectPath} 执行一次结构化价值审计。严格遵守以下纪律：

1. **零打扰**：全程不得向用户提问。能通过读取项目文件、git 历史、联网检索获得的信息一律自行获取；
   获取不到的按标记规则落为 [待验证] 并给出验证动作。唯一例外已由工具处理，你不需要任何交互。
2. **诚实**：每个结论标注来源，四类标记：
   - [代码证实]：必须附文件路径，且每个路径写完整相对路径（同目录多文件也逐个写全，禁止
     "internal/model/task.go、goal.go" 这类省略目录写法——保存时工具会逐个核实路径存在性）
   - [用户提供]：仅限 facts/决策日志已填内容；"[待补充]"视为未填写
   - [联网检索]：必须附来源 URL 与访问日期（见纪律 4）
   - [待验证]：禁止编造任何数字，只给回答框架 + 验证动作
3. **证据优先**：画像是入口不是全部。审计中你应该用 read 工具查看关键文件核实证据（只读，
   不修改任何项目文件），聚焦入口/核心流程/计费相关代码，控制读取量，不要遍历大目录。
4. **联网检索**：对外部市场类信息（竞品、定价基准、市场规模、可比公司）以及 facts 中标注
   "[你网络查询下]"（含"网络/搜索/查询"字样的方括号占位一律视为同义检索指令）的条目，应尝试联网核实：优先使用会话中可用的搜索/浏览器/抓取类工具，
   否则可用 bash 的 curl（只读 GET，不登录不提交表单）。规则：
   - 只采信权威可靠来源（官网、官方文档、知名机构/媒体报告），论坛传言不作为事实
   - 联网不能替代用户自身事实（用户数、团队、收入等仍只能来自 facts）
   - 单次审计检索控制在 8 次以内，聚焦最关键缺口；其中 2 次预留给“同类产品盈利模式/价格带”与
     “品类近 12 个月变化”（见知识库 sustain-loop A-2）；检索失败/无可靠结果/无网络 → 退回 [待验证]
5. **完成后必须调用工具 value_audit_save 提交结果**（只调用一次），不要把报告全文直接回复给用户。`);

  sections.push(`## 项目画像（已确定性采集，客观事实）\n\n${o.profileText}`);

  sections.push(`## 用户事实档案 facts.md 当前内容\n\n${o.factsText || "（尚未创建）"}`);

  if (o.journalText) {
    sections.push(`## 用户决策日志（journal.md 尾部，视为 [用户提供] 证据）\n\n${o.journalText}`);
  }

  if (o.focusText) {
    sections.push(`## 本次聚焦\n\n用户要求本次审计聚焦：${o.focusText}。与之相关的章节深入展开，其余章节从简但不省略结构。`);
  }

  sections.push(`## 方法论知识库（审计依据，逐条执行其中的"用法"与"输出要求"）\n\n${o.knowledge.text}`);

  if (isRevisit && o.prevState) {
    const last = o.prevState.audits[o.prevState.audits.length - 1];
    sections.push(`## 复审上下文（这是第 ${o.seq} 次审计，必须做变化对比）

上次审计（第 ${last.seq} 次，${last.timestamp}）结论：${last.verdict ?? "未解析"} —— ${last.verdictReason}

当前 backlog（含稳定 ID，你只能引用这些 ID 或用 B-NEW-x 新增，不得自造其他 ID）：
${JSON.stringify(o.prevState.backlog, null, 2)}

上次问答稿标记：
${JSON.stringify(o.prevState.questions)}

${o.gitDiffStat ? `自上次审计以来的代码变化（git diff --stat）：\n${o.gitDiffStat}` : "（无 git diff 可用：非 git 项目或锚点缺失，请基于画像与读码对比）"}

复审要求：
- 逐条核销 backlog：结合 diff 与实际读码验证，更新 status（open/partial/done/dropped）
- 全量重新审计（灯色判定基于当前全貌，防止"改了 A 弄坏 B"），不是只看 diff
- 若存在用户决策日志，对照"上次预测 → 实际走向"（上次建议的方向用户采纳/放弃了吗，现实反馈如何）
- diff 中若涉及指标计算、计费、权限/试用逻辑的变更，必须标注其对后续读数解读的影响
  （如新增试用期会系统性压低付费墙触达数，读数时误判"没人碰墙"）
- 报告第 6 节输出变化对比：灯色变化、backlog 核销结果、预测与实际对照、问答稿标记升级、facts 变化
- 升级归因用户（宜家效应/胜任感）：灯色提升或标记升级时，第 6 节必须归因到用户完成的
  具体动作（核销的 backlog ID、补填的 facts 条目）；工具是镜子，升级的功劳属于用户的改动
- 篇幅纪律：上次报告正文 ${o.prevReportLines ?? "?"} 行。若本次没有新的用户样本/facts 变化/收入变化，
  正文不得长于上次——无新信息却更长的报告，与用户在瓶颈不动时打磨外观是同一种自我消耗；
  第 2/3/5 节只写变化与结论，不重复上次已成立的论证`);
  }

  // 档案资产数据（T1 禀赋效应）：确定性统计由代码给出，防 LLM 编造/算错
  const audits = o.prevState?.audits ?? [];
  const trail = audits.length
    ? audits.map((a) => a.verdict ?? "?").join(" → ") + " → 本次待判"
    : "本次为首次审计，档案从现在开始积累";
  const backlog = o.prevState?.backlog ?? [];
  const cleared = backlog.filter((b) => b.status === "done" || b.status === "dropped").length;
  const journalCount = o.journalText ? o.journalText.split("\n").filter((l) => l.startsWith("- [")).length : 0;
  sections.push(`## 档案资产数据（确定性统计，报告第 7 节逐项引用，禁止改数或编造）

- 本次为第 ${o.seq} 次审计；历史灯色轨迹：${trail}
- 历史 backlog 累计 ${backlog.length} 条，已核销 ${cleared} 条（含放弃）；第 7 节引用时叠加本次新增/核销后的最新状态
- 决策日志（journal）条目：${journalCount} 条
- facts 已填条目：由你从上方 facts 内容统计非"[待补充]"条目数（仅此项由你数，其余禁止重算）`);

  sections.push(`## 报告结构要求（reportMarkdown 字段必须遵守）

# 价值审计报告：<项目名>
> 生成时间、第 ${o.seq} 次审计、代码锚点（git 短 hash 或"非 git 项目"）
## 0. 审计结论 —— 🔴/🟡/🟢 + 一句话理由（引用触发条款）
## 1. 项目画像与核心逻辑（画像摘要客观事实；末尾“核心逻辑提炼”固定四行：一句话核心逻辑/
   价值链路 输入→处理→输出→沉淀/钱在哪一步/靠人硬撑的原状，每行挂 [代码证实 路径]，见 sustain-loop A-1）
## 2. 价值审计七问（逐条：结论 + 灯色 + 证据）
## 3. 商业建议（付费方/定价推导逻辑/差异化/PMF 最薄弱 3 维度与风险），必含两个小节：
   - “持久盈利运转模型”：五环表（收入循环/留存循环/成本结构/获取渠道/壁垒累积）+ 最弱一环 +
     零代码验证动作，联网基准附 URL（sustain-loop A-2）
   - “用户观测现状与建议”：引用画像“观测/统计信号”分级（不得自行改级）；分级 <2 或事件不对应模块时，
     给最小事件集表（事件/含义/落点文件）+ 主推与备选工具（含地域与隐私判断）+ 负责人查看方式，
     并强制一条 backlog“最小事件集采集就绪（<工具>）”（有流量/即将推广 P0，无流量 P1）（sustain-loop B）
## 4. 行动 backlog（验证动作优先于代码改动，遵守知识库"处方纪律"；每条：ID、标题、
   类型[验证/代码]、方向、涉及文件或取数/访谈方法、预期信息量或收益、P0-P2；
   P0 优先给零代码验证动作；若存在上次遗留未动的 P0 条目，本节开头先列出提醒）
## 5. 投资人问答稿（**默认精简版**：仅回答已有 [代码证实]/[用户提供]/[联网检索] 证据的题目 + 缺口清单 +
   一段话说明何时值得做完整版；仅当 facts 明示"正在融资/准备路演/已约投资人"时才 32 题全出。
   无论精简与否，questions 参数始终提交 32 题的来源标记）
## 6. 与上次审计对比（首次审计省略本节，但保留第 7 节编号）
## 7. 档案资产与下一步（峰终收尾：报告正文永远以本节结束，不以风险/缺口收尾）
   - 档案资产：逐项引用上方"档案资产数据"（审计次数、灯色轨迹、backlog 核销进度、
     日志条数、facts 已填数）——这些是停用即失去的沉淀，如实呈现，禁止编造
   - 距下一灯色：最少需补齐的 1-3 项（引用七问缺口与 backlog ID）；只在证据链支持时
     列出，禁止许诺"完成即升级"；红灯项目改写"转向验证完成后重跑，以新方向重新判灯"
   - 最小下一步：从 backlog 挑 1 条 P0（单动作、当天可完成）；红灯项目挑转向建议中的最小验证动作
   - 复审触发（实施意图 When-Then，绑定用户已有事件，不发明打卡节奏不制造焦虑）：2-3 条，
     如"当 B2 完成时 / 当推广帖发出满 7 天时 / 当你犹豫要不要继续投入时 → 重跑 /value-audit"
   - 记录决策：提醒用户做出方向性决定或拿到现实反馈时用 /value-audit note <一句话>（这是复审对照
     "预测→实际"的唯一输入；不要建议用户手工创建日志文件）
## 附录：facts 填写参考草稿（仅当存在未填条目时输出，逐条对应 facts 原文条目名）
两类处理，严守诚实边界：
- 可草拟类（目标用户/现状替代/停用损失描述/竞品/定价锚/风险）：基于代码推断或联网检索
  给 1-2 句草稿 + 来源标记，并注明"请核实修改后自行填入 facts.md，工具不会代写"
- 仅用户可知类（用户数/收入/CAC/LTV/团队/融资/已验证假设）：绝不编造草稿，
  只给"如何取得这个答案"的最小动作（一条 SQL/看后台/问自己一个问题）

红灯变体（先肯定能力再判方向，降低心理抗拒）：整体红灯时第 1 节保留核心逻辑提炼，第 3-5 节替换为两节
（盈利模型与观测建议省略，观测只在第 1 节保留分级一行）：
## 3. 能力资产盘点 —— 只列 [代码证实] 的真实能力，每条附文件路径；禁止空洞夸奖，无路径不列。
   红灯否定的是方向，不是这些能力——它们是转向的本钱
## 4. 转向建议 —— 红灯理由 + 2-3 个方向；每个方向必须显式复用第 3 节的能力条目，
   指明切入哪个"正在靠人硬撑"的场景，并给最小验证动作（零代码优先）
backlog 与 questions 传空数组；第 7 节保留（复审触发绑定转向验证动作）。

backlog ID 规则：已有条目沿用真实 ID（如 B3）；新条目在报告文本和 backlog 参数中一律使用
占位符 B-NEW-1、B-NEW-2…（保存时由工具分配真实 ID 并替换文本）。

## 提交与收尾

调用 value_audit_save，参数：
- verdict / verdictReason：灯色与一句话理由
- reportMarkdown：完整报告
- backlog：全量清单（含核销后的旧条目 + 新条目）；红灯时传 []
- questions：32 题的来源标记（id: Q1..Q32，status: code-verified/user-provided/web-verified/unverified）；红灯时传 []
- next：一页纸（工具据此写 NEXT.md）：action = 第 7 节"最小下一步"原句（单动作、当天可完成）；
  blocker = 当前最卡的一件事（一句）；triggers = 第 7 节复审触发的 2-3 条原句

保存成功后向用户简短汇报（不要复述报告全文）：灯色结论、3 个最重要发现、
工具返回的报告路径与 facts 路径（提示：facts 填写后重跑可升级答案标记，纯可选）。
若工具汇报含"引用核实"警告，必须原样转述并承认相应结论降为 [待验证]，不得以"简写/不影响结论"淡化。`);

  return sections.join("\n\n---\n\n");
}

/**
 * subcommands.ts - /value-audit 子命令实现
 * note=决策日志（B1 零打扰版）、todo=待办推动（B2）、list=跨项目聚合（B3）、export=显式导出
 * @author wwj
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { projectsRoot, type AuditState, type BacklogItem, type Store } from "./store";
import { isCodeTask, planPath } from "./plan";

const JOURNAL_HEADER =
  "# 决策日志（journal）\n\n> 由 /value-audit note <文本> 追加。审计时作为 [用户提供] 证据注入，\n> 复审时用于对照\"上次预测 → 实际走向\"。\n\n";

export function appendNote(store: Store, text: string): string {
  const p = path.join(store.dir, "journal.md");
  if (!fs.existsSync(p)) fs.writeFileSync(p, JOURNAL_HEADER, "utf8");
  fs.appendFileSync(p, `- [${new Date().toISOString().slice(0, 16)}] ${text}\n`, "utf8");
  return p;
}

/** 读取日志尾部条目（控制注入 token 量） */
export function readJournalTail(store: Store, max = 20): string {
  try {
    const lines = fs
      .readFileSync(path.join(store.dir, "journal.md"), "utf8")
      .split("\n")
      .filter((l) => l.startsWith("- ["));
    return lines.slice(-max).join("\n");
  } catch {
    return "";
  }
}

/** 灯色 emoji（todo/list 共用） */
function verdictLight(v: string | null | undefined): string {
  return v === "green" ? "🟢" : v === "yellow" ? "🟡" : v === "red" ? "🔴" : "❔";
}

export function todoText(state: AuditState | null): string {
  const open = state?.backlog.filter((b) => b.status === "open" || b.status === "partial") ?? [];
  if (!state || open.length === 0) {
    return "没有待办的 backlog（先执行 /value-audit 生成，或全部已核销）";
  }
  const order: Record<string, number> = { P0: 0, P1: 1, P2: 2 };
  open.sort((a, b) => order[a.priority] - order[b.priority]);
  const dateOf = (seq: number) => state.audits.find((a) => a.seq === seq)?.timestamp.slice(0, 10) ?? "?";
  // 目标梯度：先呈现真实进度（done+dropped 才算核销），再列待办
  const last = state.audits[state.audits.length - 1];
  const cleared = state.backlog.filter((b) => b.status === "done" || b.status === "dropped").length;
  const head = `${verdictLight(last?.verdict)} 第 ${last?.seq ?? 0} 次审计 · backlog 已核销 ${cleared}/${state.backlog.length}（含放弃），待办 ${open.length} 条：`;
  return [head, ...open
    .map((b) => `${b.id} [${b.priority}][${b.status}] ${b.title}（提出于 ${dateOf(b.addedAtSeq)}）`)]
    .join("\n");
}

/** 扫描全部项目档案，输出灯色汇总（机构批量场景的最小形态） */
export function listText(): string {
  let dirs: string[] = [];
  try {
    dirs = fs.readdirSync(projectsRoot());
  } catch {
    return "还没有任何项目档案";
  }
  const rows: string[] = [];
  for (const d of dirs.sort()) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(projectsRoot(), d, "state.json"), "utf8")) as AuditState;
      const last = s.audits[s.audits.length - 1];
      const p0 = s.backlog.filter((b) => b.priority === "P0" && (b.status === "open" || b.status === "partial")).length;
      rows.push(`${verdictLight(last?.verdict)} ${d}  第${last?.seq ?? 0}次 ${last?.timestamp.slice(0, 10) ?? "-"}  待办P0: ${p0}`);
    } catch {
      rows.push(`❔ ${d}（state 缺失或损坏）`);
    }
  }
  return rows.length ? rows.join("\n") : "还没有任何项目档案";
}

/** 显式导出报告到目标目录（用户主动动作，不算污染项目） */
export function exportReport(store: Store, targetDir: string): { target: string; plan: string | null; ownerRefs: number } {
  const target = path.join(targetDir, "VALUE-AUDIT.md");
  let text = fs.readFileSync(store.reportPath, "utf8");
  fs.copyFileSync(store.reportPath, target);
  let plan: string | null = null;
  if (fs.existsSync(planPath(store))) {
    plan = path.join(targetDir, "PLAN.md");
    fs.copyFileSync(planPath(store), plan);
    text += fs.readFileSync(planPath(store), "utf8");
  }
  // 主人档案条目引用（如 #C3）计数：导出分享前提醒检查
  return { target, plan, ownerRefs: (text.match(/#[A-Z]\d+\b/g) ?? []).length };
}

/** 从最新报告截取某 backlog 条目的段落（第 4 节内，从命中行到下一个条目/标题，最多 40 行） */
function backlogSection(store: Store, id: string): string {
  let lines: string[];
  try {
    lines = fs.readFileSync(store.reportPath, "utf8").split("\n");
  } catch {
    return "";
  }
  const idRe = new RegExp(`(^|[^A-Za-z0-9])${id}([^0-9]|$)`);
  const start = lines.findIndex((l, i) => idRe.test(l) && lines.slice(0, i).some((h) => /^## 4\./.test(h)));
  if (start < 0) return "";
  const out = [lines[start]];
  for (let i = start + 1; i < lines.length && out.length < 40; i++) {
    if (/^(- \*\*B\d+|## )/.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out.join("\n").trim();
}

/** 结构化改造字段（v0.11）：有则直接喂给执行 agent，不再只靠报告正则截段 */
function detailText(item: BacklogItem): string {
  const gate = item.gate
    ? `${item.gate.check} —— ${item.gate.status === "met" ? "已满足" : "未满足：只产出验证交付物，不写代码"}`
    : "无（[止血]/最小事件集/前提已有证据，理由见“为什么”）";
  return [
    `类型：${item.kind ?? (isCodeTask(item) ? "code" : "verify")}`,
    item.why && `为什么：${item.why}`,
    item.target && `目标状态：${item.target}`,
    item.steps?.length && `改动点：\n${item.steps.map((s, i) => `  ${i + 1}. ${s}`).join("\n")}`,
    item.acceptance?.length && `验收：\n${item.acceptance.map((s) => `  - ${s}`).join("\n")}`,
    isCodeTask(item) && `前置验证：${gate}`,
    item.dependsOn?.length && `依赖：${item.dependsOn.join("、")}`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** /value-audit do <ID>：把 backlog 条目变成交给当前 agent 的可执行任务；返回 null 表示条目不存在 */
export function buildDoPrompt(store: Store, state: AuditState | null, id: string): string | null {
  const item = state?.backlog.find((b) => b.id.toLowerCase() === id.toLowerCase());
  if (!item) return null;
  const section = backlogSection(store, item.id) || "（报告中未找到该条目段落，按 state 信息执行）";
  return `# 执行价值审计 backlog 条目 ${item.id}（项目 ${store.projectPath}）

条目：${item.title} ｜ 优先级 ${item.priority} ｜ 当前状态 ${item.status} ｜ 涉及：${item.files.join("，") || "未指定"}${
    fs.existsSync(planPath(store)) ? `\n改造方案全文（含执行约定）：${planPath(store)}` : ""
  }

结构化字段（state 记录；缺的从下方报告原文补）：
${detailText(item)}

报告中的原文（含类型/方向/预期）：
${section}

执行纪律：
1. 先看"类型"。**验证类**（verify：问人/取数/访谈/一次性 SQL）：不改任何项目代码；产出可直接使用的交付物——
   访谈脚本（5 个以内开放式问题 + 追问）/ 取数步骤或 SQL / 检查清单，并说明拿到结果后如何解读（什么结果算假设成立）。
   **代码类**（code）："前置验证"未满足 → 按验证类处理，只产出验证交付物，不写代码；已满足或无需 → 按"改动点"做最小改动，
   不扩范围，遵守项目现有模式；改完按"验收"逐条自检。
2. 只做这一条，不顺手做其他 backlog；条目依赖未完成的其他条目时先指出，不擅自一起做。
3. 不修改 ~/.value-audit 下任何档案；不调用 value_audit_save（本次不是审计）。
4. 完成后提醒用户：用 \`/value-audit note <一句话>\` 记录结果/现实反馈；改动提交后重跑 \`/value-audit\`，
   工具会依据 git diff 核销 ${item.id}——核销发生在复审，不在这里。`;
}

/**
 * facts 填写参考草稿（v0.10）：从报告附录确定性截取，写到独立文件；永不碰 facts.md（草稿≠事实）。
 * 返回路径；报告无附录时删除旧草稿并返回 null。
 */
export function writeFactsDraft(store: Store, reportMarkdown: string): string | null {
  const target = path.join(store.dir, "facts-draft.md");
  const m = reportMarkdown.match(/^## 附录[：:]?\s*facts[^\n]*\n([\s\S]*)$/m);
  const body = m?.[1]?.trim();
  if (!body) {
    try {
      fs.unlinkSync(target);
    } catch {
      /* 无旧草稿 */
    }
    return null;
  }
  const head = [
    "# facts 填写参考草稿（生成物，每次审计覆盖）",
    "",
    "> 来自报告附录。可草拟类条目带来源标记，仅你可知类只给取数方法。",
    "> **核实后**把真实情况复制进 facts.md 对应条目；工具不会代写 facts，草稿里的任何数字都不是事实。",
    "",
  ];
  fs.writeFileSync(target, head.join("\n") + body + "\n", "utf8");
  return target;
}

export interface NextPage {
  action: string;
  blocker?: string;
  triggers?: string[];
}

/** 一页纸 NEXT.md：三行看清"这周做什么/卡在哪/何时重跑"，确定性生成，每次审计覆盖 */
export function writeNextPage(store: Store, state: AuditState, next: NextPage): string {
  const last = state.audits[state.audits.length - 1];
  const p0 = state.backlog.filter((b) => b.priority === "P0" && (b.status === "open" || b.status === "partial")).map((b) => b.id);
  const lines = [
    `# NEXT · ${verdictLight(last?.verdict)} 第 ${last?.seq ?? 0} 次审计 · ${last?.timestamp.slice(0, 10) ?? "?"}`,
    ``,
    `- 本周唯一动作：${next.action}`,
    `- 卡在哪：${next.blocker || "（未填）"}`,
    `- 什么信号出现就重跑 /value-audit：`,
    ...(next.triggers?.length ? next.triggers.map((t) => `  - ${t}`) : ["  - （未填）"]),
    `- 待办 P0：${p0.join("、") || "无"}（/value-audit todo 查看；/value-audit do <ID> 执行）`,
    `- 做出决定时：/value-audit note <一句话>`,
    ``,
    `> 生成物，每次审计覆盖；完整报告见 VALUE-AUDIT.md`,
  ];
  const target = path.join(store.dir, "NEXT.md");
  fs.writeFileSync(target, lines.join("\n") + "\n", "utf8");
  return target;
}

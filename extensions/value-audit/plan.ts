/**
 * plan.ts - PLAN.md 改造方案：从 state.backlog 的结构化字段确定性渲染，交给任意 LLM 落地
 * 只对商业化意图输出；自用意图或红灯时删除旧文件（过期方案会误导执行者）。
 * @author wwj
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { IntentKind } from "./prompt";
import type { AuditState, BacklogItem, Store, Verdict } from "./store";

export function planPath(store: Store): string {
  return path.join(store.dir, "PLAN.md");
}

const INTENT_LABEL: Record<IntentKind, string> = {
  unfilled: "facts 第 0 节未填，默认按“打算商业化”生成；若实为自用，忽略本文件并在 facts 第 0 节填一行意图后重跑",
  commercial: "商业化（facts 第 0 节）",
  fundraising: "正在融资（facts 第 0 节）",
  mixed: "自用为主 + 顺带商业化（facts 第 0 节）；只含“顺带”路径与止血/观测类改造",
  noncommercial: "自用/开源分享",
};
const LIGHT: Record<Verdict, string> = { red: "🔴", yellow: "🟡", green: "🟢" };

const isOpen = (b: BacklogItem) => b.status === "open" || b.status === "partial";
/** 代码类判定：显式 kind 优先；缺省时带 steps/target 即视为改造任务 */
export const isCodeTask = (b: BacklogItem) => (b.kind ? b.kind === "code" : Boolean(b.steps?.length || b.target));

/** 排序：P0→P2，同级内 gate 未满足的靠后（交接句式指向能立刻做的）；依赖先行（拓扑；依赖不在清单内视为已满足；成环按原序兜底） */
export function orderPlan(items: BacklogItem[]): BacklogItem[] {
  const prio: Record<string, number> = { P0: 0, P1: 1, P2: 2 };
  const blocked = (b: BacklogItem) => (b.gate?.status === "unmet" ? 1 : 0);
  const pending = [...items].sort((a, b) => prio[a.priority] - prio[b.priority] || blocked(a) - blocked(b));
  const out: BacklogItem[] = [];
  while (pending.length) {
    const i = pending.findIndex((b) => !(b.dependsOn ?? []).some((d) => pending.some((p) => p.id === d)));
    out.push(pending.splice(Math.max(i, 0), 1)[0]);
  }
  return out;
}

/** 改动点路径核实（与 citations 同一反幻觉机制）：首个 token 像路径、不存在且未标“新增” → 就地标 ⚠️ */
function checkStep(step: string, projectPath: string): string {
  if (/新增|新建/.test(step)) return step;
  const head = step.trim().split(/[\s：:（(]/)[0].replace(/[`'"*]/g, "");
  if (!head || !/[/.]/.test(head) || /[^\x21-\x7e]/.test(head)) return step;
  return fs.existsSync(path.join(projectPath, head)) ? step : `${step} ⚠️路径不存在：${head}`;
}

function gateText(b: BacklogItem): string {
  if (!b.gate) return "无需 gate（[止血]/最小事件集/前提已有证据，理由见“为什么”；看不到理由就先问负责人）";
  return `${b.gate.check} —— ${b.gate.status === "met" ? "✅ 已满足" : "⛔ 未满足：先做验证拿到结果，再改代码"}`;
}

function renderTask(b: BacklogItem, projectPath: string): string {
  const lines = [`### ${b.id} · ${b.title} [${b.priority}${b.status === "partial" ? "，部分完成" : ""}]`];
  if (!b.steps?.length && !b.target) {
    lines.push(`- ⚠️ 本条没有结构化改造描述（旧审计或模型未填）：执行前先 \`/value-audit do ${b.id}\`，由 agent 读报告第 4 节补全再动手`);
  }
  if (b.why) lines.push(`- 为什么：${b.why}`);
  if (b.target) lines.push(`- 目标状态：${b.target}`);
  if (b.steps?.length) lines.push("- 改动点：", ...b.steps.map((s, i) => `  ${i + 1}. ${checkStep(s, projectPath)}`));
  if (b.acceptance?.length) lines.push("- 验收：", ...b.acceptance.map((s) => `  - ${s}`));
  lines.push(`- 前置验证：${gateText(b)}`);
  if (b.dependsOn?.length) lines.push(`- 依赖：${b.dependsOn.join("、")}`);
  if (b.files.length) lines.push(`- 涉及文件：${b.files.join("，")}`);
  return lines.join("\n");
}

export interface PlanMeta {
  intent: IntentKind;
  verdict: Verdict;
}

export function planText(store: Store, state: AuditState, reportMarkdown: string, meta: PlanMeta): string {
  const last = state.audits[state.audits.length - 1];
  const open = state.backlog.filter(isOpen);
  const tasks = orderPlan(open.filter(isCodeTask));
  const verifies = open.filter((b) => !isCodeTask(b));
  const dependents = (id: string) => tasks.filter((t) => t.dependsOn?.includes(id)).map((t) => t.id);
  const core = reportMarkdown
    .split("\n")
    .find((l) => l.includes("一句话核心逻辑"))
    ?.replace(/^.*?一句话核心逻辑\**[：:]?\**\s*/, "")
    .trim();
  const self = planPath(store);
  const lines = [
    `# 改造方案（PLAN）· ${path.basename(store.projectPath)}`,
    `> 生成物，每次审计覆盖｜第 ${last?.seq ?? 0} 次审计 ${last?.timestamp.slice(0, 10) ?? "?"}｜${LIGHT[meta.verdict]}｜项目：${store.projectPath}`,
    `> 审计假设：${INTENT_LABEL[meta.intent]}`,
    ...(core ? [`> 核心逻辑：${core}`] : []),
    "",
    "## 怎么用",
    "",
    `- 在项目目录对任意 LLM/agent 说：「按 ${self} 实施 ${tasks[0]?.id ?? "<ID>"}」；在 pi 里也可 \`/value-audit do <ID>\``,
    "- 交给执行者的约定：",
    "  1. 一次只做指定的一条；按“改动点”做最小改动，不扩范围、不顺手重构，遵循项目现有模式",
    "  2. “前置验证”未满足的条目：只产出验证交付物（访谈脚本/取数步骤），不写代码；前提由负责人确认后再做",
    "  3. 不修改 ~/.value-audit 下任何档案；完成后按“验收”逐条自检",
    "  4. 改动提交后 `/value-audit note <一句话结果>` 并重跑 `/value-audit`——核销由复审按 git diff 判定，不在这里",
    "",
    "## 验证类待办（人做；标注被哪些改造任务依赖）",
    "",
    ...(verifies.length
      ? verifies.map((b) => `- ${b.id} [${b.priority}] ${b.title}${dependents(b.id).length ? `｜被依赖：${dependents(b.id).join("、")}` : ""}`)
      : ["- 无"]),
    "",
    `## 改造任务（按优先级与依赖排序，共 ${tasks.length} 条）`,
    "",
    ...(tasks.length
      ? tasks.map((t) => renderTask(t, store.projectPath)).join("\n\n").split("\n")
      : ["- 暂无代码类改造任务：当前 backlog 全是验证动作；验证拿到结果后重跑 /value-audit 再生成"]),
  ];
  return lines.join("\n") + "\n";
}

/** 写 PLAN.md；自用意图或红灯时删除旧文件并返回 null */
export function writePlanPage(store: Store, state: AuditState, reportMarkdown: string, meta: PlanMeta): string | null {
  const target = planPath(store);
  if (meta.intent === "noncommercial" || meta.verdict === "red") {
    try {
      fs.unlinkSync(target);
    } catch {
      /* 无旧文件 */
    }
    return null;
  }
  fs.writeFileSync(target, planText(store, state, reportMarkdown, meta), "utf8");
  return target;
}

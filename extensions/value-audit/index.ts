/**
 * index.ts - value-audit 扩展入口
 * /value-audit          执行审计（首次自动建档；复审自动对比）
 * /value-audit where    查看当前项目档案路径
 * 工具 value_audit_save 由审计 agent 调用，结构化落盘（报告/state/快照）。
 * @author wwj
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { execSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { collectProfile } from "./profiler";
import { buildAuditPrompt, loadKnowledge } from "./prompt";
import { Store, type AuditState, type SavePayload } from "./store";
import { citationSummary, verifyCitations } from "./citations";
import { appendNote, buildDoPrompt, exportReport, listText, readJournalTail, todoText, writeNextPage } from "./subcommands";
import { getConsent, sendEvent, setConsent, statsStatusText, telemetryConfigured } from "./telemetry";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const FACTS_TEMPLATE = path.join(PKG_ROOT, "templates", "facts.md");
const PKG_VERSION: string = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(PKG_ROOT, "package.json"), "utf8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();
/** 子命令固定枚举（统计只上报枚举名，不含任何参数内容） */
const KNOWN_CMDS = new Set(["", "where", "open", "todo", "list", "note", "export", "focus", "stats", "do"]);

interface PendingAudit {
  store: Store;
  state: AuditState;
  seq: number;
  fingerprint: string;
  gitCommit: string | null;
  knowledgeVersion: string;
}

let pending: PendingAudit | null = null;

const saveParams = Type.Object({
  verdict: StringEnum(["red", "yellow", "green"], { description: "整体灯色结论" }),
  verdictReason: Type.String({ description: "一句话理由，引用触发条款，如：红灯：Q3 停用无损失" }),
  reportMarkdown: Type.String({ description: "完整报告 markdown；新 backlog 条目用 B-NEW-x 占位" }),
  backlog: Type.Array(
    Type.Object({
      id: Type.String({ description: "已有条目用真实 ID（如 B3）；新条目用 B-NEW-1、B-NEW-2…" }),
      title: Type.String(),
      status: StringEnum(["open", "partial", "done", "dropped"]),
      priority: StringEnum(["P0", "P1", "P2"]),
      files: Type.Optional(Type.Array(Type.String(), { description: "涉及文件/目录" })),
    }),
    { description: "全量 backlog（旧条目核销 + 新条目）；红灯时传空数组" },
  ),
  questions: Type.Array(
    Type.Object({
      id: Type.String({ description: "Q1..Q32" }),
      status: StringEnum(["code-verified", "user-provided", "web-verified", "unverified"]),
    }),
    { description: "投资人 32 题来源标记；红灯时传空数组" },
  ),
  next: Type.Optional(
    Type.Object({
      action: Type.String({ description: "本周唯一动作：第 7 节最小下一步原句，单动作当天可完成" }),
      blocker: Type.Optional(Type.String({ description: "当前最卡的一件事，一句" })),
      triggers: Type.Optional(Type.Array(Type.String(), { description: "复审触发 When-Then，2-3 条原句" })),
    }),
    { description: "一页纸 NEXT.md 内容（可选但强烈建议）" },
  ),
});

function timeSlug(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 用系统默认程序打开文件/目录（macOS/Windows/Linux），失败静默忽略 */
function openPath(target: string): void {
  const cmd =
    process.platform === "darwin" ? ["open", target]
    : process.platform === "win32" ? ["cmd", "/c", "start", "", target]
    : ["xdg-open", target];
  try {
    spawn(cmd[0], cmd.slice(1), { stdio: "ignore", detached: true }).unref();
  } catch {
    /* 打不开不影响主流程 */
  }
}

function gitDiffSince(cwd: string, commit: string): string | null {
  try {
    const stat = execSync(`git diff ${commit}..HEAD --stat`, {
      cwd, encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return stat ? stat.split("\n").slice(0, 80).join("\n") : "（无文件变化，可能仅有未提交改动）";
  } catch {
    return null;
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("value-audit", {
    description:
      "价值审计：这个项目凭什么收钱（子命令：where 路径 / open 打开档案 / todo 待办 / list 全部项目 / note 记录决策 / export 导出 / focus 聚焦审计 / do 执行某条 backlog / stats 匿名统计开关）",
    handler: async (args, ctx) => {
      const store = new Store(ctx.cwd);
      store.ensure();
      const say = (msg: string) => {
        if (ctx.hasUI) ctx.ui.notify(msg, "info");
      };
      const pathsText = `报告: ${store.reportPath}\n事实档案: ${store.factsPath}\n历史快照: ${store.historyDir}`;

      const sub = (args ?? "").trim();
      const [head, ...rest] = sub.split(/\s+/);
      const payload = rest.join(" ").trim();
      if (KNOWN_CMDS.has(head)) {
        sendEvent("command_used", { version: PKG_VERSION, cmd: head === "" ? "audit" : head });
      }
      if (head === "where") {
        say(pathsText);
        return;
      }
      if (head === "open") {
        openPath(store.dir);
        say(pathsText);
        return;
      }
      if (head === "todo") {
        say(todoText(store.loadState()));
        return;
      }
      if (head === "list") {
        say(listText());
        return;
      }
      if (head === "note") {
        if (!payload) {
          say("用法：/value-audit note <一句话：决策/进展/现实反馈>，下次审计作为 [用户提供] 证据");
          return;
        }
        say(`已记入决策日志：${appendNote(store, payload)}`);
        return;
      }
      if (head === "stats") {
        if (payload === "on" || payload === "off") {
          if (!telemetryConfigured()) {
            say("统计端点未配置，无法开启");
            return;
          }
          setConsent(payload === "on");
        }
        say(statsStatusText());
        return;
      }
      if (head === "do") {
        const prompt = payload ? buildDoPrompt(store, store.loadState(), payload.split(/\s+/)[0]) : null;
        if (!prompt) {
          say(payload ? `没有 backlog 条目 ${payload}（/value-audit todo 查看可用 ID）` : "用法：/value-audit do <ID>，如 /value-audit do B3");
          return;
        }
        pi.sendUserMessage(prompt);
        return;
      }
      if (head === "export") {
        if (!fs.existsSync(store.reportPath)) {
          say("还没有报告，先执行 /value-audit");
          return;
        }
        say(`报告已导出：${exportReport(store, payload || ctx.cwd)}`);
        return;
      }
      const focusText = head === "focus" ? payload || undefined : undefined;
      if (sub !== "" && head !== "focus") {
        say(`未知子命令：${head}（支持 where/open/todo/list/note/export/focus/do/stats）`);
        return;
      }

      const facts = store.initOrMergeFacts(FACTS_TEMPLATE);
      const knowledge = loadKnowledge(PKG_ROOT);
      const profile = collectProfile(ctx.cwd);
      const factsText = store.readFacts();
      const fingerprint = store.fingerprint(profile.text, factsText, knowledge.version);
      const state = store.loadState() ?? store.newState(knowledge.version);
      const last = state.audits[state.audits.length - 1];

      // 指纹短路：唯一的一次用户交互（是否重跑属于用户决策）
      if (last && last.fingerprint === fingerprint && fs.existsSync(store.reportPath) && ctx.hasUI) {
        const ok = await ctx.ui.confirm(
          "value-audit",
          "代码与事实档案自上次审计后无变化，重跑只会得到措辞不同的相同结论。仍要执行？",
        );
        if (!ok) {
          say(`已跳过。上次结论：${last.verdict ?? "?"} —— ${last.verdictReason}\n${pathsText}`);
          return;
        }
      }

      let gitDiffStat: string | null = null;
      if (last?.gitCommit && profile.gitCommit && last.gitCommit !== profile.gitCommit) {
        gitDiffStat = gitDiffSince(ctx.cwd, last.gitCommit);
      }

      // 轻提醒（B2）：距上次审计天数与遗留 P0
      if (last) {
        const days = Math.max(0, Math.floor((Date.now() - Date.parse(last.timestamp)) / 86400000));
        const p0 = state.backlog.filter((b) => b.priority === "P0" && (b.status === "open" || b.status === "partial")).length;
        if (days >= 1 || p0 > 0) say(`距上次审计 ${days} 天，遗留待办 P0 ${p0} 条（/value-audit todo 查看）`);
      }

      let prevReportLines: number | undefined;
      try {
        prevReportLines = fs.readFileSync(store.reportPath, "utf8").split("\n").length;
      } catch {
        /* 首审无报告 */
      }
      pending = {
        store,
        state,
        seq: (last?.seq ?? 0) + 1,
        fingerprint,
        gitCommit: profile.gitCommit,
        knowledgeVersion: knowledge.version,
      };

      if (facts.created) {
        say(`已生成事实档案模板（可选填写，不填也能出报告）：${store.factsPath}`);
      } else if (facts.appended > 0) {
        say(`事实档案已追加 ${facts.appended} 个新条目（原有内容未动）`);
      }

      sendEvent("audit_started", { version: knowledge.version, seq: pending.seq });
      pi.sendUserMessage(
        buildAuditPrompt({
          projectPath: store.projectPath,
          profileText: profile.text,
          factsText,
          knowledge,
          prevState: last ? state : null,
          gitDiffStat,
          seq: pending.seq,
          prevReportLines,
          journalText: readJournalTail(store) || undefined,
          focusText,
        }),
      );
    },
  });

  pi.registerTool({
    name: "value_audit_save",
    label: "Value Audit Save",
    description: "提交价值审计结果并落盘（仅在 /value-audit 流程中调用；报告/状态写入用户主目录档案）",
    parameters: saveParams,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!pending) {
        sendEvent("audit_save_error", { version: PKG_VERSION, reason: "no-pending" });
        return {
          content: [{ type: "text", text: "没有进行中的审计流程。请先执行 /value-audit。" }],
          isError: true,
        };
      }
      try {
      const { store, state, seq, fingerprint, gitCommit, knowledgeVersion } = pending;
      const now = new Date();
      const slug = `${timeSlug(now)}_a${seq}`; // 序号并入，防同秒内两次审计快照互相覆盖
      const applied = store.applySave(state, params as SavePayload, {
        seq,
        timestamp: now.toISOString(),
        fingerprint,
        gitCommit,
        snapshot: `history/${slug}.md`,
        knowledgeVersion,
      });
      // 引用核实（反幻觉）：路径不存在的 [代码证实] 就地标注，结论降级为待验证
      const cite = verifyCitations(applied.markdown, store.projectPath);
      const lastAudit = applied.state.audits[applied.state.audits.length - 1];
      lastAudit.unverifiedCitations = cite.missing.length;
      lastAudit.noPathCitations = cite.noPath;
      const written = store.writeReport(cite.markdown, slug);
      store.saveState(applied.state);
      pending = null;
      if (ctx?.hasUI) openPath(store.dir); // 审计完成自动打开档案目录（报告/facts/journal 一目了然）

      // 匿名统计（opt-in）：首次审计完成后一次性询问，之后遵从用户选择；失败静默不阻塞
      if (telemetryConfigured() && ctx?.hasUI && getConsent() === "unset") {
        const ok = await ctx.ui.confirm(
          "匿名使用统计",
          "是否开启匿名统计帮助改进工具？只上报版本/审计次数/灯色/子命令名/错误类别/操作系统，不含任何代码与内容，可随时 /value-audit stats off 关闭",
        );
        setConsent(ok);
      }
      sendEvent("audit_completed", { version: knowledgeVersion, seq, verdict: params.verdict });

      // 档案资产（禀赋效应）：确定性数据随汇报呈现，让沉淀可见
      const trail = applied.state.audits.map((a) => a.verdict ?? "?").join(" → ");
      const clearedN = applied.state.backlog.filter((b) => b.status === "done" || b.status === "dropped").length;
      const assets = applied.state.backlog.length ? `；backlog 已核销 ${clearedN}/${applied.state.backlog.length}` : "";
      const lines = [
        `审计已保存并自动打开档案目录（第 ${seq} 次，结论：${params.verdict}）。`,
        `档案资产：灯色轨迹 ${trail}${assets}；历史快照 ${written.historyCount} 份`,
        `报告: ${written.reportPath}`,
        `事实档案: ${store.factsPath}（填写后重跑 /value-audit 可升级 [待验证] 答案，纯可选）`,
        `历史快照: ${written.snapshotPath}`,
      ];
      const citeLine = citationSummary(cite);
      if (citeLine) lines.splice(1, 0, citeLine);
      if (params.next?.action) lines.splice(1, 0, `一页纸: ${writeNextPage(store, applied.state, params.next)}`);
      if (!readJournalTail(store)) lines.push(`决策日志为空：下次做出方向性决定或拿到现实反馈时 /value-audit note <一句话>，复审才能对照"预测→实际"`);
      if (written.historyCount > 50) {
        lines.push(`提示：历史快照已达 ${written.historyCount} 份，可手动清理 ${store.historyDir}`);
      }
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { seq, verdict: params.verdict, reportPath: written.reportPath },
      };
      } catch (e) {
        // 降级信号：pi 升级/环境变化打挂保存链路时，比用户提 issue 更早知道
        sendEvent("audit_save_error", { version: PKG_VERSION, reason: "exception" });
        pending = null;
        return {
          content: [{ type: "text", text: `保存过程出错：${(e as Error).message}。可重新执行 /value-audit。` }],
          isError: true,
        };
      }
    },
  });
}

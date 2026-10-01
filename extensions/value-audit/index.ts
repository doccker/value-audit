/**
 * index.ts - value-audit 扩展入口
 * /value-audit          执行审计（首次自动建档；复审自动对比）
 * /value-audit where    查看当前项目档案路径
 * 工具 value_audit_save 由审计 agent 调用，结构化落盘（报告/state/快照）。
 * @author wwj
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { collectProfile } from "./profiler";
import { buildAuditPrompt, loadKnowledge, readIntent } from "./prompt";
import { Store, type AuditState, type SavePayload } from "./store";
import { citationSummary, verifyCitations } from "./citations";
import { appendNote, buildDoPrompt, exportReport, listText, readJournalTail, todoText, writeFactsDraft, writeNextPage } from "./subcommands";
import { getConsent, sendEvent, setConsent, statsStatusText, telemetryConfigured } from "./telemetry";
import { buildMarketPrompt, readMarket } from "./market";
import { registerMarketTool, setAfterMarket } from "./market-tool";
import { detectWebCapability } from "./web";
import { gitDiffSince, openPath, timeSlug } from "./sys-util";
import { saveParams } from "./save-schema";

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
const KNOWN_CMDS = new Set(["", "where", "open", "todo", "list", "note", "export", "focus", "stats", "do", "market"]);

interface PendingAudit {
  store: Store;
  state: AuditState;
  seq: number;
  fingerprint: string;
  gitCommit: string | null;
  knowledgeVersion: string;
}

let pending: PendingAudit | null = null;


/** /value-audit market [url...]：组装联网竞品调研 prompt */
function marketPrompt(store: Store, cwd: string, payload: string): string {
  store.initOrMergeFacts(FACTS_TEMPLATE);
  return buildMarketPrompt({
    store,
    profileText: collectProfile(cwd).text,
    factsText: store.readFacts(),
    journalText: readJournalTail(store) || undefined,
    knowledge: loadKnowledge(PKG_ROOT, ["value-judgment.md", "sustain-loop.md"]), // 调研不需要 PMF 表与 32 题
    web: detectWebCapability(PKG_ROOT),
    extraUrls: payload ? payload.split(/\s+/).filter((u) => /^https?:\/\//i.test(u)) : [],
    prev: readMarket(store),
  });
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("value-audit", {
    description:
      "价值审计：这个项目凭什么收钱（子命令：where 路径 / open 打开档案 / todo 待办 / list 全部项目 / note 记录决策 / export 导出 / focus 聚焦审计 / do 执行某条 backlog / market 联网竞品调研 / stats 匿名统计开关）",
    handler: (args, ctx) => run(args, ctx, false),
  });

  /** 主流程；followUp=true 表示由 market 保存工具串联触发（agent 仍在流式输出，消息需排队） */
  const run = async (args: string, ctx: ExtensionCommandContext, followUp: boolean): Promise<void> => {
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
    if (head === "market") {
      say(`联网竞品调研开始（抓取 ≤25 次，结果写入 ${store.dir}/market.md）`);
      pi.sendUserMessage(marketPrompt(store, ctx.cwd, payload));
      return;
    }
    if (head === "export") {
      if (!fs.existsSync(store.reportPath)) {
        say("还没有报告，先执行 /value-audit");
        return;
      }
      const exp = exportReport(store, payload || ctx.cwd);
      say(`报告已导出：${exp.target}${exp.ownerRefs ? `\n⚠️ 报告含 ${exp.ownerRefs} 处主人档案条目引用（#id），分享给他人前检查是否带出你的处境信息` : ""}`);
      return;
    }
    const focusText = head === "focus" ? payload || undefined : undefined;
    if (sub !== "" && head !== "focus") {
      say(`未知子命令：${head}（支持 where/open/todo/list/note/export/focus/do/market/stats）`);
      return;
    }

    const facts = store.initOrMergeFacts(FACTS_TEMPLATE);
    const knowledge = loadKnowledge(PKG_ROOT);
    const profile = collectProfile(ctx.cwd);
    const factsText = store.readFacts();
    const market = readMarket(store);
    // 自动串联（v0.10）：无市场资料且意图非自用 → 先联网调研，保存后以 followUp 继续审计
    const intent = readIntent(factsText).kind;
    if (!market && !followUp && intent !== "noncommercial") {
      // 意图未填 = 用户决策缺失：花 25 次抓取前确认一次（与指纹短路同属零打扰的唯一例外）
      const go = intent !== "unfilled" || !ctx.hasUI || (await ctx.ui.confirm(
        "value-audit",
        "facts 第 0 节「项目意图」未填。按默认假设（打算商业化）先联网竞品调研（≤25 次抓取）再审计？\n选「否」则本次只审计不联网；建议先在 facts 第 0 节填一行意图再跑。",
      ));
      if (go) {
        say("先联网竞品调研（≤25 次抓取），保存后自动继续审计。只想审计不联网：在 facts 第 0 节写明自用/开源");
        setAfterMarket(() => run(args, ctx, true));
        pi.sendUserMessage(marketPrompt(store, ctx.cwd, ""));
        return;
      }
    }
    const fingerprint = store.fingerprint(profile.text, factsText + (market?.date ?? ""), knowledge.version);
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
    const prompt = buildAuditPrompt({
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
        web: detectWebCapability(PKG_ROOT),
        market,
      });
    pi.sendUserMessage(prompt, followUp ? { deliverAs: "followUp" } : undefined);
  };

  registerMarketTool(pi, PKG_VERSION);

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
      const draft = writeFactsDraft(store, cite.markdown);
      if (draft) lines.splice(lines.findIndex((l) => l.startsWith("事实档案:")) + 1, 0, `填写草稿: ${draft}（核实后复制进 facts.md，工具不代写）`);
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

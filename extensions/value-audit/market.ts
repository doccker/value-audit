/**
 * market.ts - /value-audit market：联网竞品调研 + 结合主人处境的改造建议，落档案 market.md
 * 主审计存在 market.md 时注入为 [联网检索] 来源并标注新鲜度。
 * @author wwj
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { Knowledge } from "./prompt";
import { ownerSection } from "./owner";
import type { Store } from "./store";
import type { WebCapability } from "./web";
import { webCapabilityText } from "./web";
import { loadMarketData, MARKET_COLUMNS, marketPath } from "./market-store";

const STALE_DAYS = 90;
const MAX_INJECT_CHARS = 12000;

export interface MarketDoc {
  text: string;
  date: string;
  ageDays: number;
  stale: boolean;
}

/** 读取 market.md；首行 "> 调研日期：YYYY-MM-DD" 为新鲜度依据，缺失时用文件 mtime */
export function readMarket(store: Store): MarketDoc | null {
  const p = marketPath(store);
  let text: string;
  let mtime: number;
  try {
    text = fs.readFileSync(p, "utf8");
    mtime = fs.statSync(p).mtimeMs;
  } catch {
    return null;
  }
  const m = text.match(/调研日期[：:]\s*(\d{4}-\d{2}-\d{2})/);
  const date = m ? m[1] : new Date(mtime).toISOString().slice(0, 10);
  const ageDays = Math.max(0, Math.floor((Date.now() - Date.parse(date)) / 86400000));
  return { text, date, ageDays, stale: ageDays > STALE_DAYS };
}

/** 主审计注入段 */
export function marketSection(m: MarketDoc): string {
  const body = m.text.length > MAX_INJECT_CHARS ? m.text.slice(0, MAX_INJECT_CHARS) + "\n…[已截断，完整内容见档案 market.md]" : m.text;
  const fresh = m.stale
    ? `⚠️ 已过期（${m.ageDays} 天 > ${STALE_DAYS} 天）：价格/热度类数据只能作为"曾经如此"的参考，引用时必须注明日期并建议用户 \`/value-audit market\` 刷新`
    : `距今 ${m.ageDays} 天，可直接作为 [联网检索] 来源（沿用其中的 URL 与日期，不必重抓）`;
  return `## 市场资料（/value-audit market 于 ${m.date} 生成）\n\n${fresh}。其中"改造建议"节是上次的处方，本次审计以当前代码与 facts 重新判断，不照搬。\n\n${body}`;
}

export interface MarketPromptOptions {
  store: Store;
  profileText: string;
  factsText: string;
  journalText?: string;
  knowledge: Knowledge;
  web: WebCapability;
  extraUrls: string[];
  prev: MarketDoc | null;
}

export function buildMarketPrompt(o: MarketPromptOptions): string {
  const target = marketPath(o.store);
  const today = new Date().toISOString().slice(0, 10);
  const sections: string[] = [];

  sections.push(`# 市场与竞品调研任务（value-audit v${o.knowledge.version} · market）

对项目 ${o.store.projectPath} 做一次联网竞品调研，并给出**结合这个项目和它主人实际处境**的改造建议，结果写入 \`${target}\`。

纪律：
1. **零打扰**：不向用户提问；拿不到的写「未核实」，不编造。
2. **抓取预算 ≤ 25 次**（GitHub API 调用与网页抓取合计）；优先级：facts 第 5 节点名的竞品 → 用户附加 URL → 由上述页面/README 的"对比/类似项目"链接发现的新竞品。不要调用搜索引擎接口。
3. **来源**：每个数据点附 URL 与访问日期（${today}）；只采信官网、官方文档、GitHub 仓库本身、知名机构报告；论坛传言不作为事实。
4. **只读**：只做 GET/API 读取，不登录、不注册、不提交表单；不修改项目文件；不调用 value_audit_save。
5. **主人处境**：遵守知识库处方纪律 11 与下方「主人档案」节——改造建议必须过其红线/需核实条目并逐条引用 id；档案内容不得复制进结果，只引用 id 与结论。
6. **提交**：完成后调用工具 \`value_audit_market_save\` 一次（rows 只含本次实际核实的竞品，heatScore 填数值；表格排序、历史行合并、写入 \`${target}\` 由工具完成，不要自己写文件）；然后向用户三句话汇报（最值得看的 1 个发现、1 条改造建议、文件路径），不复述全文。`);

  sections.push(webCapabilityText(o.web));

  sections.push(`## 项目画像（确定性采集）\n\n${o.profileText}`);
  sections.push(`## 用户事实档案 facts.md\n\n${o.factsText || "（尚未创建）"}`);
  if (o.journalText) sections.push(`## 用户决策日志尾部（[用户提供]）\n\n${o.journalText}`);
  if (o.extraUrls.length) sections.push(`## 用户附加的竞品/参考 URL\n\n${o.extraUrls.map((u) => `- ${u}`).join("\n")}`);
  sections.push(ownerSection("改造建议"));
  if (o.prev) {
    const known = Object.values(loadMarketData(o.store).rows)
      .sort((a, b) => b.heatScore - a.heatScore)
      .map((r) => `- ${r.site} | ${r.url} | 热度 ${r.heat} | 上次复核 ${r.lastSeen}`)
      .join("\n");
    sections.push(`## 上次调研（${o.prev.date}，${o.prev.ageDays} 天前）——已累计的竞品行（工具会保留，不必重复录入未复核的行）

${known || "（无结构化行）"}

本次：预算内优先复核热度最高的已知行（价格/热度变化），其余留给新竞品；diff 字段写出新增/消失的竞品、价格或热度变化、上次改造建议的采纳情况（对照决策日志）。上次全文：

${o.prev.text.slice(0, MAX_INJECT_CHARS)}`);
  }
  sections.push(`## 方法论知识库（改造建议必须遵守其中"处方纪律"与"主人处境约束"）\n\n${o.knowledge.text}`);

  sections.push(`## 提交字段要求（value_audit_market_save）

- rows：每个竞品一行，字段对应表头 ${MARKET_COLUMNS}
  - 成立时间逐行注明口径（公司成立日 / GitHub 仓库创建日）；备案号写页面展示的号 / 未展示 / 无（境外托管）；价格只写官网可见价，需联系销售写"询价"
  - heat 写文字（⭐/fork/最近提交），heatScore 写数值（star 数或页面可见数；未知 0）；同名撞车/非同赛道的也列出并在"方向"标明，避免下次重复查
  - fit："✅/⚠️/❌ + 一句话"，判断要结合 facts 第 0 节意图与主人档案
- changes：品类近 12 个月变化（大厂免费化/平台内置/监管/新进入者），每条附 URL；没查到写"未发现可靠来源"
- priceAnchors：同类产品主流盈利模式与价格带（sustain-loop A-2 检索 1 的输入）；facts 已填的外部证据按 [用户提供] 列入
- position：本项目在表中的位置（covered / differentiated / off-track）
- advice（markdown）：
  1. 可借鉴点表：| 借鉴点 | 来源 | 可落到本项目哪里（文件/模块） |
  2. 改造建议 3-5 条：每条写 类型[验证/代码]、依据（引用表中行或 URL）、**主人处境约束（引用档案条目 id；无档案或无相关条目写"无相关约束"）**、成本（时间/月费/何时可停）；
     遵守处方纪律：零代码验证优先、不建议看板体系、不为未验证的方向写代码、意图为自用/开源时不催商业化、没有收款能力时不开收款类动作
  3. 不建议做的 1-3 件事（含理由）
- pending：抓取失败/页面未展示/需询价的条目，供用户补进 facts 第 5 节"外部证据补录"
- diff：仅有上次调研时填写`);

  return sections.join("\n\n---\n\n");
}

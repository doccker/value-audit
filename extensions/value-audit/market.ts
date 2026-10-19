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
import { loadMarketData, MARKET_COLUMNS, marketPath, sortedRows } from "./market-store";

const STALE_DAYS = 90;
const MAX_INJECT_CHARS = 12000;

export interface MarketDoc {
  text: string;
  /** 注入 prompt 用：第一节换成 6 列精简表，其余节原样；完整 14 列留在文件里按需 read */
  compact: string;
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
  return { text, compact: compactMarket(store, text, p), date, ageDays, stale: ageDays > STALE_DAYS };
}

/** 第一节 14 列表替换为 6 列精简表（站点/url/价格/热度/方向/是否适合我）；无结构化数据或分节异常时原样返回 */
function compactMarket(store: Store, text: string, mdPath: string): string {
  const rows = sortedRows(loadMarketData(store));
  const i1 = text.indexOf("\n## 一、");
  const i2 = text.indexOf("\n## 二、");
  if (!rows.length || i1 < 0 || i2 < 0 || i2 < i1) return text;
  const cell = (s: string | number) => String(s ?? "").replace(/\|/g, "／").replace(/\r?\n/g, " ").trim();
  const table = [
    "| 站点 | 站点url | 当前的具体价格 | 站点排名热度 | 方向 | 是否适合我 |",
    "|---|---|---|---|---|---|",
    ...rows.map((r) => `| ${[r.site, r.url, r.price, r.heat, r.direction, r.fit].map(cell).join(" | ")} |`),
  ].join("\n");
  return `${text.slice(0, i1)}\n## 一、竞品总表（精简 6 列；完整 14 列含成立时间/备案/功能/推广/盈利/受众/风险见 ${mdPath}，需要时 read）\n\n${table}\n${text.slice(i2)}`;
}

/** 主审计注入段 */
export function marketSection(m: MarketDoc): string {
  const body = m.compact.length > MAX_INJECT_CHARS ? m.compact.slice(0, MAX_INJECT_CHARS) + "\n…[已截断，完整内容见档案 market.md]" : m.compact;
  const fresh = m.stale
    ? `⚠️ 已过期（${m.ageDays} 天 > ${STALE_DAYS} 天）：价格/热度类数据只能作为"曾经如此"的参考，引用时必须注明日期并建议用户 \`/value-audit market\` 刷新`
    : `距今 ${m.ageDays} 天，可直接作为 [联网检索] 来源（沿用其中的 URL 与日期，不必重抓）`;
  return `## 市场资料（/value-audit market 于 ${m.date} 生成）\n\n${fresh}。其中"改造建议"节是上次的处方，本次审计以当前代码与 facts 重新判断，不照搬。\n\n${body}`;
}

/** R1（v0.11.2）：固定一轮按核心形态检索 GitHub 仓库，避免 facts 为空的首审漏掉同形态竞品；v0.11.3 改短名词短语 + 0 命中子集重搜 */
function discoverySection(web: WebCapability): string {
  const cmd = web.gh
    ? "`gh api -X GET search/repositories -f q='<关键词>' -f sort=stars -f order=desc -f per_page=10 --jq '\"total=\\(.total_count)\", (.items[]|[.full_name,.stargazers_count,.pushed_at[0:10],(.license.spdx_id//\"none\"),.description]|@tsv)'`"
    : "`curl -s 'https://api.github.com/search/repositories?q=<URL 编码关键词>&sort=stars&order=desc&per_page=10'`（GET，无需登录；或用 node 内置 fetch 请求同一 URL）";
  return `## 同形态竞品检索（GitHub 仓库搜索 API，固定一轮，计入 25 次预算）

- 命令：${cmd}
- 关键词：按项目画像与核心逻辑生成 2–4 组，**每组 ≤3 词**（GitHub 中文搜索对短名词短语召回最好，长组合词会被无关仓库稀释或 0 命中）
  - **至少 2 组用取自项目自身描述的名词短语**：从一句话描述、README 标题或首段里摘核心名词短语，每组 2–3 个词（如"回复 候选""聊天 悬浮窗"）
  - **至少 1 组用项目主语言/界面语言（主语言关键词：中文界面/中文 README 的项目必须有中文关键词）**，**至少 1 组描述「输入→输出形态」**（如"截图 生成回复"），而不是产品名
  - 平台名/品牌名（如微信、ChatGPT、AI）不单独成组，也不用作凑数的修饰词
- 关键词只用通用形态词：不放项目名、内部路径、域名或业务敏感词（查询会发往第三方）
- 自适应重搜（**0 命中时用更短子集重搜**）：某组 0 命中或前 5 条全部无关时，去掉一个词再搜一次（计入预算），不能只在 pending 写"下次换词"就结束
- 命中结果按 star 排序，每组取前 3–5 条进入复核（读描述/README 判断是否同形态）；**同形态的高 star 项目必须进表**，判定不进表的写进 pending 并注明排除理由（如"非同形态：只做 X"）
- pending 逐组记录关键词与总命中数（取响应 total_count，上面命令首行已打印；含重搜的子集），供下次复盘`;
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
2. **抓取预算 ≤ 25 次**（GitHub API 调用、GitHub 仓库检索与网页抓取合计）；发现竞品的来源按优先级：facts 第 5 节点名的竞品 → 用户附加 URL → **GitHub 仓库检索（固定一轮，见下方「同形态竞品检索」节）** → 由上述页面/README 的"对比/类似项目"链接发现的新竞品。GitHub 仓库检索是平台内的仓库搜索 API，允许且必须做；除此之外不使用通用网页搜索引擎（Google/Bing 等）的接口。
3. **来源**：每个数据点附 URL 与访问日期（${today}）；只采信官网、官方文档、GitHub 仓库本身、知名机构报告；论坛传言不作为事实。
4. **只读**：只做 GET/API 读取，不登录、不注册、不提交表单；不修改项目文件；不调用 value_audit_save。
5. **主人处境**：遵守知识库处方纪律 11 与下方「主人档案」节——改造建议必须过其红线/需核实条目并逐条引用 id；档案内容不得复制进结果，只引用 id 与结论。
6. **提交**：完成后调用工具 \`value_audit_market_save\` 一次（rows 只含本次实际核实的竞品，heatScore 填数值；表格排序、历史行合并、写入 \`${target}\` 由工具完成，不要自己写文件）；然后向用户三句话汇报（最值得看的 1 个发现、1 条改造建议、文件路径），不复述全文。`);

  sections.push(webCapabilityText(o.web));
  sections.push(discoverySection(o.web));

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

本次：预算内优先复核热度最高的已知行（价格/热度变化），其余留给新竞品；diff 字段写出新增/消失的竞品、价格或热度变化、上次改造建议的采纳情况（对照决策日志）。上次调研（精简）：

${o.prev.compact.slice(0, MAX_INJECT_CHARS)}`);
  }
  sections.push(`## 方法论知识库（改造建议必须遵守其中"处方纪律"与"主人处境约束"）\n\n${o.knowledge.text}`);

  sections.push(`## 提交字段要求（value_audit_market_save）

- rows：每个竞品一行，字段对应表头 ${MARKET_COLUMNS}
  - 成立时间逐行注明口径（公司成立日 / GitHub 仓库创建日）；备案号写页面展示的号 / 未展示 / 无（境外托管）；价格只写官网可见价，需联系销售写"询价"
  - heat 写文字（⭐/fork/最近提交），heatScore 写数值，heatBasis 写口径（github_stars / self_reported / none）：页面自报的"累计使用 N 次"是 self_reported，不与 star 混排；同名撞车/非同赛道的也列出并在"方向"标明，避免下次重复查
  - fit："✅/⚠️/❌ + 一句话"，判断要结合 facts 第 0 节意图与主人档案
- changes：品类近 12 个月变化（大厂免费化/平台内置/监管/新进入者），每条附 URL；没查到写"未发现可靠来源"
- priceAnchors：同类产品主流盈利模式与价格带（sustain-loop A-2 检索 1 的输入）；facts 已填的外部证据按 [用户提供] 列入
- position：本项目在表中的位置（covered / differentiated / off-track）。硬规则：表中存在**同形态、同地域/语言、免费开源且活跃（最近 90 天有推送）**的竞品时，不得判 differentiated——除非 advice 写明具体差异点并引用该竞品所在行（站点名 + url）；否则判 covered
- advice（markdown）：
  1. 可借鉴点表：| 借鉴点 | 来源 | 可落到本项目哪里（文件/模块） |
  2. 改造建议 3-5 条：每条写 类型[验证/代码]、依据（引用表中行或 URL）、**主人处境约束（引用档案条目 id；无档案或无相关条目写"无相关约束"）**、成本（时间/月费/何时可停）；
     遵守处方纪律：零代码验证优先、不建议看板体系、不为未验证的方向写代码、意图为自用/开源时不催商业化、没有收款能力时不开收款类动作
  3. 不建议做的 1-3 件事（含理由）
- pending：抓取失败/页面未展示/需询价的条目，供用户补进 facts 第 5 节"外部证据补录"
- diff：仅有上次调研时填写`);

  return sections.join("\n\n---\n\n");
}

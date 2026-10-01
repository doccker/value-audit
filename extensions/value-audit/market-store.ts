/**
 * market-store.ts - 竞品数据的确定性落盘：按 URL 合并历史行、按热度降序渲染固定 14 列表、快照旧文件
 * 数据源 market.json（结构化，累积不覆盖）；market.md 是渲染产物，每次重新生成。
 * @author wwj
 */
import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Store } from "./store";

export const MARKET_COLUMNS =
  "| 站点 | 站点url | 成立时间 | 备案号 | 核心功能 | 运营推广模式 | 盈利模式 | 当前的具体价格 | 是否有试用 | 受众群体画像 | 站点排名热度 | 方向 | 风险 | 是否适合我 |";

const rowSchema = Type.Object({
  site: Type.String({ description: "站点/项目名" }),
  url: Type.String({ description: "站点 url（合并主键，同一竞品多次调研按此去重）" }),
  founded: Type.String({ description: "成立时间，注明口径：公司成立日 / GitHub 仓库创建日" }),
  icp: Type.String({ description: "备案号：页面展示的号 / 未展示 / 无（境外托管）" }),
  features: Type.String({ description: "核心功能" }),
  promotion: Type.String({ description: "运营推广模式" }),
  revenue: Type.String({ description: "盈利模式" }),
  price: Type.String({ description: "当前的具体价格（官网可见价；需联系销售写 询价）" }),
  trial: Type.String({ description: "是否有试用" }),
  audience: Type.String({ description: "受众群体画像" }),
  heat: Type.String({ description: "站点排名热度文字，如 ⭐3.3k / fork 524，最近提交 2026-09-06（star 代理）" }),
  heatScore: Type.Number({ description: "热度数值（GitHub star 数或页面可见数值；未知填 0），用于同口径内降序排序" }),
  heatBasis: StringEnum(["github_stars", "self_reported", "none"], { description: "热度口径：github_stars=第三方可核实的 star 数；self_reported=页面自报使用量/用户数（不可核实）；none=无数据。排序先按口径组（star > 自报 > 无）再按数值" }),
  direction: Type.String({ description: "方向/赛道" }),
  risk: Type.String({ description: "风险" }),
  fit: Type.String({ description: "是否适合我：✅/⚠️/❌ + 一句话" }),
  source: Type.String({ description: "数据来源 URL（可多个，逗号分隔）" }),
});
export type MarketRow = Static<typeof rowSchema>;

export const marketSaveParams = Type.Object({
  rows: Type.Array(rowSchema, { description: "本次核实的竞品行（只含本次实际抓取/核实过的；历史行由工具保留）" }),
  fetches: Type.Number({ description: "本次抓取次数" }),
  changes: Type.String({ description: "二、品类近 12 个月变化（markdown，每条附 URL）" }),
  priceAnchors: Type.String({ description: "三、价格锚点（markdown）" }),
  advice: Type.String({ description: "四、对本项目的改造建议（markdown；每条标注主人处境条目 id 或「无相关约束」）" }),
  pending: Type.String({ description: "五、待核实（markdown 列表）" }),
  diff: Type.Optional(Type.String({ description: "六、与上次调研的变化（仅有上次调研时填写）" })),
  position: StringEnum(["covered", "differentiated", "off-track"], { description: "本项目在竞品表中的位置：已被免费开源覆盖 / 有差异化空间 / 非同赛道" }),
});
export type MarketSavePayload = Static<typeof marketSaveParams>;

interface StoredRow extends MarketRow {
  firstSeen: string;
  lastSeen: string;
}
export interface MarketData {
  rows: Record<string, StoredRow>;
  runs: { date: string; fetches: number; position: string }[];
}

export function marketJsonPath(store: Store): string {
  return path.join(store.dir, "market.json");
}
export function marketPath(store: Store): string {
  return path.join(store.dir, "market.md");
}

export function loadMarketData(store: Store): MarketData {
  try {
    const d = JSON.parse(fs.readFileSync(marketJsonPath(store), "utf8")) as MarketData;
    if (d && typeof d === "object" && d.rows) return { rows: d.rows, runs: d.runs ?? [] };
  } catch {
    /* 首次调研 */
  }
  return { rows: {}, runs: [] };
}

/** 合并主键：去协议/www/结尾斜杠/大小写，同一站点不同写法归一 */
export function rowKey(url: string): string {
  return url
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/+$/, "")
    .replace(/\s.*$/, "");
}

/** 本次行覆盖同键历史行的非空字段；未出现的历史行原样保留 */
export function mergeRows(data: MarketData, incoming: MarketRow[], today: string): MarketData {
  const rows = { ...data.rows };
  for (const r of incoming) {
    const k = rowKey(r.url);
    if (!k) continue;
    const prev = rows[k];
    const merged: StoredRow = { ...(prev ?? ({} as StoredRow)), firstSeen: prev?.firstSeen ?? today, lastSeen: today } as StoredRow;
    for (const [field, v] of Object.entries(r)) {
      if (typeof v === "number" || (typeof v === "string" && v.trim())) (merged as Record<string, unknown>)[field] = v;
    }
    rows[k] = merged;
  }
  return { rows, runs: data.runs };
}

const BASIS_RANK: Record<string, number> = { github_stars: 0, self_reported: 1, none: 2 };
const basisOf = (r: StoredRow) => r.heatBasis ?? (r.heatScore > 0 && /⭐|star/i.test(r.heat) ? "github_stars" : "none");
/** 口径组优先（可核实 > 自报 > 无），组内按数值降序，再按站名 */
export function sortedRows(data: MarketData): StoredRow[] {
  return Object.values(data.rows).sort(
    (a, b) => BASIS_RANK[basisOf(a)] - BASIS_RANK[basisOf(b)] || b.heatScore - a.heatScore || a.site.localeCompare(b.site, "zh"),
  );
}

const cell = (s: string | number | undefined) => String(s ?? "").replace(/\|/g, "／").replace(/\r?\n/g, " ").trim();

export function renderMarket(store: Store, data: MarketData, p: MarketSavePayload, today: string, version: string): string {
  const sorted = sortedRows(data);
  const stale = sorted.filter((r) => r.lastSeen !== today).length;
  const positionText = { covered: "已被免费开源覆盖", differentiated: "有差异化空间", "off-track": "非同赛道" }[p.position];
  const lines = [
    `# 市场与竞品调研：${path.basename(store.projectPath)}`,
    ``,
    `> 调研日期：${today}　工具：value-audit v${version}　本次抓取：${p.fetches} 次　累计调研：${data.runs.length} 次　竞品累计：${sorted.length} 个（本次未复核 ${stale} 个，热度列标注其数据日期）`,
    `> 口径说明：成立时间 = 公司成立日或 GitHub 仓库创建日（逐行注明）；热度按口径分组排序：GitHub star（第三方可核实）> 页面自报使用量（标「自报」，不可核实）> 无数据，组内按数值降序；备案号 = 页面底部是否展示（境外托管写"无"）；价格只写官网可见价。`,
    `> 本项目位置：**${positionText}**`,
    ``,
    `## 一、竞品总表（累计，按热度降序）`,
    ``,
    MARKET_COLUMNS,
    `|---|---|---|---|---|---|---|---|---|---|---|---|---|---|`,
    ...sorted.map((r) => {
      const basisTag = basisOf(r) === "self_reported" ? "【自报】" : "";
      const heat = `${basisTag}${r.heat}${r.lastSeen === today ? "" : `（${r.lastSeen} 数据，本次未复核）`}`;
      return `| ${[r.site, r.url, r.founded, r.icp, r.features, r.promotion, r.revenue, r.price, r.trial, r.audience, heat, r.direction, r.risk, r.fit].map(cell).join(" | ")} |`;
    }),
    ``,
    `来源：${sorted.map((r) => `${cell(r.site)}: ${cell(r.source)}`).join("；")}`,
    ``,
    `## 二、品类近 12 个月变化`,
    ``,
    p.changes.trim() || "（未发现可靠来源）",
    ``,
    `## 三、价格锚点`,
    ``,
    p.priceAnchors.trim() || "（未查到）",
    ``,
    `## 四、对本项目的改造建议（${today}）`,
    ``,
    p.advice.trim(),
    ``,
    `## 五、待核实`,
    ``,
    p.pending.trim() || "（无）",
  ];
  if (p.diff?.trim()) lines.push(``, `## 六、与上次调研的变化`, ``, p.diff.trim());
  lines.push(``, `> 历次调研：${data.runs.map((r) => `${r.date}（${r.fetches} 次）`).join("、")}；旧版全文见 history/market-*.md；结构化数据 market.json`);
  return lines.join("\n") + "\n";
}

/** 保存：快照旧 md → 合并行 → 写 json 与 md；返回 md 路径 */
export function saveMarket(store: Store, p: MarketSavePayload, version: string): { mdPath: string; total: number; merged: number } {
  const today = new Date().toISOString().slice(0, 10);
  const mdPath = marketPath(store);
  if (fs.existsSync(mdPath)) {
    fs.mkdirSync(store.historyDir, { recursive: true });
    const prev = fs.readFileSync(mdPath, "utf8");
    const prevDate = prev.match(/调研日期[：:]\s*(\d{4}-\d{2}-\d{2})/)?.[1] ?? "unknown";
    fs.writeFileSync(path.join(store.historyDir, `market-${prevDate}.md`), prev, "utf8");
  }
  const before = loadMarketData(store);
  const data = mergeRows(before, p.rows, today);
  data.runs = [...before.runs, { date: today, fetches: p.fetches, position: p.position }];
  fs.writeFileSync(marketJsonPath(store), JSON.stringify(data, null, 2), "utf8");
  fs.writeFileSync(mdPath, renderMarket(store, data, p, today, version), "utf8");
  const merged = p.rows.filter((r) => before.rows[rowKey(r.url)]).length;
  return { mdPath, total: Object.keys(data.rows).length, merged };
}

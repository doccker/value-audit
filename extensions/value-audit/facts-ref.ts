/**
 * facts-ref.ts - 给 facts.md 里仍为 [待补充] 的条目挂〔参考样例〕
 * 来源两类：模型提交的 factsDrafts（可草拟类）+ 市场资料的确定性派生（竞品名单、价格锚点）。
 * 原则：条目值保持 [待补充]（统计与意图解析不受影响）；用户填写过的行绝不触碰；每次审计重写样例段，幂等。
 * @author wwj
 */
import * as fs from "node:fs";
import { entryKey, type Store } from "./store";
import { loadMarketData, sortedRows } from "./market-store";

export interface FactsDraft {
  entry: string;
  draft: string;
  source: string;
}

const REF_RE = /〔参考样例[\s\S]*?〕/g;

/** 指纹/对比用：去掉工具挂的参考样例，避免"工具自己写的东西"触发"facts 变化" */
export function stripFactsRefs(text: string): string {
  return text.replace(REF_RE, "");
}
const clean = (s: string) => s.replace(/[〔〕]/g, "").replace(/\s*\n\s*/g, " ").trim();

/** 从市场资料派生的样例：竞品名单（按热度）、价格锚点 */
function marketDrafts(store: Store): FactsDraft[] {
  const data = loadMarketData(store);
  const rows = sortedRows(data);
  const out: FactsDraft[] = [];
  const date = data.sections?.date ?? data.runs[data.runs.length - 1]?.date ?? "";
  if (rows.length) {
    const direct = rows.filter((r) => !/非同赛道|撞车|无关/.test(r.direction)).slice(0, 6);
    out.push({
      entry: "直接竞争对手",
      draft: direct.map((r) => `${r.site}（${r.direction.split(/[（(]/)[0].trim()}，${r.heat.split(/[，,]/)[0]}）`).join("、"),
      source: `market.md ${date}`,
    });
  }
  const anchors = data.sections?.priceAnchors
    ?.split("\n")
    .map((l) => l.replace(/^[-*]\s*/, "").trim())
    .filter(Boolean)
    .slice(0, 2)
    .join("；");
  if (anchors) {
    out.push({ entry: "当前定价或定价想法", draft: `同类价格带参考：${anchors.slice(0, 220)}`, source: `market.md ${date} 价格锚点` });
    out.push({ entry: "外部证据补录", draft: anchors.slice(0, 220), source: `market.md ${date}；正式价以官网/商务报价为准` });
  }
  return out;
}

/** 返回写入/更新的条目数；facts 不存在返回 0 */
export function applyFactsRefs(store: Store, drafts: FactsDraft[] | undefined): number {
  let text: string;
  try {
    text = fs.readFileSync(store.factsPath, "utf8");
  } catch {
    return 0;
  }
  const all = [...(drafts ?? []), ...marketDrafts(store)];
  if (!all.length) return 0;
  let n = 0;
  const lines = text.split("\n").map((line) => {
    if (!line.startsWith("- ") || !line.includes("：")) return line;
    // 已填写的行：清掉残留的参考样例（填写即事实，样例失去意义）
    if (!line.includes("[待补充]")) {
      if (!line.includes("〔参考样例")) return line;
      n++;
      return line.replace(REF_RE, "").replace(/\s+$/, "");
    }
    const key = entryKey(line);
    const d = all.find((x) => x.entry && (key.includes(x.entry.trim()) || x.entry.trim().includes(key)));
    if (!d || !d.draft.trim()) return line;
    const base = line.replace(REF_RE, "").replace(/\s+$/, "");
    n++;
    return `${base}〔参考样例：${clean(d.draft)}｜来源：${clean(d.source)}｜核实后用真实情况替换冒号后整段〕`;
  });
  if (n) fs.writeFileSync(store.factsPath, lines.join("\n"), "utf8");
  return n;
}

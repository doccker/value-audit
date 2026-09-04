/**
 * citations.ts - 报告引用路径核实（反幻觉，确定性）
 * 解析 [代码证实 路径] 标记，路径在项目内不存在的就地标 ⚠️ 并汇总，把"诚实"从纪律变成机制。
 * @author wwj
 */
import * as fs from "node:fs";
import * as path from "node:path";

export interface CitationCheck {
  markdown: string;
  total: number;
  missing: string[];
}

const MARK_RE = /\[代码证实[:：]?\s*([^\]]+)\]/g;

/** 从标记正文里抽出路径候选：按分隔符切分，只保留像路径的 token，剥离行号与包裹符 */
function extractPaths(body: string): string[] {
  return body
    .split(/[\s,，;；、]+/)
    .map((t) => t.replace(/^[`'"(（]+|[`'")）.。]+$/g, "").replace(/:\d+(-\d+)?$/, "").replace(/#L\d+.*$/, ""))
    .filter((t) => t.length > 1 && /[/.]/.test(t) && !/^https?:/.test(t) && !/[*?]/.test(t));
}

function exists(root: string, p: string): boolean {
  const target = path.isAbsolute(p) ? p : path.join(root, p);
  try {
    fs.accessSync(target);
    return true;
  } catch {
    return false;
  }
}

export function verifyCitations(markdown: string, root: string): CitationCheck {
  const missing = new Set<string>();
  let total = 0;
  const out = markdown.replace(MARK_RE, (whole, body: string) => {
    if (whole.includes("⚠️")) return whole; // 幂等：已标注过的不重复处理
    const paths = extractPaths(body);
    if (paths.length === 0) return whole;
    total++;
    const bad = paths.filter((p) => !exists(root, p));
    if (bad.length === 0) return whole;
    bad.forEach((p) => missing.add(p));
    return `[代码证实 ${body.trim()} ⚠️路径不存在]`;
  });
  return { markdown: out, total, missing: [...missing] };
}

/** 汇报用一句话；无问题返回空串 */
export function citationSummary(c: CitationCheck): string {
  if (c.missing.length === 0) return "";
  return `⚠️ 引用核实：${c.total} 处 [代码证实] 中 ${c.missing.length} 个路径在项目内不存在，已就地标注（${c.missing.slice(0, 5).join("，")}${c.missing.length > 5 ? " …" : ""}）；请把对应结论视为 [待验证]`;
}

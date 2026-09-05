/**
 * citations.ts - 报告引用路径核实（反幻觉，确定性）
 * 解析 [代码证实 路径] 标记，路径在项目内不存在的就地标 ⚠️ 并汇总，把"诚实"从纪律变成机制。
 * v0.9：剥离路径后的括号说明、丢弃含中日韩字符的 token（qiandao 实战 6/67 全是这类误报）；
 *       没给任何路径的 [代码证实] 单独标 ⚠️缺路径 并单独计数（"无路径不列"的机制化）。
 * @author wwj
 */
import * as fs from "node:fs";
import * as path from "node:path";

export interface CitationCheck {
  markdown: string;
  /** 附了路径候选的 [代码证实] 数量 */
  total: number;
  /** 项目内不存在的路径（去重） */
  missing: string[];
  /** 一个路径都没附的 [代码证实] 数量（图例占位如 "[代码证实 路径]" 不计） */
  noPath: number;
}

const MARK_RE = /\[代码证实[:：]?\s*([^\]]+)\]/g;
/** 中日韩字符与全角符号：真实路径里不会出现，出现即为说明文字 */
const CJK_RE = /[\u3000-\u9fff\uf900-\ufaff\uff00-\uffef]/;
/** 图例/占位写法，不算"缺路径"（报告头部常有 "[代码证实 路径] / [用户提供] ..." 的标记说明） */
const PLACEHOLDER_RE = /^[\s:：]*(路径|文件路径|完整相对路径|path|paths|file|files|…|\.{3})?\s*$/i;

/**
 * 剥离括号说明：全角（）永不出现在真实路径中，成对的整体剥离；
 * 半角 (…) 仅剥离紧贴分隔符/结尾的说明组，保护 Next.js `app/(group)/page.tsx` 这类路径段。
 */
function stripAnnotations(body: string): string {
  return body.replace(/（[^（）]*）/g, " ").replace(/\([^()]*\)(?=[\s,，;；、]|$)/g, " ");
}

/** 从标记正文里抽出路径候选：剥括号说明 → 按分隔符切分 → 剥包裹符/行号 → 只留像路径且不含说明文字的 token */
function extractPaths(body: string): string[] {
  return stripAnnotations(body)
    .split(/[\s,，;；、]+/)
    .map((t) =>
      t
        .replace(/（.*$/, "") // 不成对的全角左括号：截到路径结束
        .replace(/^[`'"(（]+|[`'")）.。]+$/g, "")
        .replace(/:\d+(-\d+)?$/, "")
        .replace(/#L\d+.*$/, ""),
    )
    .filter((t) => t.length > 1 && /[/.]/.test(t) && !/^https?:/.test(t) && !/[*?]/.test(t) && !CJK_RE.test(t));
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

/**
 * 宽容解析：
 * - 同目录省略写法 `internal/model/task.go、goal.go`：goal.go 继承前一个路径的目录
 * - 半角括号说明未被剥离（如 `a.go(Func`）：仅当截断到 `(` 之前的前缀真实存在时才接受
 * 返回每个 token 的可解析形式（找不到时保留原样以便标注）。
 */
function resolveLenient(root: string, paths: string[]): { p: string; ok: boolean }[] {
  let lastDir = "";
  return paths.map((p) => {
    if (exists(root, p)) {
      lastDir = path.dirname(p);
      return { p, ok: true };
    }
    if (lastDir && !p.includes("/") && exists(root, path.join(lastDir, p))) return { p: path.join(lastDir, p), ok: true };
    const cut = p.replace(/\(.*$/, "");
    if (cut !== p && cut.length > 1 && exists(root, cut)) {
      lastDir = path.dirname(cut);
      return { p: cut, ok: true };
    }
    return { p, ok: false };
  });
}

export function verifyCitations(markdown: string, root: string): CitationCheck {
  const missing = new Set<string>();
  let total = 0;
  let noPath = 0;
  const out = markdown.replace(MARK_RE, (whole, body: string) => {
    if (whole.includes("⚠️")) return whole; // 幂等：已标注过的不重复处理
    const paths = extractPaths(body);
    if (paths.length === 0) {
      if (PLACEHOLDER_RE.test(body)) return whole;
      noPath++;
      return `[代码证实 ${body.trim()} ⚠️缺路径]`;
    }
    total++;
    const bad = resolveLenient(root, paths).filter((r) => !r.ok).map((r) => r.p);
    if (bad.length === 0) return whole;
    bad.forEach((p) => missing.add(p));
    return `[代码证实 ${body.trim()} ⚠️路径不存在: ${bad.join(", ")}]`;
  });
  return { markdown: out, total, missing: [...missing], noPath };
}

/** 汇报用一句话；无问题返回空串 */
export function citationSummary(c: CitationCheck): string {
  if (c.missing.length === 0 && c.noPath === 0) return "";
  const parts: string[] = [];
  if (c.missing.length) {
    const list = c.missing.slice(0, 5).map((p) => `\`${p}\``).join(" | ") + (c.missing.length > 5 ? " …" : "");
    parts.push(`${c.total} 处 [代码证实] 中 ${c.missing.length} 个路径在项目内不存在，已就地标注（${list}）`);
  }
  if (c.noPath) parts.push(`${c.noPath} 处 [代码证实] 未附任何路径（含"同上"类写法），已标 ⚠️缺路径`);
  return `⚠️ 引用核实：${parts.join("；")}；请把对应结论视为 [待验证]；工具不会替你确认它们存在，若确属简写请在下次报告写完整相对路径、说明文字放在方括号外`;
}

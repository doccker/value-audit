/**
 * walk.ts - 画像采集的文件系统层：DFS 计数/信号采集 + BFS 目录树 + 嵌套仓库折叠 + 本地数据文件检测
 * v0.9 背景（qiandao 实战）：仓内 vendored 三个第三方仓，字母序 DFS 让 150 条目录树全被 all-api-hub/* 占满，
 * 商业化信号 20 条中 17 条来自别人的计费代码，测试数 129 vs 实际 59。嵌套仓库折叠后不计入文件数/信号/测试/树。
 * 输出参与指纹计算：禁止包含文件大小、时间戳等每次变化的内容。
 * @author wwj
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { OBS_PATH_WORDS } from "./observability";

export const IGNORED_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "target", "out", "vendor", "third_party", "venv", ".venv",
  "__pycache__", ".next", ".nuxt", ".idea", ".vscode", "coverage", ".cache", ".value-audit",
]);

export const STACK_MANIFESTS: [string, string][] = [
  ["package.json", "Node.js/前端"],
  ["go.mod", "Go"],
  ["pom.xml", "Java (Maven)"],
  ["build.gradle", "Java/Kotlin (Gradle)"],
  ["build.gradle.kts", "Kotlin (Gradle)"],
  ["pyproject.toml", "Python"],
  ["requirements.txt", "Python"],
  ["Cargo.toml", "Rust"],
  ["composer.json", "PHP"],
  ["Gemfile", "Ruby"],
];

const SIGNAL_WORDS = [
  "billing", "payment", "pay", "subscription", "subscribe", "stripe", "price", "pricing",
  "invoice", "tenant", "quota", "license", "checkout", "wallet", "coupon", "vip", "member",
  "order", "refund", "credit",
];

/** 构建产物：带 8 位 hash 的 js/css、min 文件、source map——不作为信号/观测/测试证据（仍计入文件数） */
const ARTIFACT_RE = /(-[A-Za-z0-9_-]{8}|\.min)\.(js|mjs|cjs|css)$|\.map$/;
/** 本地数据文件：真实使用数据所在，审计可只读聚合（隐私红线见 README"隐私与匿名统计"） */
const DATA_FILE_RE = /\.(db|sqlite|sqlite3|duckdb)$/i;
const LICENSE_RE = /^(license|licence|copying)(\.|$)/i;
const README_RE = /^readme(\.|$)/i;

/** 嵌套仓库：含 .git（目录或文件），或 LICENSE + 语言清单 + README 三者齐备（去掉 .git 的 vendored 拷贝） */
export function looksNestedRepo(entries: fs.Dirent[]): boolean {
  const names = entries.map((e) => e.name);
  if (names.includes(".git")) return true;
  const hasManifest = STACK_MANIFESTS.some(([f]) => names.includes(f));
  return hasManifest && names.some((n) => LICENSE_RE.test(n)) && names.some((n) => README_RE.test(n));
}

function readDir(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

const skipDir = (e: fs.Dirent): boolean => IGNORED_DIRS.has(e.name) || e.name.startsWith(".");

export interface WalkResult {
  fileCount: number;
  signalPaths: string[];
  obsPaths: string[];
  dataFiles: string[];
  /** 已折叠的嵌套仓库相对路径（带尾部 /） */
  nestedRepos: string[];
  testCount: number;
  truncated: boolean;
}

/** DFS 全量遍历：文件计数、商业化/观测信号、测试数、数据文件；嵌套仓库整目录跳过 */
export function walk(root: string): WalkResult {
  const r: WalkResult = { fileCount: 0, signalPaths: [], obsPaths: [], dataFiles: [], nestedRepos: [], testCount: 0, truncated: false };
  let visited = 0;
  const MAX_VISIT = 8000;

  const walkDir = (dir: string, rel: string, depth: number): void => {
    if (visited >= MAX_VISIT) {
      r.truncated = true;
      return;
    }
    const entries = readDir(dir);
    if (depth > 0 && looksNestedRepo(entries)) {
      r.nestedRepos.push(`${rel}/`);
      return;
    }
    for (const e of entries) {
      if (visited++ >= MAX_VISIT) {
        r.truncated = true;
        return;
      }
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (!skipDir(e)) walkDir(path.join(dir, e.name), relPath, depth + 1);
      } else if (e.isFile()) {
        r.fileCount++;
        if (DATA_FILE_RE.test(e.name) && r.dataFiles.length < 5) r.dataFiles.push(relPath);
        if (ARTIFACT_RE.test(e.name)) continue;
        const lower = relPath.toLowerCase();
        if (/(^|[./_-])(test|spec)s?([./_-]|$)/.test(lower)) r.testCount++;
        // LICENSE/COPYING 等协议文件会误命中 "license" 关键词，排除（审计报告 B6）
        if (r.signalPaths.length < 20 && !/^(license|copying|notice)\b/i.test(e.name) && SIGNAL_WORDS.some((w) => lower.includes(w))) {
          r.signalPaths.push(relPath);
        }
        if (r.obsPaths.length < 10 && OBS_PATH_WORDS.some((w) => lower.includes(w))) r.obsPaths.push(relPath);
      }
    }
  };
  walkDir(root, "", 0);
  return r;
}

/**
 * BFS 目录树：先铺完一层再下钻，保证根目录与各顶层模块可见；子目录是结构信息全部列出，
 * 文件每目录最多 perDir 个（根目录文件多时不至于把 web/ 这类字母序靠后的目录截掉）；嵌套仓库折叠为一行。
 * 旧实现是字母序 DFS，第一个大目录就会吃掉全部条目预算。
 */
export function buildTree(root: string, maxLines = 150, maxDepth = 3, perDir = 30): { lines: string[]; truncated: boolean } {
  const lines: string[] = [];
  const queue: { abs: string; rel: string; depth: number }[] = [{ abs: root, rel: "", depth: 0 }];
  let truncated = false;
  while (queue.length) {
    if (lines.length >= maxLines) {
      truncated = true;
      break;
    }
    const { abs, rel, depth } = queue.shift()!;
    const all = readDir(abs).filter((e) => !e.isSymbolicLink() && (e.isFile() || (e.isDirectory() && !skipDir(e))));
    const dirs = all.filter((e) => e.isDirectory());
    const files = all.filter((e) => !e.isDirectory());
    let shownFiles = 0;
    for (const e of [...dirs, ...files]) {
      if (lines.length >= maxLines) {
        truncated = true;
        break;
      }
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (!e.isDirectory()) {
        if (shownFiles++ >= perDir) {
          lines.push(`${rel ? `${rel}/` : ""}… 另 ${files.length - perDir} 个文件未列出`);
          break;
        }
        lines.push(relPath);
        continue;
      }
      const childAbs = path.join(abs, e.name);
      if (looksNestedRepo(readDir(childAbs))) {
        lines.push(`${relPath}/（嵌套仓库，已折叠）`);
        continue;
      }
      lines.push(`${relPath}/`);
      if (depth + 1 < maxDepth) queue.push({ abs: childAbs, rel: relPath, depth: depth + 1 });
    }
  }
  return { lines, truncated };
}

/**
 * profiler.ts - 项目画像确定性采集（不走 LLM，不烧 token）
 * 输出文本参与指纹计算，因此禁止包含时间戳等每次变化的内容。
 * @author wwj
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export interface ProjectProfile {
  text: string;
  gitCommit: string | null;
}

const IGNORED_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "target", "out", "vendor", "venv", ".venv",
  "__pycache__", ".next", ".nuxt", ".idea", ".vscode", "coverage", ".cache", ".value-audit",
]);

const SIGNAL_WORDS = [
  "billing", "payment", "pay", "subscription", "subscribe", "stripe", "price", "pricing",
  "invoice", "tenant", "quota", "license", "checkout", "wallet", "coupon", "vip", "member",
  "order", "refund", "credit",
];

const SIGNAL_DEPS = ["stripe", "alipay", "wechatpay", "paypal", "braintree", "paddle", "lemonsqueezy"];

const STACK_MANIFESTS: [string, string][] = [
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

function git(cwd: string, args: string): string | null {
  try {
    return execSync(`git ${args}`, { cwd, encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

function readSafe(p: string, maxChars = 4000): string {
  try {
    return fs.readFileSync(p, "utf8").slice(0, maxChars);
  } catch {
    return "";
  }
}

interface WalkResult {
  treeLines: string[];
  fileCount: number;
  signalPaths: string[];
  testCount: number;
  truncated: boolean;
}

function walk(root: string): WalkResult {
  const treeLines: string[] = [];
  const signalPaths: string[] = [];
  let fileCount = 0;
  let testCount = 0;
  let visited = 0;
  let truncated = false;
  const MAX_VISIT = 8000;
  const MAX_TREE = 150;
  const MAX_DEPTH = 3;

  const walkDir = (dir: string, rel: string, depth: number): void => {
    if (visited >= MAX_VISIT) {
      truncated = true;
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (visited++ >= MAX_VISIT) {
        truncated = true;
        return;
      }
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (IGNORED_DIRS.has(e.name) || e.name.startsWith(".")) continue;
        if (depth < MAX_DEPTH && treeLines.length < MAX_TREE) treeLines.push(`${relPath}/`);
        walkDir(path.join(dir, e.name), relPath, depth + 1);
      } else if (e.isFile()) {
        fileCount++;
        if (depth < MAX_DEPTH && treeLines.length < MAX_TREE) treeLines.push(relPath);
        const lower = relPath.toLowerCase();
        if (/(^|[./_-])(test|spec)s?([./_-]|$)/.test(lower)) testCount++;
        // LICENSE/COPYING 等协议文件会误命中 "license" 关键词，排除（审计报告 B6）
        if (signalPaths.length < 20 && !/^(license|copying|notice)\b/i.test(e.name) && SIGNAL_WORDS.some((w) => lower.includes(w))) {
          signalPaths.push(relPath);
        }
      }
    }
  };
  walkDir(root, "", 0);
  if (treeLines.length >= MAX_TREE) truncated = true;
  return { treeLines, fileCount, signalPaths, testCount, truncated };
}

function detectStacks(root: string): string[] {
  const lines: string[] = [];
  for (const [file, label] of STACK_MANIFESTS) {
    const p = path.join(root, file);
    if (!fs.existsSync(p)) continue;
    let detail = "";
    if (file === "package.json") {
      try {
        const pkg = JSON.parse(fs.readFileSync(p, "utf8"));
        const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).sort();
        detail = `（name: ${pkg.name ?? "?"}，依赖 ${deps.length} 个：${deps.slice(0, 40).join(", ")}${deps.length > 40 ? " ..." : ""}）`;
        const hits = deps.filter((d) => SIGNAL_DEPS.some((s) => d.toLowerCase().includes(s)));
        if (hits.length) detail += `【支付类依赖: ${hits.join(", ")}】`;
      } catch {
        detail = "（解析失败）";
      }
    } else if (file === "go.mod") {
      const mod = readSafe(p, 500).split("\n").find((l) => l.startsWith("module "));
      detail = mod ? `（${mod.trim()}）` : "";
    }
    lines.push(`- ${label}: ${file} ${detail}`);
  }
  return lines;
}

function findReadme(root: string): string {
  try {
    const entry = fs.readdirSync(root).find((f) => f.toLowerCase().startsWith("readme"));
    if (!entry) return "（无 README）";
    const content = readSafe(path.join(root, entry));
    const lines = content.split("\n").slice(0, 60).join("\n");
    return `<${entry} 前 60 行>\n${lines}`;
  } catch {
    return "（无 README）";
  }
}

function gitSummary(root: string): { lines: string[]; commit: string | null } {
  const commit = git(root, "rev-parse --short HEAD");
  if (!commit) return { lines: ["- 非 git 项目（或无提交）"], commit: null };
  const count = git(root, "rev-list --count HEAD") ?? "?";
  // 按署名去重（同一人多邮箱很常见，按邮箱统计会高估团队规模）
  const names = git(root, "log --format=%an -n 500");
  const authorCount = names ? new Set(names.split("\n")).size : 0;
  return {
    lines: [`- HEAD: ${commit}，提交数: ${count}，作者数（按署名去重，同人多邮箱计为一人）: ${authorCount}`],
    commit,
  };
}

/** 用户自有计划文档：处方前必须阅读对照，避免开出重复/过期药方 */
function planningDocs(root: string): string[] {
  const hits: string[] = [];
  const mtime = (p: string) => {
    try {
      return fs.statSync(p).mtime.toISOString().slice(0, 10);
    } catch {
      return "?";
    }
  };
  for (const c of ["TODO.md", "ROADMAP.md", "PLAN.md"]) {
    const p = path.join(root, c);
    if (fs.existsSync(p)) hits.push(`${c}（更新 ${mtime(p)}）`);
  }
  // .codex/tasks 目录语义即任务，全部纳入；docs/ 按关键词过滤
  for (const [dir, all] of [[".codex/tasks", true], ["docs", false]] as [string, boolean][]) {
    try {
      for (const f of fs.readdirSync(path.join(root, dir)).sort()) {
        if (!/\.md$/i.test(f)) continue;
        if (!all && !/(todo|roadmap|plan|task|action)/i.test(f)) continue;
        const p = path.join(root, dir, f);
        if (fs.statSync(p).isFile()) hits.push(`${dir}/${f}（更新 ${mtime(p)}）`);
      }
    } catch {
      /* 目录不存在属正常 */
    }
  }
  return hits.slice(0, 15);
}

export function collectProfile(root: string): ProjectProfile {
  const w = walk(root);
  const infra: string[] = [];
  const has = (p: string) => fs.existsSync(path.join(root, p));
  if (has(".github/workflows") || has(".gitlab-ci.yml")) infra.push("CI 配置");
  if (has("Dockerfile") || has("docker-compose.yml") || has("compose.yml")) infra.push("Docker");
  if (has("LICENSE") || has("LICENSE.md")) infra.push("LICENSE");
  if (w.testCount > 0) infra.push(`测试相关文件约 ${w.testCount} 个`);
  const g = gitSummary(root);
  const plans = planningDocs(root);

  const text = [
    `## 技术栈`,
    ...(detectStacks(root).length ? detectStacks(root) : ["- 未识别到主流语言清单文件（可能为文档/脚本/空项目）"]),
    ``,
    `## 规模与结构`,
    `- 文件总数: ${w.fileCount}${w.truncated ? "（超限截断）" : ""}`,
    `- 目录树（限深 ${3} 层，最多 150 条）:`,
    ...w.treeLines.map((l) => `  ${l}`),
    ``,
    `## 商业化信号`,
    w.signalPaths.length
      ? `- 命中路径（关键词: 计费/订阅/租户/配额等）:\n${w.signalPaths.map((p) => `  - ${p}`).join("\n")}`
      : `- 未发现计费/订阅/租户等商业化代码痕迹`,
    ``,
    `## 工程化`,
    infra.length ? `- ${infra.join("；")}` : `- 未发现 CI/Docker/LICENSE/测试`,
    ``,
    `## git`,
    ...g.lines,
    ``,
    `## 用户自有计划文档（处方前必须逐个阅读，优先最新，对照后再开 backlog）`,
    plans.length ? plans.map((p) => `- ${p}`).join("\n") : `- 未发现计划类文档`,
    ``,
    `## README 摘要`,
    findReadme(root),
  ].join("\n");

  return { text, gitCommit: g.commit };
}

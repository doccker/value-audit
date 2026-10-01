/**
 * profiler.ts - 项目画像确定性采集（不走 LLM，不烧 token）
 * 输出文本参与指纹计算，因此禁止包含时间戳等每次变化的内容。
 * 文件系统遍历（DFS 计数/BFS 目录树/嵌套仓库折叠）在 walk.ts。
 * @author wwj
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { collectObservability } from "./observability";
import { IGNORED_DIRS, STACK_MANIFESTS, buildTree, walk } from "./walk";

export interface ProjectProfile {
  text: string;
  gitCommit: string | null;
}

const SIGNAL_DEPS = ["stripe", "alipay", "wechatpay", "paypal", "braintree", "paddle", "lemonsqueezy"];

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

function describeManifest(p: string, file: string): string {
  if (file === "package.json") {
    try {
      const pkg = JSON.parse(fs.readFileSync(p, "utf8"));
      const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).sort();
      let detail = `（name: ${pkg.name ?? "?"}，依赖 ${deps.length} 个：${deps.slice(0, 40).join(", ")}${deps.length > 40 ? " ..." : ""}）`;
      const hits = deps.filter((d) => SIGNAL_DEPS.some((s) => d.toLowerCase().includes(s)));
      if (hits.length) detail += `【支付类依赖: ${hits.join(", ")}】`;
      return detail;
    } catch {
      return "（解析失败）";
    }
  }
  if (file === "go.mod") {
    const mod = readSafe(p, 500).split("\n").find((l) => l.startsWith("module "));
    return mod ? `（${mod.trim()}）` : "";
  }
  return "";
}

/** 技术栈：根目录 + 一层子目录的清单文件（前后端分目录很常见，如 web/package.json）；嵌套仓库不算 */
function detectStacks(root: string, nestedRepos: string[]): string[] {
  const dirs = [""];
  try {
    for (const e of fs.readdirSync(root, { withFileTypes: true })) {
      if (e.isDirectory() && !IGNORED_DIRS.has(e.name) && !e.name.startsWith(".") && !nestedRepos.includes(`${e.name}/`)) dirs.push(e.name);
    }
  } catch {
    /* 根目录不可读时只看根清单 */
  }
  const lines: string[] = [];
  for (const dir of dirs.sort()) {
    for (const [file, label] of STACK_MANIFESTS) {
      const rel = dir ? `${dir}/${file}` : file;
      const p = path.join(root, rel);
      if (!fs.existsSync(p)) continue;
      lines.push(`- ${label}: ${rel} ${describeManifest(p, file)}`);
    }
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

/** 提交目录热度：开发投入用脚投票，审计时对照官方定位发现漂移；嵌套仓库的提交不算本项目投入 */
function commitHeat(root: string, nestedRepos: string[]): string[] {
  const out = git(root, "log --format= --name-only -n 200");
  if (!out) return [];
  const counts = new Map<string, number>();
  for (const raw of out.split("\n")) {
    const l = raw.trim();
    if (!l || nestedRepos.some((n) => l.startsWith(n))) continue;
    const seg = l.split("/");
    const key = seg.length === 1 ? "(根目录)" : seg.slice(0, Math.min(2, seg.length - 1)).join("/");
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([d, n]) => `${d}: ${n}`);
}

/**
 * 用户自有计划文档：处方前必须阅读对照，避免开出重复/过期药方。
 * v0.9 补齐 .codex/references（决策参考）与 .codex/tasks/archived（"用户已完成"的证据源）。
 */
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
  // .codex/tasks 与 .codex/references 目录语义即计划/决策，全部纳入；docs/ 按关键词过滤
  for (const [dir, all] of [[".codex/tasks", true], [".codex/references", true], ["docs", false]] as [string, boolean][]) {
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
  const out = hits.slice(0, 15);
  try {
    const dir = path.join(root, ".codex/tasks/archived");
    const files = fs
      .readdirSync(dir)
      .filter((f) => /\.md$/i.test(f))
      .map((f) => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    if (files.length) {
      const latest = files.slice(0, 5).map((x) => `${x.f}（更新 ${mtime(path.join(dir, x.f))}）`).join("，");
      out.push(`.codex/tasks/archived/：${files.length} 份已完成任务——"用户已完成"的证据源，勿再开成 backlog；最新 5 份：${latest}`);
    }
  } catch {
    /* 无归档目录属正常 */
  }
  return out;
}

export function collectProfile(root: string): ProjectProfile {
  const w = walk(root);
  const tree = buildTree(root);
  const infra: string[] = [];
  const has = (p: string) => fs.existsSync(path.join(root, p));
  if (has(".github/workflows") || has(".gitlab-ci.yml")) infra.push("CI 配置");
  if (has("Dockerfile") || has("docker-compose.yml") || has("compose.yml")) infra.push("Docker");
  if (has("LICENSE") || has("LICENSE.md")) infra.push("LICENSE");
  if (w.testCount > 0) infra.push(`测试相关文件约 ${w.testCount} 个`);
  const g = gitSummary(root);
  const plans = planningDocs(root);
  const obs = collectObservability(root, w.obsPaths, w.nestedRepos);
  const stacks = detectStacks(root, w.nestedRepos);
  const nestedNote = w.nestedRepos.length ? "（不含已折叠嵌套仓库）" : "";

  const text = [
    `## 技术栈`,
    ...(stacks.length ? stacks : ["- 未识别到主流语言清单文件（可能为文档/脚本/空项目）"]),
    ``,
    `## 规模与结构`,
    `- 文件总数: ${w.fileCount}${nestedNote}${w.truncated ? "（超限截断）" : ""}`,
    ...(w.nestedRepos.length
      ? [`- 嵌套仓库（含 .git 或自带 LICENSE+清单+README 的子目录；已折叠，不计入文件数/信号/测试/热度，审计时视为第三方代码，不作为本项目的商业化或测试证据）: ${w.nestedRepos.join("，")}`]
      : []),
    `- 目录树（广度优先，限深 3 层，最多 150 条，每目录最多 30 项${tree.truncated ? "，已截断" : ""}）:`,
    ...tree.lines.map((l) => `  ${l}`),
    ``,
    `## 商业化信号`,
    w.signalPaths.length
      ? `- 命中路径（关键词: 计费/订阅/租户/配额等）:\n${w.signalPaths.map((p) => `  - ${p}`).join("\n")}`
      : `- 未发现计费/订阅/租户等商业化代码痕迹`,
    ``,
    `## 观测/统计信号（负责人能否看到用户与模块使用情况；分级 <2 时审计必须给接入建议）`,
    ...obs.lines,
    ``,
    ...(w.dataFiles.length
      ? [
          `## 本地数据文件（真实使用数据；可只读聚合核实用户画像与用量——只取计数/分布/量级，不读明细行、不复制、不上传；facts 含"不要读取本地数据文件"则跳过）`,
          ...w.dataFiles.map((p) => `- ${p}`),
          ``,
        ]
      : []),
    `## 工程化`,
    infra.length ? `- ${infra.join("；")}` : `- 未发现 CI/Docker/LICENSE/测试`,
    ``,
    `## git`,
    ...g.lines,
    ...(g.commit ? [`- 近 200 次提交目录热度（开发重心用脚投票，审计时对照定位）: ${commitHeat(root, w.nestedRepos).join("，") || "无"}`] : []),
    ``,
    `## 用户自有计划文档（处方前必须逐个阅读，优先最新，对照后再开 backlog）`,
    plans.length ? plans.map((p) => `- ${p}`).join("\n") : `- 未发现计划类文档`,
    ``,
    `## README 摘要`,
    findReadme(root),
  ].join("\n");

  return { text, gitCommit: g.commit };
}

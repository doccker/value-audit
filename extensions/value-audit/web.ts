/**
 * web.ts - 联网检索能力的确定性检测，生成给审计 agent 的「联网能力」prompt 段
 * 只检测、不联网：gh CLI 是否登录、playwright 是否可解析、curl 是否存在；
 * 抓取本身由 fetch-page.mjs（随扩展发布）在 agent 调用 bash 时执行。
 * @author wwj
 */
import { execFileSync, execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface WebCapability {
  gh: boolean;
  playwright: boolean;
  curl: boolean;
  fetchScript: string;
}

function has(cmd: string, args: string[]): boolean {
  try {
    execFileSync(cmd, args, { stdio: "ignore", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/** 与 fetch-page.mjs 同一套候选目录，只判断存在性，不加载模块 */
function playwrightInstalled(pkgRoot: string): boolean {
  const bases = [process.env.VALUE_AUDIT_PW_ROOT, path.join(pkgRoot, "node_modules"), path.join(process.cwd(), "node_modules")];
  try {
    bases.push(execSync("npm root -g", { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim());
  } catch {
    /* 无 npm */
  }
  const sub = (d: string) => {
    try {
      return fs.readdirSync(d).map((n) => path.join(d, n));
    } catch {
      return [];
    }
  };
  for (const v of sub(path.join(os.homedir(), ".nvm", "versions", "node"))) bases.push(path.join(v, "lib", "node_modules"));
  for (const d of sub(path.join(os.homedir(), ".npm", "_npx"))) bases.push(path.join(d, "node_modules"));
  return bases
    .filter((b): b is string => Boolean(b))
    .some((b) => ["playwright", "playwright-core", "@playwright/test"].some((n) => fs.existsSync(path.join(b, n, "package.json"))));
}

let cached: WebCapability | null = null;

export function detectWebCapability(pkgRoot: string): WebCapability {
  if (cached) return cached;
  cached = {
    gh: has("gh", ["auth", "status"]),
    playwright: playwrightInstalled(pkgRoot),
    curl: has("curl", ["--version"]),
    fetchScript: path.join(pkgRoot, "extensions", "value-audit", "fetch-page.mjs"),
  };
  return cached;
}

/** prompt 段：告诉 agent 本机有什么、怎么调；没有任何可用手段时明确说退回 [待验证] */
export function webCapabilityText(c: WebCapability): string {
  const lines: string[] = ["## 联网能力（启动时确定性检测；只读 GET，不登录、不提交表单、不写项目文件）", ""];
  lines.push(
    c.gh
      ? "- GitHub 仓库客观数据（star/fork/创建时间/最近推送/License/描述）：`gh api repos/<owner>/<repo> --jq '[.stargazers_count,.forks_count,.created_at[0:10],.pushed_at[0:10],(.license.spdx_id//\"none\"),.description]|@tsv'`；README：`gh api repos/<owner>/<repo>/readme --jq .content | base64 -d`"
      : "- gh CLI 不可用或未登录：GitHub 数据改用抓取网页正文（star 数以页面文字为准）",
  );
  lines.push(
    `- 网页正文（官网/定价页/文档）：\`node ${c.fetchScript} [--max 6000] <url> [<url>...]\`（${
      c.playwright ? "本机已有 playwright，JS 渲染页可取正文" : "本机无 playwright，退回纯 HTTP 抓取，JS 渲染页可能只有壳"
    }）；若会话内有 playwright/浏览器类 MCP 工具，也可直接使用`,
  );
  if (!c.curl && !c.playwright) lines.push("- 注意：本机无 curl 且无 playwright，仅能依赖 node 内置 fetch");
  lines.push(
    "- 来源纪律：每条网络信息附 URL + 访问日期；页面未展示的内容写「未展示/未核实」，不用训练记忆补数；",
    "  「成立时间」若取自仓库创建日、「热度」若以 star 代理，必须注明口径",
  );
  return lines.join("\n");
}

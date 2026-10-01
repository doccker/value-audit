/**
 * observability.ts - 用户/模块使用情况观测手段的确定性检测（不走 LLM）
 * 回答"项目负责人能不能看到用户用了哪些模块"；输出参与指纹，禁止含时间戳。
 * @author wwj
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/** 路径关键词：命中即视为可能的观测相关代码（由 profiler walk 收集） */
export const OBS_PATH_WORDS = ["analytics", "telemetry", "tracking", "tracker", "metrics", "statistic", "埋点"];

type Category = "product" | "error" | "infra" | "log";

const CATEGORY_LABEL: Record<Category, string> = {
  product: "产品分析 SDK（可记录用户/模块使用）",
  error: "错误监控",
  infra: "基础设施指标",
  log: "日志库",
};

/** 依赖名片段 → 分类；匹配对象为各语言清单文件全文（小写） */
const DEP_PATTERNS: [string, Category][] = [
  ["posthog", "product"], ["mixpanel", "product"], ["amplitude", "product"], ["@segment/", "product"],
  ["analytics-node", "product"], ["@vercel/analytics", "product"], ["react-ga", "product"], ["vue-gtag", "product"],
  ["umami", "product"], ["plausible", "product"], ["openpanel", "product"],
  ["rudder", "product"], ["hotjar", "product"], ["clarity", "product"],
  ["sa-sdk", "product"], ["sensorsdata", "product"], ["growingio", "product"], ["umeng", "product"],
  ["talkingdata", "product"], ["matomo", "product"], ["countly", "product"], ["aptabase", "product"],
  ["firebase-analytics", "product"], ["firebase/analytics", "product"],
  ["sentry", "error"], ["bugsnag", "error"], ["rollbar", "error"], ["crashlytics", "error"],
  ["prom-client", "infra"], ["prometheus", "infra"], ["micrometer", "infra"], ["opentelemetry", "infra"],
  ["statsd", "infra"], ["datadog", "infra"], ["newrelic", "infra"], ["elastic-apm", "infra"], ["skywalking", "infra"],
  ["winston", "log"], ["pino", "log"], ["log4j", "log"], ["logback", "log"], ["zap", "log"], ["logrus", "log"],
  ["loguru", "log"], ["structlog", "log"],
];

const MANIFESTS = [
  "package.json", "go.mod", "pom.xml", "build.gradle", "build.gradle.kts", "requirements.txt",
  "pyproject.toml", "Cargo.toml", "composer.json", "Gemfile",
];

/** 内嵌统计脚本域名/标识 → 显示名 */
const SCRIPT_MARKS: [RegExp, string][] = [
  [/googletagmanager\.com|google-analytics\.com|gtag\(/, "Google Analytics/GTM"],
  [/hm\.baidu\.com|_hmt\.push/, "百度统计"],
  [/cnzz\.com|umeng\.com|umeng\.js/, "友盟/CNZZ"],
  [/51\.la/, "51.la"],
  [/plausible\.io/, "Plausible"],
  [/umami/i, "Umami"],
  [/clarity\.ms/, "Microsoft Clarity"],
  [/posthog/, "PostHog"],
  [/mixpanel/, "Mixpanel"],
  [/hotjar/, "Hotjar"],
  [/matomo|piwik/, "Matomo"],
  [/sensorsdata|sa\.track/, "神策"],
  [/growingio/, "GrowingIO"],
];

const HTML_CANDIDATES = [
  "index.html", "public/index.html", "src/index.html", "app/layout.tsx", "src/app/layout.tsx",
  "pages/_document.tsx", "pages/_app.tsx", "src/pages/_document.tsx", "app.vue", "src/App.vue",
  "nuxt.config.ts", "nuxt.config.js", "next.config.js", "next.config.mjs", "templates/base.html",
  "templates/index.html", "templates/layout.html",
];

/** 事件上报调用特征（模块级事件的直接证据），用 git grep 限制范围与耗时 */
const EVENT_CALL_PATTERN =
  "(posthog|mixpanel|amplitude|analytics|umami|plausible|sa|_hmt|gtag|logEvent|trackEvent|sendEvent|recordEvent|capture)[.(]\\s*(track|capture|logEvent|event|push|['\"])";

function readSafe(p: string, maxChars: number): string {
  try {
    return fs.readFileSync(p, "utf8").slice(0, maxChars);
  } catch {
    return "";
  }
}

function detectDeps(root: string): Map<Category, string[]> {
  const found = new Map<Category, string[]>();
  for (const m of MANIFESTS) {
    const text = readSafe(path.join(root, m), 20000).toLowerCase();
    if (!text) continue;
    for (const [pat, cat] of DEP_PATTERNS) {
      if (!text.includes(pat)) continue;
      const list = found.get(cat) ?? [];
      const label = `${pat}（${m}）`;
      if (!list.includes(label)) list.push(label);
      found.set(cat, list);
    }
  }
  return found;
}

function detectScripts(root: string): string[] {
  const hits: string[] = [];
  for (const rel of HTML_CANDIDATES) {
    const text = readSafe(path.join(root, rel), 30000);
    if (!text) continue;
    for (const [re, name] of SCRIPT_MARKS) {
      if (re.test(text) && !hits.some((h) => h.startsWith(name))) hits.push(`${name}（${rel}）`);
    }
  }
  return hits;
}

function gitRun(root: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

/** 返回 null = 非 git 项目未扫描；[] = 已扫描无命中（git grep 无命中退出码 1） */
function detectEventCalls(root: string, excludeDirs: string[]): string[] | null {
  if (gitRun(root, ["rev-parse", "--is-inside-work-tree"]) === null) return null;
  // 嵌套仓库（vendored 第三方代码）的事件调用不是本项目的观测能力，用 pathspec 排除
  const excludes = excludeDirs.map((d) => `:!${d.replace(/\/$/, "")}`);
  const out = gitRun(root, ["grep", "-l", "-E", EVENT_CALL_PATTERN, "--", ":!*.lock", ":!*.min.js", ":!node_modules", ":!dist", ...excludes]);
  return out ? out.split("\n").slice(0, 10) : [];
}

export interface ObservabilityResult {
  level: 0 | 1 | 2 | 3;
  lines: string[];
}

/**
 * 观测就绪分级：
 * 0 无任何观测；1 仅错误监控/基础设施指标/日志（看得到系统，看不到用户）；
 * 2 有产品分析 SDK 或内嵌统计脚本，但未发现模块级事件上报调用（只有 PV/会话级）；
 * 3 发现事件上报调用（模块覆盖度需 LLM 读码核实）。
 */
export function collectObservability(root: string, obsPaths: string[], excludeDirs: string[] = []): ObservabilityResult {
  const deps = detectDeps(root);
  const scripts = detectScripts(root);
  const calls = detectEventCalls(root, excludeDirs);
  const hasProduct = (deps.get("product")?.length ?? 0) > 0 || scripts.length > 0;
  const hasSystemOnly = (["error", "infra", "log"] as Category[]).some((c) => (deps.get(c)?.length ?? 0) > 0);
  const hasCalls = (calls?.length ?? 0) > 0;

  let level: 0 | 1 | 2 | 3 = 0;
  if (hasCalls) level = 3;
  else if (hasProduct) level = 2;
  else if (hasSystemOnly || obsPaths.length > 0) level = 1;

  const LEVEL_TEXT = {
    0: "0/3 —— 未发现任何用户观测手段：负责人看不到有没有人用、用了哪个模块",
    1: "1/3 —— 只有错误监控/指标/日志类（看得到系统健康，看不到用户行为与模块使用）",
    2: "2/3 —— 有产品分析 SDK/统计脚本，但未发现模块级事件上报调用（大概率只有 PV/会话级）",
    3: "3/3 —— 发现事件上报调用；模块覆盖度与事件命名是否对应功能模块需读码核实",
  } as const;

  const lines: string[] = [`- 观测就绪分级: ${LEVEL_TEXT[level]}`];
  for (const cat of ["product", "error", "infra", "log"] as Category[]) {
    const list = deps.get(cat);
    if (list?.length) lines.push(`- ${CATEGORY_LABEL[cat]}: ${list.join("，")}`);
  }
  if (scripts.length) lines.push(`- 内嵌统计脚本: ${scripts.join("，")}`);
  if (calls === null) lines.push(`- 事件上报调用: 非 git 项目未扫描（审计时用 grep 核实）`);
  else if (calls.length) lines.push(`- 事件上报调用命中文件（git grep，最多 10 个）: ${calls.join("，")}`);
  else lines.push(`- 事件上报调用: 未命中（源码中无 track/capture/logEvent 类调用）`);
  if (obsPaths.length) lines.push(`- 观测相关路径关键词命中: ${obsPaths.join("，")}`);
  return { level, lines };
}

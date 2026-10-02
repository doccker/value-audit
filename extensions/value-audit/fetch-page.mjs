#!/usr/bin/env node
/**
 * fetch-page.mjs - 只读抓取网页正文（value-audit 联网检索用）
 * 用法：node fetch-page.mjs [--max 6000] <url> [<url>...]
 * 有本机 playwright 则用 headless chromium（JS 渲染页也能取到正文），否则退回 fetch + 去标签。
 * 只发 GET，不登录、不提交表单、不写任何文件；输出到 stdout，每个 URL 一段。
 * @author wwj
 */
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
let max = 6000;
const urls = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--max") max = Number(args[++i]) || max;
  else urls.push(args[i]);
}
if (urls.length === 0) {
  console.error("用法：node fetch-page.mjs [--max 6000] <url>...");
  process.exit(2);
}

/** 列出目录下的子目录（不存在返回空） */
function subdirs(dir) {
  try {
    return fs.readdirSync(dir).map((n) => path.join(dir, n));
  } catch {
    return [];
  }
}

/** 依次从环境变量、脚本目录、cwd、全局 npm、其他 nvm 版本、npx 缓存解析 playwright；都没有返回 null */
function resolvePlaywright() {
  const bases = [process.env.VALUE_AUDIT_PW_ROOT, path.dirname(fileURLToPath(import.meta.url)), process.cwd()];
  try {
    bases.push(execSync("npm root -g", { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim());
  } catch {
    /* 无 npm 时跳过 */
  }
  for (const v of subdirs(path.join(os.homedir(), ".nvm", "versions", "node"))) bases.push(path.join(v, "lib", "node_modules"));
  for (const d of subdirs(path.join(os.homedir(), ".npm", "_npx"))) bases.push(path.join(d, "node_modules")); // @playwright/mcp 自带 playwright-core
  for (const base of bases.filter(Boolean)) {
    for (const name of ["playwright", "playwright-core", "@playwright/test"]) {
      try {
        const req = createRequire(path.join(base, "noop.js"));
        const entry = req.resolve(name);
        if (name !== "@playwright/test") return req(name);
        return createRequire(entry)("playwright"); // @playwright/test 自带 playwright 依赖
      } catch {
        /* 继续下一个候选 */
      }
    }
  }
  return null;
}

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

async function viaFetch(url) {
  const res = await fetch(url, { headers: { "user-agent": UA, "accept-language": "zh-CN,zh;q=0.9,en;q=0.8" }, redirect: "follow", signal: AbortSignal.timeout(30000) });
  const text = stripHtml(await res.text());
  return { text, method: `fetch ${res.status}` };
}

async function viaPlaywright(pw, url) {
  const browser = await pw.chromium.launch();
  try {
    const ctx = await browser.newContext({ locale: "zh-CN", userAgent: UA });
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(2500);
    const text = (await page.innerText("body")).replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
    return { text, method: "playwright" };
  } finally {
    await browser.close();
  }
}

const pw = resolvePlaywright();
const now = new Date().toISOString().slice(0, 10);
let ok = 0;
for (const url of urls) {
  if (!/^https?:\/\//i.test(url)) {
    console.log(`=== ${url}\nERR 只支持 http(s) URL\n`);
    continue;
  }
  try {
    let r;
    if (pw) {
      try {
        r = await viaPlaywright(pw, url);
      } catch (e) {
        r = await viaFetch(url);
        r.method += `（playwright 失败后退回：${String(e?.message ?? e).split("\n")[0].slice(0, 80)}）`;
      }
    } else {
      r = await viaFetch(url);
    }
    const body = r.text.length > max ? r.text.slice(0, max) + "\n…[截断]" : r.text;
    console.log(`=== ${url} (${r.method}, ${r.text.length} chars, ${now})\n${body}\n`);
    ok++;
  } catch (e) {
    console.log(`=== ${url}\nERR ${String(e?.message ?? e).split("\n")[0]}\n`);
  }
}
console.log(`--- 本次抓取 ${urls.length} 个 URL，成功 ${ok} 个（计入联网预算 ${urls.length} 次）`);

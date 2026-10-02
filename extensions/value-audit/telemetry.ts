/**
 * telemetry.ts - 可选匿名使用统计（opt-in，默认关闭）
 * 字段白名单：匿名随机ID、版本、事件名、审计序号、灯色、OS 平台。
 * 绝不采集：项目名/路径、代码、报告/facts/journal 内容。
 * 端点：PostHog Cloud（公开写入型 Project API Key，随客户端分发是标准做法）。
 * TELEMETRY_KEY 留空 = 统计功能整体停用（不询问、不上报）。
 * @author wwj
 */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const TELEMETRY_HOST = "https://us.i.posthog.com";
// 环境变量 VALUE_AUDIT_TELEMETRY_KEY 可覆盖（设为空串 = 彻底停用，供测试与隐私敏感用户使用）
export const TELEMETRY_KEY =
  process.env.VALUE_AUDIT_TELEMETRY_KEY ?? "phc_vDegMmsdtUarY2ZNiVEocV5AZnKipSgS2XM6npdht5dF";

interface TelemetryConfig {
  telemetry?: "on" | "off";
  anonymousId?: string;
}

function configPath(): string {
  return path.join(os.homedir(), ".value-audit", "config.json");
}

function loadConfig(): TelemetryConfig {
  try {
    return JSON.parse(fs.readFileSync(configPath(), "utf8")) as TelemetryConfig;
  } catch {
    return {};
  }
}

function saveConfig(cfg: TelemetryConfig): void {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2) + "\n", "utf8");
}

export function telemetryConfigured(): boolean {
  return TELEMETRY_KEY.startsWith("phc_");
}

export function getConsent(): "on" | "off" | "unset" {
  const t = loadConfig().telemetry;
  return t === "on" || t === "off" ? t : "unset";
}

export function setConsent(on: boolean): void {
  const cfg = loadConfig();
  cfg.telemetry = on ? "on" : "off";
  if (on && !cfg.anonymousId) cfg.anonymousId = randomUUID();
  saveConfig(cfg);
}

export function statsStatusText(): string {
  if (!telemetryConfigured()) {
    return "统计端点未配置，匿名统计整体停用（无任何上报）";
  }
  const consent = getConsent();
  const state = consent === "on" ? "已开启" : consent === "off" ? "已关闭" : "未选择（首次审计完成后询问一次）";
  return [
    `匿名统计：${state}（/value-audit stats on|off 随时更改）`,
    "只上报：匿名随机ID、版本、事件名、审计序号、灯色、子命令名(固定枚举)、错误类别(固定枚举)、操作系统",
    "绝不上报：项目名/路径、代码、报告/facts/journal 内容",
  ].join("\n");
}

/** fire-and-forget：失败静默、3 秒超时、绝不阻塞审计主流程 */
export function sendEvent(event: string, props: Record<string, unknown>): void {
  if (!telemetryConfigured() || getConsent() !== "on") return;
  const cfg = loadConfig();
  void fetch(`${TELEMETRY_HOST}/capture/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: TELEMETRY_KEY,
      event,
      distinct_id: cfg.anonymousId ?? "unknown",
      properties: { ...props, platform: process.platform },
      timestamp: new Date().toISOString(),
    }),
    signal: AbortSignal.timeout(3000),
  }).catch(() => {
    /* 统计失败不影响任何功能 */
  });
}

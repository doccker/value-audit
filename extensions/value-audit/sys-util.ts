/**
 * sys-util.ts - 与审计逻辑无关的系统辅助：时间片名、打开目录、git diff 统计
 * @author wwj
 */
import { execSync, spawn } from "node:child_process";

export function timeSlug(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 用系统默认程序打开文件/目录（macOS/Windows/Linux），失败静默忽略 */
export function openPath(target: string): void {
  const cmd =
    process.platform === "darwin" ? ["open", target]
    : process.platform === "win32" ? ["cmd", "/c", "start", "", target]
    : ["xdg-open", target];
  try {
    spawn(cmd[0], cmd.slice(1), { stdio: "ignore", detached: true }).unref();
  } catch {
    /* 打不开不影响主流程 */
  }
}

export function gitDiffSince(cwd: string, commit: string): string | null {
  try {
    const stat = execSync(`git diff ${commit}..HEAD --stat`, {
      cwd, encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return stat ? stat.split("\n").slice(0, 80).join("\n") : "（无文件变化，可能仅有未提交改动）";
  } catch {
    return null;
  }
}

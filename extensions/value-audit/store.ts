/**
 * store.ts - 档案与状态读写（~/.value-audit/projects/<id>/）
 * 职责：项目身份、state.json 读写、facts 只增不改合并、报告原子写入 + history 快照、指纹。
 * 规范依据：docs/state-spec.md、docs/report-spec.md
 * @author wwj
 */
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** 档案根目录（运行时计算，便于测试覆盖 HOME） */
export function projectsRoot(): string {
  return path.join(os.homedir(), ".value-audit", "projects");
}

/** git 仓库根提交 hash（多根仓库取最早），非 git/无提交返回 null */
function gitRootCommit(cwd: string): string | null {
  try {
    const out = execSync("git rev-list --max-parents=0 HEAD", {
      cwd, encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out.split("\n").pop() || null;
  } catch {
    return null;
  }
}

export type Verdict = "red" | "yellow" | "green";
export type BacklogStatus = "open" | "partial" | "done" | "dropped";
export type QuestionStatus = "code-verified" | "user-provided" | "web-verified" | "unverified";

export interface AuditRecord {
  seq: number;
  timestamp: string;
  verdict: Verdict | null;
  verdictReason: string;
  fingerprint: string;
  gitCommit: string | null;
  snapshot: string;
  /** v0.8：报告中路径不存在的 [代码证实] 数量（反幻觉信号：编了路径） */
  unverifiedCitations?: number;
  /** v0.9：未附任何路径的 [代码证实] 数量（反幻觉信号：没给路径） */
  noPathCitations?: number;
}

export interface BacklogItem {
  id: string;
  title: string;
  status: BacklogStatus;
  priority: "P0" | "P1" | "P2";
  files: string[];
  addedAtSeq: number;
  updatedAtSeq: number;
}

export interface QuestionMark {
  id: string;
  status: QuestionStatus;
}

export interface AuditState {
  version: number;
  projectPath: string;
  projectId: string;
  knowledgeVersion: string;
  audits: AuditRecord[];
  backlog: BacklogItem[];
  questions: QuestionMark[];
}

export interface SaveBacklogInput {
  id: string;
  title: string;
  status: BacklogStatus;
  priority: "P0" | "P1" | "P2";
  files?: string[];
}

export interface SavePayload {
  verdict: Verdict;
  verdictReason: string;
  reportMarkdown: string;
  backlog: SaveBacklogInput[];
  questions: QuestionMark[];
}

export interface SaveMeta {
  seq: number;
  timestamp: string;
  fingerprint: string;
  gitCommit: string | null;
  snapshot: string;
  knowledgeVersion: string;
}

export class Store {
  readonly projectPath: string;
  readonly projectId: string;
  readonly dir: string;
  readonly historyDir: string;

  constructor(projectPath: string) {
    this.projectPath = fs.realpathSync(projectPath);
    const base = path.basename(this.projectPath).replace(/[^\w.-]+/g, "_") || "project";
    const pathHash = createHash("sha256").update(this.projectPath).digest("hex").slice(0, 8);
    const legacyId = `${base}-${pathHash}`;
    // 身份 v2（B7）：git 根提交优先（目录移动不丢档案；同仓库多 clone 共享档案），非 git 回退路径 hash
    const rootCommit = gitRootCommit(this.projectPath);
    this.projectId = rootCommit ? `${base}-g${rootCommit.slice(0, 8)}` : legacyId;
    this.dir = path.join(projectsRoot(), this.projectId);
    this.historyDir = path.join(this.dir, "history");
    // 旧路径 hash 档案自动迁移，保护已沉淀的历史
    const legacyDir = path.join(projectsRoot(), legacyId);
    if (this.projectId !== legacyId && !fs.existsSync(this.dir) && fs.existsSync(legacyDir)) {
      fs.mkdirSync(path.dirname(this.dir), { recursive: true });
      fs.renameSync(legacyDir, this.dir);
    }
  }

  get reportPath(): string {
    return path.join(this.dir, "VALUE-AUDIT.md");
  }
  get factsPath(): string {
    return path.join(this.dir, "facts.md");
  }
  get statePath(): string {
    return path.join(this.dir, "state.json");
  }

  ensure(): void {
    fs.mkdirSync(this.historyDir, { recursive: true });
  }

  /** 损坏/不存在的 state 视为首次审计（state-spec 规则 1）。 */
  loadState(): AuditState | null {
    try {
      const raw = fs.readFileSync(this.statePath, "utf8");
      const parsed = JSON.parse(raw) as AuditState;
      if (parsed.version !== 1 || !Array.isArray(parsed.audits) || !Array.isArray(parsed.backlog)) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  newState(knowledgeVersion: string): AuditState {
    return {
      version: 1,
      projectPath: this.projectPath,
      projectId: this.projectId,
      knowledgeVersion,
      audits: [],
      backlog: [],
      questions: [],
    };
  }

  saveState(state: AuditState): void {
    this.atomicWrite(this.statePath, JSON.stringify(state, null, 2) + "\n");
  }

  readFacts(): string {
    try {
      return fs.readFileSync(this.factsPath, "utf8");
    } catch {
      return "";
    }
  }

  /** facts 只增不改：不存在则复制模板；存在则仅追加模板中新增的条目/小节。 */
  initOrMergeFacts(templatePath: string): { created: boolean; appended: number } {
    const template = fs.readFileSync(templatePath, "utf8");
    if (!fs.existsSync(this.factsPath)) {
      this.atomicWrite(this.factsPath, template);
      return { created: true, appended: 0 };
    }
    const existing = fs.readFileSync(this.factsPath, "utf8");
    const existingKeys = new Set(collectEntryKeys(existing));
    const lines = existing.split("\n");
    let appended = 0;

    const sections = parseSections(template);
    for (const [si, section] of sections.entries()) {
      const missing = section.entries.filter((e) => !existingKeys.has(e.key));
      if (missing.length === 0) continue;
      const headerIdx = lines.findIndex((l) => l.trim() === section.header.trim());
      const insertLines = missing.map((e) => e.line);
      if (headerIdx === -1) {
        // 新小节按模板顺序落位：插到后续第一个已存在小节之前（如 v0.9 的“0. 项目意图”要在“1.”之前），都不存在则追加到文末
        let anchor = -1;
        for (const later of sections.slice(si + 1)) {
          anchor = lines.findIndex((l) => l.trim() === later.header.trim());
          if (anchor !== -1) break;
        }
        if (anchor === -1) lines.push("", section.header, "", ...insertLines);
        else lines.splice(anchor, 0, section.header, "", ...insertLines, "");
      } else {
        let end = lines.length;
        for (let i = headerIdx + 1; i < lines.length; i++) {
          if (lines[i].startsWith("## ")) {
            end = i;
            break;
          }
        }
        while (end > headerIdx + 1 && lines[end - 1].trim() === "") end--;
        lines.splice(end, 0, ...insertLines);
      }
      appended += missing.length;
    }
    if (appended > 0) this.atomicWrite(this.factsPath, lines.join("\n"));
    return { created: false, appended };
  }

  fingerprint(profileText: string, factsText: string, knowledgeVersion: string): string {
    return (
      "sha256:" +
      createHash("sha256").update(profileText).update("\u0000").update(factsText).update("\u0000").update(knowledgeVersion).digest("hex")
    );
  }

  /** 原子写报告 + history 快照；返回快照数量供上层提示清理。 */
  writeReport(markdown: string, slug: string): { reportPath: string; snapshotPath: string; historyCount: number } {
    this.atomicWrite(this.reportPath, markdown);
    const snapshotPath = path.join(this.historyDir, `${slug}.md`);
    fs.copyFileSync(this.reportPath, snapshotPath);
    const historyCount = fs.readdirSync(this.historyDir).filter((f) => f.endsWith(".md")).length;
    return { reportPath: this.reportPath, snapshotPath, historyCount };
  }

  /**
   * 应用一次审计保存：分配 backlog 真实 ID（占位符替换）、合并 backlog、覆盖 questions、追加 audit 记录。
   * ID 分配是确定性代码职责（state-spec 规则 3）。
   */
  applySave(state: AuditState, payload: SavePayload, meta: SaveMeta): { markdown: string; state: AuditState } {
    const existingIds = new Set(state.backlog.map((b) => b.id));
    let nextNum = state.backlog.reduce((max, b) => {
      const n = Number(b.id.replace(/^B/, ""));
      return Number.isFinite(n) && n > max ? n : max;
    }, 0) + 1;

    const idMap = new Map<string, string>();
    for (const item of payload.backlog) {
      if (existingIds.has(item.id)) {
        const target = state.backlog.find((b) => b.id === item.id)!;
        target.status = item.status;
        target.priority = item.priority;
        if (item.files?.length) target.files = item.files;
        target.updatedAtSeq = meta.seq;
      } else {
        const realId = `B${nextNum++}`;
        idMap.set(item.id, realId);
        state.backlog.push({
          id: realId,
          title: item.title,
          status: item.status,
          priority: item.priority,
          files: item.files ?? [],
          addedAtSeq: meta.seq,
          updatedAtSeq: meta.seq,
        });
      }
    }

    let markdown = payload.reportMarkdown;
    // 长占位符先替换，避免 B-NEW-1 命中 B-NEW-10 的前缀
    const placeholders = [...idMap.keys()].sort((a, b) => b.length - a.length);
    for (const ph of placeholders) {
      markdown = markdown.split(ph).join(idMap.get(ph)!);
    }

    state.questions = payload.questions;
    state.knowledgeVersion = meta.knowledgeVersion;
    state.audits.push({
      seq: meta.seq,
      timestamp: meta.timestamp,
      verdict: payload.verdict,
      verdictReason: payload.verdictReason,
      fingerprint: meta.fingerprint,
      gitCommit: meta.gitCommit,
      snapshot: meta.snapshot,
    });
    return { markdown, state };
  }

  private atomicWrite(target: string, content: string): void {
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, content, "utf8");
    fs.renameSync(tmp, target);
  }
}

interface TemplateSection {
  header: string;
  entries: { key: string; line: string }[];
}

function parseSections(text: string): TemplateSection[] {
  const sections: TemplateSection[] = [];
  let current: TemplateSection | null = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("## ")) {
      current = { header: line, entries: [] };
      sections.push(current);
    } else if (current && line.startsWith("- ") && line.includes("：")) {
      current.entries.push({ key: line.slice(2, line.indexOf("：")).trim(), line });
    }
  }
  return sections;
}

function collectEntryKeys(text: string): string[] {
  const keys: string[] = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("- ") && line.includes("：")) {
      keys.push(line.slice(2, line.indexOf("：")).trim());
    }
  }
  return keys;
}

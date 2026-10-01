/**
 * save-schema.ts - value_audit_save 工具的参数 schema（从 index.ts 拆出以控制文件体积）
 * @author wwj
 */
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

export const saveParams = Type.Object({
  verdict: StringEnum(["red", "yellow", "green"], { description: "整体灯色结论" }),
  verdictReason: Type.String({ description: "一句话理由，引用触发条款，如：红灯：Q3 停用无损失" }),
  reportMarkdown: Type.String({ description: "完整报告 markdown；新 backlog 条目用 B-NEW-x 占位" }),
  backlog: Type.Array(
    Type.Object({
      id: Type.String({ description: "已有条目用真实 ID（如 B3）；新条目用 B-NEW-1、B-NEW-2…" }),
      title: Type.String(),
      status: StringEnum(["open", "partial", "done", "dropped"]),
      priority: StringEnum(["P0", "P1", "P2"]),
      files: Type.Optional(Type.Array(Type.String(), { description: "涉及文件/目录" })),
    }),
    { description: "全量 backlog（旧条目核销 + 新条目）；红灯时传空数组" },
  ),
  questions: Type.Array(
    Type.Object({
      id: Type.String({ description: "Q1..Q32" }),
      status: StringEnum(["code-verified", "user-provided", "web-verified", "unverified"]),
    }),
    { description: "投资人 32 题来源标记；红灯时传空数组" },
  ),
  next: Type.Optional(
    Type.Object({
      action: Type.String({ description: "本周唯一动作：第 7 节最小下一步原句，单动作当天可完成" }),
      blocker: Type.Optional(Type.String({ description: "当前最卡的一件事，一句" })),
      triggers: Type.Optional(Type.Array(Type.String(), { description: "复审触发 When-Then，2-3 条原句" })),
    }),
    { description: "一页纸 NEXT.md 内容（可选但强烈建议）" },
  ),
});

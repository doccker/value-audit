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
      kind: Type.Optional(StringEnum(["verify", "code"], { description: "verify=验证类（问人/取数/访谈，不改代码）；code=代码类改造任务（进 PLAN.md）；缺省时按是否带 steps/target 推断" })),
      why: Type.Optional(Type.String({ description: "白话一句：修的是审计中的哪个发现（如“停用后没有沉淀物”），不了解七问的 LLM 也能懂" })),
      target: Type.Optional(Type.String({ description: "代码类必填：目标状态——改完后用户/负责人能观察到什么不同，1-2 句" })),
      steps: Type.Optional(Type.Array(Type.String(), { description: "代码类必填：文件级改动点，每条“相对路径：改什么”；新文件写“新增 路径：…”；路径必须真实存在" })),
      acceptance: Type.Optional(Type.Array(Type.String(), { description: "代码类必填：验收标准，每条可观察/可测（行为、测试、读数）" })),
      gate: Type.Optional(
        Type.Object({
          check: Type.String({ description: "零代码验证前提（处方纪律 1），如“B2 访谈 ≥3 人确认愿为私有部署付费”" }),
          status: StringEnum(["met", "unmet"], { description: "前提是否已满足；met 须在 why 中引用证据" }),
        }),
        { description: "代码类的验证门槛；仅 [止血]、最小事件集采集就绪、前提已有 [代码证实]/[用户提供] 证据的改动可省略（理由写进 why）" },
      ),
      dependsOn: Type.Optional(Type.Array(Type.String(), { description: "依赖的其他 backlog ID（新条目可用 B-NEW-x 占位）" })),
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
  factsDrafts: Type.Optional(
    Type.Array(
      Type.Object({
        entry: Type.String({ description: "facts 条目名（冒号前、不含括号说明，如「目标用户是谁」「主要用户地域」）" }),
        draft: Type.String({ description: "1-2 句参考样例，不含编造数字；仅用户可知类（用户数/收入/团队/融资）不要提供" }),
        source: Type.String({ description: "来源：代码路径 / URL+日期 / 推断依据" }),
      }),
    ),
    { description: "只针对仍为 [待补充] 的可草拟类条目；工具会写成〔参考样例〕挂在该条目后，条目仍视为未填" },
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

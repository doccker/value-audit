/**
 * market-tool.ts - 工具 value_audit_market_save：结构化落盘竞品调研；可选地在保存后续跑排队的审计（自动串联）
 * @author wwj
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Store } from "./store";
import { marketSaveParams, saveMarket, type MarketSavePayload } from "./market-store";

/** /value-audit 自动串联时登记：market 保存成功后执行（通常是以 followUp 方式发送审计 prompt） */
let afterMarket: (() => Promise<void> | void) | null = null;
export function setAfterMarket(fn: (() => Promise<void> | void) | null): void {
  afterMarket = fn;
}

export function registerMarketTool(pi: ExtensionAPI, version: string): void {
  pi.registerTool({
    name: "value_audit_market_save",
    label: "Value Audit Market Save",
    description: "提交联网竞品调研结果（仅在 /value-audit market 流程中调用）：工具按 URL 合并历史行、按热度降序渲染 14 列表并写入档案 market.md",
    parameters: marketSaveParams,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const p = params as MarketSavePayload;
      if (!Array.isArray(p.rows) || p.rows.length === 0) {
        return { content: [{ type: "text", text: "rows 为空：至少提交 1 个本次核实的竞品行；抓取全部失败时把失败原因写进 pending 并仍提交已知行" }], isError: true };
      }
      const store = new Store(ctx.cwd);
      store.ensure();
      const r = saveMarket(store, p, version);
      const lines = [
        `市场资料已保存：${r.mdPath}（本次 ${p.rows.length} 行，其中 ${r.merged} 行与历史合并；累计 ${r.total} 个竞品，按热度降序）`,
        `下次 /value-audit 会引用它作为 [联网检索] 来源（90 天后提示刷新）；用户补充的价格证据可写进 facts 第 5 节"外部证据补录"`,
      ];
      if (afterMarket) {
        const fn = afterMarket;
        afterMarket = null;
        await fn();
        lines.push("审计已排队：本轮汇报结束后自动开始 /value-audit（先简短汇报调研结果，不要复述表格）");
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  });
}

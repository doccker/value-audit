/**
 * owner.ts - 主人档案注入（~/.value-audit/owner.md）
 * @author wwj
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * 主人档案（v0.10）：~/.value-audit/owner.md 原文确定性注入；它可能只是一行"读某 skill/文件"的指引。
 * 只在本地进入 prompt，不进报告/facts/上报字段。
 */
export function ownerSection(target: string): string {
  const p = path.join(os.homedir(), ".value-audit", "owner.md");
  let text = "";
  try {
    text = fs.readFileSync(p, "utf8").trim();
  } catch {
    return `## 主人档案\n\n未找到 ${p}：${target}不加处境约束，涉及收款/合规/支出的条目标「主人处境未知」。`;
  }
  return `## 主人档案（${p} 原文；处方纪律 11 的输入）

${text}

执行：若上文指向其他文件、目录或 skill，先用 read 工具读取（按其规定的读取顺序，只读命中部分），再开${target}；
${target}中涉及收款、合规、支出、法人/股东、服务器与地域的每一条都标注引用的档案条目 id（如「需核实：#C3」）或「无相关约束」；
档案中的事实优先于你的推测；输出里只出现条目 id 与结论词，不出现档案中的具体日期、数量、账户/备案状态、服务器或资产清单；
需要第三方配合的动作只写角色（如「需法人配合」「需股东配合」），不写称谓、姓名或关系（报告可能被导出分享；档案自身规则若要求写称谓，只在对话回复中遵守，不进报告）。`;
}

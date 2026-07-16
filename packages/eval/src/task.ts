/**
 * 评测任务模型。
 *
 * 一个任务 = 种子文件 + 面向 agent 的指令 + 一条离线可跑的校验命令。
 * 设计成零依赖、可离线验证：校验脚本随种子文件一起写入工作目录，用 `node` 跑，
 * 退出码 0 视为通过。这样 harness 本身（CI 里）无需真实模型也能自测其管线正确。
 */

export interface EvalTask {
  /** 稳定 id，用于筛选与报告。 */
  id: string;
  /** 一句话说明任务意图（报告里展示）。 */
  title: string;
  /** 面向 agent 的完整指令（作为一条 user 消息发送）。 */
  prompt: string;
  /** 初始化到工作目录的种子文件：相对路径 → 内容。 */
  files: Record<string, string>;
  /** 校验命令：在工作目录里执行，退出码 0 视为通过。 */
  verify: { cmd: string; args: string[] };
}

/** 认定为「文件编辑类」的工具名——用于统计编辑失败率。 */
export const EDIT_TOOLS = new Set(["write", "edit", "apply_patch"]);

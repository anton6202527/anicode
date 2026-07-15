import { ToolRegistry } from "./tool.js";
import { readTool, writeTool, editTool, globTool, grepTool } from "./fs.js";
import { bashTool } from "./bash.js";
import { createTodoTool } from "./todo.js";
import { webFetchTool } from "./webfetch.js";

export * from "./tool.js";
export { readTool, writeTool, editTool, globTool, grepTool } from "./fs.js";
export { bashTool, splitShellCommand, analyzeShellCommand, type ShellCommandAnalysis } from "./bash.js";
export { createTodoTool, type TodoItem } from "./todo.js";
export { webFetchTool, htmlToText } from "./webfetch.js";
export {
  type SandboxPolicy,
  type SandboxSpec,
  wrapWithSandbox,
  buildSeatbeltProfile,
  resolveSandboxPolicy,
} from "./sandbox.js";

/** 默认工具集：Read/Write/Edit/Glob/Grep/Bash/TodoWrite（todo 有状态，每次新建） */
export function defaultTools(): ToolRegistry {
  return new ToolRegistry()
    .register(readTool)
    .register(writeTool)
    .register(editTool)
    .register(globTool)
    .register(grepTool)
    .register(bashTool)
    .register(webFetchTool)
    .register(createTodoTool());
}

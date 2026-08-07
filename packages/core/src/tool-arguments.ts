/**
 * Provider adapter 在 tool arguments JSON 解析失败时使用的内部哨兵。
 *
 * 只认“唯一的 own enumerable key 是 __unparsed，且值为 string”，
 * 避免把合法工具恰好拥有的同名字段误判为 provider 解析失败。
 */
export function hasUnparsedToolArguments(args: Record<string, unknown>): boolean {
  const keys = Object.keys(args);
  return keys.length === 1 && keys[0] === "__unparsed" && typeof args["__unparsed"] === "string";
}

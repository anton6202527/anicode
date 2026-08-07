import type { Tool } from "./tool.js";

/**
 * Process-local provenance for closures implemented and reviewed by core.
 *
 * Keep this module off the package-root export surface. A structural execution marker describes
 * how a tool is expected to run; it is not proof that the closure came from the trusted host.
 */
const CORE_OWNED_TOOL_BRAND = new WeakSet<Tool>();

export function coreOwnedTool<T extends Tool>(tool: T): T {
  // A caller may legitimately hold a reference to a core-created tool. Freeze the branded
  // security metadata so that reference cannot be repurposed by replacing `run`, renaming the
  // definition, or widening capabilities after provenance was granted.
  deepFreeze(tool.def);
  if (tool.capabilities) Object.freeze(tool.capabilities);
  if (tool.execution) Object.freeze(tool.execution);
  Object.freeze(tool);
  CORE_OWNED_TOOL_BRAND.add(tool);
  return tool;
}

export function isCoreOwnedTool(tool: Tool): boolean {
  return CORE_OWNED_TOOL_BRAND.has(tool);
}

function deepFreeze(value: unknown, seen = new WeakSet<object>()): void {
  if (!value || typeof value !== "object" || seen.has(value) || Object.isFrozen(value)) return;
  seen.add(value);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if ("value" in descriptor) deepFreeze(descriptor.value, seen);
  }
  Object.freeze(value);
}

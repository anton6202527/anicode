/**
 * HTTP API 的形式化描述 —— 单一事实源（对齐 opencode 的「路由声明 → OpenAPI →
 * SDK」管线的第一环）。
 *
 *   - `ROUTES`：全部端点的类型化描述表。http-server 的实现与之对齐
 *     （api.test.ts 交叉校验），SDK 按它的形状封装。
 *   - `EVENTS`：SSE 事件目录（命名事件 + payload 说明）。
 *   - `generateOpenApi()`：零依赖生成 OpenAPI 3.1 文档，由 `GET /doc` 提供。
 *
 * SSE 信封统一为 `{ id, type, properties }`（首帧 server.connected，随后
 * session.snapshot，之后实时事件；每 30s 一条 server.heartbeat）。
 */

export interface RouteDef {
  method: "get" | "post" | "delete" | "patch";
  /** OpenAPI 风格路径，如 /sessions/{id}/send */
  path: string;
  summary: string;
  /** 请求体 schema（POST/PATCH；JSON object） */
  request?: Record<string, unknown>;
  parameters?: ApiParameterDef[];
  /** 成功响应：204 表示无 body；schema 表示 200 JSON；"sse" 表示事件流 */
  response: Record<string, unknown> | 204 | "sse";
  tag:
    | "global"
    | "provider"
    | "session"
    | "message"
    | "permission"
    | "artifact"
    | "runtime"
    | "patchset";
}

export interface ApiParameterDef {
  name: string;
  in: "query" | "header";
  required?: boolean;
  description?: string;
  schema: Record<string, unknown>;
}

/** 稳定 operationId：同时供 OpenAPI 与 SDK codegen 使用。 */
export function operationIdFor(route: Pick<RouteDef, "method" | "path">): string {
  const words = route.path
    .split("/")
    .filter(Boolean)
    .map((part) => part.replace(/[{}]/g, ""))
    .flatMap((part) => part.split(/[^A-Za-z0-9]+/).filter(Boolean));
  return `${route.method}${words.map((word) => word[0]!.toUpperCase() + word.slice(1)).join("")}`;
}

const SESSION_SUMMARY = { $ref: "#/components/schemas/SessionSummary" };
const SESSION_SNAPSHOT = { $ref: "#/components/schemas/SessionSnapshot" };

export const ROUTES: RouteDef[] = [
  {
    method: "get",
    path: "/healthz",
    summary: "健康检查（兼容别名）",
    response: { type: "object" },
    tag: "global",
  },
  {
    method: "get",
    path: "/global/health",
    summary: "健康检查：服务名与协议版本",
    response: {
      type: "object",
      properties: {
        ok: { type: "boolean" },
        name: { type: "string" },
        protocol: { type: "integer" },
      },
    },
    tag: "global",
  },
  {
    method: "get",
    path: "/doc",
    summary: "本文档（OpenAPI 3.1）",
    response: { type: "object" },
    tag: "global",
  },
  {
    method: "get",
    path: "/events",
    summary: "全局事件流 firehose（SSE 信封，跨所有 live 会话）；支持 Last-Event-ID 续传",
    response: "sse",
    tag: "global",
  },
  {
    method: "get",
    path: "/providers/{providerId}/models",
    summary: "从服务端凭证与网络边界发现 provider 当前可用模型；不可用时 models=null",
    response: {
      type: "object",
      required: ["providerId", "models"],
      additionalProperties: false,
      properties: {
        providerId: {
          type: "string",
          minLength: 1,
          maxLength: 128,
          pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$",
        },
        models: {
          oneOf: [
            {
              type: "array",
              maxItems: 500,
              items: { type: "string", minLength: 1, maxLength: 512 },
            },
            { type: "null" },
          ],
        },
      },
    },
    tag: "provider",
  },
  {
    method: "get",
    path: "/sessions",
    summary: "列出会话",
    parameters: [
      {
        name: "limit",
        in: "query",
        description: "分页大小；省略时兼容返回全部会话",
        schema: { type: "integer", minimum: 1, maximum: 200 },
      },
      {
        name: "cursor",
        in: "query",
        description: "上一页 x-anicode-next-cursor 返回的不透明游标",
        schema: { type: "string", minLength: 1, maxLength: 256 },
      },
    ],
    response: { type: "array", items: SESSION_SUMMARY },
    tag: "session",
  },
  {
    method: "post",
    path: "/sessions",
    summary: "创建会话",
    request: {
      type: "object",
      required: ["cwd", "model"],
      properties: {
        cwd: { type: "string", minLength: 1, maxLength: 32768 },
        model: { type: "string", minLength: 1, maxLength: 512 },
        title: { type: "string", minLength: 1, maxLength: 4096 },
      },
    },
    response: SESSION_SUMMARY,
    tag: "session",
  },
  {
    method: "get",
    path: "/sessions/{id}",
    summary: "读取会话快照（懒加载到内存）",
    response: SESSION_SNAPSHOT,
    tag: "session",
  },
  {
    method: "delete",
    path: "/sessions/{id}",
    summary: "删除会话（中断 live drive 并删盘）",
    response: 204,
    tag: "session",
  },
  {
    method: "patch",
    path: "/sessions/{id}",
    summary: "改会话标题",
    request: {
      type: "object",
      required: ["title"],
      properties: { title: { type: "string", minLength: 1, maxLength: 4096 } },
    },
    response: 204,
    tag: "session",
  },
  {
    method: "get",
    path: "/sessions/{id}/events",
    summary: "订阅会话事件流（SSE 信封）；断线可用 Last-Event-ID 头/?lastEventId= 续传",
    response: "sse",
    tag: "session",
  },
  {
    method: "get",
    path: "/sessions/{id}/messages",
    summary: "读取消息（Message+Parts 投影）",
    response: { type: "array", items: { $ref: "#/components/schemas/MessageWithParts" } },
    tag: "message",
  },
  {
    method: "get",
    path: "/sessions/{id}/checkpoints",
    summary: "列出可撤销点",
    response: { type: "array", items: { $ref: "#/components/schemas/Checkpoint" } },
    tag: "session",
  },
  {
    method: "get",
    path: "/sessions/{id}/artifacts",
    summary: "列出会话 Artifacts",
    response: { type: "array", items: { $ref: "#/components/schemas/Artifact" } },
    tag: "artifact",
  },
  {
    method: "post",
    path: "/sessions/{id}/artifacts",
    summary: "创建 Artifact（text 或 dataBase64 二选一）",
    request: {
      type: "object",
      required: ["kind", "name"],
      oneOf: [{ required: ["text"] }, { required: ["dataBase64"] }],
      properties: {
        kind: {
          type: "string",
          enum: [
            "plan",
            "patch",
            "diff",
            "verification",
            "log",
            "report",
            "screenshot",
            "file",
            "other",
          ],
        },
        name: { type: "string", minLength: 1 },
        mediaType: { type: "string" },
        text: { type: "string" },
        dataBase64: {
          type: "string",
          pattern: "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$",
        },
        metadata: { type: "object" },
      },
    },
    response: { $ref: "#/components/schemas/Artifact" },
    tag: "artifact",
  },
  {
    method: "get",
    path: "/sessions/{id}/artifacts/{artifactId}",
    summary: "读取 Artifact 元数据与 base64 内容",
    response: {
      type: "object",
      properties: {
        artifact: { $ref: "#/components/schemas/Artifact" },
        dataBase64: { type: "string" },
      },
    },
    tag: "artifact",
  },
  {
    method: "get",
    path: "/sessions/{id}/artifacts/{artifactId}/content",
    summary: "流式读取 Artifact 原始内容（支持大对象，不做 base64/堆内聚合）",
    response: { type: "string", format: "binary" },
    tag: "artifact",
  },
  {
    method: "delete",
    path: "/sessions/{id}/artifacts/{artifactId}",
    summary: "删除会话对 Artifact 的引用",
    response: 204,
    tag: "artifact",
  },
  {
    method: "post",
    path: "/sessions/{id}/patchsets",
    summary: "准备事务 PatchSet（text/binary/delete/rename），返回预览与 Artifact；不立即写盘",
    request: {
      type: "object",
      required: ["changes"],
      properties: {
        changes: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            required: ["path"],
            properties: {
              path: { type: "string" },
              text: { type: "string" },
              dataBase64: { type: "string" },
              delete: { type: "boolean" },
              renameFrom: { type: "string" },
            },
          },
        },
        requiredApprovals: { type: "integer", minimum: 0 },
        requiredRoles: { type: "array", items: { type: "string" } },
      },
    },
    response: {
      type: "object",
      properties: {
        patchset: { $ref: "#/components/schemas/PatchSet" },
        preview: { type: "string" },
        artifact: { $ref: "#/components/schemas/Artifact" },
      },
    },
    tag: "patchset",
  },
  {
    method: "get",
    path: "/sessions/{id}/patchsets/{patchsetId}",
    summary: "读取 PatchSet journal 与预览",
    response: {
      type: "object",
      properties: {
        patchset: { $ref: "#/components/schemas/PatchSet" },
        preview: { type: "string" },
      },
    },
    tag: "patchset",
  },
  {
    method: "post",
    path: "/sessions/{id}/patchsets/{patchsetId}/approve",
    summary: "记录 PatchSet 角色审批或拒绝",
    request: {
      type: "object",
      required: ["actor", "role", "decision"],
      properties: {
        actor: { type: "string" },
        role: { type: "string" },
        decision: { type: "string", enum: ["approve", "reject"] },
        comment: { type: "string" },
      },
    },
    response: { $ref: "#/components/schemas/PatchSet" },
    tag: "patchset",
  },
  {
    method: "post",
    path: "/sessions/{id}/patchsets/{patchsetId}/apply",
    summary: "校验 base hash 与审批链后原子提交 PatchSet",
    request: { type: "object" },
    response: { $ref: "#/components/schemas/PatchSet" },
    tag: "patchset",
  },
  {
    method: "post",
    path: "/sessions/{id}/patchsets/{patchsetId}/rebase",
    summary: "把 stale 文本 PatchSet 三方合并到当前工作区并生成新事务",
    request: { type: "object" },
    response: {
      type: "object",
      properties: {
        patchset: { $ref: "#/components/schemas/PatchSet" },
        conflictedPaths: { type: "array", items: { type: "string" } },
      },
    },
    tag: "patchset",
  },
  {
    method: "post",
    path: "/sessions/{id}/patchsets/{patchsetId}/rollback",
    summary: "回滚已提交 PatchSet；默认拒绝覆盖提交后的外部改动",
    request: {
      type: "object",
      properties: { force: { type: "boolean" } },
    },
    response: { $ref: "#/components/schemas/PatchSet" },
    tag: "patchset",
  },
  {
    method: "get",
    path: "/sessions/{id}/runtime-events",
    summary: "读取 Durable Runtime v2 事件；?afterSequence=N 增量读取",
    parameters: [
      {
        name: "afterSequence",
        in: "query",
        schema: { type: "integer", minimum: 0 },
      },
    ],
    response: { type: "array", items: { $ref: "#/components/schemas/RuntimeEvent" } },
    tag: "runtime",
  },
  {
    method: "get",
    path: "/sessions/{id}/runtime-state",
    summary: "从事件事实源恢复运行态投影",
    response: { type: "object" },
    tag: "runtime",
  },
  {
    method: "post",
    path: "/sessions/{id}/send",
    summary: "发消息驱动 agent loop（drive 收尾后返回）",
    request: {
      type: "object",
      required: ["text"],
      properties: {
        text: { type: "string", minLength: 1, maxLength: 2097152 },
        model: { type: "string", minLength: 1, maxLength: 512 },
        idempotencyKey: { type: "string", minLength: 1, maxLength: 256 },
      },
    },
    response: 204,
    parameters: [
      {
        name: "Idempotency-Key",
        in: "header",
        description: "重试安全的 command 幂等键；优先于同名 JSON 字段",
        schema: { type: "string", minLength: 1, maxLength: 256 },
      },
    ],
    tag: "message",
  },
  {
    method: "post",
    path: "/sessions/{id}/interrupt",
    summary: "中断当前 drive",
    request: { type: "object" },
    response: 204,
    tag: "session",
  },
  {
    method: "post",
    path: "/sessions/{id}/undo",
    summary: "撤销到检查点（files/conversation/both）",
    request: {
      type: "object",
      properties: {
        checkpointId: { type: "string", minLength: 1, maxLength: 256 },
        mode: { type: "string", enum: ["files", "conversation", "both"] },
      },
    },
    response: {
      type: "object",
      properties: {
        restored: { type: "integer" },
        deleted: { type: "integer" },
        removedMessages: { type: "integer" },
      },
    },
    tag: "session",
  },
  {
    method: "post",
    path: "/sessions/{id}/compact",
    summary: "手动压缩上下文",
    request: { type: "object" },
    response: {
      type: "object",
      properties: {
        compacted: { type: "boolean" },
        beforeTokens: { type: "integer" },
        afterTokens: { type: "integer" },
      },
    },
    tag: "session",
  },
  {
    method: "post",
    path: "/sessions/{id}/fork",
    summary: "复制会话历史为新会话",
    request: {
      type: "object",
      properties: {
        title: { type: "string", minLength: 1, maxLength: 4096 },
        upToMessage: { type: "integer", minimum: 0 },
        model: { type: "string", minLength: 1, maxLength: 512 },
      },
    },
    response: SESSION_SUMMARY,
    tag: "session",
  },
  {
    method: "post",
    path: "/sessions/{id}/permission",
    summary: "裁决权限请求（先到先得）",
    request: {
      type: "object",
      required: ["permId", "decision"],
      properties: {
        permId: { type: "string", minLength: 1, maxLength: 256 },
        decision: { type: "string", enum: ["allow", "allow_remember", "allow_always", "deny"] },
      },
    },
    response: { type: "object", properties: { answered: { type: "boolean" } } },
    tag: "permission",
  },
  {
    method: "post",
    path: "/sessions/{id}/permission-mode",
    summary: "切换权限模式",
    request: {
      type: "object",
      required: ["mode"],
      properties: {
        mode: {
          type: "string",
          enum: ["default", "acceptEdits", "auto", "bypass", "plan"],
        },
      },
    },
    response: 204,
    tag: "permission",
  },
  {
    method: "post",
    path: "/sessions/{id}/permission-profile",
    summary: "切换权限档位，返回生效模式",
    request: {
      type: "object",
      required: ["name"],
      properties: { name: { type: "string", minLength: 1, maxLength: 128 } },
    },
    response: { type: "object", properties: { mode: { type: "string" } } },
    tag: "permission",
  },
  {
    method: "get",
    path: "/sessions/{id}/permission-profiles",
    summary: "列出可用权限档位",
    response: { type: "object" },
    tag: "permission",
  },
];

/** SSE 信封：data 行统一为该 JSON 形状（不再使用 SSE 的 event: 字段区分）。 */
export interface EventEnvelope {
  id: string;
  type: string;
  properties: Record<string, unknown>;
}

/** SSE 事件目录：type → payload 说明（写进 OpenAPI 的 x-events 供 SDK/文档消费）。 */
export const EVENTS: Record<string, string> = {
  "server.connected": "连接建立（保证为首帧）",
  "server.heartbeat": "心跳（约 30s 一条）",
  "session.snapshot": "订阅即回放的会话快照（properties = SessionSnapshot）",
  "session.snapshot.chunk":
    "大快照的有界分块：{ sessionId, transferId, index, data, done }；按序聚合 data 后解析 SessionSnapshot",
  "session.event": "SessionEvent 原样透传（host 客户端兼容通道）：{ sessionId, event }",
  "session.status": "运行态变化：{ sessionId, running }",
  "session.updated": "标题等元数据变化：{ sessionId, title }",
  "session.reverted":
    "撤销完成：{ sessionId, checkpointId, restored, deleted, mode?, removedMessages? }",
  "permission.asked": "权限请求：{ sessionId, permId, toolName, ruleKey, network?, risk? }",
  "permission.replied": "权限裁决：{ sessionId, permId, decision }",
  "message.updated": "消息元数据创建/完成：{ info: MessageInfo }",
  "message.part.updated": "part 创建或到达终态：{ part: MessagePart }",
  "message.part.delta": "流式增量：{ sessionId, messageId, partId, field: text|input, delta }",
  "verification.completed": "确定性验证完成：{ sessionId, report }",
};

/** 协议版本：信封或路由的不兼容变更时 +1。 */
export const PROTOCOL_VERSION = 1;

const COMPONENT_SCHEMAS: Record<string, Record<string, unknown>> = {
  ApiError: {
    type: "object",
    required: ["error", "code", "requestId"],
    additionalProperties: false,
    properties: {
      error: { type: "string" },
      code: { type: "string", pattern: "^[A-Z][A-Z0-9_]*$" },
      requestId: { type: "string" },
      details: {},
    },
  },
  SessionSummary: {
    type: "object",
    required: ["id", "createdAt", "updatedAt", "cwd", "model", "running"],
    properties: {
      id: { type: "string" },
      createdAt: { type: "string" },
      updatedAt: { type: "string" },
      cwd: { type: "string" },
      model: { type: "string" },
      title: { type: "string" },
      running: { type: "boolean" },
    },
  },
  SessionSnapshot: {
    type: "object",
    required: ["meta", "messages", "usage", "running", "pendingPermissions"],
    properties: {
      meta: { type: "object" },
      messages: { type: "array", items: { type: "object" } },
      usage: { type: "object" },
      costUSD: { type: "number" },
      running: { type: "boolean" },
      permissionMode: {
        type: "string",
        enum: ["default", "acceptEdits", "auto", "bypass", "plan"],
      },
      pendingPermissions: { type: "array", items: { type: "object" } },
      networkTools: {
        type: "object",
        required: ["webSearch", "webFetch"],
        properties: {
          webSearch: { $ref: "#/components/schemas/NetworkToolStatus" },
          webFetch: { $ref: "#/components/schemas/NetworkToolStatus" },
        },
      },
    },
  },
  NetworkToolStatus: {
    type: "object",
    required: ["state"],
    properties: {
      state: { type: "string", enum: ["ready", "disabled"] },
      provider: { type: "string", enum: ["tavily", "brave", "custom"] },
      reason: {
        type: "string",
        enum: [
          "workspace_restricted",
          "credential_not_configured",
          "host_disabled",
          "network_policy",
          "network_proxy_unavailable",
        ],
      },
    },
  },
  Checkpoint: {
    type: "object",
    required: ["id", "tree", "label", "messageCount"],
    properties: {
      id: { type: "string" },
      tree: { type: "string" },
      label: { type: "string" },
      messageCount: { type: "integer" },
    },
  },
  MessageWithParts: {
    type: "object",
    required: ["info", "parts"],
    properties: {
      info: { type: "object" },
      parts: { type: "array", items: { $ref: "#/components/schemas/MessagePart" } },
    },
  },
  MessagePart: {
    type: "object",
    required: ["id", "sessionId", "messageId", "type"],
    properties: {
      id: { type: "string" },
      sessionId: { type: "string" },
      messageId: { type: "string" },
      type: {
        type: "string",
        enum: ["text", "reasoning", "file", "step-start", "step-finish", "tool"],
      },
    },
  },
  EventEnvelope: {
    type: "object",
    required: ["id", "type", "properties"],
    properties: {
      id: { type: "string" },
      type: { type: "string", enum: Object.keys(EVENTS) },
      properties: { type: "object" },
    },
  },
  Artifact: {
    type: "object",
    required: [
      "id",
      "sessionId",
      "kind",
      "name",
      "mediaType",
      "sizeBytes",
      "sha256",
      "createdAt",
      "uri",
    ],
    properties: {
      id: { type: "string" },
      sessionId: { type: "string" },
      kind: { type: "string" },
      name: { type: "string" },
      mediaType: { type: "string" },
      sizeBytes: { type: "integer" },
      sha256: { type: "string" },
      createdAt: { type: "string", format: "date-time" },
      uri: { type: "string" },
      metadata: { type: "object" },
    },
  },
  RuntimeEvent: {
    type: "object",
    required: ["id", "version", "streamId", "sequence", "timestamp", "type", "data"],
    properties: {
      id: { type: "string" },
      version: { type: "integer", const: 2 },
      streamId: { type: "string" },
      sequence: { type: "integer" },
      timestamp: { type: "string", format: "date-time" },
      type: { type: "string" },
      data: {},
    },
  },
  PatchSet: {
    type: "object",
    required: [
      "version",
      "id",
      "root",
      "status",
      "createdAt",
      "updatedAt",
      "changes",
      "requiredApprovals",
      "requiredRoles",
      "approvals",
      "appliedCount",
    ],
    properties: {
      version: { type: "integer", const: 2 },
      id: { type: "string" },
      root: { type: "string" },
      sessionId: { type: "string" },
      status: {
        type: "string",
        enum: [
          "planned",
          "pending_approval",
          "approved",
          "applying",
          "applied",
          "conflict",
          "rolled_back",
          "failed",
        ],
      },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
      changes: { type: "array", items: { type: "object" } },
      requiredApprovals: { type: "integer" },
      requiredRoles: { type: "array", items: { type: "string" } },
      approvals: { type: "array", items: { type: "object" } },
      appliedCount: { type: "integer" },
      error: { type: "string" },
    },
  },
};

function closedRequestSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...schema };
  if (schema.type === "object" && schema.properties && schema.additionalProperties === undefined) {
    result.additionalProperties = false;
  }
  if (schema.properties && typeof schema.properties === "object") {
    result.properties = Object.fromEntries(
      Object.entries(schema.properties as Record<string, Record<string, unknown>>).map(
        ([key, value]) => [key, closedRequestSchema(value)],
      ),
    );
  }
  if (schema.items && typeof schema.items === "object") {
    result.items = closedRequestSchema(schema.items as Record<string, unknown>);
  }
  for (const keyword of ["oneOf", "anyOf", "allOf"] as const) {
    if (Array.isArray(schema[keyword])) {
      result[keyword] = (schema[keyword] as Record<string, unknown>[]).map(closedRequestSchema);
    }
  }
  return result;
}

const RESPONSE_HEADERS = {
  "x-request-id": { $ref: "#/components/headers/RequestId" },
  "x-anicode-api-version": { $ref: "#/components/headers/ApiVersion" },
};

function successResponse(route: RouteDef): Record<string, unknown> {
  if (route.response === 204) {
    return { description: "no content", headers: RESPONSE_HEADERS };
  }
  if (route.response === "sse") {
    return {
      description: "SSE 事件流；每帧 data 为 EventEnvelope",
      headers: RESPONSE_HEADERS,
      content: {
        "text/event-stream": { schema: { $ref: "#/components/schemas/EventEnvelope" } },
      },
    };
  }
  const binary = route.response.format === "binary";
  return {
    description: "ok",
    headers: {
      ...RESPONSE_HEADERS,
      ...(route.path === "/sessions"
        ? { "x-anicode-next-cursor": { $ref: "#/components/headers/NextCursor" } }
        : {}),
    },
    content: {
      [binary ? "application/octet-stream" : "application/json"]: { schema: route.response },
    },
  };
}

/** 生成 OpenAPI 3.1 文档（`GET /doc`）。 */
export function generateOpenApi(): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const route of ROUTES) {
    const op: Record<string, unknown> = {
      operationId: operationIdFor(route),
      summary: route.summary,
      tags: [route.tag],
      parameters: [
        { $ref: "#/components/parameters/ApiVersion" },
        { $ref: "#/components/parameters/RequestId" },
        ...[...route.path.matchAll(/\{([^}]+)\}/g)].map((match) => ({
          name: match[1],
          in: "path",
          required: true,
          schema:
            match[1] === "providerId"
              ? {
                  type: "string",
                  minLength: 1,
                  maxLength: 128,
                  pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$",
                }
              : { type: "string" },
        })),
        ...(route.parameters ?? []),
      ],
      ...(route.request
        ? {
            requestBody: {
              required: true,
              content: { "application/json": { schema: closedRequestSchema(route.request) } },
            },
          }
        : {}),
      responses: {
        [route.response === 204 ? "204" : "200"]: successResponse(route),
        default: {
          description: "structured API error",
          headers: RESPONSE_HEADERS,
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/ApiError" } },
          },
        },
      },
      security:
        route.path === "/healthz" || route.path === "/global/health" ? [] : [{ bearerAuth: [] }],
    };
    (paths[route.path] ??= {})[route.method] = op;
  }
  return {
    openapi: "3.1.1",
    jsonSchemaDialect: "https://json-schema.org/draft/2020-12/schema",
    info: {
      title: "anicode server",
      version: `${PROTOCOL_VERSION}.0.0`,
      description:
        "AniCode server-first HTTP API。鉴权：除健康检查外强制 Bearer token，REST 与 SSE 均只接受 Authorization header。" +
        "多实例路由：请求可带 x-anicode-directory 头或 ?directory= 选择按目录隔离的会话实例（server 配置 resolveInstance 时生效，否则忽略）。" +
        "SSE 续传：事件帧携带 id，断线重连带 Last-Event-ID 头（或 ?lastEventId=）可增量补发丢失事件，缓冲失效时自动回落整份快照。",
    },
    paths,
    components: {
      schemas: COMPONENT_SCHEMAS,
      parameters: {
        ApiVersion: {
          name: "x-anicode-api-version",
          in: "header",
          required: false,
          schema: { type: "integer", const: PROTOCOL_VERSION },
        },
        RequestId: {
          name: "x-request-id",
          in: "header",
          required: false,
          schema: { type: "string", minLength: 1, maxLength: 128 },
        },
      },
      headers: {
        ApiVersion: { schema: { type: "integer", const: PROTOCOL_VERSION } },
        RequestId: { schema: { type: "string" } },
        NextCursor: { schema: { type: "string" } },
      },
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
    },
    security: [{ bearerAuth: [] }],
    "x-events": EVENTS,
  };
}

/** 轻量契约校验：codegen/CI 在不引入大型 validator 的情况下阻止漂移。 */
export function validateOpenApiDocument(document = generateOpenApi()): string[] {
  const errors: string[] = [];
  const paths = document["paths"] as Record<string, Record<string, unknown>> | undefined;
  const operationIds = new Set<string>();
  if (!paths) return ["document.paths is missing"];
  for (const route of ROUTES) {
    const operation = paths[route.path]?.[route.method] as Record<string, unknown> | undefined;
    if (!operation) {
      errors.push(`missing operation: ${route.method.toUpperCase()} ${route.path}`);
      continue;
    }
    const operationId = operation["operationId"];
    if (typeof operationId !== "string" || !operationId)
      errors.push(`missing operationId: ${route.path}`);
    else if (operationIds.has(operationId)) errors.push(`duplicate operationId: ${operationId}`);
    else operationIds.add(operationId);
    const declared = new Set(
      ((operation["parameters"] as { name?: string; in?: string; required?: boolean }[]) ?? [])
        .filter((parameter) => parameter.in === "path" && parameter.required)
        .map((parameter) => parameter.name),
    );
    for (const match of route.path.matchAll(/\{([^}]+)\}/g)) {
      if (!declared.has(match[1]))
        errors.push(`missing required path parameter ${match[1]}: ${route.path}`);
    }
    const responses = operation["responses"] as Record<string, unknown> | undefined;
    if (!responses || Object.keys(responses).length === 0)
      errors.push(`missing response: ${route.path}`);
    else if (!responses.default) errors.push(`missing default error response: ${route.path}`);
  }
  return errors;
}

export interface ApiRouteMatch {
  route: RouteDef;
  pathParams: Record<string, string>;
}

export interface ApiValidationIssue {
  path: string;
  keyword: string;
  message: string;
}

function routePattern(route: RouteDef): { pattern: RegExp; names: string[] } {
  const names: string[] = [];
  const source = route.path
    .split("/")
    .map((segment) => {
      const match = /^\{([^}]+)\}$/.exec(segment);
      if (match) {
        names.push(match[1]!);
        return "([^/]+)";
      }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("/");
  return { pattern: new RegExp(`^${source}$`), names };
}

const ROUTE_PATTERNS = ROUTES.map((route) => ({ route, ...routePattern(route) }));

export function matchApiRoute(method: string, pathname: string): ApiRouteMatch | undefined {
  const normalizedMethod = method.toLowerCase();
  for (const candidate of ROUTE_PATTERNS) {
    if (candidate.route.method !== normalizedMethod) continue;
    const matched = candidate.pattern.exec(pathname);
    if (!matched) continue;
    const pathParams: Record<string, string> = {};
    try {
      candidate.names.forEach((name, index) => {
        pathParams[name] = decodeURIComponent(matched[index + 1]!);
      });
    } catch {
      return undefined;
    }
    return { route: candidate.route, pathParams };
  }
  return undefined;
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** JSON Schema 2020-12 的受控子集，覆盖 ROUTES 请求契约并限制错误放大。 */
export function validateJsonSchema(
  value: unknown,
  schema: Record<string, unknown>,
  path = "$",
  depth = 0,
): ApiValidationIssue[] {
  if (depth > 64) return [{ path, keyword: "depth", message: "schema nesting is too deep" }];
  if (typeof schema.$ref === "string") {
    const name = schema.$ref.match(/^#\/components\/schemas\/([^/]+)$/)?.[1];
    const resolved = name ? COMPONENT_SCHEMAS[name] : undefined;
    return resolved
      ? validateJsonSchema(value, resolved, path, depth + 1)
      : [{ path, keyword: "$ref", message: `unresolved schema reference ${schema.$ref}` }];
  }
  const issues: ApiValidationIssue[] = [];
  const add = (keyword: string, message: string, issuePath = path) => {
    if (issues.length < 64) issues.push({ path: issuePath, keyword, message });
  };

  if (schema.const !== undefined && !sameJsonValue(value, schema.const)) {
    add("const", `must equal ${JSON.stringify(schema.const)}`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => sameJsonValue(item, value))) {
    add("enum", "must be one of the declared values");
  }
  for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
    const branches = schema[keyword];
    if (!Array.isArray(branches)) continue;
    const results = (branches as Record<string, unknown>[]).map(
      (branch) => validateJsonSchema(value, branch, path, depth + 1).length === 0,
    );
    const matches = results.filter(Boolean).length;
    if (keyword === "allOf" && matches !== results.length) add(keyword, "must match every schema");
    if (keyword === "anyOf" && matches === 0) add(keyword, "must match at least one schema");
    if (keyword === "oneOf" && matches !== 1) add(keyword, "must match exactly one schema");
  }

  const type = schema.type;
  const isObject = value !== null && typeof value === "object" && !Array.isArray(value);
  const typeMatches =
    type === undefined ||
    (type === "object" && isObject) ||
    (type === "array" && Array.isArray(value)) ||
    (type === "string" && typeof value === "string") ||
    (type === "boolean" && typeof value === "boolean") ||
    (type === "number" && typeof value === "number" && Number.isFinite(value)) ||
    (type === "integer" && typeof value === "number" && Number.isSafeInteger(value)) ||
    (type === "null" && value === null);
  if (!typeMatches) {
    add("type", `must be ${String(type)}`);
    return issues;
  }

  if (isObject) {
    const object = value as Record<string, unknown>;
    for (const key of (schema.required as string[] | undefined) ?? []) {
      if (!Object.prototype.hasOwnProperty.call(object, key)) {
        add("required", `missing required property ${key}`, `${path}.${key}`);
      }
    }
    const properties =
      (schema.properties as Record<string, Record<string, unknown>> | undefined) ?? {};
    for (const [key, child] of Object.entries(properties)) {
      if (Object.prototype.hasOwnProperty.call(object, key)) {
        issues.push(...validateJsonSchema(object[key], child, `${path}.${key}`, depth + 1));
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(object)) {
        if (!(key in properties))
          add("additionalProperties", `unknown property ${key}`, `${path}.${key}`);
      }
    }
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      add("minItems", `must contain at least ${schema.minItems} items`);
    }
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
      add("maxItems", `must contain at most ${schema.maxItems} items`);
    }
    if (schema.items && typeof schema.items === "object") {
      value.forEach((item, index) => {
        issues.push(
          ...validateJsonSchema(
            item,
            schema.items as Record<string, unknown>,
            `${path}[${index}]`,
            depth + 1,
          ),
        );
      });
    }
  }
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      add("minLength", `must contain at least ${schema.minLength} characters`);
    }
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
      add("maxLength", `must contain at most ${schema.maxLength} characters`);
    }
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(value)) {
      add("pattern", "does not match the required pattern");
    }
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      add("minimum", `must be >= ${schema.minimum}`);
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      add("maximum", `must be <= ${schema.maximum}`);
    }
  }
  return issues.slice(0, 64);
}

export function validateRouteRequest(
  method: string,
  pathname: string,
  value: unknown,
): ApiValidationIssue[] {
  const matched = matchApiRoute(method, pathname);
  if (!matched?.route.request) return [];
  return validateJsonSchema(value, closedRequestSchema(matched.route.request));
}

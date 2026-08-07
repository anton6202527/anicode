import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ROUTES,
  EVENTS,
  generateOpenApi,
  matchApiRoute,
  PROTOCOL_VERSION,
  validateRouteRequest,
  validateOpenApiDocument,
} from "./api.js";

test("generateOpenApi: 每条路由都有对应 path+method 条目", () => {
  const doc = generateOpenApi() as {
    openapi: string;
    info: { version: string };
    paths: Record<string, Record<string, unknown>>;
    "x-events": Record<string, string>;
  };
  assert.equal(doc.openapi, "3.1.1");
  assert.ok(doc.info.version.startsWith(`${PROTOCOL_VERSION}.`));
  for (const route of ROUTES) {
    const entry = doc.paths[route.path];
    assert.ok(entry, `缺 path: ${route.path}`);
    assert.ok(entry[route.method], `缺 ${route.method} ${route.path}`);
  }
  assert.deepEqual(Object.keys(doc["x-events"]).sort(), Object.keys(EVENTS).sort());
  const modelDiscovery = doc.paths["/providers/{providerId}/models"]?.["get"] as
    | {
        security?: unknown;
        parameters?: Array<{ name?: string; schema?: Record<string, unknown> }>;
      }
    | undefined;
  assert.deepEqual(modelDiscovery?.security, [{ bearerAuth: [] }]);
  assert.equal(
    modelDiscovery?.parameters?.find((parameter) => parameter.name === "providerId")?.schema
      ?.maxLength,
    128,
  );
  assert.deepEqual((doc.paths["/global/health"]?.["get"] as { security?: unknown }).security, []);
});

test("OpenAPI 3.1.1 conformance: operationId/path params/responses 完整且唯一", () => {
  const document = generateOpenApi() as { openapi: string };
  assert.equal(document.openapi, "3.1.1");
  assert.deepEqual(validateOpenApiDocument(document as Record<string, unknown>), []);
  const full = document as Record<string, unknown>;
  const components = full.components as Record<string, Record<string, unknown>>;
  assert.ok((components.schemas as Record<string, unknown>).ApiError);
  const sessionSnapshot = (components.schemas as Record<string, Record<string, unknown>>)
    .SessionSnapshot;
  assert.deepEqual(
    (sessionSnapshot?.properties as Record<string, Record<string, unknown>>).permissionMode?.enum,
    ["default", "acceptEdits", "auto", "bypass", "plan"],
  );
  assert.equal(
    (sessionSnapshot?.required as string[]).includes("permissionMode"),
    false,
    "permissionMode must remain optional for compatibility with older snapshot producers",
  );
  assert.equal(
    (sessionSnapshot?.required as string[]).includes("networkTools"),
    false,
    "networkTools must remain optional for compatibility with older snapshot producers",
  );
  const networkTools = (sessionSnapshot?.properties as Record<string, Record<string, unknown>>)
    .networkTools;
  assert.deepEqual(networkTools?.required, ["webSearch", "webFetch"]);
  const networkToolStatus = (components.schemas as Record<string, Record<string, unknown>>)
    .NetworkToolStatus;
  assert.ok(networkToolStatus);
  assert.deepEqual(
    (networkToolStatus.properties as Record<string, Record<string, unknown>>).state!.enum,
    ["ready", "disabled"],
  );
  const operations = Object.values(full.paths as Record<string, Record<string, unknown>>).flatMap(
    (path) => Object.values(path),
  ) as Array<Record<string, unknown>>;
  assert.ok(
    operations.every((operation) =>
      Boolean((operation.responses as Record<string, unknown>).default),
    ),
  );
});

test("route contract: path matching + strict request schema + oneOf", () => {
  assert.equal(
    matchApiRoute("GET", "/sessions/s_1/artifacts/art_1/content")?.pathParams.artifactId,
    "art_1",
  );
  assert.deepEqual(
    validateRouteRequest("POST", "/sessions", { cwd: "/repo", model: "openai/gpt" }),
    [],
  );
  assert.ok(
    validateRouteRequest("POST", "/sessions", {
      cwd: "/repo",
      model: "openai/gpt",
      typo: true,
    }).some((issue) => issue.keyword === "additionalProperties"),
  );
  assert.ok(
    validateRouteRequest("POST", "/sessions/s_1/artifacts", {
      kind: "report",
      name: "result",
      text: "a",
      dataBase64: "Yg==",
    }).some((issue) => issue.keyword === "oneOf"),
  );
  assert.ok(
    validateRouteRequest("POST", "/sessions/s_1/permission-mode", { mode: "unsafe" }).some(
      (issue) => issue.keyword === "enum",
    ),
  );
  assert.ok(
    validateRouteRequest("POST", "/sessions/s_1/fork", { upToMessage: -1 }).some(
      (issue) => issue.keyword === "minimum",
    ),
  );
  assert.ok(
    validateRouteRequest("POST", "/sessions/s_1/send", {
      text: "ok",
      idempotencyKey: "x".repeat(257),
    }).some((issue) => issue.keyword === "maxLength"),
  );
  assert.ok(
    validateRouteRequest("POST", "/sessions/s_1/permission-profile", { name: "" }).some(
      (issue) => issue.keyword === "minLength",
    ),
  );
});

test("ROUTES: 路径参数命名合法，method 合法", () => {
  for (const route of ROUTES) {
    assert.match(route.path, /^\//);
    const params = route.path.match(/\{[^}]+\}/g) ?? [];
    for (const p of params) assert.match(p, /^\{(?:id|artifactId|patchsetId|providerId)\}$/);
    assert.ok(["get", "post", "delete", "patch"].includes(route.method));
  }
});

test("EVENTS: 信封事件命名遵循 名词.动词 规范", () => {
  for (const type of Object.keys(EVENTS)) {
    assert.match(type, /^[a-z]+(\.[a-z]+){1,2}$/, type);
  }
});

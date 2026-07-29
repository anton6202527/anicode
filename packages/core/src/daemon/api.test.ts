import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ROUTES,
  EVENTS,
  generateOpenApi,
  PROTOCOL_VERSION,
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
});

test("OpenAPI 3.1.1 conformance: operationId/path params/responses 完整且唯一", () => {
  const document = generateOpenApi() as { openapi: string };
  assert.equal(document.openapi, "3.1.1");
  assert.deepEqual(validateOpenApiDocument(document as Record<string, unknown>), []);
});

test("ROUTES: 路径参数命名合法，method 合法", () => {
  for (const route of ROUTES) {
    assert.match(route.path, /^\//);
    const params = route.path.match(/\{[^}]+\}/g) ?? [];
    for (const p of params) assert.match(p, /^\{(?:id|artifactId|patchsetId)\}$/);
    assert.ok(["get", "post", "delete", "patch"].includes(route.method));
  }
});

test("EVENTS: 信封事件命名遵循 名词.动词 规范", () => {
  for (const type of Object.keys(EVENTS)) {
    assert.match(type, /^[a-z]+(\.[a-z]+){1,2}$/, type);
  }
});

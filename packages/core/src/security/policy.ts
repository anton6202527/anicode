/** 确定性安全策略与可验证 capability token；模型不参与最终授权判断。 */

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { globMatch } from "../permission.js";

export type SecurityEffect = "allow" | "deny" | "ask";

export interface SecurityRule {
  id: string;
  effect: SecurityEffect;
  principals?: string[];
  actions: string[];
  resources?: string[];
  /** 属性必须精确相等；适合限定 runtime/tool/provider 等可信标签。 */
  conditions?: Record<string, string | number | boolean>;
  reason?: string;
}

export interface SecurityRequest {
  principal: string;
  action: string;
  resource: string;
  attributes?: Record<string, string | number | boolean>;
}

export interface SecurityDecision {
  effect: SecurityEffect;
  matchedRules: string[];
  reason: string;
}

export interface SecurityPolicyOptions {
  rules?: SecurityRule[];
  defaultEffect?: SecurityEffect;
}

function any(patterns: readonly string[] | undefined, value: string): boolean {
  return !patterns?.length || patterns.some((pattern) => globMatch(pattern, value));
}

function conditionsMatch(
  conditions: SecurityRule["conditions"],
  attributes: SecurityRequest["attributes"],
): boolean {
  if (!conditions) return true;
  return Object.entries(conditions).every(([key, value]) => attributes?.[key] === value);
}

export class SecurityPolicyEngine {
  private readonly rules: SecurityRule[];
  private readonly defaultEffect: SecurityEffect;

  constructor(options: SecurityPolicyOptions = {}) {
    this.rules = options.rules ?? [];
    this.defaultEffect = options.defaultEffect ?? "allow";
  }

  authorize(request: SecurityRequest): SecurityDecision {
    const matched = this.rules.filter(
      (rule) =>
        any(rule.principals, request.principal) &&
        any(rule.actions, request.action) &&
        any(rule.resources, request.resource) &&
        conditionsMatch(rule.conditions, request.attributes),
    );
    // deny > ask > allow，配置顺序不能意外削弱硬边界。
    const effect = matched.some((rule) => rule.effect === "deny")
      ? "deny"
      : matched.some((rule) => rule.effect === "ask")
        ? "ask"
        : matched.some((rule) => rule.effect === "allow")
          ? "allow"
          : this.defaultEffect;
    const decisive = matched.find((rule) => rule.effect === effect);
    return {
      effect,
      matchedRules: matched.map((rule) => rule.id),
      reason: decisive?.reason ?? `security policy ${effect}`,
    };
  }

  /** 默认工作区硬边界：任何工具都不能修改 git 元数据与 AniCode 私有状态。 */
  static workspaceBoundary(): SecurityPolicyEngine {
    return new SecurityPolicyEngine({
      rules: [
        {
          id: "protect-git-metadata",
          effect: "deny",
          actions: ["tool:write", "tool:edit", "tool:apply_patch", "tool:bash"],
          resources: [".git", ".git/*", "*/.git", "*/.git/*"],
          reason: "git metadata is protected",
        },
        {
          id: "protect-anicode-state",
          effect: "deny",
          actions: ["tool:write", "tool:edit", "tool:apply_patch", "tool:bash"],
          resources: [".anicode", ".anicode/*", "*/.anicode", "*/.anicode/*"],
          reason: "agent runtime state is protected",
        },
        {
          id: "protect-credential-files",
          effect: "deny",
          actions: ["tool:read", "tool:write", "tool:edit", "tool:apply_patch", "tool:bash"],
          resources: [
            ".env",
            ".env.*",
            "*/.env",
            "*/.env.*",
            "*.env*",
            "*.npmrc*",
            "*.pypirc*",
            "*.netrc*",
            "*.pem*",
            "*id_rsa*",
            "*id_ed25519*",
            "*auth.json*",
          ],
          reason: "credential files are only accessible through Credential Broker",
        },
      ],
    });
  }
}

interface CapabilityClaims {
  v: 1;
  iss: string;
  aud: string;
  sub: string;
  scopes: string[];
  resources: string[];
  iat: number;
  exp: number;
  nonce: string;
}

export interface CapabilityGrant {
  audience: string;
  subject: string;
  scopes: string[];
  resources?: string[];
  ttlMs?: number;
}

function b64url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

function sign(secret: Uint8Array, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export class CapabilityAuthority {
  constructor(
    private readonly secret: Uint8Array,
    private readonly issuer = "anicode",
  ) {
    if (secret.byteLength < 32)
      throw new Error("Capability signing secret must be at least 32 bytes");
  }

  issue(grant: CapabilityGrant): string {
    const now = Date.now();
    const claims: CapabilityClaims = {
      v: 1,
      iss: this.issuer,
      aud: grant.audience,
      sub: grant.subject,
      scopes: grant.scopes,
      resources: grant.resources ?? ["*"],
      iat: now,
      exp: now + Math.max(1_000, grant.ttlMs ?? 5 * 60_000),
      nonce: randomUUID(),
    };
    const payload = b64url(JSON.stringify(claims));
    return `cap1.${payload}.${sign(this.secret, payload)}`;
  }

  verify(
    token: string,
    request: { audience: string; scope: string; resource: string; subject?: string },
  ): CapabilityClaims {
    const [version, payload, signature, extra] = token.split(".");
    if (version !== "cap1" || !payload || !signature || extra)
      throw new Error("Malformed capability");
    const expected = Buffer.from(sign(this.secret, payload));
    const actual = Buffer.from(signature);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new Error("Invalid capability signature");
    }
    const claims = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as CapabilityClaims;
    if (claims.v !== 1 || claims.iss !== this.issuer) throw new Error("Invalid capability issuer");
    if (claims.exp <= Date.now()) throw new Error("Capability expired");
    if (claims.aud !== request.audience) throw new Error("Capability audience mismatch");
    if (request.subject && claims.sub !== request.subject)
      throw new Error("Capability subject mismatch");
    if (!claims.scopes.some((scope) => globMatch(scope, request.scope))) {
      throw new Error("Capability scope denied");
    }
    if (!claims.resources.some((resource) => globMatch(resource, request.resource))) {
      throw new Error("Capability resource denied");
    }
    return claims;
  }
}

/** 策略化网络出口：DNS/私网/端口/域名检查 + 可审计 fetch + 短期凭证注入。 */

import { promises as dns } from "node:dns";
import * as http from "node:http";
import * as net from "node:net";
import { isIP } from "node:net";
import type { Duplex } from "node:stream";
import { Agent as UndiciAgent } from "undici";
import type { CredentialBroker } from "../security/credentials.js";

interface PinnedLookupCallback {
  (error: Error): void;
  (error: null, address: string, family: number): void;
  (error: null, addresses: { address: string; family: number }[]): void;
}

export interface NetworkPolicy {
  allowDomains?: string[];
  denyDomains?: string[];
  allowPorts?: number[];
  protocols?: ("http:" | "https:")[];
  allowPrivateAddresses?: boolean;
  maxRedirects?: number;
}

export interface NetworkAuditEvent {
  timestamp: string;
  url: string;
  host: string;
  decision: "allow" | "deny";
  reason: string;
  addresses?: string[];
}

export interface NetworkProxyOptions {
  policy?: NetworkPolicy;
  broker?: CredentialBroker;
  resolver?: (hostname: string) => Promise<string[]>;
  fetch?: typeof fetch;
  onAudit?: (event: NetworkAuditEvent) => void | Promise<void>;
}

function domainMatches(pattern: string, hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  const expected = pattern.toLowerCase().replace(/\.$/, "");
  if (expected === "*") return true;
  if (expected.startsWith("*.")) {
    const base = expected.slice(2);
    return normalized === base || normalized.endsWith(`.${base}`);
  }
  return normalized === expected;
}

function privateIpv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part))) return false;
  const [a, b] = octets as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  );
}

export function isPrivateAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return privateIpv4(address);
  if (version !== 6) return true;
  const normalized = address.toLowerCase();
  return (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb") ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("ff") ||
    (normalized.startsWith("::ffff:") && privateIpv4(normalized.slice(7)))
  );
}

export class NetworkProxy {
  private readonly policy: Required<NetworkPolicy>;
  private readonly resolver: (hostname: string) => Promise<string[]>;
  private readonly doFetch: typeof fetch;
  private readonly customFetch: boolean;
  private readonly pinnedAgents = new Map<string, UndiciAgent>();
  private readonly broker?: CredentialBroker;
  private readonly onAudit?: NetworkProxyOptions["onAudit"];

  constructor(options: NetworkProxyOptions = {}) {
    this.policy = {
      allowDomains: options.policy?.allowDomains ?? ["*"],
      denyDomains: options.policy?.denyDomains ?? [],
      allowPorts: options.policy?.allowPorts ?? [80, 443],
      protocols: options.policy?.protocols ?? ["http:", "https:"],
      allowPrivateAddresses: options.policy?.allowPrivateAddresses ?? false,
      maxRedirects: Math.max(0, options.policy?.maxRedirects ?? 5),
    };
    this.resolver =
      options.resolver ??
      (async (hostname) =>
        (await dns.lookup(hostname, { all: true })).map((entry) => entry.address));
    this.doFetch = options.fetch ?? fetch;
    this.customFetch = options.fetch !== undefined;
    if (options.broker) this.broker = options.broker;
    if (options.onAudit) this.onAudit = options.onAudit;
  }

  private async audit(event: Omit<NetworkAuditEvent, "timestamp">): Promise<void> {
    await this.onAudit?.({ timestamp: new Date().toISOString(), ...event });
  }

  async authorize(target: string | URL): Promise<{ url: URL; addresses: string[] }> {
    const url = target instanceof URL ? target : new URL(target);
    const host = url.hostname.toLowerCase();
    const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
    const deny = async (reason: string): Promise<never> => {
      await this.audit({ url: url.toString(), host, decision: "deny", reason });
      throw new Error(`Network policy denied ${url.toString()}: ${reason}`);
    };
    if (!this.policy.protocols.includes(url.protocol as "http:" | "https:")) {
      return deny(`protocol ${url.protocol} is not allowed`);
    }
    if (!this.policy.allowPorts.includes(port)) return deny(`port ${port} is not allowed`);
    if (this.policy.denyDomains.some((pattern) => domainMatches(pattern, host))) {
      return deny("domain is denied");
    }
    if (!this.policy.allowDomains.some((pattern) => domainMatches(pattern, host))) {
      return deny("domain is not allowlisted");
    }
    const addresses = isIP(host) ? [host] : await this.resolver(host);
    if (addresses.length === 0) return deny("DNS returned no addresses");
    if (!this.policy.allowPrivateAddresses && addresses.some(isPrivateAddress)) {
      return deny("private, loopback, link-local or reserved address");
    }
    await this.audit({
      url: url.toString(),
      host,
      decision: "allow",
      reason: "policy matched",
      addresses,
    });
    return { url, addresses };
  }

  async fetch(
    target: string | URL,
    init: RequestInit & { credentialLease?: string } = {},
  ): Promise<Response> {
    const { credentialLease, ...requestInit } = init;
    let authorization = await this.authorize(target);
    let current = authorization.url;
    let headers = new Headers(requestInit.headers);
    if (credentialLease) {
      if (!this.broker) throw new Error("No credential broker configured");
      headers = this.broker.injectHeaders(credentialLease, headers);
    }
    for (let redirects = 0; ; redirects++) {
      const fetchInit = {
        ...requestInit,
        headers,
        redirect: "manual",
      } satisfies RequestInit;
      const response = this.customFetch
        ? await this.doFetch(current, fetchInit)
        : await this.doFetch(current, {
            ...fetchInit,
            // Node fetch/Undici 扩展：授权时解析出的 IP 被固定到 socket lookup，
            // 防止检查后再次 DNS 解析产生 rebinding/TOCTOU。
            dispatcher: this.dispatcher(current, authorization.addresses),
          } as RequestInit);
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;
      const location = response.headers.get("location");
      if (!location) return response;
      if (redirects >= this.policy.maxRedirects) throw new Error("Network redirect limit exceeded");
      authorization = await this.authorize(new URL(location, current));
      const next = authorization.url;
      if (next.origin !== current.origin) headers.delete("authorization");
      current = next;
    }
  }

  async close(): Promise<void> {
    const agents = [...this.pinnedAgents.values()];
    this.pinnedAgents.clear();
    await Promise.all(agents.map((agent) => agent.close()));
  }

  private dispatcher(url: URL, addresses: string[]): UndiciAgent {
    const candidates = [...new Set(addresses)].sort();
    const key = `${url.origin}\0${candidates.join(",")}`;
    const existing = this.pinnedAgents.get(key);
    if (existing) return existing;
    const agent = new UndiciAgent({
      connect: {
        lookup: (_hostname, options, callback) => {
          const respond = callback as unknown as PinnedLookupCallback;
          const requested = typeof options.family === "number" ? options.family : 0;
          const matches = candidates.filter(
            (address) => requested === 0 || isIP(address) === requested,
          );
          const selected = matches.length > 0 ? matches : candidates;
          if (options.all) {
            respond(
              null,
              selected.map((address) => ({ address, family: isIP(address) })),
            );
            return;
          }
          const address = selected[0];
          if (!address) {
            respond(new Error("authorized DNS result is empty"));
            return;
          }
          respond(null, address, isIP(address));
        },
      },
    });
    this.pinnedAgents.set(key, agent);
    return agent;
  }
}

export interface NetworkProxyServerOptions {
  proxy: NetworkProxy;
  host?: string;
  port?: number;
  maxRequestBytes?: number;
}

/**
 * 本地 HTTP/CONNECT 出口。普通 HTTP 请求复用 NetworkProxy.fetch 的完整策略；
 * CONNECT 在建 TCP 隧道前完成域名/端口/DNS/私网检查，并直接连接已授权 IP，避免二次解析。
 */
export class NetworkProxyServer {
  private server: http.Server | undefined;
  private bound: { host: string; port: number } | undefined;

  constructor(private readonly options: NetworkProxyServerOptions) {}

  async listen(): Promise<string> {
    if (this.bound) return this.url();
    const host = this.options.host ?? "127.0.0.1";
    const server = http.createServer((request, response) => {
      void this.forwardHttp(request, response).catch((error) => {
        if (!response.headersSent) response.writeHead(502, { "content-type": "text/plain" });
        response.end(`proxy denied: ${error instanceof Error ? error.message : String(error)}`);
      });
    });
    server.on("connect", (request, socket, head) => {
      void this.forwardConnect(request, socket, head).catch((error) => {
        socket.end(
          `HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.options.port ?? 0, host, () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("Network proxy did not bind a TCP address");
    }
    this.server = server;
    this.bound = { host, port: address.port };
    return this.url();
  }

  url(): string {
    if (!this.bound) throw new Error("Network proxy is not listening");
    return `http://${this.bound.host}:${this.bound.port}`;
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.bound = undefined;
    if (!server) return;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }

  private async forwardHttp(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    const target = new URL(request.url ?? "", `http://${request.headers.host ?? ""}`);
    const limit = Math.max(1_024, this.options.maxRequestBytes ?? 8 * 1024 * 1024);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += value.byteLength;
      if (size > limit) throw new Error(`proxy request body exceeds ${limit} bytes`);
      chunks.push(value);
    }
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (value === undefined || ["host", "proxy-authorization", "proxy-connection"].includes(name))
        continue;
      headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    }
    const lease = headers.get("x-anicode-credential-lease") ?? undefined;
    headers.delete("x-anicode-credential-lease");
    const upstream = await this.options.proxy.fetch(target, {
      ...(request.method ? { method: request.method } : {}),
      headers,
      ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
      ...(lease ? { credentialLease: lease } : {}),
    });
    const outgoing: Record<string, string> = {};
    upstream.headers.forEach((value, name) => {
      if (!["connection", "transfer-encoding"].includes(name.toLowerCase())) outgoing[name] = value;
    });
    response.writeHead(upstream.status, outgoing);
    response.end(Buffer.from(await upstream.arrayBuffer()));
  }

  private async forwardConnect(
    request: http.IncomingMessage,
    client: Duplex,
    head: Buffer,
  ): Promise<void> {
    const authority = request.url ?? "";
    const split = authority.lastIndexOf(":");
    if (split <= 0) throw new Error("CONNECT target must be host:port");
    const hostname = authority.slice(0, split).replace(/^\[|\]$/g, "");
    const port = Number(authority.slice(split + 1));
    const authorized = await this.options.proxy.authorize(`https://${hostname}:${port}/`);
    const upstream = net.connect({ host: authorized.addresses[0]!, port });
    await new Promise<void>((resolve, reject) => {
      upstream.once("connect", resolve);
      upstream.once("error", reject);
    });
    client.write("HTTP/1.1 200 Connection Established\r\nProxy-Agent: anicode\r\n\r\n");
    if (head.length) upstream.write(head);
    upstream.pipe(client);
    client.pipe(upstream);
    const destroy = () => {
      upstream.destroy();
      client.destroy();
    };
    upstream.once("error", destroy);
    client.once("error", destroy);
  }
}

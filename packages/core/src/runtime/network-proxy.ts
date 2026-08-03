/** 策略化网络出口：DNS/私网/端口/域名检查 + 可审计 fetch + 短期凭证注入。 */

import { promises as dns } from "node:dns";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import * as http from "node:http";
import * as net from "node:net";
import { isIP } from "node:net";
import type { Duplex } from "node:stream";
import { Agent as UndiciAgent } from "undici";
import type { CredentialBroker } from "../security/credentials.js";

const PROXY_CREDENTIAL_CONTROL_PATH = "/.well-known/anicode/proxy-credentials";

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
  /** Test-runner seam only. Production traffic must use the DNS-pinned Undici dispatcher. */
  fetch?: typeof fetch;
  onAudit?: (event: NetworkAuditEvent) => void | Promise<void>;
  /** DNS-pinned Undici dispatchers retained across origins. Least-recently-used entries retire. */
  maxPinnedAgents?: number;
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

interface ParsedIpAddress {
  version: 4 | 6;
  value: bigint;
  canonical: string;
}

function parseIpv4(address: string): ParsedIpAddress | undefined {
  const parts = address.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^(?:0|[1-9]\d{0,2})$/.test(part))) {
    return undefined;
  }
  const octets = parts.map(Number);
  if (octets.some((part) => part > 255)) return undefined;
  const value = octets.reduce((result, octet) => (result << 8n) | BigInt(octet), 0n);
  return { version: 4, value, canonical: octets.join(".") };
}

function parseIpv6(address: string): ParsedIpAddress | undefined {
  let source = address.toLowerCase().replace(/^\[|\]$/g, "");
  if (!source || source.includes("%")) return undefined;

  // RFC 4291 permits the final 32 bits to use dotted IPv4 notation. Convert that suffix before
  // expanding `::`, so dotted and hexadecimal IPv4-mapped spellings share one numeric identity.
  if (source.includes(".")) {
    const split = source.lastIndexOf(":");
    if (split < 0) return undefined;
    const ipv4 = parseIpv4(source.slice(split + 1));
    if (!ipv4) return undefined;
    const high = Number((ipv4.value >> 16n) & 0xffffn).toString(16);
    const low = Number(ipv4.value & 0xffffn).toString(16);
    source = `${source.slice(0, split)}:${high}:${low}`;
  }

  const halves = source.split("::");
  if (halves.length > 2) return undefined;
  const parseHalf = (half: string): number[] | undefined => {
    if (!half) return [];
    const groups = half.split(":");
    if (groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return undefined;
    return groups.map((group) => Number.parseInt(group, 16));
  };
  const left = parseHalf(halves[0] ?? "");
  const right = parseHalf(halves[1] ?? "");
  if (!left || !right) return undefined;
  const explicit = left.length + right.length;
  if ((halves.length === 1 && explicit !== 8) || (halves.length === 2 && explicit >= 8)) {
    return undefined;
  }
  const groups =
    halves.length === 1 ? left : [...left, ...new Array<number>(8 - explicit).fill(0), ...right];
  let value = 0n;
  for (const group of groups) value = (value << 16n) | BigInt(group);
  // A fixed-width spelling is deliberately used as the canonical internal form. It is accepted by
  // Node sockets and makes every equivalent compressed spelling compare identically.
  return {
    version: 6,
    value,
    canonical: groups.map((group) => group.toString(16).padStart(4, "0")).join(":"),
  };
}

function parseIpAddress(address: string): ParsedIpAddress | undefined {
  const normalized = address.trim().replace(/^\[|\]$/g, "");
  return parseIpv4(normalized) ?? parseIpv6(normalized);
}

/** Canonical numeric spelling used for DNS pinning; invalid/zone-scoped input is rejected. */
export function canonicalizeIpAddress(address: string): string | undefined {
  return parseIpAddress(address)?.canonical;
}

function inPrefix(value: bigint, prefix: bigint, bits: number, width: 32 | 128): boolean {
  const shift = BigInt(width - bits);
  return value >> shift === prefix >> shift;
}

function ipv4Value(address: string): bigint {
  return parseIpv4(address)!.value;
}

// IANA IPv4 Special-Purpose ranges that are not suitable as public HTTP destinations. The three
// documentation networks and benchmarking/shared space matter for SSRF as much as RFC1918 space.
const NON_PUBLIC_IPV4: ReadonlyArray<readonly [bigint, number]> = [
  [ipv4Value("0.0.0.0"), 8],
  [ipv4Value("10.0.0.0"), 8],
  [ipv4Value("100.64.0.0"), 10],
  [ipv4Value("127.0.0.0"), 8],
  [ipv4Value("169.254.0.0"), 16],
  [ipv4Value("172.16.0.0"), 12],
  [ipv4Value("192.0.0.0"), 24],
  [ipv4Value("192.0.2.0"), 24],
  [ipv4Value("192.88.99.0"), 24],
  [ipv4Value("192.168.0.0"), 16],
  [ipv4Value("198.18.0.0"), 15],
  [ipv4Value("198.51.100.0"), 24],
  [ipv4Value("203.0.113.0"), 24],
  [ipv4Value("224.0.0.0"), 4],
  [ipv4Value("240.0.0.0"), 4],
];

function nonPublicIpv4(value: bigint): boolean {
  // PCP and TURN anycast are the globally reachable exceptions inside 192.0.0.0/24.
  if (value === ipv4Value("192.0.0.9") || value === ipv4Value("192.0.0.10")) return false;
  return NON_PUBLIC_IPV4.some(([prefix, bits]) => inPrefix(value, prefix, bits, 32));
}

function ipv6Value(address: string): bigint {
  return parseIpv6(address)!.value;
}

const NON_PUBLIC_IPV6: ReadonlyArray<readonly [bigint, number]> = [
  [ipv6Value("::"), 96], // obsolete IPv4-compatible space, including unspecified/loopback
  [ipv6Value("64:ff9b:1::"), 48], // local-use translation prefix
  [ipv6Value("100::"), 64], // discard-only
  [ipv6Value("2001::"), 23], // IETF protocol assignments/tunnelling, not ordinary public hosts
  [ipv6Value("2001:db8::"), 32], // documentation
  [ipv6Value("2002::"), 16], // deprecated 6to4 tunnelling
  [ipv6Value("3fff::"), 20], // documentation
  [ipv6Value("5f00::"), 16], // segment-routing SIDs
  [ipv6Value("fc00::"), 7], // unique-local
  [ipv6Value("fe80::"), 10], // link-local
  [ipv6Value("fec0::"), 10], // deprecated site-local
  [ipv6Value("ff00::"), 8], // multicast
];

export function isPrivateAddress(address: string): boolean {
  const parsed = parseIpAddress(address);
  if (!parsed) return true;
  if (parsed.version === 4) return nonPublicIpv4(parsed.value);

  // IPv4-mapped IPv6 (`::ffff:0:0/96`) can be written with dotted or hexadecimal suffixes. Apply
  // the IPv4 registry to the embedded address instead of relying on a textual prefix.
  if (parsed.value >> 32n === 0xffffn) return nonPublicIpv4(parsed.value & 0xffffffffn);
  // NAT64's well-known prefix can also turn an apparently public IPv6 destination into a private
  // IPv4 request on networks that provide a translator.
  if (inPrefix(parsed.value, ipv6Value("64:ff9b::"), 96, 128)) {
    return nonPublicIpv4(parsed.value & 0xffffffffn);
  }
  return NON_PUBLIC_IPV6.some(([prefix, bits]) => inPrefix(parsed.value, prefix, bits, 128));
}

const SENSITIVE_REDIRECT_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "cookie2",
  "x-api-key",
  "api-key",
  "x-auth-token",
  "x-goog-api-key",
]);

function stripSensitiveRedirectHeaders(headers: Headers): void {
  for (const name of [...headers.keys()]) {
    if (
      SENSITIVE_REDIRECT_HEADERS.has(name.toLowerCase()) ||
      /(?:^|[-_])(?:access[-_]?token|auth[-_]?token|token|api[-_]?key|credential|secret|password)(?:$|[-_])/i.test(
        name,
      )
    ) {
      headers.delete(name);
    }
  }
}

function dropRequestBodyHeaders(headers: Headers): void {
  for (const name of [
    "content-encoding",
    "content-language",
    "content-length",
    "content-location",
    "content-type",
    "expect",
    "transfer-encoding",
  ]) {
    headers.delete(name);
  }
}

function replayableBody(body: BodyInit | null | undefined): boolean {
  if (body === undefined || body === null || typeof body === "string") return true;
  if (body instanceof URLSearchParams || body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
    return true;
  }
  if (typeof Blob !== "undefined" && body instanceof Blob) return true;
  if (typeof FormData !== "undefined" && body instanceof FormData) return true;
  return false;
}

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function headerTokens(value: string | string[] | null | undefined): Set<string> {
  const values = Array.isArray(value)
    ? value
    : value === null || value === undefined
      ? []
      : [value];
  return new Set(
    values
      .flatMap((entry) => entry.split(","))
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
  );
}

function hopByHopRequestHeader(name: string, connectionHeaders: ReadonlySet<string>): boolean {
  const normalized = name.toLowerCase();
  return (
    normalized === "host" ||
    normalized === "content-length" ||
    normalized === "expect" ||
    HOP_BY_HOP_HEADERS.has(normalized) ||
    connectionHeaders.has(normalized)
  );
}

function hopByHopResponseHeader(name: string, connectionHeaders: ReadonlySet<string>): boolean {
  const normalized = name.toLowerCase();
  return HOP_BY_HOP_HEADERS.has(normalized) || connectionHeaders.has(normalized);
}

/**
 * WHATWG fetch transparently decodes compressed response bodies but retains the origin's
 * representation headers.  Forwarding those headers would tell the downstream client to decode
 * an already-decoded body and may also advertise the compressed byte length.  The proxy therefore
 * always emits the identity representation and lets node:http frame its actual body length.
 */
function decodedRepresentationHeader(name: string): boolean {
  const normalized = name.toLowerCase();
  return normalized === "content-encoding" || normalized === "content-length";
}

async function waitForDrain(response: http.ServerResponse, signal: AbortSignal): Promise<void> {
  if (response.destroyed) throw new Error("proxy client disconnected");
  if (signal.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("proxy request aborted");
  }
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      response.off("drain", onDrain);
      response.off("close", onClose);
      response.off("error", onError);
      signal.removeEventListener("abort", onAbort);
    };
    const settle = (action: () => void) => {
      cleanup();
      action();
    };
    const onDrain = () => settle(resolve);
    const onClose = () => settle(() => reject(new Error("proxy client disconnected")));
    const onError = (error: Error) => settle(() => reject(error));
    const onAbort = () =>
      settle(() =>
        reject(signal.reason instanceof Error ? signal.reason : new Error("proxy request aborted")),
      );
    response.once("drain", onDrain);
    response.once("close", onClose);
    response.once("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function parseConnectAuthority(authority: string): { hostname: string; port: number } {
  if (!authority || /[\u0000-\u0020\u007f/@\\?#]/.test(authority)) {
    throw new Error("CONNECT target must be an unambiguous host:port authority");
  }
  const bracketed = /^\[([^\]]+)]:(\d{1,5})$/.exec(authority);
  const named = /^([^:]+):(\d{1,5})$/.exec(authority);
  const match = bracketed ?? named;
  if (!match) throw new Error("CONNECT target must be host:port");
  const rawHostname = match[1]!;
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("CONNECT target port is invalid");
  }
  let parsed: URL;
  try {
    parsed = new URL(`https://${bracketed ? `[${rawHostname}]` : rawHostname}:${port}/`);
  } catch {
    throw new Error("CONNECT target hostname is invalid");
  }
  if (parsed.username || parsed.password || !parsed.hostname) {
    throw new Error("CONNECT target hostname is invalid");
  }
  return { hostname: parsed.hostname.replace(/^\[|]$/g, ""), port };
}

function normalizeServerName(serverName: string): string {
  const withoutTrailingDot = serverName.toLowerCase().replace(/\.$/, "");
  if (
    !withoutTrailingDot ||
    withoutTrailingDot.length > 253 ||
    isIP(withoutTrailingDot) !== 0 ||
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/.test(
      withoutTrailingDot,
    )
  ) {
    throw new Error("CONNECT TLS server name is invalid");
  }
  return withoutTrailingDot;
}

interface ParsedTlsClientHello {
  bytes: Buffer;
  serverName?: string;
  encryptedClientHello: boolean;
}

interface ParsedClientHelloBody {
  serverName?: string;
  encryptedClientHello: boolean;
}

function parseClientHelloBody(handshake: Buffer, totalLength: number): ParsedClientHelloBody {
  const end = totalLength;
  let cursor = 4;
  const requireBytes = (length: number, label: string) => {
    if (length < 0 || cursor + length > end) throw new Error(`malformed TLS ClientHello ${label}`);
  };
  requireBytes(2 + 32 + 1, "header");
  const legacyMajor = handshake[cursor]!;
  const legacyMinor = handshake[cursor + 1]!;
  if (legacyMajor !== 3 || legacyMinor < 1 || legacyMinor > 4) {
    throw new Error("CONNECT requires a TLS ClientHello");
  }
  cursor += 2 + 32;
  const sessionIdLength = handshake[cursor++]!;
  if (sessionIdLength > 32) throw new Error("malformed TLS ClientHello session id");
  requireBytes(sessionIdLength + 2, "session id");
  cursor += sessionIdLength;
  const cipherSuitesLength = handshake.readUInt16BE(cursor);
  cursor += 2;
  if (cipherSuitesLength < 2 || cipherSuitesLength % 2 !== 0) {
    throw new Error("malformed TLS ClientHello cipher suites");
  }
  requireBytes(cipherSuitesLength + 1, "cipher suites");
  cursor += cipherSuitesLength;
  const compressionMethodsLength = handshake[cursor++]!;
  if (compressionMethodsLength < 1) {
    throw new Error("malformed TLS ClientHello compression methods");
  }
  requireBytes(compressionMethodsLength, "compression methods");
  cursor += compressionMethodsLength;
  if (cursor === end) return { encryptedClientHello: false };

  requireBytes(2, "extensions length");
  const extensionsLength = handshake.readUInt16BE(cursor);
  cursor += 2;
  if (cursor + extensionsLength !== end) {
    throw new Error("malformed TLS ClientHello extensions");
  }
  const seenExtensions = new Set<number>();
  let serverName: string | undefined;
  let encryptedClientHello = false;
  while (cursor < end) {
    requireBytes(4, "extension header");
    const type = handshake.readUInt16BE(cursor);
    const length = handshake.readUInt16BE(cursor + 2);
    cursor += 4;
    requireBytes(length, "extension body");
    if (seenExtensions.has(type)) throw new Error("duplicate TLS ClientHello extension");
    seenExtensions.add(type);
    const extensionEnd = cursor + length;
    // RFC 9337 ECH and its obsolete ESNI predecessor both hide the authoritative hostname.
    if (type === 0xfe0d || type === 0xffce) encryptedClientHello = true;
    if (type === 0) {
      if (length < 2) throw new Error("malformed TLS ClientHello SNI");
      const namesLength = handshake.readUInt16BE(cursor);
      cursor += 2;
      if (cursor + namesLength !== extensionEnd) throw new Error("malformed TLS ClientHello SNI");
      while (cursor < extensionEnd) {
        if (cursor + 3 > extensionEnd) throw new Error("malformed TLS ClientHello SNI entry");
        const nameType = handshake[cursor++]!;
        const nameLength = handshake.readUInt16BE(cursor);
        cursor += 2;
        if (nameLength < 1 || cursor + nameLength > extensionEnd) {
          throw new Error("malformed TLS ClientHello SNI entry");
        }
        if (nameType === 0) {
          if (serverName) throw new Error("ambiguous TLS ClientHello SNI");
          const rawName = handshake.subarray(cursor, cursor + nameLength);
          if ([...rawName].some((byte) => byte < 0x21 || byte > 0x7e)) {
            throw new Error("invalid TLS ClientHello SNI");
          }
          serverName = normalizeServerName(rawName.toString("ascii"));
        }
        cursor += nameLength;
      }
    } else {
      cursor = extensionEnd;
    }
  }
  return { ...(serverName ? { serverName } : {}), encryptedClientHello };
}

class TlsClientHelloInspector {
  private readonly raw: Buffer;
  private readonly handshake: Buffer;
  private rawLength = 0;
  private recordOffset = 0;
  private handshakeLength = 0;

  constructor(private readonly maximumBytes: number) {
    this.raw = Buffer.allocUnsafe(maximumBytes);
    this.handshake = Buffer.allocUnsafe(maximumBytes);
  }

  add(input: Buffer): ParsedTlsClientHello | undefined {
    if (input.byteLength > this.maximumBytes - this.rawLength) {
      throw new Error(`TLS ClientHello exceeds ${this.maximumBytes} bytes`);
    }
    input.copy(this.raw, this.rawLength);
    this.rawLength += input.byteLength;
    for (;;) {
      if (this.rawLength - this.recordOffset < 5) return undefined;
      const contentType = this.raw[this.recordOffset]!;
      const major = this.raw[this.recordOffset + 1]!;
      const minor = this.raw[this.recordOffset + 2]!;
      const recordLength = this.raw.readUInt16BE(this.recordOffset + 3);
      if (contentType !== 22 || major !== 3 || minor < 1 || minor > 4) {
        throw new Error("CONNECT permits TLS ClientHello traffic only");
      }
      if (recordLength < 1 || recordLength > 16_384) {
        throw new Error("invalid TLS ClientHello record length");
      }
      const recordEnd = this.recordOffset + 5 + recordLength;
      if (this.rawLength < recordEnd) return undefined;
      if (recordLength > this.maximumBytes - this.handshakeLength) {
        throw new Error(`TLS ClientHello exceeds ${this.maximumBytes} bytes`);
      }
      this.raw.copy(this.handshake, this.handshakeLength, this.recordOffset + 5, recordEnd);
      this.handshakeLength += recordLength;
      this.recordOffset = recordEnd;
      if (this.handshakeLength < 4) continue;
      if (this.handshake[0] !== 1) throw new Error("CONNECT requires a TLS ClientHello");
      const bodyLength = this.handshake.readUIntBE(1, 3);
      const totalLength = 4 + bodyLength;
      if (totalLength > this.maximumBytes) {
        throw new Error(`TLS ClientHello exceeds ${this.maximumBytes} bytes`);
      }
      if (this.handshakeLength < totalLength) continue;
      const parsed = parseClientHelloBody(this.handshake, totalLength);
      return {
        bytes: Buffer.from(this.raw.subarray(0, this.rawLength)),
        ...parsed,
      };
    }
  }
}

async function receiveTlsClientHello(
  client: Duplex,
  head: Buffer,
  maximumBytes: number,
  timeoutMs: number,
): Promise<ParsedTlsClientHello> {
  client.pause();
  const inspector = new TlsClientHelloInspector(maximumBytes);
  const initial = inspector.add(head);
  if (initial) return initial;
  if (client.destroyed || client.readableEnded) throw new Error("proxy client disconnected");

  return new Promise<ParsedTlsClientHello>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => fail(new Error("TLS ClientHello timeout")), timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      client.off("data", onData);
      client.off("end", onEnd);
      client.off("close", onClose);
      client.off("error", onError);
    };
    const finish = (result: ParsedTlsClientHello) => {
      if (settled) return;
      settled = true;
      client.pause();
      cleanup();
      resolve(result);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      client.pause();
      cleanup();
      reject(error);
    };
    const onData = (chunk: Buffer | string) => {
      try {
        const result = inspector.add(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        if (result) finish(result);
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    };
    const onEnd = () => fail(new Error("proxy client ended before TLS ClientHello"));
    const onClose = () => fail(new Error("proxy client disconnected"));
    const onError = (error: Error) => fail(error);
    client.on("data", onData);
    client.once("end", onEnd);
    client.once("close", onClose);
    client.once("error", onError);
    client.resume();
  });
}

export class NetworkProxy {
  private readonly policy: Required<NetworkPolicy>;
  private readonly resolver: (hostname: string) => Promise<string[]>;
  private readonly doFetch: typeof fetch;
  private readonly customFetch: boolean;
  private readonly pinnedAgents = new Map<string, UndiciAgent>();
  private readonly retiringAgents = new Set<Promise<void>>();
  private readonly maxPinnedAgents: number;
  private readonly broker?: CredentialBroker;
  private readonly onAudit?: NetworkProxyOptions["onAudit"];

  constructor(options: NetworkProxyOptions = {}) {
    if (options.fetch && !process.env.NODE_TEST_CONTEXT) {
      throw new Error("NetworkProxy custom fetch is restricted to the Node test runner");
    }
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
    this.maxPinnedAgents = Number.isFinite(options.maxPinnedAgents)
      ? Math.max(1, Math.floor(options.maxPinnedAgents!))
      : 128;
    if (options.broker) this.broker = options.broker;
    if (options.onAudit) this.onAudit = options.onAudit;
  }

  private async audit(event: Omit<NetworkAuditEvent, "timestamp">): Promise<void> {
    await this.onAudit?.({ timestamp: new Date().toISOString(), ...event });
  }

  async authorize(target: string | URL): Promise<{ url: URL; addresses: string[] }> {
    const url = target instanceof URL ? target : new URL(target);
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    const literal = parseIpAddress(host);
    const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
    const deny = async (reason: string): Promise<never> => {
      await this.audit({ url: url.toString(), host, decision: "deny", reason });
      throw new Error(`Network policy denied ${url.toString()}: ${reason}`);
    };
    if (!this.policy.protocols.includes(url.protocol as "http:" | "https:")) {
      return deny(`protocol ${url.protocol} is not allowed`);
    }
    if (url.username || url.password) return deny("URL credentials are not allowed");
    if (!this.policy.allowPorts.includes(port)) return deny(`port ${port} is not allowed`);
    if (this.policy.denyDomains.some((pattern) => domainMatches(pattern, host))) {
      return deny("domain is denied");
    }
    if (!this.policy.allowDomains.some((pattern) => domainMatches(pattern, host))) {
      return deny("domain is not allowlisted");
    }
    const resolved = literal ? [literal.canonical] : await this.resolver(host);
    if (resolved.length === 0) return deny("DNS returned no addresses");
    const addresses = resolved.map(canonicalizeIpAddress);
    if (addresses.some((address) => address === undefined)) {
      return deny("DNS returned an invalid IP address");
    }
    const pinned: string[] = [...new Set(addresses as string[])];
    if (!this.policy.allowPrivateAddresses && pinned.some(isPrivateAddress)) {
      return deny("private, loopback, link-local or reserved address");
    }
    await this.audit({
      url: url.toString(),
      host,
      decision: "allow",
      reason: "policy matched",
      addresses: pinned,
    });
    return { url, addresses: pinned };
  }

  async fetch(
    target: string | URL,
    init: RequestInit & { credentialLease?: string } = {},
  ): Promise<Response> {
    const { credentialLease, body: initialBody, method: initialMethod, ...requestInit } = init;
    let authorization = await this.authorize(target);
    let current = authorization.url;
    let method = (initialMethod ?? "GET").toUpperCase();
    let body = initialBody;
    let headers = new Headers(requestInit.headers);
    if (credentialLease) {
      if (!this.broker) throw new Error("No credential broker configured");
      headers = this.broker.injectHeaders(credentialLease, headers);
    }
    for (let redirects = 0; ; redirects++) {
      const fetchInit = {
        ...requestInit,
        method,
        ...(body === undefined || body === null ? {} : { body }),
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
      if (redirects >= this.policy.maxRedirects) {
        await response.body?.cancel("network redirect limit exceeded");
        throw new Error("Network redirect limit exceeded");
      }
      await response.body?.cancel("following redirect");
      const redirectTarget = new URL(location, current);
      const crossOrigin = redirectTarget.origin !== current.origin;
      if (crossOrigin && credentialLease) {
        throw new Error("Credentialed cross-origin redirect denied");
      }
      if (crossOrigin) stripSensitiveRedirectHeaders(headers);

      const changesToGet =
        (response.status === 303 && method !== "GET" && method !== "HEAD") ||
        ((response.status === 301 || response.status === 302) && method === "POST");
      if (changesToGet) {
        method = "GET";
        body = undefined;
        dropRequestBodyHeaders(headers);
      } else if (body !== undefined && body !== null && !replayableBody(body)) {
        throw new Error("Cannot follow redirect with a non-replayable request body");
      }

      authorization = await this.authorize(redirectTarget);
      const next = authorization.url;
      current = next;
    }
  }

  async close(): Promise<void> {
    const agents = [...this.pinnedAgents.values()];
    this.pinnedAgents.clear();
    await Promise.all([...agents.map((agent) => agent.close()), ...this.retiringAgents]);
  }

  private dispatcher(url: URL, addresses: string[]): UndiciAgent {
    const candidates = [...new Set(addresses)].sort();
    const key = `${url.origin}\0${candidates.join(",")}`;
    const existing = this.pinnedAgents.get(key);
    if (existing) {
      // Map insertion order is the LRU queue. Refresh hits without allocating another dispatcher.
      this.pinnedAgents.delete(key);
      this.pinnedAgents.set(key, existing);
      return existing;
    }
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
    while (this.pinnedAgents.size > this.maxPinnedAgents) {
      const oldest = this.pinnedAgents.entries().next().value as [string, UndiciAgent] | undefined;
      if (!oldest) break;
      this.pinnedAgents.delete(oldest[0]);
      this.retireAgent(oldest[1]);
    }
    return agent;
  }

  private retireAgent(agent: UndiciAgent): void {
    const retiring = agent.close().catch(() => agent.destroy());
    this.retiringAgents.add(retiring);
    // Observe both outcomes and release the bookkeeping slot even when callers never invoke close().
    void retiring.then(
      () => this.retiringAgents.delete(retiring),
      () => this.retiringAgents.delete(retiring),
    );
  }
}

export interface ScopedProxyCredentialRequest {
  proxyUrl: string;
  tenantId: string;
  executionId: string;
  ttlMs: number;
  signal?: AbortSignal;
}

export interface ScopedProxyCredentialLease {
  /** URL containing only this execution's short-lived capability. Never log this value. */
  proxyUrl: string;
  expiresAt: string;
  redact(value: string): string;
  revoke(): Promise<void>;
}

export interface ScopedProxyCredentialIssuer {
  issue(request: ScopedProxyCredentialRequest): Promise<ScopedProxyCredentialLease>;
}

interface ProxyCredentialRecord {
  id: string;
  tokenHash: string;
  principal: string;
  tenantId: string;
  executionId: string;
  expiresAt: number;
  sourceAddress?: string;
}

export interface NetworkProxyCredentialAuthorityOptions {
  maxTtlMs?: number;
  maxActiveCredentials?: number;
  now?: () => number;
  onAudit?: (event: {
    action: "issue" | "authenticate" | "revoke" | "deny";
    credentialId?: string;
    tenantId?: string;
    executionId?: string;
    success: boolean;
    reason?: string;
  }) => void | Promise<void>;
}

/**
 * In-memory capability registry owned by the trusted egress proxy. Plaintext runner tokens are
 * returned exactly once and only SHA-256 digests remain in the proxy process. A capability is
 * bound to tenant/execution, a short TTL, and the source address observed on first use.
 */
export class NetworkProxyCredentialAuthority {
  private readonly byTokenHash = new Map<string, ProxyCredentialRecord>();
  private readonly tokenHashById = new Map<string, string>();
  private readonly maxTtlMs: number;
  private readonly maxActiveCredentials: number;
  private readonly now: () => number;

  constructor(private readonly options: NetworkProxyCredentialAuthorityOptions = {}) {
    const maxTtlMs = options.maxTtlMs ?? 16 * 60_000;
    const maxActiveCredentials = options.maxActiveCredentials ?? 10_000;
    if (!Number.isFinite(maxTtlMs) || maxTtlMs < 5_000) {
      throw new Error("Proxy credential max TTL must be at least 5000 ms");
    }
    if (!Number.isSafeInteger(maxActiveCredentials) || maxActiveCredentials < 16) {
      throw new Error("Proxy credential capacity must be a safe integer >= 16");
    }
    this.maxTtlMs = Math.min(30 * 60_000, maxTtlMs);
    this.maxActiveCredentials = Math.min(100_000, maxActiveCredentials);
    this.now = options.now ?? Date.now;
  }

  issue(request: { tenantId: string; executionId: string; ttlMs: number }): {
    id: string;
    principal: string;
    token: string;
    expiresAt: string;
  } {
    const tenantId = proxyScopeValue(request.tenantId, "tenantId");
    const executionId = proxyScopeValue(request.executionId, "executionId");
    this.purgeExpired();
    if (this.byTokenHash.size >= this.maxActiveCredentials) {
      this.audit({
        action: "deny",
        tenantId,
        executionId,
        success: false,
        reason: "capacity",
      });
      throw proxyError(503, "proxy credential capacity exceeded");
    }
    if (!Number.isFinite(request.ttlMs)) throw proxyError(400, "invalid proxy credential TTL");
    const ttlMs = Math.min(this.maxTtlMs, Math.max(1_000, Math.floor(request.ttlMs)));
    const token = randomBytes(32).toString("base64url");
    const tokenHash = proxyTokenHash(token);
    const record: ProxyCredentialRecord = {
      id: `pc_${randomUUID()}`,
      tokenHash,
      principal: `job-${randomBytes(12).toString("base64url")}`,
      tenantId,
      executionId,
      expiresAt: this.now() + ttlMs,
    };
    this.byTokenHash.set(tokenHash, record);
    this.tokenHashById.set(record.id, tokenHash);
    this.audit({
      action: "issue",
      credentialId: record.id,
      tenantId,
      executionId,
      success: true,
    });
    return {
      id: record.id,
      principal: record.principal,
      token,
      expiresAt: new Date(record.expiresAt).toISOString(),
    };
  }

  authenticate(request: { principal: string; token: string; sourceAddress?: string }): boolean {
    this.purgeExpired();
    const tokenHash = proxyTokenHash(request.token);
    const record = this.byTokenHash.get(tokenHash);
    const sourceAddress = normalizeProxySourceAddress(request.sourceAddress);
    if (!record || record.expiresAt <= this.now()) {
      this.audit({ action: "deny", success: false, reason: "unknown_or_expired" });
      return false;
    }
    if (!constantTimeEqual(request.principal, record.principal)) {
      this.audit({
        action: "deny",
        credentialId: record.id,
        tenantId: record.tenantId,
        executionId: record.executionId,
        success: false,
        reason: "execution_scope",
      });
      return false;
    }
    if (!sourceAddress) {
      this.audit({
        action: "deny",
        credentialId: record.id,
        tenantId: record.tenantId,
        executionId: record.executionId,
        success: false,
        reason: "missing_source",
      });
      return false;
    }
    if (record.sourceAddress && record.sourceAddress !== sourceAddress) {
      this.audit({
        action: "deny",
        credentialId: record.id,
        tenantId: record.tenantId,
        executionId: record.executionId,
        success: false,
        reason: "source_scope",
      });
      return false;
    }
    record.sourceAddress ??= sourceAddress;
    this.audit({
      action: "authenticate",
      credentialId: record.id,
      tenantId: record.tenantId,
      executionId: record.executionId,
      success: true,
    });
    return true;
  }

  revoke(id: string): boolean {
    const tokenHash = this.tokenHashById.get(id);
    const record = tokenHash ? this.byTokenHash.get(tokenHash) : undefined;
    if (tokenHash) this.byTokenHash.delete(tokenHash);
    const deleted = this.tokenHashById.delete(id);
    this.audit({
      action: "revoke",
      credentialId: id,
      ...(record ? { tenantId: record.tenantId, executionId: record.executionId } : {}),
      success: deleted,
      ...(!deleted ? { reason: "unknown" } : {}),
    });
    return deleted;
  }

  private purgeExpired(): void {
    const now = this.now();
    for (const [tokenHash, record] of this.byTokenHash) {
      if (record.expiresAt > now) continue;
      this.byTokenHash.delete(tokenHash);
      this.tokenHashById.delete(record.id);
    }
  }

  private audit(
    event: Parameters<NonNullable<NetworkProxyCredentialAuthorityOptions["onAudit"]>>[0],
  ): void {
    void Promise.resolve(this.options.onAudit?.(event)).catch(() => undefined);
  }
}

export interface NetworkProxyCredentialClientOptions {
  broker: CredentialBroker;
  credentialId: string;
  /** TLS control-plane endpoint. Runner traffic continues to use the request's proxyUrl. */
  controlUrl?: string;
  requestTimeoutMs?: number;
  /** Test-runner seam only. */
  fetch?: typeof fetch;
}

/** Trusted control-plane client for issuing a per-execution proxy capability. */
export class NetworkProxyCredentialClient implements ScopedProxyCredentialIssuer {
  private readonly doFetch: typeof fetch;

  constructor(private readonly options: NetworkProxyCredentialClientOptions) {
    if (options.fetch && !process.env.NODE_TEST_CONTEXT) {
      throw new Error("Proxy credential custom fetch is restricted to the Node test runner");
    }
    this.doFetch = options.fetch ?? fetch;
  }

  async issue(request: ScopedProxyCredentialRequest): Promise<ScopedProxyCredentialLease> {
    const proxyUrl = new URL(request.proxyUrl);
    if (
      !/^https?:$/.test(proxyUrl.protocol) ||
      proxyUrl.username ||
      proxyUrl.password ||
      proxyUrl.search ||
      proxyUrl.hash ||
      !["", "/"].includes(proxyUrl.pathname)
    ) {
      throw new Error("Egress proxy URL must be credential-free HTTP(S)");
    }
    const credentialFreeProxyUrl = new URL(proxyUrl);
    const tenantId = proxyScopeValue(request.tenantId, "tenantId");
    const executionId = proxyScopeValue(request.executionId, "executionId");
    const response = await this.controlRequest(
      proxyUrl,
      "issue",
      {
        method: "POST",
        body: JSON.stringify({ tenantId, executionId, ttlMs: request.ttlMs }),
      },
      request.signal,
    );
    const payload = (await response.json()) as Partial<{
      id: string;
      principal: string;
      token: string;
      expiresAt: string;
    }>;
    if (
      !payload.id?.startsWith("pc_") ||
      !payload.principal ||
      !payload.token ||
      payload.token.length < 32 ||
      !payload.expiresAt ||
      !Number.isFinite(Date.parse(payload.expiresAt))
    ) {
      throw new Error("Egress proxy returned an invalid scoped credential");
    }
    proxyUrl.username = payload.principal;
    proxyUrl.password = payload.token;
    const authenticatedUrl = proxyUrl.toString();
    let revoked = false;
    const redact = (value: string) =>
      redactScopedProxyCredential(value, payload.principal!, payload.token!, authenticatedUrl);
    return {
      proxyUrl: authenticatedUrl,
      expiresAt: payload.expiresAt,
      redact,
      revoke: async () => {
        if (revoked) return;
        try {
          await this.controlRequest(credentialFreeProxyUrl, "revoke", {
            method: "DELETE",
            body: JSON.stringify({ id: payload.id }),
          });
          revoked = true;
        } catch (error) {
          throw redactedError(error, redact);
        }
      },
    };
  }

  private async controlRequest(
    proxyUrl: URL,
    tool: "issue" | "revoke",
    init: RequestInit,
    signal?: AbortSignal,
  ): Promise<Response> {
    const controlUrl = new URL(this.options.controlUrl ?? proxyUrl);
    if (
      !/^https?:$/.test(controlUrl.protocol) ||
      controlUrl.username ||
      controlUrl.password ||
      controlUrl.search ||
      controlUrl.hash ||
      !["", "/"].includes(controlUrl.pathname)
    ) {
      throw new Error("Egress proxy control URL must be a credential-free HTTP(S) origin");
    }
    if (controlUrl.protocol !== "https:" && !proxyControlLoopback(controlUrl.hostname)) {
      throw new Error("Non-loopback egress proxy control URLs must use HTTPS");
    }
    const endpoint = new URL(PROXY_CREDENTIAL_CONTROL_PATH, controlUrl);
    endpoint.username = "";
    endpoint.password = "";
    const lease = this.options.broker.lease({
      credentialId: this.options.credentialId,
      audience: "network-proxy-control",
      host: endpoint.hostname,
      tool,
      ttlMs: Math.min(30_000, Math.max(1_000, this.options.requestTimeoutMs ?? 10_000)),
      maxUses: 1,
    });
    const headers = this.options.broker.injectHeaders(lease, {
      "content-type": "application/json",
      accept: "application/json",
    });
    const timeout = AbortSignal.timeout(
      Math.min(30_000, Math.max(1_000, this.options.requestTimeoutMs ?? 10_000)),
    );
    try {
      const response = await this.doFetch(endpoint, {
        ...init,
        headers,
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error(`Egress proxy credential control HTTP ${response.status}`);
      }
      return response;
    } catch (error) {
      throw redactedError(error, (value) => this.options.broker.redact(value));
    }
  }
}

function proxyControlLoopback(hostname: string): boolean {
  const normalized = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (normalized === "localhost" || normalized === "::1") return true;
  const parsed = parseIpv4(normalized);
  return parsed ? inPrefix(parsed.value, ipv4Value("127.0.0.0"), 8, 32) : false;
}

export interface NetworkProxyServerOptions {
  proxy: NetworkProxy;
  host?: string;
  port?: number;
  maxRequestBytes?: number;
  maxResponseBytes?: number;
  requestTimeoutMs?: number;
  connectTimeoutMs?: number;
  maxTunnelDurationMs?: number;
  maxTunnelBytes?: number;
  maxConcurrentTunnels?: number;
  /** CONNECT 在此窗口内必须提交完整 TLS ClientHello。 */
  tlsClientHelloTimeoutMs?: number;
  /** ClientHello（含 TLS record framing）的硬上限；配置值也会封顶到 256 KiB。 */
  maxTlsClientHelloBytes?: number;
  /** Legacy runner credential; with credentialAuthority this becomes control-plane auth only. */
  clientToken?: string;
  /** Dynamic legacy/control credential provider, resolved on every authentication attempt. */
  clientTokenProvider?: () => Promise<string | undefined>;
  /** 启用后 clientToken/provider 只可签发/撤销，runner 必须使用 scope-bound capability。 */
  credentialAuthority?: NetworkProxyCredentialAuthority;
}

/**
 * 本地 HTTP/CONNECT 出口。普通 HTTP 请求复用 NetworkProxy.fetch 的完整策略；
 * CONNECT 在建 TCP 隧道前完成域名/端口/DNS/私网检查，并直接连接已授权 IP，避免二次解析。
 */
export class NetworkProxyServer {
  private server: http.Server | undefined;
  private bound: { host: string; port: number } | undefined;
  private activeTunnels = 0;
  private readonly tunnelClients = new Set<Duplex>();

  constructor(private readonly options: NetworkProxyServerOptions) {
    if (!options.clientToken && !options.clientTokenProvider) {
      throw new Error("Network proxy server requires a control/client credential");
    }
  }

  async listen(): Promise<string> {
    if (this.bound) return this.url();
    const host = this.options.host ?? "127.0.0.1";
    const server = http.createServer((request, response) => {
      const operation =
        this.options.credentialAuthority && this.isCredentialControlRequest(request)
          ? this.handleCredentialControl(request, response)
          : this.forwardHttp(request, response);
      void operation.catch((error) => {
        const status = proxyStatus(error);
        if (response.headersSent) {
          response.destroy(error instanceof Error ? error : new Error(String(error)));
          return;
        } else {
          response.writeHead(status, {
            "content-type": "text/plain",
            "cache-control": "no-store",
            ...(status === 407 ? { "proxy-authenticate": 'Basic realm="anicode"' } : {}),
          });
        }
        response.end(status === 407 ? "proxy authentication required" : "proxy request denied");
      });
    });
    server.on("connect", (request, socket, head) => {
      void this.forwardConnect(request, socket, head).catch((error) => {
        const status = proxyStatus(error);
        socket.end(
          `HTTP/1.1 ${status} ${status === 407 ? "Proxy Authentication Required" : "Bad Gateway"}\r\nContent-Type: text/plain\r\nConnection: close\r\n${
            status === 407 ? 'Proxy-Authenticate: Basic realm="anicode"\r\n' : ""
          }\r\nproxy connection denied`,
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
    // Upgraded CONNECT sockets are not closed by http.Server.close(). Tear them down first so
    // shutdown cannot hang until the tunnel duration limit expires.
    for (const client of this.tunnelClients) client.destroy();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }

  private isCredentialControlRequest(request: http.IncomingMessage): boolean {
    // Forward-proxy requests use absolute-form. The control API only accepts direct origin-form
    // requests so an allowlisted upstream can never impersonate it.
    if (!request.url?.startsWith("/")) return false;
    try {
      return (
        new URL(request.url, "http://proxy.invalid").pathname === PROXY_CREDENTIAL_CONTROL_PATH
      );
    } catch {
      return false;
    }
  }

  private async handleCredentialControl(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    const authority = this.options.credentialAuthority;
    if (!authority) throw proxyError(404, "not found");
    await this.authenticateControlPlane(request);
    if (request.method !== "POST" && request.method !== "DELETE") {
      throw proxyError(405, "method not allowed");
    }
    const body = await readIncomingJson(request, 16 * 1024);
    if (request.method === "POST") {
      const input = body as Partial<{ tenantId: string; executionId: string; ttlMs: number }>;
      if (
        typeof input.tenantId !== "string" ||
        typeof input.executionId !== "string" ||
        !Number.isFinite(input.ttlMs)
      ) {
        throw proxyError(400, "invalid credential request");
      }
      const issued = authority.issue({
        tenantId: input.tenantId,
        executionId: input.executionId,
        ttlMs: input.ttlMs!,
      });
      response.writeHead(201, {
        "content-type": "application/json",
        "cache-control": "no-store",
        pragma: "no-cache",
      });
      response.end(JSON.stringify(issued));
      return;
    }
    const input = body as Partial<{ id: string }>;
    if (typeof input.id !== "string" || !/^pc_[0-9a-f-]{36}$/.test(input.id)) {
      throw proxyError(400, "invalid credential id");
    }
    // Idempotent from the control plane's perspective: an already-expired capability is revoked.
    authority.revoke(input.id);
    response.writeHead(204, { "cache-control": "no-store" });
    response.end();
  }

  private async authenticateControlPlane(request: http.IncomingMessage): Promise<void> {
    const expected = this.options.clientTokenProvider
      ? await this.options.clientTokenProvider()
      : this.options.clientToken;
    if (!expected) throw proxyError(503, "proxy control credential is unavailable");
    const header = request.headers.authorization;
    const value = Array.isArray(header) ? header[0] : header;
    const actual = value?.startsWith("Bearer ") ? value.slice(7).trim() : "";
    if (!constantTimeEqual(actual, expected))
      throw proxyError(401, "control authentication denied");
  }

  private async forwardHttp(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    await this.authenticateClient(request);
    const target = new URL(request.url ?? "", `http://${request.headers.host ?? ""}`);
    const limit = Math.max(1_024, this.options.maxRequestBytes ?? 8 * 1024 * 1024);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += value.byteLength;
      if (size > limit) throw proxyError(413, `proxy request body exceeds ${limit} bytes`);
      chunks.push(value);
    }
    const headers = new Headers();
    const connectionHeaders = headerTokens(request.headers.connection);
    for (const [name, value] of Object.entries(request.headers)) {
      if (value === undefined || hopByHopRequestHeader(name, connectionHeaders)) continue;
      headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    }
    const lease = headers.get("x-anicode-credential-lease") ?? undefined;
    headers.delete("x-anicode-credential-lease");
    const controller = new AbortController();
    let completed = false;
    let upstream: Response | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const abort = (reason: string) => {
      if (!controller.signal.aborted) controller.abort(new Error(reason));
    };
    const onRequestAborted = () => abort("proxy client aborted request");
    const onResponseClosed = () => {
      if (!completed) abort("proxy client disconnected");
    };
    request.once("aborted", onRequestAborted);
    response.once("close", onResponseClosed);
    const timer = setTimeout(
      () => abort("proxy request timed out"),
      Math.max(1_000, this.options.requestTimeoutMs ?? 120_000),
    );
    try {
      upstream = await this.options.proxy.fetch(target, {
        ...(request.method ? { method: request.method } : {}),
        headers,
        ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
        ...(lease ? { credentialLease: lease } : {}),
        signal: controller.signal,
      });
      const outgoing: Record<string, string> = {};
      const upstreamConnectionHeaders = headerTokens(upstream.headers.get("connection"));
      upstream.headers.forEach((value, name) => {
        if (
          !hopByHopResponseHeader(name, upstreamConnectionHeaders) &&
          !decodedRepresentationHeader(name)
        ) {
          outgoing[name] = value;
        }
      });
      const responseLimit = Math.max(1_024, this.options.maxResponseBytes ?? 32 * 1024 * 1024);
      const declaredLength = Number(upstream.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > responseLimit) {
        await upstream.body?.cancel("proxy response size limit exceeded");
        throw proxyError(502, `proxy response body exceeds ${responseLimit} bytes`);
      }
      response.writeHead(upstream.status, outgoing);
      reader = upstream.body?.getReader();
      if (!reader) {
        completed = true;
        response.end();
        return;
      }
      let received = 0;
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        received += chunk.value.byteLength;
        if (received > responseLimit) {
          await reader.cancel("proxy response size limit exceeded");
          throw new Error(`proxy response body exceeds ${responseLimit} bytes`);
        }
        if (!response.write(Buffer.from(chunk.value))) {
          await waitForDrain(response, controller.signal);
        }
      }
      completed = true;
      response.end();
    } finally {
      clearTimeout(timer);
      request.off("aborted", onRequestAborted);
      response.off("close", onResponseClosed);
      if (!completed) await reader?.cancel("proxy client disconnected").catch(() => undefined);
    }
  }

  private async forwardConnect(
    request: http.IncomingMessage,
    client: Duplex,
    head: Buffer,
  ): Promise<void> {
    await this.authenticateClient(request);
    const maximum = Math.max(1, this.options.maxConcurrentTunnels ?? 128);
    if (this.activeTunnels >= maximum) throw proxyError(429, "proxy tunnel concurrency exceeded");
    this.activeTunnels++;
    this.tunnelClients.add(client);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.activeTunnels--;
      this.tunnelClients.delete(client);
    };
    let accepted = false;
    let upstream: net.Socket | undefined;
    try {
      const { hostname, port } = parseConnectAuthority(request.url ?? "");
      if (isIP(hostname)) {
        throw new Error("CONNECT target must be a DNS name so TLS SNI can be enforced");
      }
      const authorized = await this.options.proxy.authorize(`https://${hostname}:${port}/`);
      client.write("HTTP/1.1 200 Connection Established\r\nProxy-Agent: anicode\r\n\r\n");
      accepted = true;
      const maximumHelloBytes = Math.min(
        256 * 1024,
        Math.max(1_024, this.options.maxTlsClientHelloBytes ?? 64 * 1024),
      );
      const hello = await receiveTlsClientHello(
        client,
        head,
        maximumHelloBytes,
        Math.min(
          30_000,
          Math.max(
            250,
            this.options.tlsClientHelloTimeoutMs ?? this.options.connectTimeoutMs ?? 10_000,
          ),
        ),
      );
      const expectedServerName = normalizeServerName(authorized.url.hostname);
      if (hello.encryptedClientHello) {
        throw new Error("CONNECT encrypted ClientHello is denied because SNI cannot be enforced");
      }
      if (!hello.serverName || normalizeServerName(hello.serverName) !== expectedServerName) {
        throw new Error("CONNECT TLS SNI must exactly match the authorized authority");
      }

      const pendingUpstream = net.connect({ host: authorized.addresses[0]!, port });
      upstream = pendingUpstream;
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(
          () => fail(new Error("proxy CONNECT timeout")),
          Math.max(1_000, this.options.connectTimeoutMs ?? 10_000),
        );
        const cleanup = () => {
          clearTimeout(timer);
          pendingUpstream.off("connect", onConnect);
          pendingUpstream.off("error", onUpstreamError);
          client.off("close", onClientClose);
          client.off("error", onClientError);
        };
        const finish = () => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve();
        };
        const fail = (error: Error) => {
          if (settled) return;
          settled = true;
          cleanup();
          pendingUpstream.destroy();
          reject(error);
        };
        const onConnect = () => finish();
        const onUpstreamError = () => fail(new Error("proxy upstream connection failed"));
        const onClientClose = () => fail(new Error("proxy client disconnected"));
        const onClientError = () => fail(new Error("proxy client disconnected"));
        pendingUpstream.once("connect", onConnect);
        pendingUpstream.once("error", onUpstreamError);
        client.once("close", onClientClose);
        client.once("error", onClientError);
      });
      if (client.destroyed) throw new Error("proxy client disconnected");
      const maximumBytes = Math.max(1_024, this.options.maxTunnelBytes ?? 256 * 1024 * 1024);
      if (hello.bytes.byteLength > maximumBytes) {
        throw new Error("proxy tunnel byte limit exceeded by TLS ClientHello");
      }
      let transferred = hello.bytes.byteLength;
      let tornDown = false;
      let duration: NodeJS.Timeout | undefined;
      const teardown = () => {
        if (tornDown) return;
        tornDown = true;
        if (duration) clearTimeout(duration);
        if (!pendingUpstream.destroyed) pendingUpstream.destroy();
        if (!client.destroyed) client.destroy();
        release();
      };
      const count = (chunk: Buffer) => {
        transferred += chunk.byteLength;
        if (transferred > maximumBytes) teardown();
      };
      duration = setTimeout(
        teardown,
        Math.max(1_000, this.options.maxTunnelDurationMs ?? 10 * 60_000),
      );
      pendingUpstream.on("data", count);
      client.on("data", count);
      pendingUpstream.once("error", teardown);
      client.once("error", teardown);
      pendingUpstream.once("close", teardown);
      client.once("close", teardown);
      pendingUpstream.write(hello.bytes);
      pendingUpstream.pipe(client);
      client.pipe(pendingUpstream);
      client.resume();
    } catch (error) {
      upstream?.destroy();
      // After the 200 response the connection is a tunnel, so never append a second HTTP response.
      // Closing is the only unambiguous fail-closed signal for malformed/mismatched ClientHello.
      if (accepted) {
        client.destroy();
        release();
        return;
      }
      release();
      throw error;
    }
  }

  private async authenticateClient(request: http.IncomingMessage): Promise<void> {
    const header = request.headers["proxy-authorization"];
    const value = Array.isArray(header) ? header[0] : header;
    let principal = "";
    let actual = "";
    if (value?.startsWith("Bearer ")) actual = value.slice(7).trim();
    else if (value?.startsWith("Basic ")) {
      const decoded = Buffer.from(value.slice(6), "base64").toString("utf8");
      const separator = decoded.indexOf(":");
      if (separator >= 0) {
        principal = decoded.slice(0, separator);
        actual = decoded.slice(separator + 1);
      }
    }
    if (this.options.credentialAuthority) {
      if (
        !this.options.credentialAuthority.authenticate({
          principal,
          token: actual,
          ...(request.socket.remoteAddress ? { sourceAddress: request.socket.remoteAddress } : {}),
        })
      ) {
        throw proxyError(407, "proxy authentication required");
      }
      return;
    }
    const expected = this.options.clientTokenProvider
      ? await this.options.clientTokenProvider()
      : this.options.clientToken;
    if (!expected) throw proxyError(503, "proxy client credential is unavailable");
    if (!constantTimeEqual(actual, expected)) {
      throw proxyError(407, "proxy authentication required");
    }
  }
}

function proxyScopeValue(value: string, label: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/.test(normalized)) {
    throw new Error(`Invalid proxy credential ${label}`);
  }
  return normalized;
}

function proxyTokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function normalizeProxySourceAddress(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.startsWith("::ffff:") ? value.slice(7) : value;
}

function constantTimeEqual(actual: string, expected: string): boolean {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function redactScopedProxyCredential(
  value: string,
  principal: string,
  token: string,
  authenticatedUrl: string,
): string {
  const variants = [
    authenticatedUrl,
    decodeURIComponent(authenticatedUrl),
    token,
    encodeURIComponent(token),
    Buffer.from(token).toString("base64"),
    Buffer.from(authenticatedUrl).toString("base64"),
    Buffer.from(`${principal}:${token}`).toString("base64"),
  ]
    .filter((candidate) => candidate.length >= 4)
    .sort((left, right) => right.length - left.length);
  let redacted = value;
  for (const secret of variants) redacted = redacted.split(secret).join("[REDACTED]");
  return redacted
    .replace(/(proxy-authorization\s*:\s*(?:bearer|basic)\s+)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[REDACTED]@");
}

function redactedError(error: unknown, redact: (value: string) => string): Error {
  const message = redact(error instanceof Error ? error.message : String(error));
  return Object.assign(new Error(message), {
    ...(error instanceof Error && error.name !== "Error" ? { name: error.name } : {}),
  });
}

async function readIncomingJson(request: http.IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += value.byteLength;
    if (size > limit) throw proxyError(413, "credential request too large");
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw proxyError(400, "invalid credential request");
  }
}

function proxyError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

function proxyStatus(error: unknown): number {
  const status = Number((error as { status?: unknown }).status);
  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : 502;
}

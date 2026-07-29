/** Kubernetes/容器专用受控出口代理 launcher。 */

import { NetworkProxy, NetworkProxyServer } from "./network-proxy.js";

function csv(value: string | undefined, fallback: string[]): string[] {
  const parsed = value
    ?.split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return parsed?.length ? parsed : fallback;
}

const proxy = new NetworkProxy({
  policy: {
    // 生产出口默认 deny-all；部署必须明确列出域名，不能靠“所有公网均可达”。
    allowDomains: csv(process.env.ANICODE_NETWORK_ALLOW_DOMAINS, []),
    denyDomains: csv(process.env.ANICODE_NETWORK_DENY_DOMAINS, []),
    allowPorts: csv(process.env.ANICODE_NETWORK_ALLOW_PORTS, ["80", "443"]).map(Number),
    allowPrivateAddresses: process.env.ANICODE_NETWORK_ALLOW_PRIVATE === "1",
  },
  onAudit: (event) => console.error(JSON.stringify({ kind: "network.audit", ...event })),
});
const server = new NetworkProxyServer({
  proxy,
  host: process.env.HOST ?? "0.0.0.0",
  port: Number(process.env.PORT ?? 8080),
});
const endpoint = await server.listen();
console.error(`AniCode egress proxy listening on ${endpoint}`);
const shutdown = async () => {
  await server.close();
  await proxy.close();
  process.exit(0);
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

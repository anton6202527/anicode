import { isIP } from "node:net";

/**
 * Local providers are a deliberate exception to the normal egress proxy so they can reach
 * Ollama/CLIProxy-style services on the developer machine. Keep that exception narrower than
 * the user-controlled base URL: only HTTP(S), no URL credentials, and a literal loopback host.
 * URL parsing also canonicalizes alternate IPv4 spellings before this check.
 */
export function isLoopbackProviderURL(value: string | URL): boolean {
  try {
    const url = value instanceof URL ? value : new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    if (url.username || url.password) return false;

    const hostname = url.hostname
      .toLowerCase()
      .replace(/^\[|\]$/g, "")
      .replace(/\.$/, "");
    if (hostname === "localhost") return true;

    const version = isIP(hostname);
    if (version === 4) return hostname.split(".")[0] === "127";
    return version === 6 && hostname === "::1";
  } catch {
    return false;
  }
}

/** Build the fixed discovery URL only after validating the local-provider trust boundary. */
export function localProviderModelsURL(baseURL: string): URL | undefined {
  if (!isLoopbackProviderURL(baseURL)) return undefined;
  return providerModelsURL(baseURL);
}

/** Build the fixed OpenAI-compatible discovery URL for a validated provider base URL. */
export function providerModelsURL(baseURL: string): URL | undefined {
  let root: URL;
  try {
    root = new URL(baseURL);
  } catch {
    return undefined;
  }
  if ((root.protocol !== "http:" && root.protocol !== "https:") || root.username || root.password) {
    return undefined;
  }
  root.search = "";
  root.hash = "";
  if (!root.pathname.endsWith("/")) root.pathname += "/";
  return new URL("models", root);
}

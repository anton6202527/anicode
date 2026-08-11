export interface SupabaseKeySources {
  /** Hosted Edge Functions expose named keys as a JSON object. */
  named?: string;
  /** Local Supabase CLI compatibility exposes a single key. */
  single?: string;
  /** Legacy anon/service-role key retained during project migration. */
  legacy?: string;
}

/** Resolve a Supabase API key without ever including key material in an error. */
export function supabaseApiKey(
  sources: SupabaseKeySources,
  label: string,
): string {
  const named = sources.named?.trim();
  if (named) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(named);
    } catch {
      throw new Error(`Invalid server configuration: ${label} named keys`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`Invalid server configuration: ${label} named keys`);
    }
    const value = (parsed as Record<string, unknown>)["default"];
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(
        `Missing required server configuration: ${label} default key`,
      );
    }
    return value.trim();
  }

  const single = sources.single?.trim();
  if (single) return single;
  const legacy = sources.legacy?.trim();
  if (legacy) return legacy;
  throw new Error(`Missing required server configuration: ${label}`);
}

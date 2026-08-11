/** 增量 symbol/reference graph + lexical/semantic/graph 混合检索。 */

import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";

export interface IndexedSymbol {
  name: string;
  signature: string;
}

export interface IndexedCodeFile {
  path: string;
  size: number;
  mtimeMs: number;
  hash: string;
  symbols: IndexedSymbol[];
  identifiers: Record<string, number>;
  embedding?: number[];
}

export interface CodeIndexSnapshot {
  version: 2;
  root: string;
  updatedAt: string;
  files: Record<string, IndexedCodeFile>;
}

export interface HybridSearchHit {
  path: string;
  score: number;
  lexical: number;
  semantic: number;
  graph: number;
  symbols: IndexedSymbol[];
  references: string[];
}

export type CodeEmbedding = (texts: string[]) => Promise<number[][]>;

export interface IncrementalCodeIndexOptions {
  indexFile?: string;
  maxFiles?: number;
  maxFileBytes?: number;
  /** Maximum aggregate source bytes considered by one refresh. Undefined preserves legacy limits. */
  maxTotalSourceBytes?: number;
  /** Disable disk persistence for process-owned ephemeral indexes. Defaults to true. */
  persist?: boolean;
  embed?: CodeEmbedding;
  extractSymbols?: (file: string, content: string) => { name: string; sig: string }[];
}

const SOURCE_EXT = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".java",
]);
const SKIP = new Set([
  ".git",
  ".anicode",
  "node_modules",
  "dist",
  "out",
  "build",
  "release",
  "coverage",
  ".next",
  ".turbo",
  "vendor",
  "__pycache__",
]);
const IDENT = /[A-Za-z_$][\w$]*/g;
const INDEX_IO_CONCURRENCY = 32;

function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function terms(value: string): string[] {
  return (
    value
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .match(/[a-z_$][\w$]*|[\p{L}\p{N}_]+/gu) ?? []
  ).filter((term) => term.length > 1);
}

function frequencies(content: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const identifier of content.match(IDENT) ?? []) {
    const key = identifier.toLowerCase();
    counts[key] = Math.min(255, (counts[key] ?? 0) + 1);
  }
  return counts;
}

function cosine(a: number[] | undefined, b: number[] | undefined): number {
  if (!a || !b || a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    aa += a[i]! * a[i]!;
    bb += b[i]! * b[i]!;
  }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
}

async function walk(dir: string, root: string, out: string[], max: number): Promise<void> {
  if (out.length >= max) return;
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (out.length >= max) return;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && !SKIP.has(entry.name) && !entry.name.startsWith("."))
      await walk(full, root, out, max);
    else if (entry.isFile() && SOURCE_EXT.has(path.extname(entry.name))) out.push(full);
  }
}

export class IncrementalCodeIndex {
  private snapshot: CodeIndexSnapshot | undefined;
  private readonly indexFile: string;
  private readonly extract: NonNullable<IncrementalCodeIndexOptions["extractSymbols"]>;
  readonly stats = { parsed: 0, reused: 0, removed: 0 };

  constructor(
    readonly root: string,
    private readonly options: IncrementalCodeIndexOptions = {},
  ) {
    this.root = path.resolve(root);
    this.indexFile = options.indexFile ?? path.join(this.root, ".anicode", "code-index-v2.json");
    this.extract = options.extractSymbols ?? (() => []);
  }

  async refresh(): Promise<CodeIndexSnapshot> {
    this.stats.parsed = 0;
    this.stats.reused = 0;
    this.stats.removed = 0;
    const previous = await this.load();
    const paths: string[] = [];
    await walk(this.root, this.root, paths, this.options.maxFiles ?? 3_000);
    const files: Record<string, IndexedCodeFile> = {};
    const embeddings: { file: IndexedCodeFile; text: string }[] = [];
    const maxFileBytes = this.options.maxFileBytes ?? 256 * 1024;
    const maxTotalSourceBytes = this.options.maxTotalSourceBytes ?? Number.POSITIVE_INFINITY;
    const metadata = await mapConcurrent(paths, INDEX_IO_CONCURRENCY, async (absolute) => {
      try {
        const stat = await fs.stat(absolute);
        return { absolute, stat };
      } catch {
        // A file may disappear between readdir and stat; the next refresh will see the new tree.
        return null;
      }
    });
    const changed: Array<{ absolute: string; relative: string; size: number; mtimeMs: number }> =
      [];
    let totalSourceBytes = 0;
    for (const item of metadata) {
      if (!item || !item.stat.isFile() || item.stat.size > maxFileBytes) continue;
      if (totalSourceBytes + item.stat.size > maxTotalSourceBytes) break;
      totalSourceBytes += item.stat.size;
      const relative = path.relative(this.root, item.absolute);
      const cached = previous?.files[relative];
      if (cached && cached.size === item.stat.size && cached.mtimeMs === item.stat.mtimeMs) {
        files[relative] = cached;
        this.stats.reused++;
        continue;
      }
      changed.push({
        absolute: item.absolute,
        relative,
        size: item.stat.size,
        mtimeMs: item.stat.mtimeMs,
      });
    }
    const parsed = await mapConcurrent(changed, INDEX_IO_CONCURRENCY, async (candidate) => {
      try {
        const content = await fs.readFile(candidate.absolute, "utf8");
        const symbols = this.extract(candidate.relative, content).map((symbol) => ({
          name: symbol.name,
          signature: symbol.sig,
        }));
        const file: IndexedCodeFile = {
          path: candidate.relative,
          size: candidate.size,
          mtimeMs: candidate.mtimeMs,
          hash: hash(content),
          symbols,
          identifiers: frequencies(content),
        };
        return {
          file,
          text: `${candidate.relative}\n${symbols.map((symbol) => symbol.signature).join("\n")}`,
        };
      } catch {
        return null;
      }
    });
    for (const item of parsed) {
      if (!item) continue;
      files[item.file.path] = item.file;
      embeddings.push(item);
      this.stats.parsed++;
    }
    this.stats.removed = Object.keys(previous?.files ?? {}).filter((file) => !files[file]).length;
    if (this.options.embed && embeddings.length) {
      const vectors = await this.options.embed(embeddings.map((item) => item.text));
      for (let i = 0; i < embeddings.length; i++) {
        const vector = vectors[i];
        if (vector) embeddings[i]!.file.embedding = vector;
      }
    }
    if (previous && embeddings.length === 0 && this.stats.removed === 0) {
      this.snapshot = previous;
      return previous;
    }
    this.snapshot = {
      version: 2,
      root: this.root,
      updatedAt: new Date().toISOString(),
      files,
    };
    await this.save(this.snapshot);
    return this.snapshot;
  }

  async search(query: string, limit = 20): Promise<HybridSearchHit[]> {
    const snapshot = this.snapshot ?? (await this.refresh());
    const queryTerms = [...new Set(terms(query))];
    const queryVector = this.options.embed ? (await this.options.embed([query]))[0] : undefined;
    const definitions = new Map<string, string[]>();
    const identifierTotals = new Map<string, number>();
    for (const file of Object.values(snapshot.files)) {
      for (const symbol of file.symbols) {
        const key = symbol.name.toLowerCase();
        definitions.set(key, [...(definitions.get(key) ?? []), file.path]);
      }
      for (const [identifier, count] of Object.entries(file.identifiers)) {
        identifierTotals.set(identifier, (identifierTotals.get(identifier) ?? 0) + count);
      }
    }
    const queriedSymbols = [...definitions.keys()].filter((name) =>
      queryTerms.some((term) => name.includes(term)),
    );
    const ranked = Object.values(snapshot.files).map((file) => {
      const pathTerms = new Set(terms(file.path));
      const symbolTerms = new Set(file.symbols.flatMap((symbol) => terms(symbol.name)));
      let lexical = 0;
      let graph = 0;
      const references = new Set<string>();
      for (const term of queryTerms) {
        if (pathTerms.has(term)) lexical += 3;
        if (symbolTerms.has(term)) lexical += 5;
        lexical += Math.min(3, file.identifiers[term] ?? 0) * 0.6;
        if ((file.identifiers[term] ?? 0) > 0) {
          for (const target of definitions.get(term) ?? []) {
            if (target !== file.path) references.add(target);
          }
          if ((definitions.get(term)?.length ?? 0) > 0) graph += 2;
        }
      }
      for (const symbolName of queriedSymbols) {
        if ((file.identifiers[symbolName] ?? 0) === 0) continue;
        graph += 2;
        for (const target of definitions.get(symbolName) ?? []) {
          if (target !== file.path) references.add(target);
        }
      }
      // 命中定义文件时，把引用该符号的文件边反向计分。
      for (const symbol of file.symbols) {
        if (!queriedSymbols.includes(symbol.name.toLowerCase())) continue;
        for (const other of Object.values(snapshot.files)) {
          if (other.path !== file.path && (other.identifiers[symbol.name.toLowerCase()] ?? 0) > 0) {
            graph += 0.5;
            references.add(other.path);
          }
        }
      }
      const semantic = Math.max(0, cosine(queryVector, file.embedding));
      return {
        path: file.path,
        score: lexical + graph + semantic * 4,
        lexical,
        semantic,
        graph,
        symbols: file.symbols,
        references: [...references].slice(0, 8),
        // Query-independent fallback used when a natural-language query has no lexical/vector
        // hit. It approximates the old repo-map's global reference ranking while keeping the
        // normal relevant-query score untouched.
        fallbackScore: file.symbols.reduce(
          (sum, symbol) => sum + (identifierTotals.get(symbol.name.toLowerCase()) ?? 0),
          0,
        ),
      };
    });
    const matched = ranked.filter((hit) => hit.score > 0);
    const selected = matched.length > 0 ? matched : ranked;
    return selected
      .sort((a, b) =>
        matched.length > 0
          ? b.score - a.score || a.path.localeCompare(b.path)
          : b.fallbackScore - a.fallbackScore || a.path.localeCompare(b.path),
      )
      .slice(0, Math.max(1, limit))
      .map(({ fallbackScore: _fallbackScore, ...hit }) => hit);
  }

  async render(query: string, tokenBudget = 1_500): Promise<string> {
    const hits = await this.search(query, 100);
    if (!hits.length) return "";
    const maxChars = tokenBudget * 4;
    const lines = ['<repo-map mode="hybrid">'];
    let used = lines[0]!.length;
    let shown = 0;
    for (const hit of hits) {
      const block = [
        `${hit.path}: # score=${hit.score.toFixed(2)}`,
        ...hit.symbols.slice(0, 12).map((symbol) => `  ${symbol.signature}`),
        ...(hit.references.length ? [`  refs: ${hit.references.join(", ")}`] : []),
      ].join("\n");
      if (shown && used + block.length + 1 > maxChars) break;
      lines.push(block);
      used += block.length + 1;
      shown++;
    }
    if (shown < hits.length) lines.push(`… (+${hits.length - shown} more files)`);
    lines.push("</repo-map>");
    return lines.join("\n");
  }

  private async load(): Promise<CodeIndexSnapshot | undefined> {
    if (this.snapshot) return this.snapshot;
    if (this.options.persist === false) return undefined;
    try {
      const parsed = JSON.parse(await fs.readFile(this.indexFile, "utf8")) as CodeIndexSnapshot;
      if (parsed.version === 2 && parsed.root === this.root) return parsed;
    } catch {
      // 缓存损坏/不存在时全量重建；它不是事实源。
    }
    return undefined;
  }

  private async save(snapshot: CodeIndexSnapshot): Promise<void> {
    if (this.options.persist === false) return;
    await fs.mkdir(path.dirname(this.indexFile), { recursive: true, mode: 0o700 });
    const temporary = `${this.indexFile}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(snapshot) + "\n", { mode: 0o600 });
      await fs.rename(temporary, this.indexFile);
      await fs.chmod(this.indexFile, 0o600);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async (): Promise<void> => {
      while (true) {
        const index = cursor++;
        if (index >= values.length) return;
        results[index] = await mapper(values[index]!);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

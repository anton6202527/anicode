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
    for (const absolute of paths) {
      const stat = await fs.stat(absolute);
      if (stat.size > (this.options.maxFileBytes ?? 256 * 1024)) continue;
      const relative = path.relative(this.root, absolute);
      const cached = previous?.files[relative];
      if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
        files[relative] = cached;
        this.stats.reused++;
        continue;
      }
      const content = await fs.readFile(absolute, "utf8");
      const symbols = this.extract(relative, content).map((symbol) => ({
        name: symbol.name,
        signature: symbol.sig,
      }));
      const indexed: IndexedCodeFile = {
        path: relative,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        hash: hash(content),
        symbols,
        identifiers: frequencies(content),
      };
      files[relative] = indexed;
      embeddings.push({
        file: indexed,
        text: `${relative}\n${symbols.map((symbol) => symbol.signature).join("\n")}`,
      });
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
    for (const file of Object.values(snapshot.files)) {
      for (const symbol of file.symbols) {
        const key = symbol.name.toLowerCase();
        definitions.set(key, [...(definitions.get(key) ?? []), file.path]);
      }
    }
    const queriedSymbols = [...definitions.keys()].filter((name) =>
      queryTerms.some((term) => name.includes(term)),
    );
    return Object.values(snapshot.files)
      .map((file) => {
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
            if (
              other.path !== file.path &&
              (other.identifiers[symbol.name.toLowerCase()] ?? 0) > 0
            ) {
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
        };
      })
      .filter((hit) => hit.score > 0 || queryTerms.length === 0)
      .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
      .slice(0, Math.max(1, limit));
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
    try {
      const parsed = JSON.parse(await fs.readFile(this.indexFile, "utf8")) as CodeIndexSnapshot;
      if (parsed.version === 2 && parsed.root === this.root) return parsed;
    } catch {
      // 缓存损坏/不存在时全量重建；它不是事实源。
    }
    return undefined;
  }

  private async save(snapshot: CodeIndexSnapshot): Promise<void> {
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

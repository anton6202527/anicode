/** Tree-sitter AST + LSP 类型信息 + 向量库的增量跨语言代码图。 */

import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, promises as fs, realpathSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Lang, parse, registerDynamicLanguage, type SgNode } from "@ast-grep/napi";
import python from "@ast-grep/lang-python";
import go from "@ast-grep/lang-go";
import rust from "@ast-grep/lang-rust";
import java from "@ast-grep/lang-java";
import type { LspPool, LspSymbol } from "../lsp.js";
import { SqliteVectorStore, localCodeEmbedding, type VectorStore } from "./vector-store.js";

let dynamicRegistered = false;
function ensureLanguages(): void {
  if (dynamicRegistered) return;
  registerDynamicLanguage({ python, go, rust, java });
  dynamicRegistered = true;
}

export type CodeLanguage = "javascript" | "typescript" | "tsx" | "python" | "go" | "rust" | "java";

export interface CodeRange {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

export interface TypedCodeSymbol {
  id: string;
  name: string;
  kind: string;
  language: CodeLanguage;
  path: string;
  range: CodeRange;
  signature: string;
  exported: boolean;
  container?: string;
  source: "tree-sitter" | "tree-sitter+lsp" | "lsp";
}

export interface TypedCodeReference {
  id: string;
  name: string;
  path: string;
  range: CodeRange;
  fromSymbolId?: string;
  targetSymbolIds: string[];
  kind: CodeReferenceKind;
  resolution: "tree-sitter" | "lsp" | "unresolved";
}

export type CodeReferenceKind = "call" | "import" | "type" | "inheritance" | "reference";

export interface TypedCodeFile {
  path: string;
  language: CodeLanguage;
  size: number;
  mtimeMs: number;
  mtimeNs: string;
  ctimeNs: string;
  inode: string;
  hash: string;
  symbols: TypedCodeSymbol[];
  references: TypedCodeReference[];
}

export interface TypedCodeGraphSnapshot {
  version: 4;
  root: string;
  updatedAt: string;
  files: Record<string, TypedCodeFile>;
}

export interface TypedGraphSearchHit {
  path: string;
  score: number;
  lexical: number;
  graph: number;
  semantic: number;
  symbols: TypedCodeSymbol[];
  relatedPaths: string[];
}

export interface TypedCodeGraphOptions {
  /** Trusted host-owned cache directory. Defaults to a private per-process runtime directory. */
  cacheDirectory?: string;
  indexFile?: string;
  vectorStore?: VectorStore;
  vectorFile?: string;
  lspPool?: LspPool;
  maxFiles?: number;
  maxFileBytes?: number;
  embedding?: (texts: string[]) => Promise<number[][]>;
  embeddingDimensions?: number;
  maxLspSymbolsPerFile?: number;
  maxLspReferencesPerFile?: number;
  maxLspInvalidatedFiles?: number;
  embeddingBatchSize?: number;
  /** Maximum serialized JSON index size. Defaults to 64 MiB. */
  maxCacheBytes?: number;
  /** Maximum aggregate source bytes processed by one refresh. Defaults to 256 MiB. */
  maxTotalSourceBytes?: number;
}

const MAX_GRAPH_FILES = 5_000;
const MAX_EMBEDDING_DIMENSIONS = 4_096;
const MAX_VECTOR_CONTENT_BYTES = 64 * 1024;
let privateCacheRoot: string | undefined;

function runtimeCacheRoot(): string {
  if (privateCacheRoot) return privateCacheRoot;
  const created = mkdtempSync(path.join(realpathSync(os.tmpdir()), "anicode-repomap-"));
  chmodSync(created, 0o700);
  privateCacheRoot = created;
  process.once("exit", () => {
    try {
      rmSync(created, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup only; the directory is private and contains derived data.
    }
  });
  return created;
}

function pathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}

function boundedPositive(value: number | undefined, fallback: number, maximum: number): number {
  if (!Number.isFinite(value) || value === undefined) return fallback;
  return Math.max(1, Math.min(maximum, Math.floor(value)));
}

function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return value;
  return bytes
    .subarray(0, maxBytes)
    .toString("utf8")
    .replace(/\uFFFD$/u, "");
}

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

const DEFINITION_KINDS = new Set([
  "function_declaration",
  "function_definition",
  "method_definition",
  "method_declaration",
  "method_definition",
  "method_declaration",
  "class_declaration",
  "class_definition",
  "interface_declaration",
  "type_alias_declaration",
  "enum_declaration",
  "struct_item",
  "enum_item",
  "trait_item",
  "function_item",
  "impl_item",
  "type_declaration",
  "const_item",
  "static_item",
]);

const REFERENCE_KINDS = new Set([
  "identifier",
  "type_identifier",
  "field_identifier",
  "property_identifier",
  "shorthand_property_identifier_pattern",
]);

function languageFor(file: string): { language: CodeLanguage; parser: Lang | string } | undefined {
  const ext = path.extname(file).toLowerCase();
  if ([".js", ".jsx", ".mjs", ".cjs"].includes(ext)) {
    return ext === ".jsx"
      ? { language: "tsx", parser: Lang.Tsx }
      : { language: "javascript", parser: Lang.JavaScript };
  }
  if (ext === ".ts") return { language: "typescript", parser: Lang.TypeScript };
  if (ext === ".tsx") return { language: "tsx", parser: Lang.Tsx };
  if (ext === ".py") return { language: "python", parser: "python" };
  if (ext === ".go") return { language: "go", parser: "go" };
  if (ext === ".rs") return { language: "rust", parser: "rust" };
  if (ext === ".java") return { language: "java", parser: "java" };
  return undefined;
}

function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function rangeOf(node: SgNode): CodeRange {
  const range = node.range();
  return {
    startLine: range.start.line + 1,
    startColumn: range.start.column + 1,
    endLine: range.end.line + 1,
    endColumn: range.end.column + 1,
  };
}

function nodeName(node: SgNode): SgNode | undefined {
  const field = (node as unknown as { field(name: string): SgNode | null }).field("name");
  if (field) return field;
  return node.children().find((child) => REFERENCE_KINDS.has(String(child.kind())));
}

function symbolKind(nodeKind: string): string {
  if (nodeKind.includes("method")) return "method";
  if (nodeKind.includes("function")) return "function";
  if (nodeKind.includes("class")) return "class";
  if (nodeKind.includes("interface") || nodeKind.includes("trait")) return "interface";
  if (nodeKind.includes("enum")) return "enum";
  if (nodeKind.includes("struct")) return "struct";
  if (nodeKind.includes("type")) return "type";
  if (nodeKind.includes("const")) return "constant";
  if (nodeKind.includes("static")) return "static";
  return nodeKind;
}

function signature(node: SgNode): string {
  const text = node.text().split(/\r?\n/, 1)[0]!.trim().replace(/\s+/g, " ");
  return text.slice(0, 240);
}

function symbolId(file: string, name: string, range: CodeRange): string {
  return `sym_${createHash("sha256")
    .update(`${file}\0${name}\0${range.startLine}\0${range.startColumn}`)
    .digest("hex")
    .slice(0, 24)}`;
}

function referenceKind(node: SgNode): CodeReferenceKind {
  const ancestors = node.ancestors().slice(0, 8);
  const kinds = ancestors.map((ancestor) => String(ancestor.kind()));
  if (
    kinds.some((kind) =>
      /(?:import|use_declaration|use_list|extern_crate|package_clause)/.test(kind),
    )
  ) {
    return "import";
  }
  if (kinds.some((kind) => /(?:extends|implements|superclass|trait_bounds)/.test(kind))) {
    return "inheritance";
  }
  if (
    kinds.some((kind) =>
      /(?:type_annotation|generic_type|type_arguments|type_parameter|return_type)/.test(kind),
    )
  ) {
    return "type";
  }
  const call = ancestors.find((ancestor) =>
    /^(?:call_expression|new_expression|object_creation_expression)$/.test(String(ancestor.kind())),
  );
  if (call) {
    const callee = (call as unknown as { field(name: string): SgNode | null }).field(
      String(call.kind()) === "new_expression" ? "constructor" : "function",
    );
    if (callee) {
      const target = node.range();
      const range = callee.range();
      if (target.start.index >= range.start.index && target.end.index <= range.end.index) {
        return "call";
      }
    }
  }
  return "reference";
}

function parseFile(relative: string, content: string): TypedCodeFile | undefined {
  const language = languageFor(relative);
  if (!language) return undefined;
  ensureLanguages();
  const root = parse(language.parser, content).root();
  const symbols: TypedCodeSymbol[] = [];
  const definitionNameNodes = new Set<number>();
  const definitionNodes = new Map<number, TypedCodeSymbol>();

  const visitDefinitions = (node: SgNode, container?: string): void => {
    let nextContainer = container;
    const kind = String(node.kind());
    if (DEFINITION_KINDS.has(kind)) {
      const nameNode = nodeName(node);
      const name = nameNode?.text().trim();
      if (name) {
        const range = rangeOf(nameNode ?? node);
        const prefix = node.text().slice(0, 80);
        const symbol: TypedCodeSymbol = {
          id: symbolId(relative, name, range),
          name,
          kind: symbolKind(kind),
          language: language.language,
          path: relative,
          range,
          signature: signature(node),
          exported: /\b(?:export|public|pub)\b/.test(prefix),
          ...(container ? { container } : {}),
          source: "tree-sitter",
        };
        symbols.push(symbol);
        definitionNodes.set(node.id(), symbol);
        if (nameNode) definitionNameNodes.add(nameNode.id());
        if (["class", "interface", "struct", "enum"].includes(symbol.kind)) nextContainer = name;
      }
    }
    for (const child of node.children()) visitDefinitions(child, nextContainer);
  };
  visitDefinitions(root);

  const references: TypedCodeReference[] = [];
  const visitReferences = (node: SgNode, owner?: TypedCodeSymbol): void => {
    const nextOwner = definitionNodes.get(node.id()) ?? owner;
    if (REFERENCE_KINDS.has(String(node.kind())) && !definitionNameNodes.has(node.id())) {
      const name = node.text().trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) {
        const range = rangeOf(node);
        references.push({
          id: `ref_${relative.replace(/[^A-Za-z0-9]/g, "_")}_${range.startLine}_${range.startColumn}`,
          name,
          path: relative,
          range,
          ...(nextOwner ? { fromSymbolId: nextOwner.id } : {}),
          targetSymbolIds: [],
          kind: referenceKind(node),
          resolution: "unresolved",
        });
      }
    }
    for (const child of node.children()) visitReferences(child, nextOwner);
  };
  visitReferences(root);
  return {
    path: relative,
    language: language.language,
    size: Buffer.byteLength(content),
    mtimeMs: 0,
    mtimeNs: "0",
    ctimeNs: "0",
    inode: "0:0",
    hash: hash(content),
    symbols,
    references,
  };
}

async function walk(dir: string, out: string[], max: number): Promise<void> {
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
    if (entry.isDirectory() && !SKIP.has(entry.name) && !entry.name.startsWith(".")) {
      await walk(full, out, max);
    } else if (entry.isFile() && languageFor(full)) out.push(full);
  }
}

export class TypedCodeGraph {
  private snapshot: TypedCodeGraphSnapshot | undefined;
  private readonly indexFile: string;
  private readonly vectors: VectorStore;
  private readonly ownsVectors: boolean;
  private readonly namespace: string;
  readonly stats = {
    parsed: 0,
    reused: 0,
    removed: 0,
    lspEnriched: 0,
    lspResolved: 0,
    lspInvalidated: 0,
  };

  constructor(
    readonly root: string,
    private readonly options: TypedCodeGraphOptions = {},
  ) {
    const requestedRoot = path.resolve(root);
    this.root = realpathSync(requestedRoot);
    const cacheDirectory = path.resolve(
      options.cacheDirectory ??
        path.join(
          runtimeCacheRoot(),
          createHash("sha256").update(this.root).digest("hex").slice(0, 32),
        ),
    );
    const requestedIndex = path.resolve(
      options.indexFile ?? path.join(cacheDirectory, "graph-v4.json"),
    );
    const requestedVectors = path.resolve(
      options.vectorFile ?? path.join(cacheDirectory, "vectors.db"),
    );
    if (
      (options.indexFile &&
        (pathInside(requestedRoot, requestedIndex) || pathInside(this.root, requestedIndex))) ||
      (options.vectorFile &&
        (pathInside(requestedRoot, requestedVectors) || pathInside(this.root, requestedVectors))) ||
      (options.cacheDirectory &&
        (pathInside(requestedRoot, cacheDirectory) || pathInside(this.root, cacheDirectory)))
    ) {
      throw new Error("Typed-code-graph caches must live outside the workspace");
    }
    this.indexFile = requestedIndex;
    this.vectors = options.vectorStore ?? new SqliteVectorStore(requestedVectors);
    this.ownsVectors = !options.vectorStore;
    this.namespace = `repo:${createHash("sha256").update(this.root).digest("hex").slice(0, 24)}`;
  }

  async refresh(): Promise<TypedCodeGraphSnapshot> {
    this.stats.parsed = 0;
    this.stats.reused = 0;
    this.stats.removed = 0;
    this.stats.lspEnriched = 0;
    this.stats.lspResolved = 0;
    this.stats.lspInvalidated = 0;
    const previous = await this.load();
    const paths: string[] = [];
    const maxFiles = boundedPositive(this.options.maxFiles, MAX_GRAPH_FILES, MAX_GRAPH_FILES);
    await walk(this.root, paths, maxFiles);
    const files: Record<string, TypedCodeFile> = {};
    const changed: TypedCodeFile[] = [];
    let totalSourceBytes = 0;
    for (const absolute of paths) {
      const canonical = await fs.realpath(absolute);
      if (!pathInside(this.root, canonical)) continue;
      const stat = await fs.stat(canonical, { bigint: true });
      if (!stat.isFile()) continue;
      const size = Number(stat.size);
      if (size > boundedPositive(this.options.maxFileBytes, 512 * 1024, 8 * 1024 * 1024)) continue;
      totalSourceBytes += size;
      if (
        totalSourceBytes >
        boundedPositive(this.options.maxTotalSourceBytes, 256 * 1024 * 1024, 1024 * 1024 * 1024)
      )
        break;
      const relative = path.relative(this.root, canonical);
      const cached = previous?.files[relative];
      const inode = `${stat.dev}:${stat.ino}`;
      const mtimeNs = stat.mtimeNs.toString();
      const ctimeNs = stat.ctimeNs.toString();
      if (
        cached &&
        cached.size === size &&
        cached.mtimeNs === mtimeNs &&
        cached.ctimeNs === ctimeNs &&
        cached.inode === inode
      ) {
        files[relative] = cached;
        this.stats.reused++;
        continue;
      }
      const content = await fs.readFile(canonical, "utf8");
      const parsed = parseFile(relative, content);
      if (!parsed) continue;
      parsed.size = size;
      parsed.mtimeMs = Number(stat.mtimeNs) / 1_000_000;
      parsed.mtimeNs = mtimeNs;
      parsed.ctimeNs = ctimeNs;
      parsed.inode = inode;
      await this.enrichWithLsp(canonical, parsed);
      files[relative] = parsed;
      changed.push(parsed);
      this.stats.parsed++;
    }
    const removedPaths = Object.keys(previous?.files ?? {}).filter((file) => !files[file]);
    this.stats.removed = removedPaths.length;
    const lspCandidates = this.invalidateDependentLspEdges(previous, files, changed, removedPaths);
    this.resolveReferences(files);
    await this.resolveReferencesWithLsp(lspCandidates, files);
    this.snapshot = {
      version: 4,
      root: this.root,
      updatedAt: new Date().toISOString(),
      files,
    };
    await this.updateVectors(changed, files);
    await this.save(this.snapshot);
    return this.snapshot;
  }

  private async enrichWithLsp(absolute: string, file: TypedCodeFile): Promise<void> {
    const client = this.options.lspPool?.clientFor(path.extname(absolute));
    if (!client) return;
    let lspSymbols: LspSymbol[];
    try {
      lspSymbols = await client.documentSymbols(absolute);
    } catch {
      return;
    }
    for (const value of lspSymbols.slice(0, this.options.maxLspSymbolsPerFile ?? 200)) {
      const existing = file.symbols.find(
        (symbol) =>
          symbol.name === value.name && Math.abs(symbol.range.startLine - value.line) <= 1,
      );
      if (existing) {
        existing.kind = value.kind;
        existing.source = "tree-sitter+lsp";
        if (value.container) existing.container = value.container;
      } else {
        const range: CodeRange = {
          startLine: value.line,
          startColumn: value.column,
          endLine: value.line,
          endColumn: value.column + value.name.length,
        };
        file.symbols.push({
          id: symbolId(file.path, value.name, range),
          name: value.name,
          kind: value.kind,
          language: file.language,
          path: file.path,
          range,
          signature: `${value.kind} ${value.name}`,
          exported: true,
          ...(value.container ? { container: value.container } : {}),
          source: "lsp",
        });
      }
      this.stats.lspEnriched++;
    }
  }

  private invalidateDependentLspEdges(
    previous: TypedCodeGraphSnapshot | undefined,
    files: Record<string, TypedCodeFile>,
    changed: TypedCodeFile[],
    removedPaths: string[],
  ): TypedCodeFile[] {
    if (!previous || !this.options.lspPool) return changed;
    const changedPaths = new Set([...changed.map((file) => file.path), ...removedPaths]);
    if (changedPaths.size === 0) return changed;
    const previousSymbolPaths = new Map<string, string>();
    const affectedNames = new Set<string>();
    for (const [filePath, file] of Object.entries(previous.files)) {
      for (const symbol of file.symbols) {
        previousSymbolPaths.set(symbol.id, filePath);
        if (changedPaths.has(filePath) && symbol.name.length > 2) {
          affectedNames.add(symbol.name.toLowerCase());
        }
      }
    }
    for (const file of changed) {
      for (const symbol of file.symbols) {
        if (symbol.name.length > 2) affectedNames.add(symbol.name.toLowerCase());
      }
    }
    const dependent: TypedCodeFile[] = [];
    for (const file of Object.values(files)) {
      if (changedPaths.has(file.path)) continue;
      let invalidated = false;
      for (const reference of file.references) {
        if (reference.resolution !== "lsp") continue;
        const pointsToChangedFile = reference.targetSymbolIds.some((id) =>
          changedPaths.has(previousSymbolPaths.get(id) ?? ""),
        );
        if (!pointsToChangedFile && !affectedNames.has(reference.name.toLowerCase())) continue;
        reference.targetSymbolIds = [];
        reference.resolution = "unresolved";
        invalidated = true;
      }
      if (invalidated) dependent.push(file);
    }
    this.stats.lspInvalidated = dependent.length;
    return [...changed, ...dependent.slice(0, this.options.maxLspInvalidatedFiles ?? 250)];
  }

  private resolveReferences(files: Record<string, TypedCodeFile>): void {
    const definitions = new Map<string, TypedCodeSymbol[]>();
    const validSymbolIds = new Set<string>();
    for (const file of Object.values(files)) {
      for (const symbol of file.symbols) {
        validSymbolIds.add(symbol.id);
        const key = symbol.name.toLowerCase();
        definitions.set(key, [...(definitions.get(key) ?? []), symbol]);
      }
    }
    for (const file of Object.values(files)) {
      for (const reference of file.references) {
        reference.targetSymbolIds = reference.targetSymbolIds.filter((id) =>
          validSymbolIds.has(id),
        );
        if (reference.resolution === "lsp" && reference.targetSymbolIds.length > 0) continue;
        const candidates = definitions.get(reference.name.toLowerCase()) ?? [];
        // 同文件定义优先，其次 exported；保留歧义边供后续 LSP/reranker 消解。
        candidates.sort(
          (a, b) =>
            Number(b.path === file.path) - Number(a.path === file.path) ||
            Number(b.exported) - Number(a.exported),
        );
        reference.targetSymbolIds = candidates.slice(0, 8).map((symbol) => symbol.id);
        reference.resolution = candidates.length ? "tree-sitter" : "unresolved";
      }
    }
  }

  private async resolveReferencesWithLsp(
    changed: TypedCodeFile[],
    files: Record<string, TypedCodeFile>,
  ): Promise<void> {
    if (!this.options.lspPool) return;
    const symbols = Object.values(files).flatMap((file) => file.symbols);
    const symbolAt = (
      absolute: string,
      line: number,
      column: number,
    ): TypedCodeSymbol | undefined => {
      let canonical: string;
      try {
        canonical = realpathSync(path.resolve(absolute));
      } catch {
        return undefined;
      }
      const relative = path.relative(this.root, canonical);
      if (relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
      const candidates = files[relative]?.symbols ?? [];
      const closest = candidates
        .map((symbol) => ({
          symbol,
          distance:
            Math.abs(symbol.range.startLine - line) * 1_000 +
            Math.abs(symbol.range.startColumn - column),
        }))
        .sort((a, b) => a.distance - b.distance)[0];
      return closest && closest.distance <= 2_000 ? closest.symbol : undefined;
    };
    for (const file of changed) {
      const client = this.options.lspPool.clientFor(path.extname(file.path));
      if (!client) continue;
      const absolute = path.join(this.root, file.path);
      for (const reference of file.references.slice(
        0,
        this.options.maxLspReferencesPerFile ?? 100,
      )) {
        try {
          const locations = await client.definition(absolute, {
            line: reference.range.startLine - 1,
            character: reference.range.startColumn - 1,
          });
          const targets = locations
            .map((location) => symbolAt(location.path, location.line, location.column))
            .filter((symbol): symbol is TypedCodeSymbol => Boolean(symbol));
          const ids = [...new Set(targets.map((symbol) => symbol.id))];
          if (ids.length > 0) {
            reference.targetSymbolIds = ids;
            reference.resolution = "lsp";
            this.stats.lspResolved++;
          }
        } catch {
          // 单个 definition 失败保留 Tree-sitter 名字解析，不拖垮全库索引。
        }
      }
    }
    // 防止 LSP 返回旧索引中的位置后形成悬空边。
    const validIds = new Set(symbols.map((symbol) => symbol.id));
    for (const file of Object.values(files)) {
      for (const reference of file.references) {
        reference.targetSymbolIds = reference.targetSymbolIds.filter((id) => validIds.has(id));
        if (reference.resolution === "lsp" && reference.targetSymbolIds.length === 0) {
          reference.resolution = "unresolved";
        }
      }
    }
  }

  private async updateVectors(
    changed: TypedCodeFile[],
    files: Record<string, TypedCodeFile>,
  ): Promise<void> {
    const texts = changed.map(
      (file) =>
        `${file.path}\n${file.symbols.map((symbol) => `${symbol.kind} ${symbol.signature}`).join("\n")}` +
        `\nreferences ${[...new Set(file.references.map((reference) => reference.name))].slice(0, 256).join(" ")}`,
    );
    const batchSize = this.options.embeddingBatchSize ?? 64;
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1_000) {
      throw new Error("embeddingBatchSize must be between 1 and 1000");
    }
    let dimensions = this.options.embeddingDimensions;
    for (let offset = 0; offset < changed.length; offset += batchSize) {
      const batchFiles = changed.slice(offset, offset + batchSize);
      const batchTexts = texts.slice(offset, offset + batchSize);
      const embeddings = this.options.embedding
        ? await this.options.embedding(batchTexts)
        : batchTexts.map((text) => localCodeEmbedding(text, dimensions ?? 384));
      if (embeddings.length !== batchFiles.length) {
        throw new Error("Embedding provider returned an unexpected batch size");
      }
      dimensions ??= embeddings[0]?.length;
      if (dimensions && dimensions > MAX_EMBEDDING_DIMENSIONS) {
        throw new Error(`Embedding dimensions exceed ${MAX_EMBEDDING_DIMENSIONS}`);
      }
      for (const embedding of embeddings) {
        if (
          !embedding ||
          embedding.length === 0 ||
          embedding.length !== dimensions ||
          embedding.some((value) => !Number.isFinite(value))
        ) {
          throw new Error("Embedding provider returned an invalid vector");
        }
      }
      await this.vectors.upsert(
        batchFiles.map((file, index) => ({
          namespace: this.namespace,
          id: file.path,
          embedding: embeddings[index]!,
          content: truncateUtf8(batchTexts[index]!, MAX_VECTOR_CONTENT_BYTES),
          metadata: { path: file.path, language: file.language, hash: file.hash },
        })),
      );
    }
    await this.vectors.deleteExcept(this.namespace, new Set(Object.keys(files)));
  }

  async search(query: string, limit = 20): Promise<TypedGraphSearchHit[]> {
    const snapshot = this.snapshot ?? (await this.refresh());
    const terms = [...new Set(query.toLowerCase().match(/[a-z_$][\w$]*|[\p{L}\p{N}_]+/gu) ?? [])];
    const queryVector = this.options.embedding
      ? (await this.options.embedding([query]))[0]
      : localCodeEmbedding(query, this.options.embeddingDimensions ?? 384);
    const vectorHits = queryVector
      ? await this.vectors.search(this.namespace, queryVector, Math.max(limit * 3, 30))
      : [];
    const semanticByPath = new Map(vectorHits.map((hit) => [hit.id, hit.score]));
    const symbols = Object.values(snapshot.files).flatMap((file) => file.symbols);
    const symbolById = new Map(symbols.map((symbol) => [symbol.id, symbol]));
    const incomingBySymbol = new Map<string, Set<string>>();
    for (const file of Object.values(snapshot.files)) {
      for (const reference of file.references) {
        for (const target of reference.targetSymbolIds) {
          const incoming = incomingBySymbol.get(target) ?? new Set<string>();
          incoming.add(file.path);
          incomingBySymbol.set(target, incoming);
        }
      }
    }
    return Object.values(snapshot.files)
      .map((file) => {
        let lexical = 0;
        let graph = 0;
        const related = new Set<string>();
        const pathTerms = file.path.toLowerCase();
        for (const term of terms) {
          if (pathTerms.includes(term)) lexical += 3;
          for (const symbol of file.symbols) {
            if (symbol.name.toLowerCase() === term) lexical += 8;
            else if (symbol.name.toLowerCase().includes(term)) lexical += 3;
          }
          for (const reference of file.references) {
            if (reference.name.toLowerCase() !== term) continue;
            graph +=
              reference.kind === "inheritance"
                ? 4
                : reference.kind === "call"
                  ? 3
                  : reference.kind === "type"
                    ? 2.5
                    : reference.kind === "import"
                      ? 2
                      : 1.5;
            for (const target of reference.targetSymbolIds) {
              const destination = symbolById.get(target)?.path;
              if (destination && destination !== file.path) related.add(destination);
            }
          }
        }
        for (const symbol of file.symbols) {
          const incoming = incomingBySymbol.get(symbol.id) ?? new Set<string>();
          for (const source of incoming) {
            if (source !== file.path) related.add(source);
          }
          if (terms.some((term) => symbol.name.toLowerCase().includes(term))) {
            graph += Math.min(6, incoming.size * 0.75);
          }
        }
        for (const reference of file.references) {
          for (const target of reference.targetSymbolIds) {
            const destination = symbolById.get(target)?.path;
            if (destination && destination !== file.path) related.add(destination);
          }
        }
        const semantic = Math.max(0, semanticByPath.get(file.path) ?? 0);
        return {
          path: file.path,
          score: lexical + graph + semantic * 6,
          lexical,
          graph,
          semantic,
          symbols: file.symbols,
          relatedPaths: [...related].slice(0, 12),
        };
      })
      .filter((hit) => hit.score > 0 || terms.length === 0)
      .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
      .slice(0, Math.max(1, limit));
  }

  async render(query: string, tokenBudget = 1_500): Promise<string> {
    const hits = await this.search(query, 100);
    if (!hits.length) return "";
    const maxChars = tokenBudget * 4;
    const lines = ['<repo-map mode="tree-sitter+lsp+vector">'];
    let used = lines[0]!.length;
    let shown = 0;
    for (const hit of hits) {
      const block = [
        `${hit.path}: # score=${hit.score.toFixed(2)} semantic=${hit.semantic.toFixed(2)}`,
        ...hit.symbols.slice(0, 16).map((symbol) => `  ${symbol.kind} ${symbol.signature}`),
        ...(hit.relatedPaths.length ? [`  refs: ${hit.relatedPaths.join(", ")}`] : []),
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

  async close(): Promise<void> {
    if (this.ownsVectors) await this.vectors.close?.();
  }

  private async load(): Promise<TypedCodeGraphSnapshot | undefined> {
    if (this.snapshot) return this.snapshot;
    try {
      const stat = await fs.lstat(this.indexFile);
      if (!stat.isFile() || stat.isSymbolicLink()) return undefined;
      if (stat.size > (this.options.maxCacheBytes ?? 64 * 1024 * 1024)) return undefined;
      const parsed = JSON.parse(
        await fs.readFile(this.indexFile, "utf8"),
      ) as TypedCodeGraphSnapshot;
      if (parsed.version === 4 && parsed.root === this.root) return parsed;
    } catch {
      // 衍生索引损坏时重建。
    }
    return undefined;
  }

  private async save(snapshot: TypedCodeGraphSnapshot): Promise<void> {
    await fs.mkdir(path.dirname(this.indexFile), { recursive: true, mode: 0o700 });
    const temporary = `${this.indexFile}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const serialized = JSON.stringify(snapshot) + "\n";
      if (Buffer.byteLength(serialized) > (this.options.maxCacheBytes ?? 64 * 1024 * 1024)) {
        throw new Error("Typed-code-graph cache exceeds its configured size limit");
      }
      await fs.writeFile(temporary, serialized, { mode: 0o600, flag: "wx" });
      await fs.rename(temporary, this.indexFile);
      await fs.chmod(this.indexFile, 0o600);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }
}

export function extractTreeSitterSymbols(
  file: string,
  content: string,
): { name: string; sig: string }[] {
  return (parseFile(file, content)?.symbols ?? []).map((symbol) => ({
    name: symbol.name,
    sig: symbol.signature,
  }));
}

/** 从官方 Hugging Face dataset server 生成不含参考 patch 的 280 题真实仓库目录。 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

interface DatasetRow {
  repo: string;
  instance_id: string;
  base_commit: string;
  problem_statement: string;
  FAIL_TO_PASS?: string[] | string;
  PASS_TO_PASS?: string[] | string;
  patch?: string;
  test_patch?: string;
}

interface IndexedRow extends DatasetRow {
  rowIndex: number;
  sourceDataset: string;
  language: string;
}

const MULTILINGUAL = "SWE-bench/SWE-bench_Multilingual";
const VERIFIED = "SWE-bench/SWE-bench_Verified";
const TARGETS: Record<string, number> = {
  java: 39,
  go: 39,
  rust: 39,
  ruby: 30,
  php: 30,
  c_cpp: 30,
  javascript: 18,
  typescript: 15,
};

const REPO_LANGUAGE: Record<string, string> = {
  "apache/druid": "java",
  "apache/lucene": "java",
  "google/gson": "java",
  "javaparser/javaparser": "java",
  "projectlombok/lombok": "java",
  "reactivex/rxjava": "java",
  "astral-sh/ruff": "rust",
  "burntsushi/ripgrep": "rust",
  "nushell/nushell": "rust",
  "sharkdp/bat": "rust",
  "tokio-rs/axum": "rust",
  "tokio-rs/tokio": "rust",
  "uutils/coreutils": "rust",
  "caddyserver/caddy": "go",
  "gin-gonic/gin": "go",
  "gohugoio/hugo": "go",
  "hashicorp/terraform": "go",
  "prometheus/prometheus": "go",
  "axios/axios": "javascript",
  "babel/babel": "javascript",
  "immutable-js/immutable-js": "javascript",
  "mrdoob/three.js": "javascript",
  "preactjs/preact": "javascript",
  "facebook/docusaurus": "typescript",
  "vuejs/core": "typescript",
  "briannesbitt/carbon": "php",
  "laravel/framework": "php",
  "php-cs-fixer/php-cs-fixer": "php",
  "phpoffice/phpspreadsheet": "php",
  "faker-ruby/faker": "ruby",
  "fastlane/fastlane": "ruby",
  "fluent/fluentd": "ruby",
  "jekyll/jekyll": "ruby",
  "jordansissel/fpm": "ruby",
  "rubocop/rubocop": "ruby",
  "fmtlib/fmt": "c_cpp",
  "nlohmann/json": "c_cpp",
  "jqlang/jq": "c_cpp",
  "micropython/micropython": "c_cpp",
  "redis/redis": "c_cpp",
  "valkey-io/valkey": "c_cpp",
};

const EXTENSION_LANGUAGE: Record<string, string> = {
  java: "java",
  go: "go",
  rs: "rust",
  rb: "ruby",
  php: "php",
  c: "c_cpp",
  h: "c_cpp",
  cc: "c_cpp",
  cpp: "c_cpp",
  hpp: "c_cpp",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  tsx: "typescript",
};

function languageOf(row: DatasetRow, dataset: string): string {
  if (dataset === VERIFIED) return "python";
  const counts = new Map<string, number>();
  const diff = `${row.patch ?? ""}\n${row.test_patch ?? ""}`;
  for (const matched of diff.matchAll(/^diff --git a\/.*?\.([A-Za-z0-9]+) b\//gm)) {
    const language = EXTENSION_LANGUAGE[matched[1]!.toLowerCase()];
    if (language) counts.set(language, (counts.get(language) ?? 0) + 1);
  }
  return [...counts].sort((left, right) => right[1] - left[1])[0]?.[0] ?? REPO_LANGUAGE[row.repo] ?? "";
}

async function fetchDataset(dataset: string, expected: number): Promise<IndexedRow[]> {
  const rows: IndexedRow[] = [];
  for (let offset = 0; offset < expected; offset += 100) {
    const url = new URL("https://datasets-server.huggingface.co/rows");
    url.searchParams.set("dataset", dataset);
    url.searchParams.set("config", "default");
    url.searchParams.set("split", "test");
    url.searchParams.set("offset", String(offset));
    url.searchParams.set("length", String(Math.min(100, expected - offset)));
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Dataset fetch ${response.status}: ${await response.text()}`);
    const body = (await response.json()) as { rows?: { row_idx?: number; row?: DatasetRow }[] };
    for (const item of body.rows ?? []) {
      if (!item.row) continue;
      const language = languageOf(item.row, dataset);
      if (!language) throw new Error(`No language mapping for ${item.row.repo}`);
      rows.push({
        ...item.row,
        rowIndex: item.row_idx ?? offset + rows.length,
        sourceDataset: dataset,
        language,
      });
    }
  }
  if (rows.length !== expected) throw new Error(`Expected ${expected} rows from ${dataset}, got ${rows.length}`);
  return rows;
}

/** 仓库轮询，避免某个大型仓库把单语言配额全部占满。 */
function diverse(rows: IndexedRow[], count: number): IndexedRow[] {
  const byRepo = new Map<string, IndexedRow[]>();
  for (const row of rows) {
    const bucket = byRepo.get(row.repo) ?? [];
    bucket.push(row);
    byRepo.set(row.repo, bucket);
  }
  const result: IndexedRow[] = [];
  while (result.length < count) {
    let progressed = false;
    for (const bucket of byRepo.values()) {
      const next = bucket.shift();
      if (!next) continue;
      result.push(next);
      progressed = true;
      if (result.length === count) break;
    }
    if (!progressed) break;
  }
  if (result.length !== count) throw new Error(`Only ${result.length}/${count} diverse rows available`);
  return result;
}

function stringList(value: string[] | string | undefined): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [value];
  } catch {
    return [value];
  }
}

function serializable(row: IndexedRow) {
  return {
    id: `oss-${row.instance_id}`,
    sourceDataset: row.sourceDataset,
    rowIndex: row.rowIndex,
    instanceId: row.instance_id,
    repo: row.repo,
    baseCommit: row.base_commit,
    language: row.language,
    prompt: row.problem_statement.trim(),
    failToPass: stringList(row.FAIL_TO_PASS),
    passToPass: stringList(row.PASS_TO_PASS),
  };
}

const multilingual = await fetchDataset(MULTILINGUAL, 300);
const selected = Object.entries(TARGETS).flatMap(([language, count]) =>
  diverse(multilingual.filter((row) => row.language === language), count),
);
const python = diverse(await fetchDataset(VERIFIED, 500), 40);
const catalog = [...selected, ...python].map(serializable).sort((a, b) => a.id.localeCompare(b.id));
if (catalog.length !== 280) throw new Error(`Expected 280 tasks, got ${catalog.length}`);

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.join(packageRoot, "src", "tasks", "real-repo.generated.ts");
const source =
  `/** Generated by npm run eval:sync-real. Reference patches are intentionally excluded. */\n` +
  `import type { RealRepoEvalTask } from "../real-repo.js";\n\n` +
  `export const REAL_REPO_TASKS: RealRepoEvalTask[] = ${JSON.stringify(catalog, null, 2)};\n`;
await fs.writeFile(target, source, "utf8");
console.error(`Wrote ${catalog.length} real repository tasks to ${target}`);

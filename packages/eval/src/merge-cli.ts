import { promises as fs } from "node:fs";
import * as path from "node:path";
import { evaluateQualityGate, formatQualityGate } from "./quality-gate.js";
import { assertComparableSummaries, formatReport, mergeSummaries, type Summary } from "./report.js";

interface Args {
  input?: string;
  output?: string;
  baseline?: string;
  bootstrapBaseline?: boolean;
}

function parse(argv: string[]): Args {
  const args: Args = {};
  const required = (index: number, flag: string): string => {
    const value = argv[index];
    if (!value) throw new Error(`${flag} requires a value`);
    return value;
  };
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (value === "--input") args.input = required(++index, value);
    else if (value === "--output") args.output = required(++index, value);
    else if (value === "--baseline") args.baseline = required(++index, value);
    else if (value === "--bootstrap-baseline") args.bootstrapBaseline = true;
    else throw new Error(`Unknown merge argument: ${value}`);
  }
  return args;
}

async function jsonFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(target);
      else if (/real-eval-\d+\.json$/.test(entry.name)) files.push(target);
    }
  };
  await walk(root);
  return files.sort();
}

async function main(): Promise<void> {
  const args = parse(process.argv.slice(2));
  if (!args.input || !args.output) throw new Error("--input and --output are required");
  const files = await jsonFiles(path.resolve(args.input));
  const summaries = await Promise.all(
    files.map(async (file) => JSON.parse(await fs.readFile(file, "utf8")) as Summary),
  );
  const merged = mergeSummaries(summaries);
  await fs.writeFile(args.output, `${JSON.stringify(merged, null, 2)}\n`);
  console.log(formatReport(merged));

  if (args.baseline) {
    try {
      const baseline = JSON.parse(await fs.readFile(args.baseline, "utf8")) as Summary;
      assertComparableSummaries(merged, baseline);
      const gate = evaluateQualityGate(merged, baseline);
      if (!gate.passed) {
        console.error(formatQualityGate(gate));
        process.exitCode = 1;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !args.bootstrapBaseline)
        throw error;
      await fs.mkdir(path.dirname(path.resolve(args.baseline)), { recursive: true });
      await fs.writeFile(args.baseline, `${JSON.stringify(merged, null, 2)}\n`);
      console.error(
        `Bootstrapped eval baseline ${args.baseline}; review it before making the gate required`,
      );
    }
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

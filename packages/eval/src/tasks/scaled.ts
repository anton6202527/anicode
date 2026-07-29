/**
 * 96 个可离线复现的真实编辑任务：12 类常见生产缺陷 × 8 组边界数据。
 * 每个任务都有失败种子、不可被 agent 修改的断言脚本与参考解。
 */
import type { EvalTask, TaskKind } from "../task.js";

interface Family {
  name: string;
  title: string;
  kind: TaskKind;
  prompt: string;
  seed: string;
  solution: string;
  verify: (variant: number) => string;
}

const prelude = "import assert from 'node:assert/strict';\n";

const FAMILIES: Family[] = [
  {
    name: "clamp-boundaries",
    title: "修复 clamp 的上下界处理",
    kind: "fix",
    prompt: "修复 value.mjs 的 clamp，使数值同时受最小值和最大值约束。不要修改 verify.mjs。",
    seed: "export const clamp = (value, min, max) => Math.max(min, value);\n",
    solution: "export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));\n",
    verify: (v) =>
      `${prelude}import { clamp } from './value.mjs';\nassert.equal(clamp(${100 + v}, ${v}, ${10 + v}), ${10 + v});\nassert.equal(clamp(-5, ${v}, ${10 + v}), ${v});\n`,
  },
  {
    name: "array-chunks",
    title: "修复数组分块的 slice 终点",
    kind: "debug",
    prompt: "chunk 应按给定大小完整分组，末组允许不足。定位并修复 array.mjs。",
    seed: "export function chunk(xs, size) { const out=[]; for(let i=0;i<xs.length;i+=size) out.push(xs.slice(i, size)); return out; }\n",
    solution:
      "export function chunk(xs, size) { if(size < 1) throw new RangeError('size'); const out=[]; for(let i=0;i<xs.length;i+=size) out.push(xs.slice(i, i + size)); return out; }\n",
    verify: (v) =>
      `${prelude}import { chunk } from './value.mjs';\nassert.deepEqual(chunk([1,2,3,4,5,${6 + v}], 2), [[1,2],[3,4],[5,${6 + v}]]);\nassert.throws(() => chunk([], 0), RangeError);\n`,
  },
  {
    name: "group-by",
    title: "实现稳定的 groupBy",
    kind: "implement",
    prompt: "实现 value.mjs 的 groupBy(xs, keyFn)，保持每组输入顺序并返回普通对象。",
    seed: "export function groupBy(xs, keyFn) { return {}; }\n",
    solution:
      "export function groupBy(xs, keyFn) { return xs.reduce((out, item) => { const key=String(keyFn(item)); (out[key] ??= []).push(item); return out; }, {}); }\n",
    verify: (v) =>
      `${prelude}import { groupBy } from './value.mjs';\nconst xs=[{k:'a',v:${v}},{k:'b',v:2},{k:'a',v:3}];\nassert.deepEqual(groupBy(xs, x=>x.k), {a:[xs[0],xs[2]],b:[xs[1]]});\n`,
  },
  {
    name: "dedupe-key",
    title: "按业务键去重对象",
    kind: "fix",
    prompt: "dedupeBy 应按 keyFn 的结果保留第一次出现的对象；当前 Set 用错了对象身份。",
    seed: "export const dedupeBy = (xs, keyFn) => [...new Set(xs)];\n",
    solution:
      "export function dedupeBy(xs, keyFn) { const seen=new Set(); return xs.filter(x => { const key=keyFn(x); if(seen.has(key)) return false; seen.add(key); return true; }); }\n",
    verify: (v) =>
      `${prelude}import { dedupeBy } from './value.mjs';\nconst xs=[{id:${v},n:'first'},{id:${v},n:'duplicate'},{id:${v + 1},n:'next'}];\nassert.deepEqual(dedupeBy(xs,x=>x.id), [xs[0],xs[2]]);\n`,
  },
  {
    name: "memoize-falsy",
    title: "修复 memoize 对 falsy 值重复计算",
    kind: "debug",
    prompt: "memoize 必须缓存 0、false 和空字符串；修复当前用真值判断缓存命中的问题。",
    seed: "export function memoize(fn) { const cache=new Map(); return x => { if(cache.get(x)) return cache.get(x); const value=fn(x); cache.set(x,value); return value; }; }\n",
    solution:
      "export function memoize(fn) { const cache=new Map(); return x => { if(cache.has(x)) return cache.get(x); const value=fn(x); cache.set(x,value); return value; }; }\n",
    verify: (v) =>
      `${prelude}import { memoize } from './value.mjs';\nlet calls=0; const f=memoize(x => { calls++; return x-${v}; });\nassert.equal(f(${v}),0); assert.equal(f(${v}),0); assert.equal(calls,1);\n`,
  },
  {
    name: "retry-attempts",
    title: "修复异步重试次数",
    kind: "fix",
    prompt: "retry(fn, attempts) 的 attempts 表示总尝试次数；修复少执行一次及最终错误传播。",
    seed: "export async function retry(fn, attempts) { let error; for(let i=0;i<attempts-1;i++){ try{return await fn();}catch(e){error=e;} } throw error; }\n",
    solution:
      "export async function retry(fn, attempts) { let error; for(let i=0;i<attempts;i++){ try{return await fn();}catch(e){error=e;} } throw error; }\n",
    verify: (v) =>
      `${prelude}import { retry } from './value.mjs';\nlet calls=0; const result=await retry(async()=>{ calls++; if(calls<3) throw new Error('temporary-${v}'); return 'ok'; },3);\nassert.equal(result,'ok'); assert.equal(calls,3);\n`,
  },
  {
    name: "topological-order",
    title: "实现依赖优先的拓扑排序",
    kind: "implement",
    prompt: "实现拓扑排序：graph 中每个 key 的数组是其依赖，依赖必须排在任务之前；循环应抛错。",
    seed: "export const topoSort = graph => Object.keys(graph).sort();\n",
    solution:
      "export function topoSort(graph) { const out=[],state=new Map(); const visit=n=>{ if(state.get(n)===1) throw new Error('cycle'); if(state.get(n)===2) return; state.set(n,1); for(const d of graph[n]??[]) visit(d); state.set(n,2); out.push(n); }; for(const n of Object.keys(graph)) visit(n); return out; }\n",
    verify: (v) =>
      `${prelude}import { topoSort } from './value.mjs';\nconst out=topoSort({deploy${v}:['build${v}'],build${v}:['test${v}'],test${v}:[]});\nassert.ok(out.indexOf('test${v}')<out.indexOf('build${v}')); assert.ok(out.indexOf('build${v}')<out.indexOf('deploy${v}'));\nassert.throws(()=>topoSort({a:['b'],b:['a']}),/cycle/);\n`,
  },
  {
    name: "csv-quotes",
    title: "解析带引号和转义引号的 CSV 行",
    kind: "implement",
    prompt: "parseCsvLine 需正确处理逗号、双引号包裹字段和两个双引号表示的转义引号。",
    seed: "export const parseCsvLine = line => line.split(',');\n",
    solution:
      "export function parseCsvLine(line) { const out=[]; let value='',quoted=false; for(let i=0;i<line.length;i++){ const c=line[i]; if(c==='\"'){ if(quoted&&line[i+1]==='\"'){value+='\"';i++;} else quoted=!quoted; } else if(c===','&&!quoted){out.push(value);value='';} else value+=c; } out.push(value); return out; }\n",
    verify: (v) =>
      `${prelude}import { parseCsvLine } from './value.mjs';\nassert.deepEqual(parseCsvLine('a,"b,${v}","say ""hi"""'), ['a','b,${v}','say "hi"']);\n`,
  },
  {
    name: "deep-get",
    title: "支持点号与数组下标的 deepGet",
    kind: "refactor",
    prompt: "扩展 deepGet，使 a[0].b 与 a.0.b 都能访问；中间值缺失时返回 fallback。",
    seed: "export function deepGet(value, path, fallback) { return path.split('.').reduce((x,k)=>x?.[k],value) ?? fallback; }\n",
    solution:
      "export function deepGet(value, path, fallback) { const keys=path.replace(/\\[(\\d+)\\]/g,'.$1').split('.').filter(Boolean); const result=keys.reduce((x,k)=>x?.[k],value); return result ?? fallback; }\n",
    verify: (v) =>
      `${prelude}import { deepGet } from './value.mjs';\nconst x={a:[{b:${v}}]}; assert.equal(deepGet(x,'a[0].b','no'),${v}); assert.equal(deepGet(x,'a[1].b','fallback'),'fallback');\n`,
  },
  {
    name: "redact-all",
    title: "完整脱敏重复出现的密钥",
    kind: "debug",
    prompt: "redact 必须替换文本中所有 secret（包括包含 $ 的字面密钥），不能只替换第一次。",
    seed: "export const redact = (text, secret) => text.replace(secret, '[REDACTED]');\n",
    solution:
      "export const redact = (text, secret) => secret ? text.split(secret).join('[REDACTED]') : text;\n",
    verify: (v) =>
      `${prelude}import { redact } from './value.mjs';\nconst secret='sk$${v}'; const out=redact('x '+secret+' y '+secret,secret); assert.equal(out,'x [REDACTED] y [REDACTED]'); assert.ok(!out.includes(secret));\n`,
  },
  {
    name: "partition-predicate",
    title: "按谓词稳定分区",
    kind: "fix",
    prompt: "partition(xs, predicate) 应返回 [命中项, 未命中项]，两个分区都保持原始顺序。",
    seed: "export const partition = xs => [xs.filter(Boolean), xs.filter(x=>!x)];\n",
    solution:
      "export function partition(xs, predicate) { const yes=[],no=[]; for(const x of xs) (predicate(x)?yes:no).push(x); return [yes,no]; }\n",
    verify: (v) =>
      `${prelude}import { partition } from './value.mjs';\nassert.deepEqual(partition([${v},${v + 1},${v + 2},${v + 3}],x=>x%2===0), [[${v % 2 === 0 ? `${v},${v + 2}` : `${v + 1},${v + 3}`}],[${v % 2 === 0 ? `${v + 1},${v + 3}` : `${v},${v + 2}`}]]);\n`,
  },
  {
    name: "emitter-once",
    title: "修复事件总线 once 语义",
    kind: "refactor",
    prompt: "Emitter.once 注册的回调最多执行一次，同时 on/off/emit 的既有行为保持可用。",
    seed: "export class Emitter { #m=new Map(); on(k,f){(this.#m.get(k)??this.#m.set(k,new Set()).get(k)).add(f);return()=>this.off(k,f)} off(k,f){this.#m.get(k)?.delete(f)} once(k,f){return this.on(k,f)} emit(k,v){for(const f of this.#m.get(k)??[])f(v)} }\n",
    solution:
      "export class Emitter { #m=new Map(); on(k,f){(this.#m.get(k)??this.#m.set(k,new Set()).get(k)).add(f);return()=>this.off(k,f)} off(k,f){this.#m.get(k)?.delete(f)} once(k,f){const wrap=v=>{this.off(k,wrap);f(v)};return this.on(k,wrap)} emit(k,v){for(const f of [...(this.#m.get(k)??[])])f(v)} }\n",
    verify: (v) =>
      `${prelude}import { Emitter } from './value.mjs';\nconst e=new Emitter(); let total=0; e.once('x',n=>total+=n); e.emit('x',${v}); e.emit('x',${v}); assert.equal(total,${v});\n`,
  },
];

function task(family: Family, variant: number): EvalTask {
  const suffix = String(variant).padStart(2, "0");
  return {
    id: `real-${family.name}-${suffix}`,
    title: `${family.title} #${suffix}`,
    lang: "js",
    kind: family.kind,
    prompt: `${family.prompt} 完成后运行 node verify.mjs。任务数据集编号 ${suffix}。`,
    files: { "value.mjs": family.seed, "verify.mjs": family.verify(variant) },
    verify: { cmd: "node", args: ["verify.mjs"] },
    solution: { "value.mjs": family.solution },
  };
}

export const SCALED_TASKS: EvalTask[] = FAMILIES.flatMap((family) =>
  Array.from({ length: 8 }, (_, index) => task(family, index + 1)),
);

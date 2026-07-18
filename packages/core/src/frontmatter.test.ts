import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFrontmatter, stripFrontmatter, fmString, fmStringList } from "./frontmatter.js";

test("单行标量与引号", () => {
  const fm = parseFrontmatter(`---\nname: my-skill\ndescription: "带引号, 含逗号"\nmodel: 'sonnet'\n---\nbody`);
  assert.equal(fm["name"], "my-skill");
  assert.equal(fm["description"], "带引号, 含逗号");
  assert.equal(fm["model"], "sonnet");
});

test("块标量 | 保留换行，> 折叠为空格", () => {
  const fm = parseFrontmatter(
    ["---", "a: |", "  line1", "  line2", "b: >", "  fold1", "  fold2", "---"].join("\n"),
  );
  assert.equal(fm["a"], "line1\nline2");
  assert.equal(fm["b"], "fold1 fold2");
});

test("块标量 |- 变体与更深缩进保留", () => {
  const fm = parseFrontmatter(["a: |-", "  first", "    indented", "  last", "b: x"].join("\n"));
  assert.equal(fm["a"], "first\n  indented\nlast");
  assert.equal(fm["b"], "x");
});

test("行内列表与块列表", () => {
  const fm = parseFrontmatter(
    ["tools: [read, bash, \"a, b\"]", "allowed-tools:", "  - edit", "  - grep"].join("\n"),
  );
  assert.deepEqual(fm["tools"], ["read", "bash", "a, b"]);
  assert.deepEqual(fm["allowed-tools"], ["edit", "grep"]);
});

test("嵌套 map", () => {
  const fm = parseFrontmatter(["metadata:", "  type: project", "  nested:", "    k: v"].join("\n"));
  assert.deepEqual(fm["metadata"], { type: "project", nested: { k: "v" } });
});

test("注释与空行跳过；行尾注释剥离", () => {
  const fm = parseFrontmatter(["# comment", "", "a: value # trailing", "b: a#b"].join("\n"));
  assert.equal(fm["a"], "value");
  assert.equal(fm["b"], "a#b");
});

test("超出子集的行不抛错", () => {
  const fm = parseFrontmatter(["a: ok", "- stray list item", "b: fine"].join("\n"));
  assert.equal(fm["a"], "ok");
  assert.equal(fm["b"], "fine");
});

test("stripFrontmatter 与无 frontmatter 情形", () => {
  assert.equal(stripFrontmatter("---\na: 1\n---\nbody"), "body");
  assert.equal(stripFrontmatter("no fm"), "no fm");
  assert.deepEqual(parseFrontmatter("no fm"), {});
});

test("fmString / fmStringList 便捷取值", () => {
  assert.equal(fmString("x"), "x");
  assert.equal(fmString(""), undefined);
  assert.equal(fmString(["a"]), undefined);
  assert.deepEqual(fmStringList("a, b"), ["a", "b"]);
  assert.deepEqual(fmStringList(["a", "b"]), ["a", "b"]);
  assert.equal(fmStringList(""), undefined);
  assert.equal(fmStringList(undefined), undefined);
});

test("空值 key 与后续更深缩进为空的情形", () => {
  const fm = parseFrontmatter(["a:", "b: x"].join("\n"));
  assert.equal(fm["a"], "");
  assert.equal(fm["b"], "x");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { setLang, clearLangOverride } from "@anicode/core";
import {
  sliceAnsi,
  compositeFrame,
  dispWidth,
  truncWidth,
  buildModelPickerOverlay,
  buildSessionsOverlay,
  buildPermissionOverlay,
  buildCommandMenuOverlay,
  hitTestSprite,
  windowHorizontally,
  DIALOG_MIN,
  type PickerLikeRow,
  type CommandMenuRow,
  type Sprite,
} from "./overlay.js";

const SGR = new RegExp("\\u001b\\[[0-9;]*m", "g");
const strip = (s: string) => s.replace(SGR, "");
const visW = (s: string) => dispWidth(strip(s));

test("overlay: sliceAnsi 取纯文本可见区间", () => {
  assert.equal(strip(sliceAnsi("hello", 1, 3)), "el");
  assert.equal(strip(sliceAnsi("hello", 0, 100)), "hello");
  assert.equal(strip(sliceAnsi("hello", 10, 20)), "");
});

test("overlay: sliceAnsi 右半段续接颜色状态", () => {
  const red = "\x1b[31mhello\x1b[0m";
  const right = sliceAnsi(red, 2, Number.POSITIVE_INFINITY);
  assert.equal(strip(right), "llo");
  // 从第 2 列起落笔，仍应带上此刻生效的红色 SGR
  assert.ok(right.includes("\x1b[31m"), "右半段丢了颜色状态");
});

test("overlay: sliceAnsi 边界劈开的宽字符用空格顶位", () => {
  // "你好"：你=[0,2) 好=[2,4)；窗口 [1,3) 各切一半 → 两个空格
  assert.equal(strip(sliceAnsi("你好", 1, 3)), "  ");
  assert.equal(strip(sliceAnsi("你好", 0, 2)), "你");
});

test("overlay: compositeFrame 把精灵盖到中间列，两侧背景透出", () => {
  const bg = ["aaaaaaaaaa", "bbbbbbbbbb", "cccccccccc"];
  const sprite: Sprite = { top: 1, left: 2, width: 3, lines: ["XYZ"] };
  const out = compositeFrame(bg, sprite);
  assert.equal(strip(out[0]!), "aaaaaaaaaa"); // 未覆盖行不变
  assert.equal(strip(out[1]!), "bbXYZbbbbb"); // 中间 3 列被替换，两侧 b 仍在
  assert.equal(strip(out[2]!), "cccccccccc");
});

test("overlay: compositeFrame 背景短于 left 时补空格", () => {
  const out = compositeFrame(["ab"], { top: 0, left: 5, width: 2, lines: ["##"] });
  assert.equal(strip(out[0]!), "ab   ##");
});

const rows: PickerLikeRow[] = [
  { label: "Opus 4.8", providerName: "Anthropic", free: false, ready: true, readyHint: "" },
  { label: "DeepSeek V4 Flash", providerName: "DeepSeek", free: true, ready: true, readyHint: "" },
];

test("overlay: 模型选择器每行定宽、含标题与分组与高亮", () => {
  const s = buildModelPickerOverlay(rows, 1, "", 30, 80);
  assert.equal(s.lines.length, 22, "模型弹框应保持固定高度");
  for (const l of s.lines)
    assert.equal(visW(l), s.width, `行宽不等于 ${s.width}: ${JSON.stringify(strip(l))}`);
  const text = s.lines.map(strip).join("\n");
  assert.match(text, /选择模型/);
  assert.match(text, /esc/);
  assert.match(text, /Anthropic/); // 分组标题
  assert.match(text, /DeepSeek/);
  assert.match(text, /Free/); // 免费右标签
  assert.doesNotMatch(text, /↑\/↓|Enter 确认/); // 不再占一行展示键盘操作提示
  // 高亮项（index=1）整行铺暖橙底 #f6b17a → 48;2;246;177;122
  assert.ok(
    s.lines.some((l) => l.includes("48;2;246;177;122")),
    "缺少高亮底色",
  );
});

test("overlay: 模型选择器搜索词回显", () => {
  const s = buildModelPickerOverlay([], 0, "abc", 30, 80);
  assert.equal(s.lines.length, 22, "无结果时弹框高度也不应跳动");
  const text = s.lines.map(strip).join("\n");
  assert.match(text, /abc/);
  assert.match(text, /（无匹配模型）/);
});

test("overlay: 会话列表与授权弹框定宽且含关键信息", () => {
  const sess = buildSessionsOverlay(
    [{ id: "s_a", running: true, title: "会话A", model: "opus" }],
    30,
    80,
  );
  for (const l of sess.lines) assert.equal(visW(l), sess.width);
  const st = sess.lines.map(strip).join("\n");
  assert.match(st, /会话列表/);
  assert.match(st, /s_a/);
  assert.match(st, /会话A/);

  const perm = buildPermissionOverlay([{ toolName: "bash", ruleKey: "rm x" }], 30, 80);
  for (const l of perm.lines) assert.equal(visW(l), perm.width);
  const pt = perm.lines.map(strip).join("\n");
  assert.match(pt, /授权请求/);
  assert.match(pt, /bash/);
  assert.match(pt, /允许并记住/);
});

test("overlay: 命令菜单钉在锚点上方、定宽、含命令与描述与高亮", () => {
  const cmds: CommandMenuRow[] = [
    { name: "model", description: "打开内置模型选择器" },
    { name: "sessions", description: "列出最近会话" },
    { name: "undo", description: "撤销上一轮文件改动" },
  ];
  const anchorTop = 20;
  const s = buildCommandMenuOverlay(cmds, 1, anchorTop, 30, 80);
  assert.equal(s.lines.length, 12, "命令菜单应保持固定高度");
  for (const l of s.lines) assert.equal(visW(l), s.width, `行宽不等于 ${s.width}`);
  // 方向朝上：末行落在锚点上一行（top + 高度 === anchorTop）。
  assert.equal(s.top + s.lines.length, anchorTop);
  assert.equal(s.left, 0); // 与输入框左缘对齐
  const text = s.lines.map(strip).join("\n");
  assert.match(text, /\/model/);
  assert.match(text, /打开内置模型选择器/);
  assert.match(text, /\/sessions/);
  assert.doesNotMatch(text, /↑\/↓|Tab 补全|Enter 执行/);
  // 高亮项（index=1）整行铺暖橙底 #f6b17a。
  assert.ok(
    s.lines.some((l) => l.includes("48;2;246;177;122")),
    "缺少高亮底色",
  );
});

test("overlay: 命令菜单超长列表在固定高度内滚动", () => {
  const many: CommandMenuRow[] = Array.from({ length: 20 }, (_, i) => ({
    name: `cmd${i}`,
    description: `第 ${i} 个命令`,
  }));
  // 小终端 + 高亮靠后：应开窗，高亮项仍在窗口内可见。
  const s = buildCommandMenuOverlay(many, 15, 24, 24, 80);
  const text = s.lines.map(strip).join("\n");
  assert.match(text, /\/cmd15/); // 高亮项落在窗口里
  assert.doesNotMatch(text, /还有/); // 不再显示上下翻页提示
  assert.equal(s.lines.length, 12);
});

test("overlay: 模型选择器在固定高度内随高亮项滚动", () => {
  const big: PickerLikeRow[] = Array.from({ length: 40 }, (_, i) => ({
    label: `Model ${i}`,
    providerName: "P",
    free: false,
    ready: true,
    readyHint: "",
  }));
  const first = buildModelPickerOverlay(big, 0, "", 30, 80);
  const last = buildModelPickerOverlay(big, 39, "", 30, 80);
  assert.equal(first.lines.length, 22);
  assert.equal(last.lines.length, 22);
  const text = first.lines.map(strip).join("\n");
  assert.doesNotMatch(text, /还有/); // 靠开窗滚动，不显示上下翻页提示
  // 40 个模型必被开窗：靠后的模型不出现在首屏。
  assert.doesNotMatch(text, /Model 39/);
  const lastText = last.lines.map(strip).join("\n");
  assert.match(lastText, /Model 39/); // 高亮滚到末尾时，末项进入固定视口
  assert.doesNotMatch(lastText, /Model 0\b/);
  const modelRow = last.hitRows?.findIndex((target) => target === 39) ?? -1;
  assert.ok(modelRow >= 0, "末项应有可点击行");
  assert.equal(hitTestSprite(last, last.left + 1, last.top + modelRow + 1), 39);
  assert.equal(hitTestSprite(last, last.left + 1, last.top + 2), null, "标题行不可点击");
});

test("overlay: 弹框随终端变窄而缩小，不超过屏宽", () => {
  // 宽屏封顶 64；中等屏跟着缩；窄屏缩到可读下限 DIALOG_MIN。
  const wide = buildSessionsOverlay([], 30, 120);
  assert.equal(wide.width, 64);
  const mid = buildSessionsOverlay([], 30, 50);
  assert.equal(mid.width, 48); // 50 - 2
  assert.ok(mid.width <= 50);
  const narrow = buildSessionsOverlay([], 30, 28);
  assert.equal(narrow.width, DIALOG_MIN); // 缩到下限（此时比屏还宽，靠横向开窗兜底）
});

test("overlay: 超窄终端弹框横向开窗并补横向滚动条", () => {
  // 28 列终端：弹框自然宽 30 > 屏宽 → 需要横向开窗。
  const nat = buildModelPickerOverlay(rows, 0, "", 24, 28);
  assert.equal(nat.width, 30);
  const w0 = windowHorizontally(nat, 28, 0);
  assert.equal(w0.width, 28); // 裁到屏宽
  assert.equal(w0.left, 0);
  for (const l of w0.lines) assert.equal(visW(l), 28, "开窗后每行应恰为屏宽");
  // 末行是滚动条：含滑块 █ 与右向 ▶（因还有未展示的右侧内容）。
  const bar = strip(w0.lines[w0.lines.length - 1]!);
  assert.match(bar, /█/);
  assert.match(bar, /▶/);
  // 右移后左端出现 ◀，且可见内容随之移动。
  const w1 = windowHorizontally(nat, 28, 2);
  const bar1 = strip(w1.lines[w1.lines.length - 1]!);
  assert.match(bar1, /◀/);
  // 不比屏窄时原样返回、不加滚动条。
  const fit = buildSessionsOverlay([], 30, 120);
  assert.equal(windowHorizontally(fit, 120, 0), fit);
});

test("overlay: 切到英文时弹框文案随之改为英文", () => {
  try {
    setLang("en");
    const s = buildModelPickerOverlay(rows, 0, "", 30, 80);
    const text = s.lines.map(strip).join("\n");
    assert.match(text, /Select model/); // 标题英文
    assert.doesNotMatch(text, /选择模型/);
    const perm = buildPermissionOverlay([{ toolName: "bash", ruleKey: "rm x" }], 30, 80);
    assert.match(perm.lines.map(strip).join("\n"), /Permission|permission|Allow|allow/);
  } finally {
    clearLangOverride(); // 复位，避免影响其余以中文断言的用例（脚本 env=zh）
  }
});

test("overlay: truncWidth/dispWidth 按显示宽度处理 CJK", () => {
  assert.equal(dispWidth("你好"), 4);
  assert.equal(dispWidth("ab"), 2);
  assert.equal(truncWidth("hello", 3), "he…");
  assert.equal(truncWidth("hi", 5), "hi");
});

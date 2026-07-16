import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { t, getLang, setLang, detectLang, clearLangOverride } from "./i18n.js";

const saved = { ...process.env };
afterEach(() => {
  clearLangOverride();
  process.env["ANICODE_LANG"] = saved["ANICODE_LANG"];
  process.env["LANG"] = saved["LANG"];
  process.env["LC_ALL"] = saved["LC_ALL"];
});

test("i18n: 默认英文，ANICODE_LANG 显式覆盖", () => {
  delete process.env["ANICODE_LANG"];
  delete process.env["LANG"];
  delete process.env["LC_ALL"];
  assert.equal(detectLang(), "en");
  process.env["ANICODE_LANG"] = "zh";
  assert.equal(detectLang(), "zh");
  process.env["ANICODE_LANG"] = "en";
  assert.equal(detectLang(), "en");
});

test("i18n: 无显式设置时按系统 LANG 判定中文", () => {
  delete process.env["ANICODE_LANG"];
  delete process.env["LC_ALL"];
  process.env["LANG"] = "zh_CN.UTF-8";
  assert.equal(detectLang(), "zh");
  process.env["LANG"] = "en_US.UTF-8";
  assert.equal(detectLang(), "en");
});

test("i18n: setLang 运行时覆盖优先于环境", () => {
  process.env["ANICODE_LANG"] = "en";
  setLang("zh");
  assert.equal(getLang(), "zh");
  assert.equal(t("Select model", "选择模型"), "选择模型");
  setLang("en");
  assert.equal(t("Select model", "选择模型"), "Select model");
  clearLangOverride();
  assert.equal(getLang(), "en"); // 覆盖清除后回到 env
});

import assert from "node:assert/strict";
import test from "node:test";
import { parseEditorCommand } from "./external-editor.js";

test("external editor: parses arguments without shell evaluation", () => {
  assert.deepEqual(parseEditorCommand('code --wait "--user-data-dir=/tmp/a b"'), [
    "code",
    "--wait",
    "--user-data-dir=/tmp/a b",
  ]);
  assert.deepEqual(parseEditorCommand("vim -f"), ["vim", "-f"]);
  assert.throws(() => parseEditorCommand("code 'unterminated"), /unterminated/);
});

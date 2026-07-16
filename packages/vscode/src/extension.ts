/**
 * 扩展入口（唯一依赖 vscode 的文件）。把 ChatBridge（core）接到侧边栏 webview 上，
 * 并用原生 QuickPick / 状态栏提供选择模型、恢复会话等 VSCode 味的操作。
 */

import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { t } from "@anicode/core";
import { ChatBridge } from "./bridge.js";
import { buildManager, modelChoices, DEFAULT_MODEL } from "./host.js";
import type { HostToWebview, WebviewToHost } from "./protocol.js";

export function activate(context: vscode.ExtensionContext): void {
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd() ?? os.homedir();
  const sessionsDir = path.join(context.globalStorageUri.fsPath, "sessions");
  const manager = buildManager(sessionsDir);

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.command = "anicode.pickModel";
  context.subscriptions.push(status);

  const provider = new ChatViewProvider(context.extensionUri, manager, cwd, () => {
    status.text = `$(sparkle) ${provider.model}`;
    status.tooltip = t(
      `anicode model: ${provider.model} (click to switch)`,
      `anicode 模型：${provider.model}（点击切换）`,
    );
    status.show();
  });

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewId, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("anicode.focus", () =>
      vscode.commands.executeCommand("anicode.chat.focus"),
    ),
    vscode.commands.registerCommand("anicode.newSession", () => provider.newSession()),
    vscode.commands.registerCommand("anicode.pickModel", () => provider.pickModel()),
    vscode.commands.registerCommand("anicode.resume", () => provider.resume()),
    { dispose: () => provider.dispose() },
  );
}

export function deactivate(): void {}

class ChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = "anicode.chat";
  private view: vscode.WebviewView | undefined;
  private bridge: ChatBridge;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly manager: import("@anicode/core").SessionManager,
    private readonly cwd: string,
    private readonly onModelChange: () => void,
  ) {
    this.bridge = new ChatBridge(manager, cwd, DEFAULT_MODEL, () => {});
    this.onModelChange();
  }

  get model(): string {
    return this.bridge.model;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, "out"),
        vscode.Uri.joinPath(this.extensionUri, "media"),
      ],
    };
    this.bridge.setPost((msg: HostToWebview) => void view.webview.postMessage(msg));
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((msg: WebviewToHost) => {
      if (msg.type === "pickModel") return void this.pickModel();
      if (msg.type === "resume") return void this.resume();
      if (msg.type === "openFile") return void this.openFile(msg.path);
      void this.bridge.handle(msg).then(() => this.onModelChange());
    });
  }

  async newSession(): Promise<void> {
    await this.reveal();
    await this.bridge.newSession(this.bridge.model);
    this.onModelChange();
  }

  async pickModel(): Promise<void> {
    const choices = await modelChoices();
    const pick = await vscode.window.showQuickPick(
      choices.map((c) => ({ label: c.label, detail: c.detail, spec: c.spec })),
      {
        title: t("Select model", "选择模型"),
        placeHolder: t("✔ ready to use · ✖ missing credential", "✔ 可直接使用 · ✖ 缺凭证"),
        matchOnDetail: true,
      },
    );
    if (!pick) return;
    await this.reveal();
    await this.bridge.switchModel(pick.spec);
    this.onModelChange();
  }

  async resume(): Promise<void> {
    type Item = vscode.QuickPickItem & { id: string };
    const toItems = (
      sessions: readonly { id: string; title?: string; model: string; running: boolean }[],
    ): Item[] =>
      sessions.map((s) => ({
        label: s.title ?? t("Untitled chat", "未命名对话"),
        description: `${s.model}${s.running ? t(" · running", " · 运行中") : ""}`,
        detail: s.id,
        id: s.id,
        buttons: [
          { iconPath: new vscode.ThemeIcon("trash"), tooltip: t("Delete session", "删除会话") },
        ],
      }));

    const initial = await this.manager.listSessions();
    if (initial.length === 0) {
      void vscode.window.showInformationMessage(t("No past sessions", "暂无历史会话"));
      return;
    }

    const qp = vscode.window.createQuickPick<Item>();
    qp.title = t("Sessions (Enter to resume · 🗑 to delete)", "会话（Enter 恢复 · 🗑 删除）");
    qp.items = toItems(initial);

    qp.onDidTriggerItemButton(async (e) => {
      await this.manager.deleteSession(e.item.id);
      if (e.item.id === this.bridge.sessionId) {
        await this.reveal();
        await this.bridge.newSession(this.bridge.model);
        this.onModelChange();
      }
      const remaining = await this.manager.listSessions();
      if (remaining.length === 0) qp.hide();
      else qp.items = toItems(remaining);
    });
    qp.onDidAccept(async () => {
      const pick = qp.selectedItems[0];
      qp.hide();
      if (!pick) return;
      await this.reveal();
      await this.bridge.resume(pick.id);
      this.onModelChange();
    });
    qp.onDidHide(() => qp.dispose());
    qp.show();
  }

  private async openFile(relPath: string): Promise<void> {
    try {
      const uri = vscode.Uri.file(
        path.isAbsolute(relPath) ? relPath : path.join(this.cwd, relPath),
      );
      await vscode.window.showTextDocument(uri, { preview: true });
    } catch (err) {
      void vscode.window.showErrorMessage(
        t(
          `Failed to open file: ${err instanceof Error ? err.message : String(err)}`,
          `打开文件失败：${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }
  }

  private async reveal(): Promise<void> {
    if (this.view) this.view.show?.(true);
    else await vscode.commands.executeCommand("anicode.chat.focus");
  }

  dispose(): void {
    this.bridge.dispose();
  }

  private html(webview: vscode.Webview): string {
    const nonce = makeNonce();
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "out", "webview.js"),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "style.css"),
    );
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");
    return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${styleUri}" />
  <title>anicode</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function makeNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 32; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

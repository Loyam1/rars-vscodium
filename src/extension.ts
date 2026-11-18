import * as path from "node:path";
import * as vscode from "vscode";
import { RarsBridge, type RarsEvent } from "./rarsBridge";
import { RarsDebugPanel } from "./debugPanel";

const CONFIGURATION_SECTION = "rarsVscodium";

const TERMINATION_REASONS = new Set(["NORMAL_TERMINATION", "CLIFF_TERMINATION", "EXCEPTION"]);

export function activate(context: vscode.ExtensionContext): void {
  const session = new RarsSession(context);

  context.subscriptions.push(
    session,
    vscode.commands.registerCommand("rarsVscodium.configureJar", configureJar),
    vscode.commands.registerCommand("rarsVscodium.runActiveFile", () => runActiveFile(false)),
    vscode.commands.registerCommand("rarsVscodium.openGui", () => runActiveFile(true)),
    vscode.commands.registerCommand("rarsVscodium.debugActiveFile", () => session.start()),
    vscode.commands.registerCommand("rarsVscodium.debugStep", () => session.step()),
    vscode.commands.registerCommand("rarsVscodium.debugContinue", () => session.continueRun()),
    vscode.commands.registerCommand("rarsVscodium.debugPause", () => session.pause()),
    vscode.commands.registerCommand("rarsVscodium.debugStop", () => session.stop()),
    vscode.commands.registerCommand("rarsVscodium.toggleBreakpoint", () => session.toggleBreakpointAtCursor())
  );
}

async function configureJar(): Promise<void> {
  const choice = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    filters: { "Archives Java": ["jar"] },
    title: "Choisir le fichier rars.jar"
  });

  if (!choice?.[0]) {
    return;
  }

  await vscode.workspace
    .getConfiguration(CONFIGURATION_SECTION)
    .update("jarPath", choice[0].fsPath, vscode.ConfigurationTarget.Workspace);
}

async function runActiveFile(gui: boolean): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showErrorMessage("Ouvrez un fichier assembleur RISC-V avant de lancer RARS.");
    return;
  }

  await editor.document.save();
  const jarPath = await getJarPath();
  if (!jarPath) {
    return;
  }

  const args = ["-jar", jarPath];
  if (!gui) {
    args.push("nc");
  }
  args.push(editor.document.uri.fsPath);

  const terminal = vscode.window.createTerminal({
    name: gui ? "RARS (interface graphique)" : "RARS",
    shellPath: "java",
    shellArgs: args
  });
  terminal.show();
}

async function getJarPath(): Promise<string | undefined> {
  const configuredPath = vscode.workspace
    .getConfiguration(CONFIGURATION_SECTION)
    .get<string>("jarPath", "");
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  const jarPath = workspaceFolder && configuredPath && !path.isAbsolute(configuredPath)
    ? path.join(workspaceFolder.uri.fsPath, configuredPath)
    : configuredPath;

  if (jarPath) {
    return jarPath;
  }

  void vscode.window.showWarningMessage(
    "Configurez d'abord le chemin de rars.jar avec la commande « RARS: Choisir le fichier JAR ».",
    "Configurer"
  ).then((selection) => {
    if (selection === "Configurer") {
      return configureJar();
    }
    return undefined;
  });
  return undefined;
}

export function deactivate(): void {
  // Les processus RARS sont attaches a leurs terminaux VSCodium.
}

/**
 * Session de debogage : un processus pont Java (RarsBridge), un panneau
 * webview, les decorations de l'editeur et les points d'arret par fichier.
 */
class RarsSession implements vscode.Disposable {
  private bridge?: RarsBridge;
  private panel: RarsDebugPanel;
  private readonly breakpoints = new Map<string, Set<number>>();
  private mainFile?: string;
  private validLines: Set<number> = new Set();
  private readonly outputChannel: vscode.OutputChannel;
  private readonly currentLineDecoration: vscode.TextEditorDecorationType;
  private readonly breakpointDecoration: vscode.TextEditorDecorationType;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.outputChannel = vscode.window.createOutputChannel("RARS");
    this.currentLineDecoration = vscode.window.createTextEditorDecorationType({
      backgroundColor: { id: "editor.wordHighlightBackground" },
      border: "1px solid",
      borderColor: { id: "editor.lineHighlightBorder" },
      isWholeLine: true
    });
    this.breakpointDecoration = vscode.window.createTextEditorDecorationType({
      gutterIconPath: vscode.Uri.parse(this.breakpointIconUri()),
      gutterIconSize: "contain"
    });

    this.panel = new RarsDebugPanel(context.extensionUri, (message) => {
      switch (message.command) {
        case "step":
          this.bridge?.step();
          break;
        case "continue":
          this.bridge?.continueRun();
          break;
        case "pause":
          this.bridge?.pause();
          break;
        case "stop":
          this.bridge?.stop();
          break;
        case "input":
          if (message.text !== undefined) {
            this.bridge?.sendInput(message.text);
          }
          break;
        case "openLine":
          if (typeof message.line === "number") {
            void this.revealLine(message.line - 1);
          }
          break;
      }
    });

    vscode.window.onDidChangeActiveTextEditor(() => this.refreshBreakpointDecorations());
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.contentChanges.length > 0 && this.mainFile && e.document.uri.fsPath === this.mainFile) {
        // Les lignes du fichier change ne sont plus fiables : l'utilisateur
        // reassemblera (ou la session le fera) avant de continuer le pas-a-pas.
        this.validLines = new Set();
      }
    });
  }

  async start(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      void vscode.window.showErrorMessage("Ouvrez un fichier assembleur RISC-V avant de deboguer.");
      return;
    }

    await editor.document.save();
    const jarPath = await getJarPath();
    if (!jarPath) {
      return;
    }

    const javaPath = vscode.workspace.getConfiguration(CONFIGURATION_SECTION).get<string>("javaPath", "java");
    const bridgePath = this.context.asAbsolutePath(path.join("resources", "bridge", "RarsBridge.java"));

    this.disposeBridge();
    this.outputChannel.show(true);
    this.outputChannel.appendLine(`Pont RARS : ${javaPath} -cp ${jarPath} ${bridgePath}`);

    const newBridge = new RarsBridge();
    newBridge.start(javaPath, jarPath, bridgePath);
    newBridge.onEvent((event) => this.onEvent(event));
    newBridge.onExit(() => {
      this.outputChannel.appendLine("Pont RARS arrete.");
      this.outputChannel.show(true);
      this.panel.status("pont arrete");
      void vscode.commands.executeCommand("setContext", "rarsVscodium.sessionActive", false);
    });
    this.bridge = newBridge;
    void vscode.commands.executeCommand("setContext", "rarsVscodium.sessionActive", true);

    this.mainFile = editor.document.uri.fsPath;
    this.validLines = new Set();
    this.panel.show();
    this.panel.status("assemblage…");
    newBridge.assemble(this.mainFile);
  }

  step(): void {
    this.bridge?.step();
  }

  continueRun(): void {
    this.bridge?.continueRun();
  }

  pause(): void {
    this.bridge?.pause();
  }

  stop(): void {
    this.bridge?.stop();
  }

  async toggleBreakpointAtCursor(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    const file = editor.document.uri.fsPath;
    const line = editor.selection.active.line + 1;
    const lines = this.breakpoints.get(file) ?? new Set<number>();
    if (lines.has(line)) {
      lines.delete(line);
    } else {
      lines.add(line);
    }
    if (lines.size === 0) {
      this.breakpoints.delete(file);
    } else {
      this.breakpoints.set(file, lines);
    }
    this.refreshBreakpointDecorations();
    if (this.bridge?.alive && this.mainFile === file) {
      this.bridge.toggleBreakpoint(line, lines.has(line));
    }
  }

  dispose(): void {
    this.disposeBridge();
    this.currentLineDecoration.dispose();
    this.breakpointDecoration.dispose();
    this.outputChannel.dispose();
  }

  private disposeBridge(): void {
    if (this.bridge) {
      this.bridge.dispose();
      this.bridge = undefined;
    }
  }

  private onEvent(event: RarsEvent): void {
    switch (event.type) {
      case "assembleOk":
        this.validLines = new Set(event.lines);
        // Rejoue les points d'arret connus pour ce fichier sur le nouveau binaire.
        for (const line of this.breakpoints.get(this.mainFile ?? "") ?? []) {
          this.bridge?.toggleBreakpoint(line, true);
        }
        this.panel.status("assemble, pret (F5 = continuer)");
        this.outputChannel.appendLine(
          `Assemble : ${event.file} (entree ligne ${event.entryLine})`
        );
        break;
      case "assembleErrors":
        for (const err of event.errors) {
          const where = err.line > 0 ? `ligne ${err.line}` : "fichier";
          this.outputChannel.appendLine(`Erreur d'assemblage [${where}] : ${err.message}`);
        }
        void vscode.window.showErrorMessage(
          event.errors.length > 0
            ? `RARS : erreur d'assemblage ligne ${event.errors[0].line} — voir la sortie RARS.`
            : "RARS : echec d'assemblage — voir la sortie RARS."
        );
        this.panel.status("echec d'assemblage");
        break;
      case "breakpoints":
        if (this.mainFile) {
          this.breakpoints.set(this.mainFile, new Set(event.lines));
          this.refreshBreakpointDecorations();
        }
        break;
      case "breakpointRefused":
        if (this.mainFile) {
          const lines = this.breakpoints.get(this.mainFile);
          lines?.delete(event.line);
          this.refreshBreakpointDecorations();
        }
        break;
      case "stopped": {
        const terminated = TERMINATION_REASONS.has(event.reason);
        this.panel.update({
          reason: event.reason,
          pc: event.pc,
          line: event.line,
          instruction: event.instruction,
          expanded: event.expanded,
          exitCode: event.exitCode,
          terminated,
          registers: event.registers,
          fp: event.fp
        });
        if (terminated) {
          this.outputChannel.appendLine(
            `Terminaison (${event.reason}), code de sortie ${event.exitCode}.`
          );
        }
        if (terminated && event.line === undefined) {
          this.clearCurrentLineDecoration();
        } else if (event.line !== undefined) {
          void this.revealLine(event.line - 1, true);
        }
        break;
      }
      case "executionError":
        this.outputChannel.appendLine(`Erreur d'execution ligne ${event.line ?? "?"} : ${event.message}`);
        void vscode.window.showErrorMessage(
          `RARS : ${event.message} (ligne ${event.line ?? "?"})`
        );
        this.panel.status("erreur d'execution");
        break;
      case "output":
        if (event.stream === "err") {
          this.outputChannel.appendLine(event.text);
        } else {
          this.outputChannel.append(event.text);
        }
        this.panel.appendOutput(event.text, event.stream);
        break;
      case "error":
        this.outputChannel.appendLine(`Pont : ${event.message}`);
        break;
    }
  }

  private async revealLine(line: number, highlight = false): Promise<void> {
    const editors = vscode.window.visibleTextEditors.filter(
      (e) => this.mainFile && e.document.uri.fsPath === this.mainFile
    );
    let editor = editors[0];
    if (!editor) {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(this.mainFile!));
      editor = await vscode.window.showTextDocument(document, { preserveFocus: true, preview: false });
    }
    const lineCount = editor.document.lineCount;
    const clamped = Math.max(0, Math.min(line, lineCount - 1));
    const range = new vscode.Range(clamped, 0, clamped, 0);
    editor.selection = new vscode.Selection(range.start, range.end);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    if (highlight) {
      editor.setDecorations(this.currentLineDecoration, [range]);
    }
  }

  private clearCurrentLineDecoration(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      editor.setDecorations(this.currentLineDecoration, []);
    }
  }

  private refreshBreakpointDecorations(): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !this.mainFile || editor.document.uri.fsPath !== this.mainFile) {
      return;
    }
    const lines = this.breakpoints.get(this.mainFile) ?? new Set<number>();
    editor.setDecorations(
      this.breakpointDecoration,
      [...lines].filter((line) => line <= editor.document.lineCount)
        .map((line) => new vscode.Range(line - 1, 0, line - 1, 0))
    );
  }

  private breakpointIconUri(): string {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">' +
      '<circle cx="8" cy="8" r="5" fill="#e5534b"/></svg>';
    return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
  }
}

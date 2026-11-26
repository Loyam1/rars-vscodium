import * as path from "node:path";
import * as vscode from "vscode";
import { RarsBridge, type RarsEvent } from "./rarsBridge";
import { RarsConsole } from "./rarsConsole";

/**
 * Execution simple du fichier actif, sans le panneau de debogage : le pont
 * Java RARS assemble puis execute le programme et envoie chaque sortie
 * (stdout/stderr) vers la console dediee. L'entree du programme se tape dans
 * cette console (syscalls 5/8/12) ; Ctrl+C arrete l'execution.
 *
 * On ne passe plus par un terminal ordinaire (« shellPath = java ») : la
 * resolution du binaire y est fragile (surtout sous Windows) et rien ne
 * garantissait l'affichage des sorties du programme.
 */
export class RarsRunner implements vscode.Disposable {
  private bridge?: RarsBridge;
  private readonly console: RarsConsole;

  constructor() {
    this.console = new RarsConsole("RARS (execution)", {
      onLine: (line) => this.bridge?.sendInput(line),
      onInterrupt: () => this.requestStop()
    });
  }

  async run(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      void vscode.window.showErrorMessage("Ouvrez un fichier assembleur RISC-V avant de lancer RARS.");
      return;
    }

    await editor.document.save();
    const jarPath = getJarPathSetting();
    if (!jarPath) {
      void vscode.window.showErrorMessage(
        "Configurez d'abord le chemin de rars.jar avec la commande « RARS: Choisir le fichier JAR »."
      );
      return;
    }

    // Une seule execution a la fois : l'execution precedente est fermee.
    this.disposeBridge();

    const javaPath = vscode.workspace
      .getConfiguration(CONFIG_SECTION)
      .get<string>("javaPath", "java");

    this.console.clear();
    this.console.show();

    const bridge = new RarsBridge();
    this.bridge = bridge;
    bridge.onEvent((event) => this.onEvent(event));
    bridge.onExit(() => {
      if (this.bridge === bridge) {
        this.bridge = undefined;
      }
    });
    bridge.start(javaPath, jarPath, bridgeResourcePath);
    this.console.message("Execution en cours : assemblage…");
    bridge.assemble(editor.document.uri.fsPath);
  }

  dispose(): void {
    this.disposeBridge();
    this.console.dispose();
  }

  private requestStop(): void {
    this.bridge?.stop();
  }

  private onEvent(event: RarsEvent): void {
    switch (event.type) {
      case "assembleOk":
        this.console.message(`Programme assemble (entree ligne ${event.entryLine}), execution…`);
        this.bridge?.continueRun();
        break;
      case "assembleErrors":
        for (const err of event.errors) {
          const where = err.line > 0 ? `ligne ${err.line}` : "fichier";
          this.console.writeProgramError(`Erreur d'assemblage [${where}] : ${err.message}\n`);
        }
        break;
      case "stopped":
        if (TERMINATION_REASONS.has(event.reason)) {
          this.console.message(`Programme termine, code de sortie ${event.exitCode}.`);
          this.disposeBridge();
        } else if (event.reason === "STOP") {
          this.console.message("Execution arretee (Ctrl+C).");
          this.disposeBridge();
        }
        break;
      case "executionError":
        this.console.writeProgramError(`${event.message} (ligne ${event.line ?? "?"})\n`);
        this.disposeBridge();
        break;
      case "output":
        if (event.stream === "err") {
          this.console.writeProgramError(event.text);
        } else {
          this.console.writeProgram(event.text);
        }
        break;
      case "error":
        this.console.writeProgramError(event.message + "\n");
        break;
      default:
        // regs, speed, breakpoints… : sans objet hors debogage.
        break;
    }
  }

  private disposeBridge(): void {
    if (this.bridge) {
      this.bridge.dispose();
      this.bridge = undefined;
    }
  }
}

const CONFIG_SECTION = "rarsVscodium";
const TERMINATION_REASONS = new Set(["NORMAL_TERMINATION", "CLIFF_TERMINATION", "EXCEPTION"]);

function getJarPathSetting(): string | undefined {
  const configuredPath = vscode.workspace
    .getConfiguration(CONFIG_SECTION)
    .get<string>("jarPath", "");
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (configuredPath) {
    return workspaceFolder && !path.isAbsolute(configuredPath)
      ? path.join(workspaceFolder.uri.fsPath, configuredPath)
      : configuredPath;
  }
  return undefined;
}

/** Chemin du pont Java (RarsBridge.java) dans l'extension, renseigne a l'activation. */
let bridgeResourcePath = "";

/** Appele a l'activation avec context.asAbsolutePath("resources/bridge/RarsBridge.java"). */
export function setBridgeResourcePath(bridgePath: string): void {
  bridgeResourcePath = bridgePath;
}

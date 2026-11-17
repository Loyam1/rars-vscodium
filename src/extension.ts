import * as path from "node:path";
import * as vscode from "vscode";

const CONFIGURATION_SECTION = "rarsVscodium";

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("rarsVscodium.configureJar", configureJar),
    vscode.commands.registerCommand("rarsVscodium.runActiveFile", () => runActiveFile(false)),
    vscode.commands.registerCommand("rarsVscodium.openGui", () => runActiveFile(true))
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

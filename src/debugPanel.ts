import * as vscode from "vscode";

interface PanelMessage {
  command: "step" | "continue" | "pause" | "stop" | "input" | "openLine";
  text?: string;
  line?: number;
}

/**
 * Panneau webview « RARS : registres et execution ».
 * Affiche les registres, l'instruction courante, la sortie du programme
 * et expose les boutons d'execution (continuer / pas-a-pas / pause / arreter).
 */
export class RarsDebugPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private lastRegisters: Record<string, number> = {};
  private lastStatus = "";

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly send: (message: PanelMessage) => void
  ) {}

  show(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "rarsVscodium.debug",
      "RARS — registres et execution",
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true
      }
    );
    this.panel = panel;
    panel.webview.html = this.html(panel.webview);
    panel.onDidDispose(() => {
      this.panel = undefined;
    });
    panel.webview.onDidReceiveMessage((m: PanelMessage) => {
      this.send(m);
      this.refreshButtons(m.command === "step" ? false : m.command === "pause");
    });
    this.refreshButtons(false);
  }

  /** Passe les boutons en mode "programme en attente" (arrete sur un point). */
  status(text: string): void {
    this.lastStatus = text;
    this.postMessage({ type: "state", running: false, status: text });
  }

  private refreshButtons(running: boolean): void {
    this.postMessage({ type: "state", running, status: this.lastStatus });
  }

  update(
    event: {
      reason: string;
      pc: number;
      line?: number;
      instruction?: string;
      expanded?: string;
      exitCode?: number;
      terminated?: boolean;
      registers: Record<string, number>;
      fp: Record<string, number>;
    }
  ): void {
    const previous = this.lastRegisters;
    this.lastRegisters = { ...event.registers, ...event.fp };
    this.postMessage({
      type: "update",
      reason: event.reason,
      pc: event.pc,
      line: event.line,
      instruction: event.instruction,
      expanded: event.expanded,
      exitCode: event.exitCode,
      terminated: event.terminated ?? false,
      registers: event.registers,
      fp: event.fp,
      changed: previous
    });
  }

  appendOutput(text: string, stream: "out" | "err"): void {
    this.postMessage({ type: "output", text, stream });
  }

  private postMessage(message: unknown): void {
    void this.panel?.webview.postMessage(message);
  }

  dispose(): void {
    this.panel?.dispose();
    this.panel = undefined;
  }

  private html(webview: vscode.Webview): string {
    const css = mainStyle();
    const script = webviewScript();
    const nonce = Math.random().toString(36).slice(2);
    return /* html */ `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<title>RARS</title>
${css}
</head>
<body>
  <div class="toolbar">
    <button id="btn-continue">Continuer</button>
    <button id="btn-step">Pas-a-pas</button>
    <button id="btn-pause">Pause</button>
    <button id="btn-stop">Arreter</button>
    <span id="status"></span>
  </div>
  <div id="current" class="current"></div>
  <h2>Registres entiers</h2>
  <div id="regs" class="grid"></div>
  <h2>Registres virgule flottante</h2>
  <div id="fp" class="grid"></div>
  <h2>Entree du programme</h2>
  <div class="input-row">
    <input id="stdin" type="text" placeholder="Texte a envoyer au programme (syscall 5/8/12)">
    <button id="btn-send">Envoyer</button>
  </div>
  <h2>Sortie du programme</h2>
  <pre id="output"></pre>
  <script nonce="${nonce}">${script}</script>
</body>
</html>`;
  }
}

function mainStyle(): string {
  return `<style>
  :root { color-scheme: light dark; }
  body { font-family: sans-serif; font-size: 0.85em; margin: 8px; }
  .toolbar { display: flex; gap: 6px; align-items: baseline; margin-bottom: 6px; }
  button { padding: 2px 10px; cursor: pointer; }
  button:disabled { opacity: 0.5; cursor: default; }
  #status { margin-left: 8px; opacity: 0.8; }
  .current { font-family: monospace; white-space: pre-wrap; min-height: 1.5em;
    background: rgba(255, 200, 0, 0.15); border-left: 3px solid rgba(255, 200, 0, 0.8);
    padding: 4px 8px; margin: 4px 0; visibility: hidden; }
  h2 { font-size: 0.9em; margin: 10px 0 4px; }
  .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 2px 10px; }
  .cell { font-family: monospace; padding: 1px 4px; white-space: nowrap; }
  .cell.changed { background: rgba(255, 160, 0, 0.25); border-radius: 2px; }
  .name { opacity: 0.7; display: inline-block; min-width: 4ch; }
  .input-row { display: flex; gap: 4px; }
  input { flex: 1; }
  #output { font-family: monospace; min-height: 4em; max-height: 12em; overflow: auto;
    border: 1px solid rgba(128,128,128,0.3); border-radius: 3px; padding: 4px; }
  #output .err { color: #e5534b; }
  </style>`;
}

function webviewScript(): string {
  return `
  const vs = acquireVsCodeApi();
  const BUTTONS = ["btn-continue", "btn-step", "btn-pause", "btn-stop", "btn-send"];
  function setButtonsEnabled(enabled) {
    for (const id of BUTTONS) {
      document.getElementById(id).disabled = !enabled;
    }
  }
  function fmt(v) {
    return (v < 0 ? v + 4294967296 : v).toString(16).padStart(8, "0").toUpperCase();
  }
  function renderGrid(el, regs, changed) {
    el.innerHTML = "";
    for (const [name, value] of Object.entries(regs)) {
      if (name === "pc") continue;
      const cell = document.createElement("div");
      cell.className = "cell" + (changed[name] !== undefined && changed[name] !== value ? " changed" : "");
      const label = document.createElement("span");
      label.className = "name";
      label.textContent = name;
      cell.appendChild(label);
      cell.appendChild(document.createTextNode(fmt(value)));
      el.appendChild(cell);
    }
  }
  document.getElementById("btn-continue").onclick = () => vs.postMessage({ command: "continue" });
  document.getElementById("btn-step").onclick = () => vs.postMessage({ command: "step" });
  document.getElementById("btn-pause").onclick = () => vs.postMessage({ command: "pause" });
  document.getElementById("btn-stop").onclick = () => vs.postMessage({ command: "stop" });
  document.getElementById("btn-send").onclick = () => {
    const input = document.getElementById("stdin");
    vs.postMessage({ command: "input", text: input.value });
    input.value = "";
  };
  const currentEl = document.getElementById("current");
  const statusEl = document.getElementById("status");
  const outputEl = document.getElementById("output");
  window.addEventListener("message", (event) => {
    const m = event.data;
    if (m.type === "state") {
      setButtonsEnabled(!m.running);
      statusEl.textContent = m.status;
      return;
    }
    if (m.type === "update") {
      renderGrid(document.getElementById("regs"), m.registers, m.changed || {});
      renderGrid(document.getElementById("fp"), m.fp, m.changed || {});
      if (m.instruction) {
        currentEl.style.visibility = "visible";
        currentEl.textContent = "PC " + fmt(m.pc) + "\\n" + m.instruction +
          (m.expanded && m.expanded !== m.instruction ? "  =>  " + m.expanded : "");
      }
      const reasons = {
        BREAKPOINT: "point d'arret",
        MAX_STEPS: "pas-a-pas",
        PAUSE: "en pause",
        STOP: "arrete",
        NORMAL_TERMINATION: "termine",
        CLIFF_TERMINATION: "sortie de la zone de code",
        EXCEPTION: "exception"
      };
      const base = reasons[m.reason] || m.reason;
      statusEl.textContent = m.terminated
        ? base + " (code de sortie " + m.exitCode + ")"
        : base + " — ligne " + m.line;
      setButtonsEnabled(true);
      return;
    }
    if (m.type === "output") {
      const span = document.createElement("span");
      if (m.stream === "err") span.className = "err";
      span.textContent = m.text;
      outputEl.appendChild(span);
      outputEl.scrollTop = outputEl.scrollHeight;
      return;
    }
  });
  setButtonsEnabled(true);
  `;
}

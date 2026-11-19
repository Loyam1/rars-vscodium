import * as vscode from "vscode";

interface PanelMessage {
  command: "launch" | "continue" | "pause" | "stop" | "step" | "back" | "input" | "openLine" | "speed";
  text?: string;
  line?: number;
  index?: number;
}

/**
 * Panneau webview « RARS : registres et execution ».
 * Affiche les registres (hexadecimal + decimal, flottants decodees), l'instruction
 * courante et expose les boutons d'execution (continuer / pas-a-pas / pause /
 * arreter). Les E/S de texte du programme passent par le terminal
 * « RARS (console) » (voir RarsConsole), comme pour « Executer le fichier actif ».
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
      // Ces commandes lancent une execution : l'etat « en cours » (Lancer ->
      // Arreter, Continuer -> Pause) reste affiche jusqu'a l'evenement stopped.
      if (
        m.command === "step" || m.command === "continue" ||
        m.command === "launch" || m.command === "back"
      ) {
        this.postMessage({ type: "state", running: true, status: this.lastStatus });
      }
    });
  }

  /** Passe les boutons en mode "programme en attente" (arrete sur un point). */
  status(text: string): void {
    this.lastStatus = text;
    this.postMessage({ type: "state", running: false, status: text });
  }

  /** Met a jour l'etat « execution en cours » sans changer le texte de statut. */
  setRunning(running: boolean): void {
    this.postMessage({ type: "state", running, status: this.lastStatus });
  }

  /** Position du curseur de vitesse et table des vitesses recues du pont. */
  setSpeed(index: number, table: number[]): void {
    this.postMessage({ type: "speed", index, table });
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

  /** Positions periodiques des registres pendant l'execution continue. */
  updateRegs(
    registers: Record<string, number>,
    fp: Record<string, number>,
    waitingInput?: boolean,
    position?: { pc?: number; line?: number; instruction?: string; expanded?: string }
  ): void {
    const previous = this.lastRegisters;
    const next = { ...registers, ...fp };
    const changed: Record<string, number> = {};
    for (const [name, value] of Object.entries(next)) {
      if (previous[name] !== value) {
        changed[name] = previous[name] ?? value;
      }
    }
    this.lastRegisters = next;
    this.postMessage({ type: "regs", registers, fp, changed, waitingInput, ...position });
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
    <button id="btn-launch">Lancer</button>
    <button id="btn-cont">Continuer</button>
    <button id="btn-step">Pas-a-pas</button>
    <button id="btn-back">Precedent</button>
    <span id="status"></span>
  </div>
  <div class="speed">
    <div id="speed-label">Vitesse : maximale (sans interaction)</div>
    <input id="speed-slider" type="range" min="0" max="40" step="1" value="40" aria-label="Vitesse d'execution">
  </div>
  <div id="current" class="current"></div>
  <h2>Registres entiers</h2>
  <div id="regs" class="grid"></div>
  <h2>Registres virgule flottante (bits / valeur)</h2>
  <div id="fp" class="grid"></div>
  <p class="hint">Le texte du programme (sortie et reponses aux syscalls de lecture)
  s'affiche dans le terminal « RARS (console) ». Tapez une ligne puis Entree pour
  repondre au programme. Ctrl+C arrete l'execution.</p>
  <script nonce="${nonce}">${script}</script>
</body>
</html>`;
  }
}

function mainStyle(): string {
  return `<style>
  :root { color-scheme: light dark; }
  body { font-family: sans-serif; font-size: 0.85em; margin: 8px; }
  .toolbar { display: flex; gap: 6px; align-items: baseline; margin-bottom: 6px; flex-wrap: wrap; }
  button { padding: 2px 10px; cursor: pointer; }
  button:disabled { opacity: 0.5; cursor: default; }
  #status { flex-basis: 100%; flex-shrink: 0; width: 100%; margin: 0; opacity: 0.8; }
  .speed { margin: 2px 0 8px; }
  #speed-label { text-align: center; margin: 0 0 2px; white-space: nowrap;
    overflow: hidden; text-overflow: ellipsis; }
  #speed-slider { width: 100%; margin: 0; padding: 0; }
  .current { font-family: monospace; white-space: pre-wrap; min-height: 1.5em;
    background: rgba(255, 200, 0, 0.15); border-left: 3px solid rgba(255, 200, 0, 0.8);
    padding: 4px 8px; margin: 4px 0; visibility: hidden; }
  h2 { font-size: 0.9em; margin: 10px 0 4px; }
  .grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 2px 14px; }
  .cell { font-family: monospace; padding: 1px 4px; white-space: nowrap; }
  .cell.changed { background: rgba(255, 160, 0, 0.25); border-radius: 2px; }
  .name { opacity: 0.7; display: inline-block; min-width: 9ch; }
  .val { display: inline-block; min-width: 9ch; }
  .dec { opacity: 0.65; }
  .hint { opacity: 0.7; font-size: 0.9em; }
  </style>`;
}

function webviewScript(): string {
  return `
  const vs = acquireVsCodeApi();
  // Machine a etats des boutons : Lancer <-> Arreter, Continuer <-> Pause.
  let running = false;
  let terminated = false;
  let waitingInput = false;
  function refreshButtons() {
    document.getElementById("btn-launch").textContent = running ? "Arreter" : "Lancer";
    const cont = document.getElementById("btn-cont");
    cont.textContent = running ? "Pause" : "Continuer";
    cont.disabled = terminated;
    document.getElementById("btn-step").disabled = running || terminated;
    document.getElementById("btn-back").disabled = running || terminated;
  }
  document.getElementById("btn-launch").onclick = () => {
    if (running) {
      vs.postMessage({ command: "stop" });
    } else {
      running = true;
      terminated = false;
      waitingInput = false;
      vs.postMessage({ command: "launch" });
    }
    refreshButtons();
  };
  document.getElementById("btn-cont").onclick = () => {
    if (running) {
      if (waitingInput) {
        statusEl.textContent = "pause prevue des que vous aurez repondu dans le terminal « RARS (console) »";
      }
      vs.postMessage({ command: "pause" });
    } else {
      running = true;
      vs.postMessage({ command: "continue" });
    }
    refreshButtons();
  };
  document.getElementById("btn-step").onclick = () => {
    if (!running && !terminated) {
      running = true;
      vs.postMessage({ command: "step" });
      refreshButtons();
    }
  };
  document.getElementById("btn-back").onclick = () => {
    if (!running && !terminated) {
      running = true;
      vs.postMessage({ command: "back" });
      refreshButtons();
    }
  };
  // Curseur de vitesse d'execution : indices de la table native RARS
  // (0 = 0.05 inst/sec le plus lent, dernier indice = vitesse maximale).
  let speedTable = [];
  let speedIndex = 40;
  const speedSlider = document.getElementById("speed-slider");
  const speedLabel = document.getElementById("speed-label");
  function updateSpeedLabel() {
    const speed = speedTable[speedIndex];
    if (speed === undefined) {
      return;
    }
    speedLabel.textContent = speed >= 40
      ? "Vitesse maximale (sans interaction)"
      : "Vitesse d'execution : " + speed + " inst/sec";
  }
  speedSlider.addEventListener("input", () => {
    const index = parseInt(speedSlider.value, 10);
    if (Number.isNaN(index) || index === speedIndex) {
      return;
    }
    speedIndex = index;
    updateSpeedLabel();
    vs.postMessage({ command: "speed", index });
  });

  // Noms ABI -> numero de registre xN (ordre RARS : zero ra sp gp tp t0 t1 t2 s0 s1 a0..a7 s2..s11 t3..t6)
  const INT_ORDER = ["zero","ra","sp","gp","tp","t0","t1","t2","s0","s1","a0","a1","a2","a3","a4","a5","a6","a7",
    "s2","s3","s4","s5","s6","s7","s8","s9","s10","s11","t3","t4","t5","t6"];
  const XNAMES = {};
  INT_ORDER.forEach((n, i) => { XNAMES[n] = "x" + i; });

  function fmtHex(v) {
    return (v < 0 ? v + 4294967296 : v).toString(16).padStart(8, "0").toUpperCase();
  }
  function fmtDec(v) {
    return String(v);
  }
  // Les registres FP arrivent en bits bruts (entier non signe 32 bits) : on
  // reinterprete en float IEEE 754 pour afficher la vraie valeur.
  function fmtFloat(v) {
    const view = new DataView(new ArrayBuffer(4));
    view.setUint32(0, v < 0 ? v + 4294967296 : v, false);
    const f = view.getFloat32(0, false);
    if (Number.isInteger(f) && Math.abs(f) < 1e15) return String(f);
    return String(f);
  }
  function renderGrid(el, regs, changed) {
    el.innerHTML = "";
    for (const [name, value] of Object.entries(regs)) {
      if (name === "pc") continue;
      const cell = document.createElement("div");
      cell.className = "cell" + (changed[name] !== undefined && changed[name] !== value ? " changed" : "");
      const label = document.createElement("span");
      label.className = "name";
      label.textContent = XNAMES[name] ? name + " (" + XNAMES[name] + ")" : name;
      const hex = document.createElement("span");
      hex.className = "val";
      hex.textContent = fmtHex(value);
      const dec = document.createElement("span");
      dec.className = "dec";
      dec.textContent = name in XNAMES ? fmtDec(value) : fmtFloat(value);
      cell.appendChild(label);
      cell.appendChild(hex);
      cell.appendChild(document.createTextNode("  "));
      cell.appendChild(dec);
      el.appendChild(cell);
    }
  }
  const currentEl = document.getElementById("current");
  const statusEl = document.getElementById("status");
  window.addEventListener("message", (event) => {
    const m = event.data;
    if (m.type === "speed") {
      speedTable = m.table || [];
      speedIndex = Math.max(0, Math.min(m.index ?? speedIndex, speedTable.length - 1));
      speedSlider.min = 0;
      speedSlider.max = speedTable.length - 1;
      // Affectation programmatique : declenche pas d'evenement input.
      speedSlider.value = speedIndex;
      updateSpeedLabel();
      return;
    }
    if (m.type === "state") {
      running = m.running;
      terminated = false;
      statusEl.textContent = m.status;
      refreshButtons();
      return;
    }
    if (m.type === "update") {
      running = false;
      terminated = !!m.terminated;
      waitingInput = false;
      renderGrid(document.getElementById("regs"), m.registers, m.changed || {});
      renderGrid(document.getElementById("fp"), m.fp, m.changed || {});
      if (m.instruction) {
        currentEl.style.visibility = "visible";
        currentEl.textContent = "PC " + fmtHex(m.pc) + "\\n" + m.instruction +
          (m.expanded && m.expanded !== m.instruction ? "  =>  " + m.expanded : "");
      }
      const reasons = {
        BREAKPOINT: "point d'arret",
        MAX_STEPS: "pas-a-pas",
        PAUSE: "en pause",
        STOP: "arrete",
        BACKSTEP: "precedent",
        NORMAL_TERMINATION: "termine",
        CLIFF_TERMINATION: "sortie de la zone de code",
        EXCEPTION: "exception"
      };
      const base = reasons[m.reason] || m.reason;
      statusEl.textContent = m.terminated
        ? base + (m.exitCode !== undefined ? " (code de sortie " + m.exitCode + ")" : "")
        : base + (m.line !== undefined ? " — ligne " + m.line : "");
      refreshButtons();
      return;
    }
    if (m.type === "regs") {
      // Rafraichissement periodique en execution continue : registres + ligne
      // courante (afin de suivre l'execution comme en pas-a-pas).
      renderGrid(document.getElementById("regs"), m.registers, m.changed || {});
      renderGrid(document.getElementById("fp"), m.fp, m.changed || {});
      if (m.pc !== undefined && m.instruction) {
        currentEl.style.visibility = "visible";
        currentEl.textContent = "PC " + fmtHex(m.pc) + "\\n" + m.instruction +
          (m.expanded && m.expanded !== m.instruction ? "  =>  " + m.expanded : "");
      }
      if (m.waitingInput === true) {
        waitingInput = true;
        statusEl.textContent = "en attente d'une entree : repondez dans le terminal « RARS (console) »";
      } else if (waitingInput) {
        waitingInput = false;
        statusEl.textContent = "en execution…";
      }
      return;
    }
  });
  refreshButtons();
  `;
}

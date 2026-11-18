import * as vscode from "vscode";

/**
 * Terminal « RARS (console) » : affiche la sortie du programme simule et
 * collecte les lignes tapees par l'utilisateur (entree du programme, syscalls
 * 5/8/12). Le panneau webview garde les boutons et les registres ; les E/S de
 * texte passent ici, comme avec « Executer le fichier actif ».
 */
export class RarsConsole implements vscode.Disposable {
  private readonly writeEmitter = new vscode.EventEmitter<string>();
  private readonly onDidWrite: vscode.Event<string> = this.writeEmitter.event;
  private terminal?: vscode.Terminal;
  private pendingLine = "";
  private opened = false;
  private readonly pendingWrites: string[] = [];
  private readonly onLine?: (line: string) => void;
  private readonly interrupt?: () => void;

  constructor(
    private readonly name: string,
    handlers: { onLine?: (line: string) => void; onInterrupt?: () => void }
  ) {
    this.onLine = handlers.onLine;
    this.interrupt = handlers.onInterrupt;
  }

  /** Affiche le terminal (sans voler le focus au panneau). */
  show(): void {
    this.ensureTerminal().show(true);
  }

  /** Sortie du programme simulate (stdout). */
  writeProgram(text: string): void {
    // Dans une pty, un '\n' seul descend le curseur sans revenir au debut de
    // ligne : on normalise en CRLF.
    this.write(text.replace(/\r?\n/g, "\r\n"));
  }

  /** Sortie d'erreur du programme simulate (stderr), en rouge. */
  writeProgramError(text: string): void {
    this.write(`\x1b[31m${text.replace(/\r?\n/g, "\r\n")}\x1b[39m`);
  }

  /** Message de l'extension (assemble, terminaison…), en cyan. */
  message(text: string): void {
    this.write(`\x1b[36m[RARS] ${text}\x1b[39m\r\n`);
  }

  clear(): void {
    this.write("\x1b[2J\x1b[1;1H");
  }

  dispose(): void {
    this.terminal?.dispose();
    this.terminal = undefined;
    this.writeEmitter.dispose();
  }

  private write(text: string): void {
    this.ensureTerminal();
    if (this.opened) {
      this.writeEmitter.fire(text);
    } else {
      // Les evenements fires avant pty.open() sont ignores par VSCodium.
      this.pendingWrites.push(text);
    }
  }

  private ensureTerminal(): vscode.Terminal {
    if (this.terminal) {
      return this.terminal;
    }
    const self = this;
    const pty: vscode.Pseudoterminal = {
      onDidWrite: this.writeEmitter.event,
      open(): void {
        self.opened = true;
        const queued = self.pendingWrites.splice(0);
        for (const text of queued) {
          self.writeEmitter.fire(text);
        }
        self.writeEmitter.fire(
          "RARS : console du programme.\r\nTapez une ligne puis Entree pour repondre au programme (syscall de lecture).\r\n\r\n"
        );
      },
      close(): void {
        self.terminal = undefined;
        self.pendingLine = "";
      },
      handleInput(data: string): void {
        self.handleKeystrokes(data);
      }
    };
    this.terminal = vscode.window.createTerminal({ name: this.name, pty });
    return this.terminal;
  }

  private handleKeystrokes(data: string): void {
    // Filtre les sequences d'echappement du clavier (fleches, F1-F12...) pour
    // qu'elles ne s'ecrivent pas dans la ligne en cours.
    const clean = data.replace(/\x1b\[[0-9;?]*[A-Za-z~]/g, "").replace(/\x1b[A-Z]/g, "").replace(/\x1b/g, "");
    for (const ch of clean) {
      if (ch === "\r") {
        this.writeEmitter.fire("\r\n");
        const line = this.pendingLine;
        this.pendingLine = "";
        this.onLine?.(line);
      } else if (ch === "\x7f") {
        // Retour arriere : efface le dernier caractere, terminal inclus.
        if (this.pendingLine.length > 0) {
          this.pendingLine = this.pendingLine.slice(0, -1);
          this.writeEmitter.fire("\b \b");
        }
      } else if (ch === "\x03") {
        // Ctrl+C : arrete l'execution en cours (la session reste ouverte).
        if (this.pendingLine.length > 0) {
          this.writeEmitter.fire("\r\n");
          this.pendingLine = "";
        } else {
          this.writeEmitter.fire("^C\r\n");
          this.interrupt?.();
        }
      } else if (ch >= " ") {
        this.pendingLine += ch;
        this.writeEmitter.fire(ch);
      }
    }
  }
}

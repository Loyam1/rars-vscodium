import { spawn, ChildProcess } from "node:child_process";
import * as vscode from "vscode";

export interface AssembleOkEvent {
  type: "assembleOk";
  file: string;
  entryLine: number;
  lines: number[];
}

export interface AssembleError {
  file: string;
  line: number;
  message: string;
}

export interface AssembleErrorsEvent {
  type: "assembleErrors";
  errors: AssembleError[];
}

export interface BreakpointsEvent {
  type: "breakpoints";
  lines: number[];
}

export interface BreakpointRefusedEvent {
  type: "breakpointRefused";
  line: number;
  message: string;
}

export interface StoppedEvent {
  type: "stopped";
  reason: string;
  pc: number;
  exitCode: number;
  line?: number;
  file?: string;
  instruction?: string;
  expanded?: string;
  registers: Record<string, number>;
  fp: Record<string, number>;
}

export interface RegsEvent {
  type: "regs";
  /** Vrai quand la simulation est bloquee dans une lecture (syscall 5/8/12). */
  waitingInput?: boolean;
  /** Vrai quand l'execution est cadencee (curseur de vitesse sous le max). */
  throttled?: boolean;
  /** Instruction courante (comme stopped), pour suivre la ligne en execution. */
  pc?: number;
  line?: number;
  instruction?: string;
  expanded?: string;
  registers: Record<string, number>;
  fp: Record<string, number>;
}

export interface ExecutionErrorEvent {
  type: "executionError";
  message: string;
  reason: string;
  pc: number;
  line?: number;
}

export interface OutputEvent {
  type: "output";
  stream: "out" | "err";
  text: string;
}

export interface RarsErrorEvent {
  type: "error";
  message: string;
}

export interface SpeedEvent {
  type: "speed";
  /** Position du curseur de vitesse RARS (0 = le plus lent, 40 = au max). */
  index: number;
  /** Table des vitesses RARS en inst/sec ; les dernieres valeurs = au max. */
  table: number[];
}

export type RarsEvent =
  | AssembleOkEvent
  | AssembleErrorsEvent
  | BreakpointsEvent
  | BreakpointRefusedEvent
  | StoppedEvent
  | RegsEvent
  | ExecutionErrorEvent
  | OutputEvent
  | RarsErrorEvent
  | SpeedEvent;

/**
 * Process Java qui pilote RARS (assembleur, pas-a-pas, points d'arret).
 * Une commande par ligne sur stdin, une ligne JSON par evenement sur stdout.
 */
export class RarsBridge implements vscode.Disposable {
  private process?: ChildProcess;
  private stdoutBuffer = "";
  private readonly eventEmitter = new vscode.EventEmitter<RarsEvent>();
  private readonly exitEmitter = new vscode.EventEmitter<void>();

  readonly onEvent = this.eventEmitter.event;
  readonly onExit = this.exitEmitter.event;

  start(javaPath: string, jarPath: string, bridgePath: string): void {
    this.process = spawn(javaPath, ["-cp", jarPath, bridgePath]);

    this.process.stdout?.setEncoding("utf8");
    this.process.stdout?.on("data", (chunk: string) => {
      this.stdoutBuffer += chunk;
      let newline = this.stdoutBuffer.indexOf("\n");
      while (newline >= 0) {
        const line = this.stdoutBuffer.slice(0, newline).trim();
        this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
        if (line) {
          this.dispatch(line);
        }
        newline = this.stdoutBuffer.indexOf("\n");
      }
    });

    this.process.stderr?.setEncoding("utf8");
    this.process.stderr?.on("data", (chunk: string) => {
      // Diagnostics de la JVM elle-meme (hors protocole).
      this.eventEmitter.fire({ type: "output", stream: "err", text: chunk });
    });

    this.process.on("exit", () => {
      this.process = undefined;
      this.exitEmitter.fire();
    });
  }

  private dispatch(line: string): void {
    let event: RarsEvent;
    try {
      event = JSON.parse(line) as RarsEvent;
    } catch {
      this.eventEmitter.fire({ type: "error", message: `Ligne non JSON du pont : ${line}` });
      return;
    }
    this.eventEmitter.fire(event);
  }

  get alive(): boolean {
    return this.process !== undefined;
  }

  assemble(file: string): void {
    this.write(`AS ${file}`);
  }

  toggleBreakpoint(line: number, set: boolean): void {
    this.write(`BP ${line} ${set ? 1 : 0}`);
  }

  step(): void {
    this.write("STEP");
  }

  /** Pas-a-pas arriere : annule la derniere instruction (historique RARS). */
  backStep(): void {
    this.write("BACK");
  }

  continueRun(): void {
    this.write("CONT");
  }

  /** Regle la vitesse d'execution continue (indice dans la table RARS). */
  setSpeed(index: number): void {
    this.write(`SPEED ${index}`);
  }

  pause(): void {
    this.write("PAUSE");
  }

  stop(): void {
    this.write("STOP");
  }

  sendInput(text: string): void {
    this.write(`IN ${text}`);
  }

  quit(): void {
    this.write("QUIT");
  }

  private write(command: string): void {
    if (!this.process?.stdin?.writable) {
      return;
    }
    this.process.stdin.write(command + "\n");
  }

  dispose(): void {
    if (this.process?.stdin?.writable) {
      try {
        this.stdinQuit();
      } catch {
        // canal deja ferme
      }
    }
    const p = this.process;
    if (p && p.exitCode === null) {
      p.kill();
    }
    this.process = undefined;
    this.eventEmitter.dispose();
    this.exitEmitter.dispose();
  }

  private stdinQuit(): void {
    this.process?.stdin?.write("QUIT\n");
  }
}

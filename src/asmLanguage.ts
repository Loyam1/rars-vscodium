import * as vscode from "vscode";
import {
  asRegister,
  getInstruction,
  matchingInstructions,
  REGISTERS
} from "./instructions";

/**
 * Fonctions de langage pour les fichiers RISC-V (.asm, .s) :
 * - completion des commandes : n'insere QUE la commande, jamais les arguments ;
 * - texte fantome (inlay hints) montrant les arguments attendus tant qu'ils
 *   ne sont pas tous ecrits ; le fantome reste affiche meme si le curseur
 *   quitte la ligne (Entree) et disparait des que l'argument reel est ecrit ;
 * - survol d'une commande : explication courte + role de chaque argument ;
 * - survol d'un registre : la phrase attachee dans un commentaire
 *   « t0="compteur" », sinon le role standard du registre.
 */

const DOCUMENT_SELECTOR: vscode.DocumentSelector = [
  { scheme: "file", pattern: "**/*.asm" },
  { scheme: "file", pattern: "**/*.s" },
  { scheme: "untitled", pattern: "**/*.asm" }
];

/** Nombre d'arguments attendus, deduit de la forme d'usage (« li rd, imm » -> 2). */
function expectedArgs(info: { usage: string }): number {
  const operands = info.usage.split(/\s+/).slice(1).join(" ");
  if (!operands) {
    return 0;
  }
  return operands.split(",").length;
}

/** Renvoie le texte de la ligne sans le commentaire (# ...), un # entre guillemets ne compte pas. */
function codePart(line: string): string {
  const hash = commentStart(line);
  return (hash >= 0 ? line.slice(0, hash) : line).trimEnd();
}

/** Position du premier # hors chaine, ou -1. */
function commentStart(line: string): number {
  let inString = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"' && line[i - 1] !== "\\") {
      inString = !inString;
    } else if (ch === "#" && !inString) {
      return i;
    }
  }
  return -1;
}

/** Compte les operandes deja ecrits apres la commande (« t0,10 » -> 2). */
function countOperands(rest: string): number {
  const trimmed = rest.trim();
  if (!trimmed) {
    return 0;
  }
  const parts = trimmed.includes(",") ? trimmed.split(",") : trimmed.split(/\s+/);
  return parts.filter((p) => p.trim().length > 0).length;
}

// ---------------------------------------------------------------- completion

class InstructionCompletionProvider implements vscode.CompletionItemProvider {
  provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.CompletionList {
    const word = document.getWordRangeAtPosition(position);
    const prefix = word ? document.getText(word).toLowerCase() : "";
    const items: vscode.CompletionItem[] = [];

    for (const [mnemonic, info] of matchingInstructions(prefix)) {
      const item = new vscode.CompletionItem(mnemonic, vscode.CompletionItemKind.Function);
      item.detail = info.usage;
      item.documentation = instructionDocumentation(info);
      // Uniquement la commande : les arguments restent a ecrire, le texte
      // fantome les affiche en attendant.
      item.insertText = mnemonic;
      items.push(item);
    }

    for (const [name, description] of Object.entries(REGISTERS)) {
      if (!name.startsWith(prefix)) {
        continue;
      }
      const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Variable);
      item.detail = description;
      item.documentation = new vscode.MarkdownString(`**${name}** : ${description}`);
      item.sortText = `z${name}`;
      item.insertText = name;
      items.push(item);
    }

    return new vscode.CompletionList(items);
  }
}

function instructionDocumentation(info: { summary: string; usage: string; args: string }): vscode.MarkdownString {
  const doc = new vscode.MarkdownString();
  doc.appendMarkdown(`${info.summary}\n\n`);
  doc.appendCodeblock(info.usage, "riscv");
  const args = info.args.split(";").map((a) => a.trim()).filter(Boolean);
  if (args.length > 0 && args[0] !== "(aucun argument)") {
    doc.appendMarkdown("\n\n" + args.map((a) => `- ${a}`).join("\n"));
  }
  return doc;
}

// ------------------------------------------------------------- texte fantome

class MissingArgsInlayHintsProvider implements vscode.InlayHintsProvider {
  provideInlayHints(
    document: vscode.TextDocument,
    range: vscode.Range
  ): vscode.InlayHint[] {
    const hints: vscode.InlayHint[] = [];
    const first = Math.max(0, range.start.line);
    const last = Math.min(document.lineCount - 1, range.end.line);

    for (let line = first; line <= last; line++) {
      const code = codePart(document.lineAt(line).text);
      const match = code.match(/^([A-Za-z_][A-Za-z0-9_.]*)\b/);
      if (!match) {
        continue;
      }
      const info = getInstruction(match[1]);
      if (!info) {
        continue;
      }
      const expected = expectedArgs(info);
      const written = countOperands(code.slice(match[1].length));
      if (written >= expected) {
        continue;
      }
      const all = info.usage.split(/\s+/).slice(1).join(" ").split(",").map((a) => a.trim());
      const missing = all.slice(written);
      const hint = new vscode.InlayHint(
        new vscode.Position(line, code.length),
        (written > 0 ? ", " : "") + missing.join(", "),
        vscode.InlayHintKind.Parameter
      );
      hint.paddingLeft = true;
      hint.tooltip = new vscode.MarkdownString(
        `**${info.usage}**\n\n${info.summary}\n\n${info.args.split(";").map((a) => a.trim()).join("\n\n")}`
      );
      hints.push(hint);
    }
    return hints;
  }
}

// -------------------------------------------------------------------- survol

class AsmHoverProvider implements vscode.HoverProvider {
  async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position
  ): Promise<vscode.Hover | undefined> {
    const word = document.getWordRangeAtPosition(position);
    if (!word) {
      return undefined;
    }
    const token = document.getText(word);

    const info = getInstruction(token);
    if (info) {
      return new vscode.Hover(instructionDocumentation(info));
    }

    const register = asRegister(token);
    if (register) {
      // Etiquette personnalisee uniquement pendant le debogage, a la ligne
      // en cours d'execution : les definitions se revelent petit a petit.
      if (executionPosition && executionPosition.file === document.uri.fsPath) {
        const definitions = parseRegisterDefinitions(document);
        const label = activeLabels(definitions, executionPosition.line).get(register);
        if (label !== undefined) {
          return new vscode.Hover(
            new vscode.MarkdownString(`**${register}** = « ${label} »`)
          );
        }
      }
      const description = REGISTERS[register];
      if (description) {
        return new vscode.Hover(new vscode.MarkdownString(`**${register}** : ${description}`));
      }
    }
    return undefined;
  }
}

// ------------------------------------------------------- etiquettes de registres

/** Une definition d'etiquette dans un commentaire : « li t0,0 # t0="compteur" ». */
export interface RegisterDefinition {
  /** Ligne (1-based) de la definition. */
  line: number;
  label: string;
}

/**
 * Extrait TOUTES les definitions de registres des commentaires du document,
 * dans l'ordre du fichier. Un meme registre peut etre defini plusieurs fois :
 * c'est la definition la plus recente AVANT la ligne en cours d'execution
 * qui fait foi (voir activeLabels).
 */
export function parseRegisterDefinitions(
  document: vscode.TextDocument
): Map<string, RegisterDefinition[]> {
  const definitions = new Map<string, RegisterDefinition[]>();
  const pattern =
    /\b(x\d{1,2}|zero|ra|sp|gp|tp|fp|t\d|s\d{1,2}|a\d|ft\d{1,2}|fs\d{1,2}|fa\d|f\d{1,2})\s*=\s*"([^"\n]*)"/gi;
  for (let i = 0; i < document.lineCount; i++) {
    const text = document.lineAt(i).text;
    const hash = commentStart(text);
    if (hash < 0) {
      continue;
    }
    for (const match of text.slice(hash + 1).matchAll(pattern)) {
      const register = asRegister(match[1]);
      if (register) {
        const list = definitions.get(register) ?? [];
        list.push({ line: i + 1, label: match[2] });
        definitions.set(register, list);
      }
    }
  }
  return definitions;
}

/**
 * Etiquettes actives a la ligne d'execution donnee : pour chaque registre, la
 * derniere definition placee a ou avant currentLine — les etiquettes se
 * definissent donc petit a petit pendant le debogage, et reviennent en
 * arriere avec le pas-a-pas arriere.
 */
export function activeLabels(
  definitions: Map<string, RegisterDefinition[]>,
  currentLine: number
): Map<string, string> {
  const labels = new Map<string, string>();
  for (const [register, list] of definitions) {
    let active: RegisterDefinition | undefined;
    for (const def of list) {
      if (def.line <= currentLine) {
        active = def;
      }
    }
    if (active) {
      labels.set(register, active.label);
    }
  }
  return labels;
}

/** Position d'execution courante du fichier principal (session de debogage). */
let executionPosition: { file: string; line: number } | undefined;

/** Mis a jour par la session de debogage a chaque arret ou position regs. */
export function setExecutionPosition(file: string | undefined, line?: number): void {
  executionPosition = file !== undefined && line !== undefined ? { file, line } : undefined;
}

/** Enregistre tous les fournisseurs de langage ; a ajouter aux subscriptions. */
export function registerAsmLanguage(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(DOCUMENT_SELECTOR, new InstructionCompletionProvider()),
    vscode.languages.registerInlayHintsProvider(DOCUMENT_SELECTOR, new MissingArgsInlayHintsProvider()),
    vscode.languages.registerHoverProvider(DOCUMENT_SELECTOR, new AsmHoverProvider())
  );
}

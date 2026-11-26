/**
 * Base d'instructions RISC-V supportees par RARS 1.6.
 * `summary` : explication courte (francais sans accents, style du code existant).
 * `args` : role de chaque argument de la forme « nom = description » separe par « ; ».
 * L'ordre des noms dans args correspond a l'ordre dans usage.
 */
export interface InstructionInfo {
  summary: string;
  usage: string;
  args: string;
}

const INSTRUCTIONS: Record<string, InstructionInfo> = {
  // Arithmetique
  add: { summary: "Addition : rd = rs1 + rs2.", usage: "add rd, rs1, rs2", args: "rd = registre destination ; rs1 = premier operande (registre) ; rs2 = second operande (registre)" },
  addi: { summary: "Addition avec une constante : rd = rs1 + imm.", usage: "addi rd, rs1, imm", args: "rd = registre destination ; rs1 = operande (registre) ; imm = valeur constante (nombre)" },
  sub: { summary: "Soustraction : rd = rs1 - rs2.", usage: "sub rd, rs1, rs2", args: "rd = registre destination ; rs1 = premier operande ; rs2 = second operande" },
  mul: { summary: "Multiplication 32 bits (32 bits bas) : rd = rs1 * rs2.", usage: "mul rd, rs1, rs2", args: "rd = registre destination ; rs1 = premier facteur ; rs2 = second facteur" },
  mulh: { summary: "Multiplication signee, 32 bits hauts du produit.", usage: "mulh rd, rs1, rs2", args: "rd = registre destination ; rs1 = premier facteur ; rs2 = second facteur" },
  mulhu: { summary: "Multiplication non signee, 32 bits hauts du produit.", usage: "mulhu rd, rs1, rs2", args: "rd = registre destination ; rs1 = premier facteur ; rs2 = second facteur" },
  div: { summary: "Division entiere signee : rd = rs1 / rs2.", usage: "div rd, rs1, rs2", args: "rd = registre destination (quotient) ; rs1 = dividende ; rs2 = diviseur" },
  divu: { summary: "Division entiere non signee.", usage: "divu rd, rs1, rs2", args: "rd = registre destination (quotient) ; rs1 = dividende ; rs2 = diviseur" },
  rem: { summary: "Reste de la division signee : rd = rs1 % rs2.", usage: "rem rd, rs1, rs2", args: "rd = registre destination (reste) ; rs1 = dividende ; rs2 = diviseur" },
  remu: { summary: "Reste de la division non signee.", usage: "remu rd, rs1, rs2", args: "rd = registre destination (reste) ; rs1 = dividende ; rs2 = diviseur" },

  // Logique et decalages
  and: { summary: "Et binaire bit a bit : rd = rs1 & rs2.", usage: "and rd, rs1, rs2", args: "rd = registre destination ; rs1 = premier operande ; rs2 = second operande" },
  andi: { summary: "Et binaire avec une constante : rd = rs1 & imm.", usage: "andi rd, rs1, imm", args: "rd = registre destination ; rs1 = operande ; imm = masque constant" },
  or: { summary: "Ou binaire bit a bit : rd = rs1 | rs2.", usage: "or rd, rs1, rs2", args: "rd = registre destination ; rs1 = premier operande ; rs2 = second operande" },
  ori: { summary: "Ou binaire avec une constante.", usage: "ori rd, rs1, imm", args: "rd = registre destination ; rs1 = operande ; imm = masque constant" },
  xor: { summary: "Ou exclusif bit a bit : rd = rs1 ^ rs2.", usage: "xor rd, rs1, rs2", args: "rd = registre destination ; rs1 = premier operande ; rs2 = second operande" },
  xori: { summary: "Ou exclusif avec une constante.", usage: "xori rd, rs1, imm", args: "rd = registre destination ; rs1 = operande ; imm = masque constant" },
  sll: { summary: "Decalage a gauche (bits bas) : rd = rs1 << rs2.", usage: "sll rd, rs1, rs2", args: "rd = registre destination ; rs1 = valeur a decaler ; rs2 = nombre de bits (registre)" },
  slli: { summary: "Decalage a gauche d'un nombre constant de bits.", usage: "slli rd, rs1, shamt", args: "rd = registre destination ; rs1 = valeur a decaler ; shamt = nombre de bits (0-31)" },
  srl: { summary: "Decalage a droite logique (zeros a gauche).", usage: "srl rd, rs1, rs2", args: "rd = registre destination ; rs1 = valeur a decaler ; rs2 = nombre de bits (registre)" },
  srli: { summary: "Decalage a droite logique d'un nombre constant de bits.", usage: "srli rd, rs1, shamt", args: "rd = registre destination ; rs1 = valeur a decaler ; shamt = nombre de bits (0-31)" },
  sra: { summary: "Decalage a droite arithmetique (signe conserve).", usage: "sra rd, rs1, rs2", args: "rd = registre destination ; rs1 = valeur a decaler ; rs2 = nombre de bits (registre)" },
  srai: { summary: "Decalage a droite arithmetique d'un nombre constant de bits.", usage: "srai rd, rs1, shamt", args: "rd = registre destination ; rs1 = valeur a decaler ; shamt = nombre de bits (0-31)" },
  not: { summary: "Negation binaire (pseudo) : rd = ~rs1.", usage: "not rd, rs1", args: "rd = registre destination ; rs1 = registre a nier" },
  neg: { summary: "Negation arithmetique (pseudo) : rd = -rs1.", usage: "neg rd, rs1", args: "rd = registre destination ; rs1 = registre a inverser" },

  // Comparaisons
  slt: { summary: "Positionne rd a 1 si rs1 < rs2 (signe), sinon 0.", usage: "slt rd, rs1, rs2", args: "rd = registre destination (0 ou 1) ; rs1 = premier operande ; rs2 = second operande" },
  slti: { summary: "Positionne rd a 1 si rs1 < imm (signe).", usage: "slti rd, rs1, imm", args: "rd = registre destination (0 ou 1) ; rs1 = operande ; imm = constante" },
  sltu: { summary: "Positionne rd a 1 si rs1 < rs2 (non signe).", usage: "sltu rd, rs1, rs2", args: "rd = registre destination (0 ou 1) ; rs1 = premier operande ; rs2 = second operande" },
  sltiu: { summary: "Positionne rd a 1 si rs1 < imm (non signe).", usage: "sltiu rd, rs1, imm", args: "rd = registre destination (0 ou 1) ; rs1 = operande ; imm = constante" },
  seqz: { summary: "Positionne rd a 1 si rs1 = 0 (pseudo).", usage: "seqz rd, rs1", args: "rd = registre destination (0 ou 1) ; rs1 = registre a tester" },
  snez: { summary: "Positionne rd a 1 si rs1 != 0 (pseudo).", usage: "snez rd, rs1", args: "rd = registre destination (0 ou 1) ; rs1 = registre a tester" },
  sltz: { summary: "Positionne rd a 1 si rs1 < 0 (pseudo).", usage: "sltz rd, rs1", args: "rd = registre destination (0 ou 1) ; rs1 = registre a tester" },
  sgtz: { summary: "Positionne rd a 1 si rs1 > 0 (pseudo).", usage: "sgtz rd, rs1", args: "rd = registre destination (0 ou 1) ; rs1 = registre a tester" },

  // Chargements
  lb: { summary: "Charge un octet (etendu avec le signe).", usage: "lb rd, offset(rs)", args: "rd = registre destination ; offset = deplacement en octets ; rs = registre contenant l'adresse de base" },
  lh: { summary: "Charge un demi-mot 16 bits (signe).", usage: "lh rd, offset(rs)", args: "rd = registre destination ; offset = deplacement en octets ; rs = registre contenant l'adresse de base" },
  lw: { summary: "Charge un mot 32 bits depuis la memoire.", usage: "lw rd, offset(rs)", args: "rd = registre destination ; offset = deplacement en octets ; rs = registre contenant l'adresse de base" },
  lbu: { summary: "Charge un octet (etendu avec des zeros).", usage: "lbu rd, offset(rs)", args: "rd = registre destination ; offset = deplacement en octets ; rs = registre contenant l'adresse de base" },
  lhu: { summary: "Charge un demi-mot 16 bits (zeros).", usage: "lhu rd, offset(rs)", args: "rd = registre destination ; offset = deplacement en octets ; rs = registre contenant l'adresse de base" },
  la: { summary: "Charge l'adresse d'une etiquette (pseudo).", usage: "la rd, label", args: "rd = registre destination ; label = etiquette des donnees (.data) dont on veut l'adresse" },
  li: { summary: "Charge une valeur immediate dans un registre (pseudo).", usage: "li rd, imm", args: "rd = registre destination ; imm = valeur constante" },
  mv: { summary: "Copie un registre dans un autre (pseudo) : rd = rs1.", usage: "mv rd, rs1", args: "rd = registre destination (copie) ; rs1 = registre source" },

  // Stockages
  sb: { summary: "Stocke l'octet bas de rs2 en memoire.", usage: "sb rs2, offset(rs)", args: "rs2 = registre dont on stocke la valeur ; offset = deplacement en octets ; rs = registre contenant l'adresse de base" },
  sh: { summary: "Stocke un demi-mot 16 bits en memoire.", usage: "sh rs2, offset(rs)", args: "rs2 = registre dont on stocke la valeur ; offset = deplacement en octets ; rs = registre contenant l'adresse de base" },
  sw: { summary: "Stocke un mot 32 bits en memoire.", usage: "sw rs2, offset(rs)", args: "rs2 = registre dont on stocke la valeur ; offset = deplacement en octets ; rs = registre contenant l'adresse de base" },

  // Branchements (conditionnels)
  beq: { summary: "Saute a label si rs1 = rs2.", usage: "beq rs1, rs2, label", args: "rs1 = premier operande compare ; rs2 = second operande compare ; label = etiquette de destination" },
  bne: { summary: "Saute a label si rs1 != rs2.", usage: "bne rs1, rs2, label", args: "rs1 = premier operande compare ; rs2 = second operande compare ; label = etiquette de destination" },
  blt: { summary: "Saute a label si rs1 < rs2 (signe).", usage: "blt rs1, rs2, label", args: "rs1 = premier operande compare ; rs2 = second operande compare ; label = etiquette de destination" },
  bge: { summary: "Saute a label si rs1 >= rs2 (signe).", usage: "bge rs1, rs2, label", args: "rs1 = premier operande compare ; rs2 = second operande compare ; label = etiquette de destination" },
  bltu: { summary: "Saute a label si rs1 < rs2 (non signe).", usage: "bltu rs1, rs2, label", args: "rs1 = premier operande compare ; rs2 = second operande compare ; label = etiquette de destination" },
  bgeu: { summary: "Saute a label si rs1 >= rs2 (non signe).", usage: "bgeu rs1, rs2, label", args: "rs1 = premier operande compare ; rs2 = second operande compare ; label = etiquette de destination" },
  beqz: { summary: "Saute a label si rs1 = 0 (pseudo).", usage: "beqz rs1, label", args: "rs1 = registre teste ; label = etiquette de destination" },
  bnez: { summary: "Saute a label si rs1 != 0 (pseudo).", usage: "bnez rs1, label", args: "rs1 = registre teste ; label = etiquette de destination" },
  bltz: { summary: "Saute a label si rs1 < 0 (pseudo).", usage: "bltz rs1, label", args: "rs1 = registre teste ; label = etiquette de destination" },
  bgez: { summary: "Saute a label si rs1 >= 0 (pseudo).", usage: "bgez rs1, label", args: "rs1 = registre teste ; label = etiquette de destination" },
  bgt: { summary: "Saute a label si rs1 > rs2 (pseudo).", usage: "bgt rs1, rs2, label", args: "rs1 = premier operande compare ; rs2 = second operande compare ; label = etiquette de destination" },
  ble: { summary: "Saute a label si rs1 <= rs2 (pseudo).", usage: "ble rs1, rs2, label", args: "rs1 = premier operande compare ; rs2 = second operande compare ; label = etiquette de destination" },
  bgtu: { summary: "Saute a label si rs1 > rs2 (non signe, pseudo).", usage: "bgtu rs1, rs2, label", args: "rs1 = premier operande compare ; rs2 = second operande compare ; label = etiquette de destination" },
  bleu: { summary: "Saute a label si rs1 <= rs2 (non signe, pseudo).", usage: "bleu rs1, rs2, label", args: "rs1 = premier operande compare ; rs2 = second operande compare ; label = etiquette de destination" },

  // Sauts
  j: { summary: "Saut inconditionnel (pseudo).", usage: "j label", args: "label = etiquette de destination" },
  jal: { summary: "Saute a l'adresse et retient l'adresse de retour dans rd.", usage: "jal rd, label", args: "rd = registre recevant l'adresse de retour (ra pour un appel de fonction) ; label = etiquette de destination" },
  jr: { summary: "Saute a l'adresse contenue dans rs1 (pseudo).", usage: "jr rs1", args: "rs1 = registre contenant l'adresse de destination" },
  jalr: { summary: "Saute a l'adresse de rs1+imm et retient l'adresse de retour dans rd.", usage: "jalr rd, rs1, imm", args: "rd = registre recevant l'adresse de retour ; rs1 = registre contenant l'adresse ; imm = deplacement" },
  ret: { summary: "Retour de fonction : saute a l'adresse dans ra (pseudo).", usage: "ret", args: "(aucun argument)" },
  call: { summary: "Appel de fonction (pseudo) : jal ra, label.", usage: "call label", args: "label = etiquette de la fonction a appeler" },
  tail: { summary: "Saut de fin de fonction (pseudo) : idem call sans sauver ra.", usage: "tail label", args: "label = etiquette de destination" },

  // Systeme
  ecall: { summary: "Appel systeme : le service demande est donne par a0 (34 = sortie, 5 = lecture…), les resultats reviennent dans a0/a1.", usage: "ecall", args: "(aucun argument) ; a0 = numero du service (et valeur de sortie) ; a1 = second resultat ; a2-a7 = parametres supplementaires" },
  ebreak: { summary: "Point d'arret materiel : arrete la simulation (point de sauvegarde).", usage: "ebreak", args: "(aucun argument)" },
  nop: { summary: "Ne fait rien (pseudo) : addi zero, zero, 0.", usage: "nop", args: "(aucun argument)" },

  // Virgule flottante (RVF)
  flw: { summary: "Charge un float 32 bits vers un registre FP.", usage: "flw fd, offset(rs)", args: "fd = registre flottant destination ; offset = deplacement en octets ; rs = registre contenant l'adresse de base" },
  fsw: { summary: "Stocke un float 32 bits depuis un registre FP.", usage: "fsw fs2, offset(rs)", args: "fs2 = registre flottant source ; offset = deplacement en octets ; rs = registre contenant l'adresse de base" },
  fadd_s: { summary: "Addition flottante simple precision.", usage: "fadd.s fd, fs1, fs2", args: "fd = registre flottant destination ; fs1 = premier operande ; fs2 = second operande" },
  fsub_s: { summary: "Soustraction flottante simple precision.", usage: "fsub.s fd, fs1, fs2", args: "fd = registre flottant destination ; fs1 = premier operande ; fs2 = second operande" },
  fmul_s: { summary: "Multiplication flottante simple precision.", usage: "fmul.s fd, fs1, fs2", args: "fd = registre flottant destination ; fs1 = premier operande ; fs2 = second operande" },
  fdiv_s: { summary: "Division flottante simple precision.", usage: "fdiv.s fd, fs1, fs2", args: "fd = registre flottant destination ; fs1 = dividende ; fs2 = diviseur" },
  fsqrt_s: { summary: "Racine carree flottante.", usage: "fsqrt.s fd, fs1", args: "fd = registre flottant destination ; fs1 = registre source" },
  fcvt_w_s: { summary: "Convertit un float en entier 32 bits (arrondi).", usage: "fcvt.w.s rd, fs1", args: "rd = registre entier destination ; fs1 = registre flottant source" },
  fcvt_s_w: { summary: "Convertit un entier 32 bits en float.", usage: "fcvt.s.w fd, rs1", args: "fd = registre flottant destination ; rs1 = registre entier source" },
  feq_s: { summary: "rd = 1 si les deux floats sont egaux.", usage: "feq.s rd, fs1, fs2", args: "rd = registre entier destination (0 ou 1) ; fs1 = premier float compare ; fs2 = second float compare" },
  flt_s: { summary: "rd = 1 si fs1 < fs2.", usage: "flt.s rd, fs1, fs2", args: "rd = registre entier destination (0 ou 1) ; fs1 = premier float compare ; fs2 = second float compare" },
  fle_s: { summary: "rd = 1 si fs1 <= fs2.", usage: "fle.s rd, fs1, fs2", args: "rd = registre entier destination (0 ou 1) ; fs1 = premier float compare ; fs2 = second float compare" }
};

export function getInstruction(mnemonic: string): InstructionInfo | undefined {
  return INSTRUCTIONS[mnemonic.toLowerCase()];
}

/** Toutes les commandes completes dont le nom commence par le prefixe donne. */
export function matchingInstructions(prefix: string): Array<[string, InstructionInfo]> {
  const lower = prefix.toLowerCase();
  return Object.entries(INSTRUCTIONS).filter(([mnemonic]) => mnemonic.startsWith(lower));
}

/**
 * Noms de registres connus : numeriques (x/f) et ABI.
 * La valeur = description courte du role.
 */
export const REGISTERS: Record<string, string> = {
  zero: "registre constant 0 (toujours 0, ecrire n'a pas d'effet)",
  ra: "adresse de retour des fonctions",
  sp: "pointeur de pile (adresse du haut de la pile)",
  gp: "pointeur global",
  tp: "pointeur de thread",
  fp: "pointeur de cadre de fonction",
  t0: "registre temporaire (non sauvegarde entre deux appels)",
  t1: "registre temporaire (non sauvegarde entre deux appels)",
  t2: "registre temporaire (non sauvegarde entre deux appels)",
  t3: "registre temporaire (non sauvegarde entre deux appels)",
  t4: "registre temporaire (non sauvegarde entre deux appels)",
  t5: "registre temporaire (non sauvegarde entre deux appels)",
  t6: "registre temporaire (non sauvegarde entre deux appels)",
  s0: "registre sauvegarde (precede par la fonction appelante)",
  s1: "registre sauvegarde (precede par la fonction appelante)",
  s2: "registre sauvegarde (precede par la fonction appelante)",
  s3: "registre sauvegarde (precede par la fonction appelante)",
  s4: "registre sauvegarde (precede par la fonction appelante)",
  s5: "registre sauvegarde (precede par la fonction appelante)",
  s6: "registre sauvegarde (precede par la fonction appelante)",
  s7: "registre sauvegarde (precede par la fonction appelante)",
  s8: "registre sauvegarde (precede par la fonction appelante)",
  s9: "registre sauvegarde (precede par la fonction appelante)",
  s10: "registre sauvegarde (precede par la fonction appelante)",
  s11: "registre sauvegarde (precede par la fonction appelante)",
  a0: "registre d'argument / valeur de retour des syscalls",
  a1: "registre d'argument / second resultat des syscalls",
  a2: "registre d'argument",
  a3: "registre d'argument",
  a4: "registre d'argument",
  a5: "registre d'argument",
  a6: "registre d'argument",
  a7: "registre d'argument (numero de service des syscalls)",
  ft0: "registre flottant temporaire (non sauvegarde entre deux appels)",
  ft1: "registre flottant temporaire (non sauvegarde entre deux appels)",
  ft2: "registre flottant temporaire (non sauvegarde entre deux appels)",
  ft3: "registre flottant temporaire (non sauvegarde entre deux appels)",
  ft4: "registre flottant temporaire (non sauvegarde entre deux appels)",
  ft5: "registre flottant temporaire (non sauvegarde entre deux appels)",
  ft6: "registre flottant temporaire (non sauvegarde entre deux appels)",
  ft7: "registre flottant temporaire (non sauvegarde entre deux appels)",
  ft8: "registre flottant temporaire (non sauvegarde entre deux appels)",
  ft9: "registre flottant temporaire (non sauvegarde entre deux appels)",
  ft10: "registre flottant temporaire (non sauvegarde entre deux appels)",
  ft11: "registre flottant temporaire (non sauvegarde entre deux appels)",
  fs0: "registre flottant sauvegarde (precede par la fonction appelante)",
  fs1: "registre flottant sauvegarde (precede par la fonction appelante)",
  fs2: "registre flottant sauvegarde (precede par la fonction appelante)",
  fs3: "registre flottant sauvegarde (precede par la fonction appelante)",
  fs4: "registre flottant sauvegarde (precede par la fonction appelante)",
  fs5: "registre flottant sauvegarde (precede par la fonction appelante)",
  fs6: "registre flottant sauvegarde (precede par la fonction appelante)",
  fs7: "registre flottant sauvegarde (precede par la fonction appelante)",
  fs8: "registre flottant sauvegarde (precede par la fonction appelante)",
  fs9: "registre flottant sauvegarde (precede par la fonction appelante)",
  fs10: "registre flottant sauvegarde (precede par la fonction appelante)",
  fs11: "registre flottant sauvegarde (precede par la fonction appelante)",
  fa0: "registre flottant d'argument",
  fa1: "registre flottant d'argument",
  fa2: "registre flottant d'argument",
  fa3: "registre flottant d'argument",
  fa4: "registre flottant d'argument",
  fa5: "registre flottant d'argument",
  fa6: "registre flottant d'argument",
  fa7: "registre flottant d'argument"
};

/** Correspondance numero -> nom ABI, pour decoder x0..x31 (meme ordre que RARS). */
export const NUMERIC_HANDLES: Record<string, string> = Object.fromEntries(
  ["zero", "ra", "sp", "gp", "tp", "t0", "t1", "t2", "s0", "s1", "a0", "a1", "a2", "a3", "a4", "a5", "a6", "a7",
    "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9", "s10", "s11", "t3", "t4", "t5", "t6"].map((n, i) => [`x${i}`, n])
);

/**
 * Correspondance numero -> nom ABI pour les registres flottants f0..f31 :
 * ft0-ft7, fs0-fs1, fa0-fa7, fs2-fs11, ft8-ft11 (meme decoupage que les entiers).
 */
export const FP_NUMERIC_HANDLES: Record<string, string> = Object.fromEntries(
  ["ft0", "ft1", "ft2", "ft3", "ft4", "ft5", "ft6", "ft7", "fs0", "fs1",
    "fa0", "fa1", "fa2", "fa3", "fa4", "fa5", "fa6", "fa7",
    "fs2", "fs3", "fs4", "fs5", "fs6", "fs7", "fs8", "fs9", "fs10", "fs11",
    "ft8", "ft9", "ft10", "ft11"].map((n, i) => [`f${i}`, n])
);

/** Renvoie la forme canonique (ABI) d'un nom de registre, ou undefined. */
export function asRegister(name: string): string | undefined {
  const lower = name.toLowerCase();
  if (lower in REGISTERS) {
    return lower;
  }
  const numeric = lower.match(/^x(\d{1,2})$/);
  if (numeric) {
    const n = Number(numeric[1]);
    if (n >= 0 && n <= 31) {
      return NUMERIC_HANDLES[lower] ?? lower;
    }
  }
  const fpNumeric = lower.match(/^f(\d{1,2})$/);
  if (fpNumeric) {
    const n = Number(fpNumeric[1]);
    if (n >= 0 && n <= 31) {
      return FP_NUMERIC_HANDLES[lower] ?? lower;
    }
  }
  return undefined;
}

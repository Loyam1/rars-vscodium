// Pont Java entre VSCodium et l'API RARS 1.6.
//
// Lance par l'extension via le "single-file source launcher" (Java 11+) :
//   java -cp rars1_6.jar RarsBridge.java
//
// Une commande par ligne sur stdin, une ligne JSON par evenement sur stdout.
//
// Commandes :
//   AS <chemin>        assembler le fichier ; emet assembleOk ou assembleErrors
//   BP <ligne> <0|1>   poser/enlever un point d'arret sur une ligne du fichier principal
//   STEP               executer une instruction ; emet stopped
//   CONT               lancer ou reprendre en continu ; emet stopped et regs periodiques
//   BACK               revenir a l'instruction precedente (historique RARS) ; emet stopped
//   STOP               arreter la simulation courante
//   PAUSE              mettre la simulation en pause
//   IN <texte>         ajoute une ligne au stdin du programme simule (consomme
//                      des qu'il lit, sinon rejouee au prochain lancement)
//   SPEED <indice>     regler la vitesse d'execution continue : indice dans la
//                      table de vitesses RARS (0 = le plus lent, 0.05 inst/sec,
//                      40 = vitesse maximale, sans interaction) ; emet speed.
//                      La cadence est geree par le pont ; PAUSE/STOP sont
//                      traites entre deux paquets d'instructions.
//   QUIT               fermer le pont
//
// Evenements :
//   speed {index, table:[...]}         position du curseur et vitesses disponibles
//   assembleOk {file, entryLine, lines:[...]}
//   assembleErrors {errors:[{file,line,message}]}
//   breakpoints {lines:[...]}
//   stopped {reason, pc, line, file, exitCode, registers:{...}, fp:{...}}
//   regs {waitingInput, registers:{...}, fp:{...}}   positions pendant l'execution
//   executionError {message, reason, pc, line}
//   regs {registers:{...}, fp:{...}}        positions periodiques en execution continue
//   output {text, stream:"out"|"err"}
//   error {message}

import rars.Globals;
import rars.AssemblyException;
import rars.ErrorMessage;
import rars.ErrorList;
import rars.ProgramStatement;
import rars.RISCVprogram;
import rars.Settings;
import rars.SimulationException;
import rars.riscv.hardware.Memory;
import rars.riscv.hardware.Register;
import rars.riscv.hardware.RegisterFile;
import rars.riscv.hardware.FloatingPointRegisterFile;
import rars.simulator.BackStepper;
import rars.simulator.Simulator;
import rars.util.SystemIO;
import rars.venus.run.RunSpeedPanel;

import java.io.BufferedOutputStream;
import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.FileDescriptor;
import java.io.FilterInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.io.PipedInputStream;
import java.io.PipedOutputStream;
import java.io.PrintStream;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.concurrent.LinkedBlockingDeque;
import java.lang.reflect.Field;

public class RarsBridge {

    private static final int MAX_STEPS_UNLIMITED = 0;
    private static final int MAX_STEPS_ONE = 1;
    private static final int STDIN_INDEX = 0;

    private static final Object protocolLock = new Object();
    private static final Object runStateLock = new Object();
    // Lignes tapees dans la console VSCodium, en attente d'une lecture du programme.
    private static final LinkedBlockingDeque<String> stdinQueue = new LinkedBlockingDeque<>();
    private static volatile PipedOutputStream stdinPipe;

    private static PrintStream protocolOut;
    private static PrintStream programStdout;
    private static PrintStream programStderr;

    private static RISCVprogram mainProgram;
    private static ArrayList<RISCVprogram> allPrograms;
    private static Memory assembledMemory;
    private static Memory simulationMemory;
    private static SystemIO.Data ioData;
    private static final TreeMap<Integer, ProgramStatement> addressToStatement = new TreeMap<>();
    private static final TreeMap<Integer, ProgramStatement> lineToStatement = new TreeMap<>();
    private static final TreeSet<Integer> breakpointAddresses = new TreeSet<>();
    private static String mainFile;
    private static boolean programReady = false;
    private static volatile boolean running = false;

    // Vitesse d'execution : panneau natif de RARS pilote par reflexion (pas de
    // mutateur public sur l'indice du curseur). instPerSec = 0 -> vitesse max,
    // sinon le pont cadence l'execution a autant d'instructions par seconde.
    private static Object runSpeedPanelInstance;
    private static Field runSpeedIndexField;
    private static double[] speedTable;
    private static volatile double instPerSec = 0.0;

    public static void main(String[] args) {
        // La sortie du programme simule doit passer par les evenements JSON :
        // on remplace System.out/System.err AVANT la premiere construction de
        // SystemIO.Data, qui capture les references des flux.
        OutputStream rawOut = new FileOutputStream(FileDescriptor.out) {
            @Override
            public void write(byte[] b, int off, int len) {
                synchronized (protocolLock) {
                    try {
                        super.write(b, off, len);
                        super.flush();
                    } catch (IOException e) {
                        // canal mort, rien a faire
                    }
                }
            }
        };
        protocolOut = new PrintStream(new BufferedOutputStream(rawOut, 1 << 16), false);
        programStdout = new PrintStream(new ProgramOutputProxy("out"), true, StandardCharsets.UTF_8);
        programStderr = new PrintStream(new ProgramOutputProxy("err"), true, StandardCharsets.UTF_8);
        System.setOut(programStdout);
        System.setErr(programStderr);

        Globals.initialize();
        enableRunSpeedControls();
        startReader();
    }

    private static void startReader() {
        BufferedReader stdin = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
        try {
            String line;
            while ((line = stdin.readLine()) != null) {
                line = line.trim();
                if (line.isEmpty()) {
                    continue;
                }
                try {
                    handleCommand(line);
                } catch (Exception e) {
                    sendError("Commande '" + line + "' : " + e);
                }
                if (line.equals("QUIT")) {
                    break;
                }
            }
        } catch (IOException e) {
            // canal ferme, on quitte
        }
        requestStop();
        Thread active = currentRunThread;
        if (active != null) {
            try {
                active.join(2000);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }
        protocolOut.flush();
    }

    private static void handleCommand(String line) {
        if (line.equals("QUIT")) {
            return;
        }
        if (line.startsWith("AS ")) {
            assemble(line.substring(3).trim());
            return;
        }
        if (line.startsWith("BP ")) {
            String[] parts = line.split("\\s+");
            if (parts.length == 3) {
                try {
                    toggleBreakpoint(Integer.parseInt(parts[1]), parts[2].equals("1"));
                    return;
                } catch (NumberFormatException ignored) {
                }
            }
            sendError("Commande BP invalide : " + line);
            return;
        }
        if (line.startsWith("IN ")) {
            stdinQueue.add(line.substring(3));
            return;
        }
        if (line.startsWith("SPEED ")) {
            String[] parts = line.split("\\s+");
            if (parts.length == 2) {
                try {
                    setRunSpeedIndex(Integer.parseInt(parts[1]));
                    return;
                } catch (NumberFormatException ignored) {
                }
            }
            sendError("Commande SPEED invalide : " + line);
            return;
        }
        switch (line) {
            case "STOP" -> requestStop();
            case "PAUSE" -> simulatorPause();
            // Les deux Lancent un thread separe : une commande suivante (STOP,
            // PAUSE...) reste traitable meme si la simulation se bloque dans
            // une lecture (syscall 5/8/12) ou s'arrete sur un point d'arret.
            case "STEP" -> run(MAX_STEPS_ONE);
            case "CONT" -> run(MAX_STEPS_UNLIMITED);
            case "BACK" -> backStep();
            default -> sendError("Commande inconnue : " + line);
        }
    }

    // ------------------------------------------------------------------ assemblage

    private static synchronized void assemble(String file) {
        requestStop();
        Thread previous = currentRunThread;
        if (previous != null) {
            try {
                previous.join(2000);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
            if (running) {
                sendError("Impossible d'assembler : l'execution precedente ne repond pas.");
                return;
            }
        }
        try {
            programReady = false;
            mainFile = file;
            mainProgram = new RISCVprogram();
            ArrayList<String> files = new ArrayList<>();            files.add(file);
            allPrograms = mainProgram.prepareFilesForAssembly(files, file, null);

            if (assembledMemory == null) {
                assembledMemory = new Memory();
            }
            Memory keep = Memory.swapInstance(assembledMemory);
            try {
                mainProgram.assemble(allPrograms, true, false);
            } finally {
                Memory.swapInstance(keep);
            }
            breakpointAddresses.clear();
            stdinQueue.clear();

            addressToStatement.clear();
            lineToStatement.clear();
            for (RISCVprogram prog : allPrograms) {
                for (ProgramStatement stmt : prog.getMachineList()) {
                    addressToStatement.put(stmt.getAddress(), stmt);
                    String sourceFile = stmt.getSourceFile();
                    if (stmt.getSource() != null && !stmt.getSource().trim().isEmpty()
                            && sourceFile != null && sourceFile.equals(prog.getFilename())) {
                        lineToStatement.putIfAbsent(stmt.getSourceLine(), stmt);
                    }
                }
            }

            RegisterFile.initializeProgramCounter(true);
            // Comme RunAssembleAction dans la GUI : necessaire pour que le
            // BackStepper enregistre les restaurations (bouton Precedent).
            Globals.program = mainProgram;
            mainProgram.getBackStepper().setEnabled(true);

            // Le programme charge vit dans une memoire dediee ; la memoire globale
            // de RARS reste disponible pour reassembler plus tard.
            simulationMemory = new Memory();
            simulationMemory.copyFrom(assembledMemory);
            programReady = true;

            StringBuilder lines = new StringBuilder();
            for (Integer key : lineToStatement.keySet()) {
                if (lines.length() > 0) {
                    lines.append(',');
                }
                lines.append(key);
            }
            ProgramStatement first = addressToStatement.get(RegisterFile.getProgramCounter());
            int entryLine = first == null ? 0 : first.getSourceLine();
            sendEvent("{\"type\":\"assembleOk\",\"file\":" + Json.str(mainFile)
                + ",\"entryLine\":" + entryLine
                + ",\"lines\":[" + lines + "]}");
            // Etat initial des registres, des l'assemblage.
            sendEvent("{\"type\":\"regs\",\"registers\":" + registersJson()
                + ",\"fp\":" + fpRegistersJson() + "}");
        } catch (AssemblyException ae) {
            sendAssembleErrors(ae.errors());
        } catch (Exception e) {
            sendError("Assemblage impossible : " + e);
        }
    }

    // ------------------------------------------------------------------ breakpoints

    private static synchronized void toggleBreakpoint(int sourceLine, boolean set) {
        if (mainProgram == null) {
            sendError("Assemblez d'abord (AS) avant de poser un point d'arret.");
            return;
        }
        ProgramStatement stmt = lineToStatement.get(sourceLine);
        if (set) {
            if (stmt == null) {
                sendEvent("{\"type\":\"breakpointRefused\",\"line\":" + sourceLine
                    + ",\"message\":" + Json.str("aucune instruction sur cette ligne") + "}");
                return;
            }
            breakpointAddresses.add(stmt.getAddress());
        } else {
            if (stmt != null) {
                breakpointAddresses.remove(stmt.getAddress());
            }
        }
        sendBreakpoints();
    }

    private static void sendBreakpoints() {
        StringBuilder lineNumbers = new StringBuilder();
        for (int pc : breakpointAddresses) {
            ProgramStatement s = addressToStatement.get(pc);
            if (s != null) {
                if (lineNumbers.length() > 0) {
                    lineNumbers.append(',');
                }
                lineNumbers.append(s.getSourceLine());
            }
        }
        sendEvent("{\"type\":\"breakpoints\",\"lines\":[" + lineNumbers + "]}");
    }

    // ------------------------------------------------------------------ execution

    private static volatile Thread currentRunThread = null;

    private static void run(int maxSteps) {
        synchronized (runStateLock) {
            if (mainProgram == null || !programReady || simulationMemory == null) {
                sendError("Aucun programme assemblé : envoyez AS d'abord.");
                return;
            }
            if (running) {
                sendEvent("{\"type\":\"error\",\"message\":"
                    + Json.str("une execution est deja en cours") + "}");
                return;
            }
            running = true;
            stopRequested = false;
            pauseRequested = false;
        }
        Thread t = new Thread(() -> {
            try {
                startRegsTicker();
                doRun(maxSteps);
            } finally {
                running = false;
            }
        }, "RarsBridge-Run");
        currentRunThread = t;
        t.start();
    }

    private static void doRun(int maxSteps) {
        boolean selfMod = true;
        SystemIO.Data tmpFiles;
        Memory tmpMem;
        PipedInputStream stdinReader = null;
        try {
            selfMod = Globals.getSettings().getBooleanSetting(Settings.Bool.SELF_MODIFYING_CODE_ENABLED);
            Globals.getSettings().setBooleanSettingNonPersistent(
                Settings.Bool.SELF_MODIFYING_CODE_ENABLED, false);

            // Stdin vivant : le programme bloque reellement jusqu'a ce que
            // l'utilisateur tape une ligne dans la console VSCodium.
            stdinReader = new PipedInputStream(1 << 16);
            stdinPipe = new PipedOutputStream(stdinReader);
            startStdinPump(stdinPipe);
            BridgeInputStream stdinWatch = new BridgeInputStream(stdinReader);
            ioData = new SystemIO.Data(true);
            ioData.streams[STDIN_INDEX] = stdinWatch;
            ioData.inputReader = new BufferedReader(
                new InputStreamReader(stdinWatch, StandardCharsets.UTF_8));

            tmpFiles = SystemIO.swapData(ioData);
            tmpMem = Memory.swapInstance(simulationMemory);
            Simulator.Reason reason;
            try {
                reason = simulateRun(maxSteps);
            } finally {
                Memory.swapInstance(tmpMem);
                SystemIO.swapData(tmpFiles);
                ioData = null;
                // Ferme le stdin : debloque un programme en attente de lecture.
                stdinPipe = null;
                try {
                    stdinReader.close();
                } catch (IOException ignored) {
                }
            }
            Globals.getSettings().setBooleanSettingNonPersistent(
                Settings.Bool.SELF_MODIFYING_CODE_ENABLED, selfMod);
            sendStopped(reason, Globals.exitCode);
        } catch (SimulationException se) {
            Globals.getSettings().setBooleanSettingNonPersistent(
                Settings.Bool.SELF_MODIFYING_CODE_ENABLED, selfMod);
            if (stopRequested) {
                // L'arret a debloque une lecture ; ce n'est pas une erreur du programme.
                sendStopped(Simulator.Reason.STOP, Globals.exitCode);
            } else if (pauseRequested) {
                pauseRequested = false;
                sendStopped(Simulator.Reason.PAUSE, Globals.exitCode);
            } else if (se.getMessage() == null || se.getMessage().isEmpty()) {
                // Sortie normale par ecall (exit/exit2) : RARS 1.6 fait sortir la
                // SimulationException du simulateur, sans message, exitCode deja pose.
                sendStopped(Simulator.Reason.NORMAL_TERMINATION, Globals.exitCode);
            } else {
                sendExecutionError(se.getMessage());
            }
        } catch (Exception e) {
            Globals.getSettings().setBooleanSettingNonPersistent(
                Settings.Bool.SELF_MODIFYING_CODE_ENABLED, selfMod);
            if (stopRequested) {
                sendStopped(Simulator.Reason.STOP, Globals.exitCode);
            } else if (pauseRequested) {
                pauseRequested = false;
                sendStopped(Simulator.Reason.PAUSE, Globals.exitCode);
            } else {
                sendExecutionError(String.valueOf(e));
            }
        }
    }

    /**
     * Boucle d'execution : paquets d'instructions (simulate), avec verification
     * des drapeaux STOP/PAUSE et de la cadence entre les paquets. On ne
     * s'appuie pas sur pauseExecution/stopExecution de RARS : appelles depuis
     * un autre thread ils ne prennent pas effet de facon fiable (le thread de
     * simulation n'envoie pas sa fin), ce qui bloquait pas-a-pas et pause.
     */
    private static Simulator.Reason simulateRun(int maxSteps) throws SimulationException {
        int[] bps = breakpointAddresses.isEmpty()
            ? null
            : breakpointAddresses.stream().mapToInt(Integer::intValue).toArray();
        if (maxSteps == MAX_STEPS_ONE) {
            return Simulator.getInstance()
                .simulate(RegisterFile.getProgramCounter(), MAX_STEPS_ONE, bps);
        }
        Simulator.Reason reason = Simulator.Reason.MAX_STEPS;
        while (true) {
            // Paquet redefini a chaque tour avec la vitesse instantanee : un
            // changement de curseur pendant l'execution (y compris depuis ou
            // vers la vitesse max) est applique au paquet suivant.
            double speed = instPerSec;
            int chunk = pauseOrStopWanted()
                ? 1
                : (speed <= 0.0
                    ? 200_000
                    : (int) Math.min(200_000L, Math.max(1, Math.round(speed * 0.05))));
            reason = Simulator.Reason.MAX_STEPS;
            try {
                reason = Simulator.getInstance()
                    .simulate(RegisterFile.getProgramCounter(), chunk, bps);
            } catch (RuntimeException rt) {
                // Fin de paquet forcee par stopExecution natif (changement de
                // vitesse) : l'epilogue de simulate() relit simulatorThread,
                // mis a null par interruptExecution, et lève une NPE. Sans
                // demande de pause/arre, ce n'est pas une vraie fin : on
                // boucle, le paquet suivant sera cale sur la nouvelle vitesse.
                if (stopRequested || pauseRequested) {
                    throw rt;
                }
                continue;
            }
            if (reason != Simulator.Reason.MAX_STEPS) {
                // Point d'arret, sortie, falaise, exception, erreur RARS :
                // fin reelle.
                return reason;
            }
            if (pauseOrStopWanted()) {
                return stopRequested
                    ? Simulator.Reason.STOP
                    : Simulator.Reason.PAUSE;
            }
            // Ralentit entre deux paquets ; le sommeil est tranche pour que
            // une pause ou un arret reste reactif.
            paceSleep(chunk, speed);
            if (pauseOrStopWanted()) {
                return stopRequested
                    ? Simulator.Reason.STOP
                    : Simulator.Reason.PAUSE;
            }
        }
    }

    /** Vrai si un arret ou une pause a ete demande pendant l'execution. */
    private static boolean pauseOrStopWanted() {
        return stopRequested || pauseRequested;
    }

    /** Le temps entre paquets a la vitesse demandee (0.05..30 inst/sec). */
    private static void paceSleep(int chunk, double speed) {
        if (speed <= 0.0) {
            return;
        }
        long total = Math.round(chunk * 1000.0 / speed);
        long slept = 0;
        while (slept < total) {
            if (pauseOrStopWanted()) {
                return;
            }
            try {
                long slice = Math.min(total - slept, 50);
                Thread.sleep(slice);
                slept += slice;
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return;
            }
        }
    }

    /** Rejoue en arriere la derniere instruction (historique BackStepper de RARS). */
    private static synchronized void backStep() {
        if (mainProgram == null || !programReady || simulationMemory == null) {
            sendError("Aucun programme assemblé : envoyez AS d'abord.");
            return;
        }
        if (running) {
            sendError("Impossible de revenir en arriere pendant l'execution.");
            return;
        }
        BackStepper bs = mainProgram.getBackStepper();
        if (bs == null || bs.empty()) {
            sendError("Pas d'historique : impossible de revenir en arriere (l'entree/sortie du programme ne peut pas etre annulee).");
            return;
        }
        Memory keep = Memory.swapInstance(simulationMemory);
        try {
            bs.backStep();
        } finally {
            Memory.swapInstance(keep);
        }
        sendStopped("BACKSTEP", Globals.exitCode);
    }

    private static volatile boolean blockedOnInput = false;

    /**
     * Enveloppe du stdin simule : signale (a destination du ticker regs) que la
     * simulation est bloquee en attente d'une ligne tapee par l'utilisateur.
     */
    private static class BridgeInputStream extends FilterInputStream {
        BridgeInputStream(InputStream in) {
            super(in);
        }

        @Override
        public int read() throws IOException {
            try {
                if (in.available() == 0) {
                    blockedOnInput = true;
                }
            } catch (IOException ignored) {
            }
            int r = super.read();
            blockedOnInput = false;
            armDeferredPause();
            return r;
        }

        @Override
        public int read(byte[] b, int off, int len) throws IOException {
            try {
                if (in.available() == 0) {
                    blockedOnInput = true;
                }
            } catch (IOException ignored) {
            }
            int r = super.read(b, off, len);
            blockedOnInput = false;
            armDeferredPause();
            return r;
        }
    }

    /** Une pause demandee pendant une lecture prend effet a la fin du paquet,
     *  des que l'entree recue aura laisse avancer la simulation. */
    private static void armDeferredPause() {
        // Rien a faire ici : le drapeau pauseRequested est verifie entre les
        // paquets d'instructions, la lecture bloque dans le paquet courant.
    }

    private static void simulatorPause() {
        if (!running) {
            return;
        }
        // La pause est traitee entre les paquets d'instructions dans simulateRun ;
        // le mecanisme natif (drapeau verifie par RARS a chaque instruction)
        // termine EN PLUS le paquet en cours des l'instruction suivante, ce
        // qui est indispensable quand le paquet contient une lecture : sans lui,
        // la pause ne serait delivree qu'apres une ligne tapee par l'utilisateur,
        // et le restant du paquet (calcul + lecture suivante) filerait d'un coup.
        pauseRequested = true;
        try {
            Simulator.getInstance().pauseExecution();
        } catch (Throwable ignored) {
        }
    }

    private static volatile boolean pauseRequested = false;

    private static volatile boolean stopRequested = false;

    /**
     * Positions periodiques des registres pendant l'execution continue.
     * Embarque aussi l'instruction courante (comme un arret pas-a-pas) pour
     * que l'editeur suive la ligne quand l'execution est cadencee.
     */
    private static void startRegsTicker() {
        Thread ticker = new Thread(() -> {
            while (running) {
                try {
                    Thread.sleep(200);
                } catch (InterruptedException e) {
                    return;
                }
                if (!running) {
                    return;
                }
                StringBuilder sb = new StringBuilder();
                sb.append("{\"type\":\"regs\",\"waitingInput\":").append(blockedOnInput);
                sb.append(",\"throttled\":").append(instPerSec > 0.0);
                appendCurrent(sb);
                sb.append(",\"registers\":").append(registersJson())
                    .append(",\"fp\":").append(fpRegistersJson()).append('}');
                sendEvent(sb.toString());
            }
        }, "RarsBridge-Regs");
        ticker.setDaemon(true);
        ticker.start();
    }

    /** Ajoute pc, ligne et instruction courantes (partie commune stopped/regs). */
    private static void appendCurrent(StringBuilder sb) {
        int pc = RegisterFile.getProgramCounter();
        ProgramStatement stmt = addressToStatement.get(pc);
        sb.append(",\"pc\":").append(pc);
        if (stmt != null) {
            sb.append(",\"line\":").append(stmt.getSourceLine());
            String src = stmt.getSource();
            String basic = stmt.getPrintableBasicAssemblyStatement();
            sb.append(",\"instruction\":").append(Json.str(src == null ? "" : src.trim()));
            sb.append(",\"expanded\":").append(Json.str(basic == null ? "" : basic.trim()));
        }
    }

    private static void requestStop() {
        if (running) {
            // Pris en compte entre les paquets dans simulateRun ; les deux
            // accelerations ci-dessous font le reste :
            // - le drapeau natif de RARS termine le paquet en cours a la
            //   prochaine instruction ;
            // - la fermeture du stdin debloque une simulation bloquee dans
            //   une lecture.
            stopRequested = true;
            try {
                Simulator.getInstance().stopExecution();
            } catch (Throwable ignored) {
            }
            PipedOutputStream pipe = stdinPipe;
            stdinPipe = null;
            if (pipe != null) {
                try {
                    pipe.close();
                } catch (IOException ignored) {
                }
            }
        }
    }

    /** Envoie les lignes en file d'attente vers le stdin vivant du programme. */
    private static void startStdinPump(PipedOutputStream pipe) {
        Thread pump = new Thread(() -> {
            try {
                while (true) {
                    String line = stdinQueue.take();
                    PipedOutputStream target = stdinPipe;
                    if (target == null || target != pipe) {
                        // Pas d'execution active (ou execution remplacee) :
                        // on restitue la ligne, elle sera consommee plus tard.
                        stdinQueue.putFirst(line);
                        Thread.sleep(50);
                        continue;
                    }
                    target.write((line + "\n").getBytes(StandardCharsets.UTF_8));
                    target.flush();
                }
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            } catch (IOException e) {
                // pipe fermee, fin du pompe
            }
        }, "RarsBridge-Stdin");
        pump.setDaemon(true);
        pump.start();
    }

    // ------------------------------------------------------------------ vitesse d'execution

    /**
     * Active et expose la table de vitesse native de RARS (RunSpeedPanel).
     * La cadence elle-meme est geree par le pont (simulateRun/paceSleep) : le
     * drapeau runSpeedPanelExists est remis a false pour neutraliser le sommeil
     * natif de RARS (pas d'edition fiable possible sans interface, et l'arret
     * pauseExecution n'y repond pas correctement). Ne depend d'aucun ecran.
     */
    private static void enableRunSpeedControls() {
        try {
            Object panel = RunSpeedPanel.getInstance();
            runSpeedPanelInstance = panel;
            Field tableField = RunSpeedPanel.class.getDeclaredField("speedTable");
            tableField.setAccessible(true);
            speedTable = (double[]) tableField.get(panel);
            runSpeedIndexField = RunSpeedPanel.class.getDeclaredField("runSpeedIndex");
            runSpeedIndexField.setAccessible(true);
            Globals.runSpeedPanelExists = false;
            sendEvent(speedEventJson());
        } catch (Throwable t) {
            // La vitesse est un confort : un echec n'interdit pas le debogage.
            sendError("Vitesse d'execution indisponible : " + t);
        }
    }

    /** Commande SPEED <indice> : change la position du curseur de vitesse. */
    private static void setRunSpeedIndex(int index) {
        if (runSpeedIndexField == null || speedTable == null) {
            sendError("Vitesse d'execution indisponible.");
            return;
        }
        if (index < 0 || index >= speedTable.length) {
            sendError("Indice de vitesse hors bornes : " + index);
            return;
        }
        try {
            runSpeedIndexField.setInt(runSpeedPanelInstance, index);
        } catch (IllegalAccessException e) {
            sendError("Vitesse d'execution inaccessible : " + e);
            return;
        }
        instPerSec = speedTable[index] < 40.0 ? speedTable[index] : 0.0;
        // Applique le changement des la fin du paquet en cours : sans cela,
        // un programme qui lit souvent (une lecture toutes les quelques
        // instructions) ne laisserait jamais un paquet de 200 000 se finir
        // et la nouvelle vitesse ne serait jamais prise en compte.
        // Le simulate() en cours renverra STOP/PAUSE ; simulateRun le
        // reconnait comme une fin de paquet forcee (drapeaux faux) et
        // continue avec le nouveau reglage.
        if (running) {
            try {
                Simulator.getInstance().stopExecution();
            } catch (Throwable ignored) {
            }
        }
        sendEvent(speedEventJson());
    }

    /** Evenement speed : position courante du curseur et table des vitesses. */
    private static String speedEventJson() {
        int index = 0;
        if (runSpeedIndexField != null && runSpeedPanelInstance != null) {
            try {
                index = runSpeedIndexField.getInt(runSpeedPanelInstance);
            } catch (IllegalAccessException ignored) {
            }
        }
        StringBuilder table = new StringBuilder();
        if (speedTable != null) {
            for (double speed : speedTable) {
                if (table.length() > 0) {
                    table.append(',');
                }
                table.append(speed);
            }
        }
        return "{\"type\":\"speed\",\"index\":" + index
            + ",\"table\":[" + table + "]}";
    }

    // ------------------------------------------------------------------ evenements

    private static void sendStopped(Simulator.Reason reason, int exitCode) {
        sendStopped(reason.name(), exitCode);
    }

    private static void sendStopped(String reason, int exitCode) {
        StringBuilder sb = new StringBuilder();
        sb.append("{\"type\":\"stopped\",\"reason\":\"").append(reason).append('"');
        sb.append(",\"exitCode\":").append(exitCode);
        appendCurrent(sb);
        if (addressToStatement.get(RegisterFile.getProgramCounter()) != null) {
            sb.append(",\"file\":").append(Json.str(mainFile));
        }
        sb.append(",\"registers\":").append(registersJson());
        sb.append(",\"fp\":").append(fpRegistersJson());
        sb.append('}');
        sendEvent(sb.toString());
    }

    private static void sendExecutionError(String message) {
        int pc = RegisterFile.getProgramCounter();
        ProgramStatement stmt = addressToStatement.get(pc);
        StringBuilder sb = new StringBuilder();
        sb.append("{\"type\":\"executionError\",\"message\":").append(Json.str(message));
        sb.append(",\"reason\":\"EXCEPTION\"");
        sb.append(",\"pc\":").append(pc);
        if (stmt != null) {
            sb.append(",\"line\":").append(stmt.getSourceLine());
        }
        sb.append('}');
        sendEvent(sb.toString());
    }

    private static String registersJson() {
        StringBuilder sb = new StringBuilder();
        sb.append('{');
        for (Register r : RegisterFile.getRegisters()) {
            if (sb.length() > 1) sb.append(',');
            sb.append(Json.str(r.getName())).append(':').append(r.getValue());
        }
        if (sb.length() > 1) sb.append(',');
        sb.append(Json.str("pc")).append(':').append(RegisterFile.getProgramCounter());
        sb.append('}');
        return sb.toString();
    }

    private static String fpRegistersJson() {
        StringBuilder sb = new StringBuilder();
        sb.append('{');
        for (Register r : FloatingPointRegisterFile.getRegisters()) {
            if (sb.length() > 1) sb.append(',');
            sb.append(Json.str(r.getName())).append(':').append(r.getValue());
        }
        sb.append('}');
        return sb.toString();
    }

    private static void sendAssembleErrors(ErrorList errors) {
        StringBuilder arr = new StringBuilder();
        if (errors != null) {
            for (ErrorMessage em : errors.getErrorMessages()) {
                if (arr.length() > 0) arr.append(',');
                arr.append("{\"file\":")
                    .append(Json.str(em.getFilename() == null ? mainFile : em.getFilename()));
                arr.append(",\"line\":").append(em.getLine());
                arr.append(",\"message\":").append(Json.str(em.getMessage()));
                arr.append('}');
            }
        }
        sendEvent("{\"type\":\"assembleErrors\",\"errors\":[" + arr + "]}");
    }

    private static void sendError(String message) {
        sendEvent("{\"type\":\"error\",\"message\":" + Json.str(message) + "}");
    }

    private static void sendEvent(String json) {
        synchronized (protocolLock) {
            protocolOut.print(json);
            protocolOut.print('\n');
            protocolOut.flush();
        }
    }

    // ------------------------------------------------------------------ capture stdout / stderr

    private static class ProgramOutputProxy extends OutputStream {
        private final String stream;
        private final ByteArrayOutputStream buffer = new ByteArrayOutputStream();

        private ProgramOutputProxy(String stream) {
            this.stream = stream;
        }

        @Override
        public void write(int b) {
            // Le saut de ligne est conserve dans le texte envoye : sans lui,
            // les lignes successives se retrouvent collees dans la console.
            if (b == '\n') {
                buffer.write(b);
                flushLine();
            } else if (b != '\r') {
                buffer.write(b);
                if (buffer.size() >= 512) {
                    flushLine();
                }
            }
        }

        @Override
        public void close() {
            flushLine();
            // la fermeture par RARS (SystemIO.resetFiles) ne doit pas tuer le canal
        }

        @Override
        public void flush() {
            // L'autoflush du PrintStream du programme arrive ici : on emet
            // immediatement les fragments sans saut de ligne (prompt "quel est ton calcul ? ").
            flushLine();
        }

        private void flushLine() {
            if (buffer.size() == 0) {
                return;
            }
            String text = buffer.toString(StandardCharsets.UTF_8);
            buffer.reset();
            sendEvent("{\"type\":\"output\",\"stream\":\"" + stream
                + "\",\"text\":" + Json.str(text) + "}");
        }
    }

    private static final class Json {
        private Json() {
        }

        static String str(String value) {
            StringBuilder sb = new StringBuilder("\"");
            if (value == null) {
                value = "";
            }
            for (int i = 0; i < value.length(); i++) {
                char c = value.charAt(i);
                switch (c) {
                    case '"' -> sb.append("\\\"");
                    case '\\' -> sb.append("\\\\");
                    case '\n' -> sb.append("\\n");
                    case '\r' -> sb.append("\\r");
                    case '\t' -> sb.append("\\t");
                    default -> {
                        if (c < 0x20) {
                            sb.append(String.format("\\u%04x", (int) c));
                        } else {
                            sb.append(c);
                        }
                    }
                }
            }
            return sb.append('"').toString();
        }
    }
}

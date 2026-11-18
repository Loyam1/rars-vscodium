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
//   CONT               lancer ou reprendre en continu (thread separe) ; emet stopped
//   STOP               arreter la simulation courante
//   PAUSE              mettre la simulation en pause
//   IN <texte>         alimente le stdin du programme simule
//   QUIT               fermer le pont
//
// Evenements :
//   assembleOk {file, entryLine, lines:[...]}
//   assembleErrors {errors:[{file,line,message}]}
//   breakpoints {lines:[...]}
//   stopped {reason, pc, line, file, exitCode, registers:{...}, fp:{...}}
//   executionError {message, reason, pc, line}
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
import rars.simulator.Simulator;
import rars.util.SystemIO;

import java.io.BufferedOutputStream;
import java.io.BufferedReader;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.FileDescriptor;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.io.PrintStream;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.TreeMap;
import java.util.TreeSet;

public class RarsBridge {

    private static final int MAX_STEPS_UNLIMITED = 0;
    private static final int MAX_STEPS_ONE = 1;
    private static final int STDIN_INDEX = 0;

    private static final Object protocolLock = new Object();
    private static final Object runStateLock = new Object();
    private static final StringBuilder programInput = new StringBuilder();

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
            synchronized (programInput) {
                programInput.append(line.substring(3)).append('\n');
            }
            return;
        }
        switch (line) {
            case "STOP" -> requestStop();
            case "PAUSE" -> simulatorPause();
            case "STEP" -> run(MAX_STEPS_ONE, false);
            case "CONT" -> run(MAX_STEPS_UNLIMITED, true);
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
            programInput.setLength(0);

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

    private static void run(int maxSteps, boolean threaded) {
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
        }
        if (threaded) {
            Thread t = new Thread(() -> {
                try {
                    doRun(maxSteps);
                } finally {
                    running = false;
                }
            }, "RarsBridge-Run");
            currentRunThread = t;
            t.start();
        } else {
            try {
                doRun(maxSteps);
            } finally {
                running = false;
            }
        }
    }

    private static void doRun(int maxSteps) {
        boolean selfMod = true;
        SystemIO.Data tmpFiles;
        Memory tmpMem;
        try {
            selfMod = Globals.getSettings().getBooleanSetting(Settings.Bool.SELF_MODIFYING_CODE_ENABLED);
            Globals.getSettings().setBooleanSettingNonPersistent(
                Settings.Bool.SELF_MODIFYING_CODE_ENABLED, false);

            byte[] pending;
            synchronized (programInput) {
                pending = programInput.toString().getBytes(StandardCharsets.UTF_8);
                programInput.setLength(0);
            }
            ioData = new SystemIO.Data(true);
            ioData.streams[STDIN_INDEX] = new ByteArrayInputStream(pending);
            ioData.inputReader = new BufferedReader(new InputStreamReader(new ByteArrayInputStream(pending)));

            tmpFiles = SystemIO.swapData(ioData);
            tmpMem = Memory.swapInstance(simulationMemory);
            Simulator.Reason reason;
            try {
                int[] bps = breakpointAddresses.isEmpty()
                    ? null
                    : breakpointAddresses.stream().mapToInt(Integer::intValue).toArray();
                reason = Simulator.getInstance()
                    .simulate(RegisterFile.getProgramCounter(), maxSteps, bps);
            } finally {
                Memory.swapInstance(tmpMem);
                SystemIO.swapData(tmpFiles);
                ioData = null;
            }
            Globals.getSettings().setBooleanSettingNonPersistent(
                Settings.Bool.SELF_MODIFYING_CODE_ENABLED, selfMod);
            sendStopped(reason, Globals.exitCode);
        } catch (SimulationException se) {
            Globals.getSettings().setBooleanSettingNonPersistent(
                Settings.Bool.SELF_MODIFYING_CODE_ENABLED, selfMod);
            sendExecutionError(se.getMessage());
        }
    }

    private static void simulatorPause() {
        if (running) {
            Simulator.getInstance().pauseExecution();
        }
    }

    private static void requestStop() {
        if (running) {
            Simulator.getInstance().stopExecution();
        }
    }

    // ------------------------------------------------------------------ evenements

    private static void sendStopped(Simulator.Reason reason, int exitCode) {
        int pc = RegisterFile.getProgramCounter();
        ProgramStatement stmt = addressToStatement.get(pc);
        StringBuilder sb = new StringBuilder();
        sb.append("{\"type\":\"stopped\",\"reason\":\"").append(reason).append('"');
        sb.append(",\"pc\":").append(pc);
        sb.append(",\"exitCode\":").append(exitCode);
        if (stmt != null) {
            sb.append(",\"line\":").append(stmt.getSourceLine());
            sb.append(",\"file\":").append(Json.str(stmt.getSourceFile() == null ? mainFile : stmt.getSourceFile()));
            String src = stmt.getSource();
            String basic = stmt.getPrintableBasicAssemblyStatement();
            sb.append(",\"instruction\":").append(Json.str(src == null ? "" : src.trim()));
            sb.append(",\"expanded\":").append(Json.str(basic == null ? "" : basic.trim()));
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
            if (b == '\n') {
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

# RARS for VSCodium

Extension VSCodium qui lance des programmes RISC-V avec RARS.

## Statut

Execution et debogage du fichier `.asm` actif :

- « Executer le fichier actif » : assemble puis execute via le pont Java, les
 sorties du programme s'affichent dans le terminal « RARS (execution) » ; les
 reponses aux syscalls de lecture (5, 8, 12...) se tapent dans ce terminal,
 Ctrl+C arrete l'execution ;
- « Ouvrir dans l'interface graphique » : lance RARS en processus detache, ses
 fenetres s'ouvrent independamment ;
- affichage des registres entiers et virgule flottante dans un panneau webview,
 avec les valeurs modifiees mises en evidence ;
- pas-a-pas instruction par instruction, reprise, pause, arret, pas-a-pas
 arriere (historique RARS) ;
- points d'arret posables a la souris, avec marqueur dans la gouttiere ;
- sortie du programme (stdout/stderr) capturee dans le terminal et le canal
 de sortie « RARS » ;
- surbrillance de la ligne courante dans l'editeur ;
- auto-completion des instructions RISC-V : n'insere que la commande, les
 arguments attendus s'affichent en texte fantome tant qu'ils ne sont pas
 ecrits, et le survol d'une commande montre son role et ses arguments ;
- etiquettes de registres dynamiques : un commentaire
 `li t0,0 # t0="compteur"` attache « compteur » a t0 pendant le debogage ;
 la definition s'active quand l'execution atteint sa ligne, se met a jour a
 chaque pas (avant comme arriere) et s'affiche en survol dans l'editeur et le
 panneau. Les registres flottants sont couverts (`ft0`, `fs3`, `fa2` ou
 `f0`-`f31`).

Le mode debogage fonctionne via un pont Java (`resources/bridge/RarsBridge.java`)
qui pilote directement l'API de `rars.jar` (assembleur RISCVprogram, simulateur
`Simulator`) : rien ne depend d'automatismes sur la fenêtre de RARS. Le pont est
lance en mode « single-file source launcher », il est donc compile a l'execution
par la JVM — aucun fichier `.class` a maintenir.

## Prerequis

- Java 11 ou plus recent (le pont utilise le lancement de source Java) ;
- Node.js et npm (uniquement pour compiler l'extension) ;
- un fichier `rars.jar` (teste avec RARS 1.6).

Dans les reglages VSCodium, renseignez :

- `rarsVscodium.jarPath` : chemin (absolu ou relatif au workspace) de `rars.jar`.
 Pour tester avec le projet voisin : `../calculatrice-risc-V/rars1_6.jar` ;
- `rarsVscodium.javaPath` : executable Java (defaut `java`).

## Commandes

- `RARS: Executer le fichier actif`
- `RARS: Ouvrir dans l'interface graphique`
- `RARS: Choisir le fichier JAR`
- `RARS: Deboguer le fichier actif` — assemble puis ouvre le panneau de debogage
- `RARS: Pas a pas (instruction suivante)` — F10
- `RARS: Continuer l'execution` — F5 (les raccourcis ne sont actifs que
 pendant une session de debogage)
- `RARS: Pause`
- `RARS: Arreter la session de debogage` — Maj+F5
- `RARS: Basculer un point d'arret sur cette ligne` — clic droit dans l'editeur

Limites connues : un point d'arret pose sur l'instruction de depart ne
declenche qu'apres la premiere instruction (le simulateur de RARS verifie les
points d'arret apres chaque instruction).

## Developpement

```powershell
npm install
npm run compile
```

Ouvrez ensuite ce dossier dans VSCodium et utilisez `F5` pour lancer une fenetre
de test de l'extension.

Test rapide du pont hors VSCodium (depuis le dossier de l'extension) :

```bash
printf 'AS <chemin absolu du fichier.asm>\nBP 5 1\nCONT\nSTEP\nCONT\nQUIT\n' | \
  java -cp <chemin de rars.jar> resources/bridge/RarsBridge.java
```

Chaque evenement est une ligne JSON sur stdout : `assembleOk`, `assembleErrors`,
`breakpoints`, `stopped` (registres, PC, ligne courante), `output`, `error`.

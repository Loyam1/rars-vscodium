# RARS for VSCodium

Extension VSCodium qui lance des programmes RISC-V avec RARS.

## Statut

Commandes d'execution du fichier `.asm` actif (terminal integre ou interface
graphique de RARS), plus un mode debogage natif :

- affichage des registres entiers et virgule flottante dans un panneau webview,
 avec les valeurs modifiees mises en evidence ;
- pas-a-pas instruction par instruction, reprise, pause, arret ;
- points d'arret posables a la souris, avec marqueur dans la gouttiere ;
- sortie du programme (stdout/stderr) capturee dans le panneau et le canal
 de sortie « RARS » ;
- surbrillance de la ligne courante dans l'editeur.

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

Limites connues : les syscalls d'entree (5, 8, 12...) lisent ce qui est tape dans
le champ « Entree du programme » du panneau ; un point d'arret pose sur
l'instruction de depart ne declenche qu'apres la premiere instruction (le
simulateur de RARS verifie les points d'arret apres chaque instruction).

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

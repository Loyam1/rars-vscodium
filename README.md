# RARS for VSCodium

Extension VSCodium qui lance des programmes RISC-V avec RARS.

## Statut

Premier squelette : les commandes permettent d'executer le fichier `.asm` actif dans un terminal integre ou d'ouvrir le fichier dans l'interface graphique de RARS, ou les registres sont visibles.

L'affichage natif des registres et le pas-a-pas dans VSCodium seront ajoutes via un pont Java utilisant l'API RARS. Ils ne doivent pas dependre de l'automatisation de la fenetre RARS.

## Prerequis

- Java 8 ou plus recent ;
- Node.js et npm (uniquement pour compiler l'extension) ;
- un fichier `rars.jar`.

Dans les reglages VSCodium, renseignez `rarsVscodium.jarPath`. Pour tester avec le projet voisin, utilisez :

```text
../calculatrice-risc-V/rars1_6.jar
```

## Commandes

- `RARS: Executer le fichier actif`
- `RARS: Ouvrir dans l'interface graphique`
- `RARS: Choisir le fichier JAR`

## Developpement

```powershell
npm install
npm run compile
```

Ouvrez ensuite ce dossier dans VSCodium et utilisez `F5` pour lancer une fenetre de test de l'extension.

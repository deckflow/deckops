**Langues :** [English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | **Français** | [Español](README.es.md) | [Русский](README.ru.md) | [日本語](README.ja.md)

# deckops CLI

Deckops est l'outil en ligne de commande de [Deckflow](https://app.deckflow.com). Il permet de téléverser des fichiers, de créer des tâches asynchrones et de consulter l'état des tâches.

## Prérequis

- Node.js >= 18
- Un compte Deckflow valide et un workspace (space)

## Installation

```bash
npm install -g deckops
deckops --help
```

## Démarrage rapide

```bash
deckops convert slides.pptx --to pdf
```

## Options globales

| Option | Description |
|--------|-------------|
| `--json` | Afficher les résultats au format JSON (idéal pour les scripts) |
| `--version` | Afficher le numéro de version |
| `--help` | Afficher l'aide |

Exemples :

```bash
# Lister les tâches en mode JSON
deckops --json task list --limit 5

# Afficher la version
deckops --version

# Afficher l'aide d'une sous-commande
deckops convert --help
```

## Compression de fichiers

### `compress <input-file>`

Compresser des documents Office, des vidéos ou des fichiers zip. Le type de tâche est sélectionné automatiquement selon l'extension.

Formats pris en charge : `.zip`, `.pptx`, `.key`, `.docx`, `.xlsx`, `.mp4`, `.avi`, `.mov`, `.mkv`

| Option | Description |
|--------|-------------|
| `-o, --out <path>` | Écrire le résultat de la tâche dans un fichier ou un répertoire |
| `--no-wait` | Ne pas attendre la fin après la création de la tâche |
| `--timeout <seconds>` | Délai d'attente (par défaut 300 secondes) |

```bash
# Compresser une présentation PPT
deckops compress presentation.pptx

# Compresser une vidéo et enregistrer le résultat
deckops compress demo.mp4 -o ./output/compressed.mp4

# Créer la tâche uniquement, sans attendre
deckops compress large.pptx --no-wait
```

## Extraction d'informations

### `extract <input-file>`

Extraire les polices, les formes de texte et d'autres informations d'un fichier.

| Option | Description |
|--------|-------------|
| `--type <type>` | Type d'extraction : `fonts`, `text-shapes` |
| `-o, --out <path>` | Enregistrer le résultat |
| `--no-wait` | Ne pas attendre la fin |
| `--timeout <seconds>` | Délai en secondes |

```bash
# Extraire automatiquement les infos de polices depuis un pptx
deckops extract slides.pptx

# Extraire explicitement les formes de texte
deckops extract slides.pptx --type text-shapes

# Extraire et enregistrer dans un répertoire
deckops extract slides.pptx --type fonts -o ./extracted/
```

## Reconnaissance OCR

### `ocr <input-file>`

Effectuer de l'OCR sur des images. Prend en charge `.jpg`, `.jpeg`, `.png`.

| Option | Description |
|--------|-------------|
| `--language <lang>` | Langue (par défaut `zh-hans`) |
| `-o, --out <path>` | Enregistrer le résultat |
| `--no-wait` | Ne pas attendre la fin |
| `--timeout <seconds>` | Délai en secondes |

Langues prises en charge : `zh-hans`, `zh-hant`, `en`, `ja`, `ko`, `ar`, `de`, `es`, `fr`, `it`, `pt`, `ru`

```bash
# Reconnaître une image en chinois (langue par défaut)
deckops ocr scan.jpg

# Reconnaître une image en anglais
deckops ocr document.png --language en

# Reconnaître en japonais et enregistrer
deckops ocr receipt.jpg --language ja -o ./ocr-result.json
```

## Conversion de format

### `convert <input-files...> --to <format>`

Convertir des fichiers au format spécifié.

| Option | Description |
|--------|-------------|
| `--to <format>` | Format de sortie (obligatoire) : `image`, `pdf`, `video`, `html`, `png`, `pptx`, `webp` |
| `--width <number>` | Largeur pour HTML → PPT/PNG |
| `--height <number>` | Hauteur pour HTML → PPT/PNG |
| `--need-embed-fonts [boolean]` | Intégrer les polices pour HTML → PPTX (par défaut false) |
| `-o, --out <path>` | Enregistrer le résultat |
| `--no-wait` | Ne pas attendre la fin |
| `--timeout <seconds>` | Délai en secondes |

**Note multi-fichiers** : Seul `html → pptx` prend en charge plusieurs fichiers d'entrée, fusionnés dans l'ordre en une seule tâche de conversion.

```bash
# PPT vers PDF
deckops convert slides.pptx --to pdf

# Fusionner plusieurs HTML en PPTX
deckops convert page1.html page2.html page3.html --to pptx

# HTML vers PNG avec dimensions et enregistrement
deckops convert slide.html --to png --width 1920 --height 1080 -o ./slide.png
```

## Fusion PPT

### `join <input-files...>`

Fusionner plusieurs fichiers `.pptx` dans l'ordre donné en un seul (type de tâche `pptx.join`). Au moins 2 fichiers requis.

| Option | Description |
|--------|-------------|
| `--name <name>` | Nom de la tâche |
| `-o, --out <path>` | Enregistrer le résultat |
| `--no-wait` | Ne pas attendre la fin |
| `--timeout <seconds>` | Délai en secondes |

```bash
# Fusionner trois présentations
deckops join intro.pptx body.pptx appendix.pptx

# Spécifier le nom de la tâche et enregistrer
deckops join part1.pptx part2.pptx --name merged-deck -o ./merged.pptx

# Créer la tâche uniquement
deckops join a.pptx b.pptx --no-wait
```

## Génération de contenu IA

### `create [input-files...]`

Générer du contenu documentaire à partir de texte ou de fichiers de référence (type de tâche API `generation`).

| Option | Description |
|--------|-------------|
| `--input-text <text>` | Texte d'entrée |
| `--enable-search [boolean]` | Activer la recherche |
| `--advanced-model [boolean]` | Utiliser le modèle avancé |
| `--fast-mode [boolean]` | Mode rapide |
| `--intent <intent>` | Intention de génération |
| `--audience <audience>` | Public cible |
| `--page-count <number>` | Nombre de pages attendu |
| `--author <name>` | Auteur du document |
| `-o, --out <path>` | Enregistrer le résultat |
| `--no-wait` | Ne pas attendre la fin |
| `--timeout <seconds>` | Délai en secondes |

Jusqu'à 2 fichiers de référence pris en charge : `.html`, `.pdf`, `.docx`, `.pptx`, `.txt`, `.md`, `.mm`, `.xmind`, `.ipynb`

```bash
# Génération texte pur
deckops create --input-text "Rédiger un plan de lancement produit"

# Avec fichier de référence et limite de pages
deckops create outline.md --input-text "Développer en discours complet" --page-count 20

# Modèle avancé + recherche, et enregistrer le résultat
deckops create brief.pdf --input-text "Générer un rapport détaillé" --advanced-model --enable-search -o ./report/
```

## Traduction de documents

### `translate <input-file>`

Traduire des fichiers documentaires. Prend en charge `.docx`, `.pptx`, `.pdf`, `.xlsx`, `.key`.

| Option | Description |
|--------|-------------|
| `--from <language>` | Langue source (obligatoire) |
| `--to <language>` | Langue cible (obligatoire) |
| `--model <model>` | Modèle (obligatoire) : `Standard` ou `Pro` |
| `--use-glossary [boolean]` | Utiliser le glossaire |
| `--image-translate [boolean]` | Traduire le texte dans les images |
| `-o, --out <path>` | Enregistrer le résultat |
| `--no-wait` | Ne pas attendre la fin |
| `--timeout <seconds>` | Délai en secondes |

```bash
# Chinois vers anglais (modèle Standard)
deckops translate handbook.docx --from zh --to en --model Standard

# Anglais vers chinois, modèle Pro
deckops translate slides.pptx --from en --to zh --model Pro

# Détection automatique de la langue source, glossaire et enregistrement
deckops translate manual.pdf --from auto --to ja --model Pro --use-glossary -o ./translated.pdf
```

## Exécution générique de tâches

### `run <task-type> <input-files...>`

Exécuter avec un type de tâche explicite. Convient aux usages avancés ou aux tâches non encapsulées par le CLI.

| Option | Description |
|--------|-------------|
| `--param <key=value>` | Paramètres de tâche (répétables ; les valeurs supportent JSON) |
| `-o, --out <path>` | Enregistrer le résultat |
| `--no-wait` | Ne pas attendre la fin |
| `--timeout <seconds>` | Délai en secondes |

**Note multi-fichiers** : Les types de tâches suivants prennent en charge plusieurs fichiers d'entrée comme ensemble de sources ordonné : `pptx.join`, `convertor.html2pptx`, `html.buildPlayer`, `generation`.

```bash
# PPT vers PDF (type de tâche explicite)
deckops run convertor.ppt2pdf demo.ppt

# Fusionner PPT
deckops run pptx.join part1.pptx part2.pptx

# HTML vers PPTX avec paramètres
deckops run convertor.html2pptx page1.html page2.html --param width=1920 --param needEmbedFonts=true
```

## Gestion des tâches

### `task list`

Lister les tâches du workspace.

| Option | Description |
|--------|-------------|
| `--type <type>` | Filtrer par type de tâche |
| `--limit <n>` | Nombre maximum (par défaut 50) |
| `--offset <n>` | Décalage de pagination (par défaut 0) |

```bash
# Lister les 10 tâches les plus récentes
deckops task list --limit 10

# Tâches de conversion uniquement
deckops task list --type convertor.ppt2pdf --limit 20

# Requête paginée en JSON
deckops --json task list --offset 50 --limit 50
```

### `task get <task-id>`

Obtenir les détails d'une tâche.

| Option | Description |
|--------|-------------|
| `-o, --out <path>` | Télécharger et enregistrer le résultat d'une tâche terminée |

```bash
# Voir les détails de la tâche
deckops task get abc123-task-id

# Télécharger le résultat vers un fichier
deckops task get abc123-task-id -o ./result.pdf

# Mode JSON
deckops --json task get abc123-task-id
```

### `task delete <task-id>`

Supprimer une tâche spécifiée.

```bash
# Supprimer la tâche
deckops task delete abc123-task-id

# Mode JSON
deckops --json task delete abc123-task-id

# Confirmer la liste après suppression
deckops task delete abc123-task-id && deckops task list --limit 5
```

## REPL interactif

### `repl`

Entrer dans une ligne de commande interactive pour exécuter des sous-commandes une par une sans redémarrer le processus.

```bash
# Démarrer le REPL
deckops repl
```

Dans le REPL, vous pouvez saisir les mêmes commandes que le CLI classique, par exemple :

```
deckflow> convert slides.pptx --to pdf
deckflow> task list --limit 5
```

Tapez `exit` ou `quit` pour quitter.

## Complétion interactive

Dans un environnement TTY, si des arguments ou options obligatoires sont manquants, le CLI tentera des invites interactives (non déclenchées avec `--json`). Par exemple, si `--to` est manquant, `convert` vous guidera pour choisir un format de sortie.

## Sortie et comportement de `-o`

- Par défaut : texte lisible + spinner de progression
- `--json` : JSON structuré pour l'analyse par script
- `-o, --out` : télécharger automatiquement le résultat après la fin de la tâche
  - Fichier unique → écrire au chemin spécifié
  - Fichiers multiples → écrire dans un répertoire ; si le chemin se termine par `.zip`, empaqueter en zip
  - Pas de résultat fichier → écrire en JSON

Lorsque `-o` est spécifié, la tâche sera attendue même si `--wait` n'est pas explicitement passé.

## FAQ

**Q : Quand l'entrée multi-fichiers est-elle valide ?**

Seules certaines tâches prennent en charge les sources multiples ordonnées : `convert` pour `html → pptx`, `join`, `create` (jusqu'à 2 fichiers de référence), et `run` pour `pptx.join` / `convertor.html2pptx`, etc.

## Liens connexes

- [Deckflow](https://app.deckflow.com)
- Signaler un problème : [GitHub Issues](https://github.com/deckflow/deckops/issues)

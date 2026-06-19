**Langues :** [English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | **Français** | [Español](README.es.md) | [Русский](README.ru.md) | [日本語](README.ja.md)

# @deckops/sdk

SDK compatible Node.js et navigateur pour les API de tâches Deckops/Deckflow.

## Installation

```bash
pnpm add @deckops/sdk
```

Dans ce monorepo :

```bash
pnpm --filter @deckops/sdk build
```

## Créer un client

```ts
import { createDeck } from '@deckops/sdk';

const deck = createDeck({
  root: 'https://app.deckflow.com/v1',
  token: 'user-token',
  apiKey: 'api-key',
  spaceId: 'space-id',
});
```

Options :

- `root?: string` - Adresse racine de l'API. Par défaut `https://app.deckflow.com/v1`.
- `token?: string` - envoyé via l'en-tête `X-Auth-Token`.
- `apiKey?: string` - envoyé via `Authorization: Bearer {apiKey}`.
- `spaceId?: string` - identifiant d'espace par défaut pour les appels de tâches et de fichiers.
- `authUuid?: string` - UUID client explicite (UUID v4) envoyé via `X-Auth-UUID`. Ignore la persistance automatique.
- `authUuidStorage?: { get(), set(value) }` - stockage personnalisé pour l'UUID client (SSR, tests, applications embarquées).
- `onUnauthorized?: () => Promise<{ token: string; spaceId?: string } | string>` - appelé une fois après un 401, puis la requête est réessayée.
- `onPaymentRequired?: () => Promise<void>` - appelé une fois après un 402, puis la requête est réessayée.

Chaque requête API Deckops inclut automatiquement `X-Auth-UUID`, un UUID v4 stable utilisé pour suivre le client entre les sessions.

- **Navigateur** : persisté dans `localStorage` sous la clé `df_uuid`.
- **Node.js** : persisté dans `~/.deckops/auth-uuid` (remplacez le répertoire avec `DECKOPS_CONFIG_DIR`).
- **Remplacement explicite** : passez `authUuid` ou définissez `DECKOPS_AUTH_UUID` (Node uniquement) pour des identifiants fixes en CI, conteneurs ou serveurs multi-locataires.

```ts
const uuid = await deck.getAuthUuid();
console.log('Client UUID:', uuid);
```

## Créer des tâches avec des fichiers

Passez directement les fichiers sélectionnés par l'utilisateur aux méthodes de tâche. Le SDK les téléverse en interne et envoie les identifiants de fichier résultants à l'API de tâches :

```ts
const task = await deck.convertPptToPdf({
  files: ['./slides.pptx'],
  upload: {
    onProgress: (p) => console.log(`${Math.round(p * 100)}%`),
  },
});
```

`files` prend en charge :

- Chemin de fichier Node.js : `'./a.pptx'`
- Données binaires Node.js/navigateur : `Uint8Array` ou `ArrayBuffer`
- `Blob`/`File` du navigateur

Pour les sélecteurs de fichiers du navigateur, passez l'objet `File` sélectionné :

```ts
await deck.convertPptToPdf({
  files: [file],
});
```

Pour des données binaires sans nom de fichier, incluez des options de téléversement par fichier :

```ts
await deck.imageOcr({
  files: [{ input: bytes, name: 'image.png' }],
  params: { language: 'en' },
});
```

Pour la compatibilité avec les intégrations existantes, `fileIds` est toujours accepté et peut être combiné avec `files`.

## API de tâches générique

```ts
const task = await deck.tasks.create({
  type: 'convertor.ppt2pdf',
  files: ['./slides.pptx'],
  name: 'slides',
  params: {},
});

await deck.tasks.list({ type: 'convertor.ppt2pdf', startIndex: 0, maxResults: 50 });
await deck.tasks.get(task.id);
await deck.tasks.wait(task.id, { timeout: 300, useEventStream: true });
await deck.tasks.down<'convertor.ppt2pdf'>(task.id);
await deck.tasks.delete(task.id);

const cancel = await deck.tasks.subscribe(task.id, {
  onUpdate: (next) => console.log(next.status),
  onError: console.error,
});
cancel();
```

Les réponses de détail de tâche servent aux métadonnées de statut/progression. Les résultats de tâche doivent être lus via `deck.tasks.down(...)` ou l'alias backend `deck.ttask.down(...)`.

```ts
const result = await deck.ttask.down<'convertor.ppt2pdf'>(task.id);
const generationDownload = await deck.ttask.down<'generation'>(task.id, { type: 'pptx' });
console.log(generationDownload.downloadUrl);
```

## Types de résultats

Le SDK exporte des types de résultats concrets pour chaque type de tâche via `DeckTaskTypeResult`.

La plupart des tâches produisant des fichiers renvoient des résultats de fichier en forme de tuple, conformément au contrat backend :

```ts
type FileResult = [
  path: string,
  bytes: number,
  hash: string,
];

type ConvertFileResult = [
  path: string,
  bytes: number,
  hash: string,
  bounds?: { w?: number; h?: number; total?: number } | null,
];
```

`path` est la clé de stockage ou le chemin relatif dans les données brutes du backend. Lorsque l'API de détail de tâche développe les résultats téléchargeables, il peut déjà s'agir d'une URL signée/d'accès.

Exemples :

- `deck.convertPptToPdf(...)` renvoie `ConvertFileResult[]`.
- `deck.convertHtmlToPptx(...)` renvoie `{ target: FileResult; usedFonts: string[] }`.
- `deck.pptxSplit(...)` renvoie `{ ppt, sections, slides }` avec des métadonnées de fichiers de diapositives typées.
- `deck.pptxGetFontInfo(...)` renvoie `{ fonts, embeddedFont, subsetFont }`.
- `deck.pptxGetTextShapes(...)` renvoie des métadonnées typées de page/forme/texte/image.

## Helpers de tâches typés

Chaque helper accepte `{ spaceId?, files?, fileIds?, name?, params?, upload? }`, définit le `type` de tâche backend, téléverse les fichiers si nécessaire et renvoie un `DeckTask` typé.

### Fichiers et images

```ts
await deck.fileCompress({ files: ['./document.pdf'] });
await deck.imageOcr({ files: [file], params: { language: 'en' } });
await deck.imageConvertWebp({ files: [file] });
await deck.imageResize({ files: [file], params: { maxWidth: 1024 } });
```

### PPTX

```ts
await deck.pptxSplit({ files: ['./slides.pptx'], params: { indexes: [0, 1] } });
await deck.pptxJoin({ files: ['./part1.pptx', './part2.pptx'], name: 'merged' });
await deck.pptxGetFontInfo({ files: ['./slides.pptx'] });
await deck.pptxGetTextShapes({
  files: ['./slides.pptx'],
  params: { includeNotes: true, ignoreEmptyText: true },
});
await deck.pptxEmbedFonts({
  files: ['./slides.pptx'],
  params: { usedFonts: ['Arial'] },
});
```

### Convertisseurs

```ts
await deck.convertPptToImage({
  files: ['./slides.pptx'],
  params: { resolution: 1920, format: 'jpg' },
});
await deck.convertPptToPptx({ files: ['./slides.ppt'] });
await deck.convertPptToPdf({ files: ['./slides.pptx'] });
await deck.convertDocToPdf({ files: ['./handbook.docx'] });
await deck.convertPptToVideo({ files: ['./slides.pptx'] });
await deck.convertPdfToImage({ files: ['./document.pdf'] });
await deck.convertKeynoteToImage({ files: ['./deck.key'] });
await deck.convertKeynoteToHtml({ files: ['./deck.key'] });
await deck.convertKeynoteToPdf({ files: ['./deck.key'] });
await deck.convertHtmlToPng({
  files: [{ input: htmlBytes, name: 'page.html' }],
  params: { width: 1280, height: 720, fullPage: true },
});
await deck.convertMarkdownToPng({
  files: [{ input: markdownBytes, name: 'page.md' }],
  params: { theme: 'dark', pageWidth: 960 },
});
await deck.convertHtmlToPptx({
  files: [{ input: htmlBytes, name: 'deck.html' }],
  params: { width: 1280, height: 720, needEmbedFonts: false },
});
await deck.convertHtmlToPptx({
  files: ['./page1.html', './page2.html'],
  params: { width: 1280, height: 720 },
});
```

L'ordre des fichiers multi-sources est significatif pour les types de tâches qui mappent l'intégralité du tableau de fichiers vers les paramètres backend, notamment `pptx.join`, `convertor.html2pptx`, `html.buildPlayer` et `generation`. La plupart des autres types de tâches ne lisent qu'un fichier source ; passez un fichier par tâche pour ceux-ci.

### Lecteur HTML, génération, traduction, refonte

```ts
await deck.htmlBuildPlayer({
  params: {
    contents: [{ key: 'pages/1.html' }],
    pageWidth: 1280,
    pageHeight: 720,
    title: 'Deck',
    description: 'Deck player',
    brandMarkPosition: 'none',
  },
});

await deck.generation({
  files: [referenceFile],
  params: {
    inputText: 'Rédigez un plan de lancement produit',
    enableSearch: true,
    pageCount: 8,
  },
});

await deck.translation({
  files: [file],
  params: {
    from: 'zh',
    to: 'en',
    model: 'Standard',
    useGlossary: false,
    imageTranslate: false,
  },
});

await deck.revamp({
  files: [file],
  params: { lang: 'zh' },
});
```

## Notes navigateur et Node.js

- Les helpers de tâches acceptent directement les fichiers et les téléversent avant la création de la tâche.
- Les téléversements Node.js peuvent lire un chemin et calculer le MD5.
- Les téléversements navigateur peuvent utiliser `Blob`/`File` ; le SDK lit le nom de fichier et calcule le MD5.
- L'abonnement Server-Sent Event est principalement destiné aux flux Node.js. Le polling navigateur via `deck.tasks.wait(taskId, { useEventStream: false })` est l'option la plus portable.

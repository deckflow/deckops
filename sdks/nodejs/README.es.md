**Idiomas:** [English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [Français](README.fr.md) | **Español** | [Русский](README.ru.md) | [日本語](README.ja.md)

# @deckops/sdk

SDK compatible con Node.js y navegador para las API de tareas de Deckops/Deckflow.

## Instalación

```bash
pnpm add @deckops/sdk
```

En este monorepo:

```bash
pnpm --filter @deckops/sdk build
```

## Crear un cliente

```ts
import { createDeck } from '@deckops/sdk';

const deck = createDeck({
  root: 'https://app.deckflow.com/v1',
  token: 'user-token',
  apiKey: 'api-key',
  spaceId: 'space-id',
});
```

Opciones:

- `root?: string` - Dirección raíz de la API. Por defecto `https://app.deckflow.com/v1`.
- `token?: string` - se envía como `X-Auth-Token`.
- `apiKey?: string` - se envía como `Authorization: Bearer {apiKey}`.
- `spaceId?: string` - id de espacio predeterminado para llamadas de tareas y archivos.
- `authUuid?: string` - UUID de cliente explícito (UUID v4) enviado como `X-Auth-UUID`. Omite la persistencia automática.
- `authUuidStorage?: { get(), set(value) }` - almacenamiento personalizado para el UUID del cliente (SSR, pruebas, aplicaciones embebidas).
- `onUnauthorized?: () => Promise<{ token: string; spaceId?: string } | string>` - se llama una vez tras un 401, luego se reintenta la solicitud.
- `onPaymentRequired?: () => Promise<void>` - se llama una vez tras un 402, luego se reintenta la solicitud.

Cada solicitud a la API de Deckops incluye automáticamente `X-Auth-UUID`, un UUID v4 estable usado para rastrear el cliente entre sesiones.

- **Navegador**: persistido en `localStorage` bajo `df_uuid`.
- **Node.js**: persistido en `~/.deckops/auth-uuid` (sobrescribe el directorio con `DECKOPS_CONFIG_DIR`).
- **Sobrescritura explícita**: pasa `authUuid` o establece `DECKOPS_AUTH_UUID` (solo Node) para IDs fijos en CI, contenedores o servidores multiinquilino.

```ts
const uuid = await deck.getAuthUuid();
console.log('Client UUID:', uuid);
```

## Crear tareas con archivos

Pasa los archivos seleccionados por el usuario directamente a los métodos de tarea. El SDK los sube internamente y envía los ids de archivo resultantes a la API de tareas:

```ts
const task = await deck.convertPptToPdf({
  files: ['./slides.pptx'],
  upload: {
    onProgress: (p) => console.log(`${Math.round(p * 100)}%`),
  },
});
```

`files` admite:

- Ruta de archivo en Node.js: `'./a.pptx'`
- Datos binarios en Node.js/navegador: `Uint8Array` o `ArrayBuffer`
- `Blob`/`File` del navegador

Para selectores de archivos del navegador, pasa el objeto `File` seleccionado:

```ts
await deck.convertPptToPdf({
  files: [file],
});
```

Para datos binarios sin nombre de archivo, incluye opciones de subida por archivo:

```ts
await deck.imageOcr({
  files: [{ input: bytes, name: 'image.png' }],
  params: { language: 'en' },
});
```

Por compatibilidad con integraciones existentes, `fileIds` sigue aceptándose y puede combinarse con `files`.

## API genérica de tareas

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

Las respuestas de detalle de tarea sirven para metadatos de estado/progreso. Los resultados de tarea deben leerse mediante `deck.tasks.down(...)` o el alias del backend `deck.ttask.down(...)`.

```ts
const result = await deck.ttask.down<'convertor.ppt2pdf'>(task.id);
const generationDownload = await deck.ttask.down<'generation'>(task.id, { type: 'pptx' });
console.log(generationDownload.downloadUrl);
```

## Tipos de resultado

El SDK exporta tipos de resultado concretos para cada tipo de tarea mediante `DeckTaskTypeResult`.

La mayoría de las tareas que producen archivos devuelven resultados de archivo en forma de tupla, según el contrato del backend:

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

`path` es la clave de almacenamiento o la ruta relativa en los datos brutos del backend. Cuando la API de detalle de tarea expande resultados descargables, puede ser ya una URL firmada/de acceso.

Ejemplos:

- `deck.convertPptToPdf(...)` devuelve `ConvertFileResult[]`.
- `deck.convertHtmlToPptx(...)` devuelve `{ target: FileResult; usedFonts: string[] }`.
- `deck.pptxSplit(...)` devuelve `{ ppt, sections, slides }` con metadatos tipados de archivos de diapositivas.
- `deck.pptxGetFontInfo(...)` devuelve `{ fonts, embeddedFont, subsetFont }`.
- `deck.pptxGetTextShapes(...)` devuelve metadatos tipados de página/forma/texto/imagen.

## Helpers de tareas tipados

Cada helper acepta `{ spaceId?, files?, fileIds?, name?, params?, upload? }`, establece el `type` de tarea del backend, sube archivos cuando es necesario y devuelve un `DeckTask` tipado.

### Archivos e imágenes

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

### Convertidores

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

El orden de archivos multiorigen es significativo para tipos de tarea que mapean todo el array de archivos a parámetros del backend, incluidos `pptx.join`, `convertor.html2pptx`, `html.buildPlayer` y `generation`. La mayoría de los demás tipos de tarea leen un solo archivo fuente; pasa un archivo por tarea en esos casos.

### Reproductor HTML, generación, traducción, renovación

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
    inputText: 'Escribe un plan de lanzamiento de producto',
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

## Notas para navegador y Node.js

- Los helpers de tareas aceptan archivos directamente y los suben antes de crear la tarea.
- Las subidas en Node.js pueden leer una ruta y calcular MD5.
- Las subidas en navegador pueden usar `Blob`/`File`; el SDK lee el nombre del archivo y calcula MD5.
- La suscripción Server-Sent Event está pensada principalmente para flujos de Node.js. El sondeo en navegador mediante `deck.tasks.wait(taskId, { useEventStream: false })` es la opción más portable.

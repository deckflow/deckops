**Idiomas:** [English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [Français](README.fr.md) | **Español** | [Русский](README.ru.md) | [日本語](README.ja.md)

# deckops CLI

Deckops es la herramienta de línea de comandos de [Deckflow](https://app.deckflow.com). Permite subir archivos, crear tareas asíncronas y consultar el estado de las tareas.

## Requisitos

- Node.js >= 18
- Una cuenta de Deckflow válida y un workspace (space)

## Instalación

```bash
npm install -g deckops
deckops --help
```

## Inicio rápido

```bash
deckops convert slides.pptx --to pdf
```

## Opciones globales

| Opción | Descripción |
|--------|-------------|
| `--json` | Mostrar resultados en formato JSON (ideal para scripts) |
| `--version` | Mostrar número de versión |
| `--help` | Mostrar ayuda |

Ejemplos:

```bash
# Listar tareas en modo JSON
deckops --json task list --limit 5

# Ver versión
deckops --version

# Ver ayuda de un subcomando
deckops convert --help
```

## Compresión de archivos

### `compress <input-file>`

Comprimir documentos de Office, vídeos o archivos zip. El tipo de tarea se selecciona automáticamente según la extensión.

Formatos admitidos: `.zip`, `.pptx`, `.key`, `.docx`, `.xlsx`, `.mp4`, `.avi`, `.mov`, `.mkv`

| Opción | Descripción |
|--------|-------------|
| `-o, --out <path>` | Escribir el resultado de la tarea en un archivo o directorio |
| `--no-wait` | No esperar la finalización tras crear la tarea |
| `--timeout <seconds>` | Tiempo de espera (por defecto 300 segundos) |

```bash
# Comprimir una presentación PPT
deckops compress presentation.pptx

# Comprimir vídeo y guardar resultado
deckops compress demo.mp4 -o ./output/compressed.mp4

# Solo crear tarea, sin esperar
deckops compress large.pptx --no-wait
```

## Extracción de información

### `extract <input-file>`

Extraer fuentes, formas de texto y otra información de un archivo.

| Opción | Descripción |
|--------|-------------|
| `--type <type>` | Tipo de extracción: `fonts`, `text-shapes` |
| `-o, --out <path>` | Guardar resultado |
| `--no-wait` | No esperar finalización |
| `--timeout <seconds>` | Tiempo de espera en segundos |

```bash
# Extraer automáticamente info de fuentes de pptx
deckops extract slides.pptx

# Extraer explícitamente formas de texto
deckops extract slides.pptx --type text-shapes

# Extraer y guardar en directorio
deckops extract slides.pptx --type fonts -o ./extracted/
```

## Reconocimiento OCR

### `ocr <input-file>`

Realizar OCR en imágenes. Admite `.jpg`, `.jpeg`, `.png`.

| Opción | Descripción |
|--------|-------------|
| `--language <lang>` | Idioma (por defecto `zh-hans`) |
| `-o, --out <path>` | Guardar resultado |
| `--no-wait` | No esperar finalización |
| `--timeout <seconds>` | Tiempo de espera en segundos |

Idiomas admitidos: `zh-hans`, `zh-hant`, `en`, `ja`, `ko`, `ar`, `de`, `es`, `fr`, `it`, `pt`, `ru`

```bash
# Reconocer imagen en chino (idioma por defecto)
deckops ocr scan.jpg

# Reconocer imagen en inglés
deckops ocr document.png --language en

# Reconocer en japonés y guardar
deckops ocr receipt.jpg --language ja -o ./ocr-result.json
```

## Conversión de formato

### `convert <input-files...> --to <format>`

Convertir archivos al formato especificado.

| Opción | Descripción |
|--------|-------------|
| `--to <format>` | Formato de salida (obligatorio): `image`, `pdf`, `video`, `html`, `png`, `pptx`, `webp` |
| `--width <number>` | Ancho para HTML → PPT/PNG |
| `--height <number>` | Alto para HTML → PPT/PNG |
| `--need-embed-fonts [boolean]` | Incrustar fuentes para HTML → PPTX (por defecto false) |
| `-o, --out <path>` | Guardar resultado |
| `--no-wait` | No esperar finalización |
| `--timeout <seconds>` | Tiempo de espera en segundos |

**Nota multi-archivo**: Solo `html → pptx` admite múltiples archivos de entrada, fusionados en orden en una sola tarea de conversión.

```bash
# PPT a PDF
deckops convert slides.pptx --to pdf

# Fusionar varios HTML en PPTX
deckops convert page1.html page2.html page3.html --to pptx

# HTML a PNG con dimensiones y guardar
deckops convert slide.html --to png --width 1920 --height 1080 -o ./slide.png
```

## Fusión de PPT

### `join <input-files...>`

Fusionar varios archivos `.pptx` en el orden dado en uno solo (tipo de tarea `pptx.join`). Se requieren al menos 2 archivos.

| Opción | Descripción |
|--------|-------------|
| `--name <name>` | Nombre de la tarea |
| `-o, --out <path>` | Guardar resultado |
| `--no-wait` | No esperar finalización |
| `--timeout <seconds>` | Tiempo de espera en segundos |

```bash
# Fusionar tres presentaciones
deckops join intro.pptx body.pptx appendix.pptx

# Especificar nombre de tarea y guardar
deckops join part1.pptx part2.pptx --name merged-deck -o ./merged.pptx

# Solo crear tarea
deckops join a.pptx b.pptx --no-wait
```

## Generación de contenido con IA

### `create [input-files...]`

Generar contenido documental a partir de texto o archivos de referencia (tipo de tarea API `generation`).

| Opción | Descripción |
|--------|-------------|
| `--input-text <text>` | Texto de entrada |
| `--enable-search [boolean]` | Activar búsqueda |
| `--advanced-model [boolean]` | Usar modelo avanzado |
| `--fast-mode [boolean]` | Modo rápido |
| `--intent <intent>` | Intención de generación |
| `--audience <audience>` | Público objetivo |
| `--page-count <number>` | Número de páginas esperado |
| `--author <name>` | Autor del documento |
| `-o, --out <path>` | Guardar resultado |
| `--no-wait` | No esperar finalización |
| `--timeout <seconds>` | Tiempo de espera en segundos |

Hasta 2 archivos de referencia admitidos: `.html`, `.pdf`, `.docx`, `.pptx`, `.txt`, `.md`, `.mm`, `.xmind`, `.ipynb`

```bash
# Generación solo con texto
deckops create --input-text "Escribe un plan de lanzamiento de producto"

# Con archivo de referencia y límite de páginas
deckops create outline.md --input-text "Ampliar a discurso completo" --page-count 20

# Modelo avanzado + búsqueda, y guardar resultado
deckops create brief.pdf --input-text "Generar informe detallado" --advanced-model --enable-search -o ./report/
```

## Traducción de documentos

### `translate <input-file>`

Traducir archivos documentales. Admite `.docx`, `.pptx`, `.pdf`, `.xlsx`, `.key`.

| Opción | Descripción |
|--------|-------------|
| `--from <language>` | Idioma de origen (obligatorio) |
| `--to <language>` | Idioma de destino (obligatorio) |
| `--model <model>` | Modelo (obligatorio): `Standard` o `Pro` |
| `--use-glossary [boolean]` | Usar glosario |
| `--image-translate [boolean]` | Traducir texto en imágenes |
| `-o, --out <path>` | Guardar resultado |
| `--no-wait` | No esperar finalización |
| `--timeout <seconds>` | Tiempo de espera en segundos |

```bash
# Chino a inglés (modelo Standard)
deckops translate handbook.docx --from zh --to en --model Standard

# Inglés a chino, modelo Pro
deckops translate slides.pptx --from en --to zh --model Pro

# Detección automática de idioma de origen, glosario y guardar
deckops translate manual.pdf --from auto --to ja --model Pro --use-glossary -o ./translated.pdf
```

## Ejecución genérica de tareas

### `run <task-type> <input-files...>`

Ejecutar con un tipo de tarea explícito. Adecuado para usos avanzados o tareas no encapsuladas por el CLI.

| Opción | Descripción |
|--------|-------------|
| `--param <key=value>` | Parámetros de tarea (repetibles; los valores admiten JSON) |
| `-o, --out <path>` | Guardar resultado |
| `--no-wait` | No esperar finalización |
| `--timeout <seconds>` | Tiempo de espera en segundos |

**Nota multi-archivo**: Los siguientes tipos de tarea admiten múltiples archivos de entrada como conjunto de fuentes ordenado: `pptx.join`, `convertor.html2pptx`, `html.buildPlayer`, `generation`.

```bash
# PPT a PDF (tipo de tarea explícito)
deckops run convertor.ppt2pdf demo.ppt

# Fusionar PPT
deckops run pptx.join part1.pptx part2.pptx

# HTML a PPTX con parámetros
deckops run convertor.html2pptx page1.html page2.html --param width=1920 --param needEmbedFonts=true
```

## Gestión de tareas

### `task list`

Listar tareas del workspace.

| Opción | Descripción |
|--------|-------------|
| `--type <type>` | Filtrar por tipo de tarea |
| `--limit <n>` | Número máximo (por defecto 50) |
| `--offset <n>` | Desplazamiento de paginación (por defecto 0) |

```bash
# Listar las 10 tareas más recientes
deckops task list --limit 10

# Solo tareas de conversión
deckops task list --type convertor.ppt2pdf --limit 20

# Consulta paginada en JSON
deckops --json task list --offset 50 --limit 50
```

### `task get <task-id>`

Obtener detalles de una tarea.

| Opción | Descripción |
|--------|-------------|
| `-o, --out <path>` | Descargar y guardar el resultado de una tarea completada |

```bash
# Ver detalles de la tarea
deckops task get abc123-task-id

# Descargar resultado a archivo
deckops task get abc123-task-id -o ./result.pdf

# Modo JSON
deckops --json task get abc123-task-id
```

### `task delete <task-id>`

Eliminar una tarea especificada.

```bash
# Eliminar tarea
deckops task delete abc123-task-id

# Modo JSON
deckops --json task delete abc123-task-id

# Confirmar lista tras eliminación
deckops task delete abc123-task-id && deckops task list --limit 5
```

## REPL interactivo

### `repl`

Entrar en una línea de comandos interactiva para ejecutar subcomandos uno a uno sin reiniciar el proceso.

```bash
# Iniciar REPL
deckops repl
```

En el REPL puedes introducir los mismos comandos que el CLI normal, por ejemplo:

```
deckflow> convert slides.pptx --to pdf
deckflow> task list --limit 5
```

Escribe `exit` o `quit` para salir.

## Autocompletado interactivo

En un entorno TTY, si faltan argumentos u opciones obligatorios, el CLI intentará completar de forma interactiva (no se activa con `--json`). Por ejemplo, si falta `--to`, `convert` te guiará para elegir un formato de salida.

## Salida y comportamiento de `-o`

- Por defecto: texto legible + spinner de progreso
- `--json`: JSON estructurado para análisis por script
- `-o, --out`: descargar automáticamente el resultado tras completar la tarea
  - Archivo único → escribir en la ruta especificada
  - Varios archivos → escribir en directorio; si la ruta termina en `.zip`, empaquetar como zip
  - Sin resultado de archivo → escribir JSON

Cuando se especifica `-o`, se esperará la tarea aunque no se pase explícitamente `--wait`.

## Preguntas frecuentes

**P: ¿Cuándo es válida la entrada multi-archivo?**

Solo algunas tareas admiten múltiples fuentes ordenadas: `convert` para `html → pptx`, `join`, `create` (hasta 2 archivos de referencia), y `run` para `pptx.join` / `convertor.html2pptx`, etc.

## Enlaces relacionados

- [Deckflow](https://app.deckflow.com)
- Reportar problemas: [GitHub Issues](https://github.com/deckflow/deckops/issues)

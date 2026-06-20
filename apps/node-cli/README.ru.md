**Языки:** [English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [Français](README.fr.md) | [Español](README.es.md) | **Русский** | [日本語](README.ja.md)

# deckops CLI

Deckops — это инструмент командной строки для [Deckflow](https://app.deckflow.com). Он позволяет загружать файлы, создавать асинхронные задачи и просматривать статус задач.

## Требования

- Node.js >= 18
- Действующий аккаунт Deckflow и workspace (space)

## Установка

```bash
npm install -g deckops
deckops --help
```

## Быстрый старт

Deckops проведет вас через аутентификацию и настройку рабочего пространства, когда это потребуется команде.

```bash
deckops convert slides.pptx --to pdf
```

## Глобальные опции

| Опция | Описание |
|-------|----------|
| `--json` | Выводить результаты в формате JSON (удобно для скриптов) |
| `--version` | Показать номер версии |
| `--help` | Показать справку |

Примеры:

```bash
# Список задач в режиме JSON
deckops --json task list --limit 5

# Просмотр версии
deckops --version

# Справка по подкоманде
deckops convert --help
```

## Сжатие файлов

### `compress <input-file>`

Сжимать документы Office, видео или zip-файлы. Тип задачи выбирается автоматически по расширению.

Поддерживаемые форматы: `.zip`, `.pptx`, `.key`, `.docx`, `.xlsx`, `.mp4`, `.avi`, `.mov`, `.mkv`

| Опция | Описание |
|-------|----------|
| `-o, --out <path>` | Записать результат задачи в файл или каталог |
| `--no-wait` | Не ждать завершения после создания задачи |
| `--timeout <seconds>` | Таймаут ожидания (по умолчанию 300 секунд) |

```bash
# Сжать презентацию PPT
deckops compress presentation.pptx

# Сжать видео и сохранить результат
deckops compress demo.mp4 -o ./output/compressed.mp4

# Только создать задачу, не ждать
deckops compress large.pptx --no-wait
```

## Извлечение информации

### `extract <input-file>`

Извлекать шрифты, текстовые фигуры и другую информацию из файла.

| Опция | Описание |
|-------|----------|
| `--type <type>` | Тип извлечения: `fonts`, `text-shapes` |
| `-o, --out <path>` | Сохранить результат |
| `--no-wait` | Не ждать завершения |
| `--timeout <seconds>` | Таймаут в секундах |

```bash
# Автоматически извлечь информацию о шрифтах из pptx
deckops extract slides.pptx

# Явно извлечь текстовые фигуры
deckops extract slides.pptx --type text-shapes

# Извлечь и сохранить в каталог
deckops extract slides.pptx --type fonts -o ./extracted/
```

## OCR-распознавание текста

### `ocr <input-file>`

Выполнять OCR для изображений. Поддерживает `.jpg`, `.jpeg`, `.png`.

| Опция | Описание |
|-------|----------|
| `--language <lang>` | Язык (по умолчанию `zh-hans`) |
| `-o, --out <path>` | Сохранить результат |
| `--no-wait` | Не ждать завершения |
| `--timeout <seconds>` | Таймаут в секундах |

Поддерживаемые языки: `zh-hans`, `zh-hant`, `en`, `ja`, `ko`, `ar`, `de`, `es`, `fr`, `it`, `pt`, `ru`

```bash
# Распознать китайское изображение (язык по умолчанию)
deckops ocr scan.jpg

# Распознать английское изображение
deckops ocr document.png --language en

# Распознать на японском и сохранить
deckops ocr receipt.jpg --language ja -o ./ocr-result.json
```

## Конвертация формата

### `convert <input-files...> --to <format>`

Конвертировать файлы в указанный формат.

| Опция | Описание |
|-------|----------|
| `--to <format>` | Формат вывода (обязательно): `image`, `pdf`, `video`, `html`, `png`, `pptx`, `webp` |
| `--width <number>` | Ширина для HTML → PPT/PNG |
| `--height <number>` | Высота для HTML → PPT/PNG |
| `--need-embed-fonts [boolean]` | Встраивать шрифты для HTML → PPTX (по умолчанию false) |
| `-o, --out <path>` | Сохранить результат |
| `--no-wait` | Не ждать завершения |
| `--timeout <seconds>` | Таймаут в секундах |

**Примечание о нескольких файлах**: Только `html → pptx` поддерживает несколько входных файлов, объединяемых по порядку в одну задачу конвертации.

```bash
# PPT в PDF
deckops convert slides.pptx --to pdf

# Объединить несколько HTML в PPTX
deckops convert page1.html page2.html page3.html --to pptx

# HTML в PNG с размерами и сохранением
deckops convert slide.html --to png --width 1920 --height 1080 -o ./slide.png
```

## Объединение PPT

### `join <input-files...>`

Объединить несколько файлов `.pptx` в заданном порядке в один (тип задачи `pptx.join`). Требуется минимум 2 файла.

| Опция | Описание |
|-------|----------|
| `--name <name>` | Имя задачи |
| `-o, --out <path>` | Сохранить результат |
| `--no-wait` | Не ждать завершения |
| `--timeout <seconds>` | Таймаут в секундах |

```bash
# Объединить три презентации
deckops join intro.pptx body.pptx appendix.pptx

# Указать имя задачи и сохранить
deckops join part1.pptx part2.pptx --name merged-deck -o ./merged.pptx

# Только создать задачу
deckops join a.pptx b.pptx --no-wait
```

## Генерация контента с ИИ

### `create [input-files...]`

Генерировать содержимое документа из текста или справочных файлов (тип задачи API `generation`).

| Опция | Описание |
|-------|----------|
| `--input-text <text>` | Входной текст |
| `--enable-search [boolean]` | Включить поиск |
| `--advanced-model [boolean]` | Использовать продвинутую модель |
| `--fast-mode [boolean]` | Быстрый режим |
| `--intent <intent>` | Намерение генерации |
| `--audience <audience>` | Целевая аудитория |
| `--page-count <number>` | Ожидаемое число страниц |
| `--author <name>` | Автор документа |
| `-o, --out <path>` | Сохранить результат |
| `--no-wait` | Не ждать завершения |
| `--timeout <seconds>` | Таймаут в секундах |

До 2 справочных файлов: `.html`, `.pdf`, `.docx`, `.pptx`, `.txt`, `.md`, `.mm`, `.xmind`, `.ipynb`

```bash
# Генерация только из текста
deckops create --input-text "Напиши план презентации продукта"

# Со справочным файлом и ограничением страниц
deckops create outline.md --input-text "Развернуть в полный текст выступления" --page-count 20

# Продвинутая модель + поиск и сохранение результата
deckops create brief.pdf --input-text "Сгенерировать подробный отчёт" --advanced-model --enable-search -o ./report/
```

## Перевод документов

### `translate <input-file>`

Переводить документы. Поддерживает `.docx`, `.pptx`, `.pdf`, `.xlsx`, `.key`.

| Опция | Описание |
|-------|----------|
| `--from <language>` | Исходный язык (обязательно) |
| `--to <language>` | Целевой язык (обязательно) |
| `--model <model>` | Модель (обязательно): `Standard` или `Pro` |
| `--use-glossary [boolean]` | Использовать глоссарий |
| `--image-translate [boolean]` | Переводить текст на изображениях |
| `-o, --out <path>` | Сохранить результат |
| `--no-wait` | Не ждать завершения |
| `--timeout <seconds>` | Таймаут в секундах |

```bash
# Китайский в английский (модель Standard)
deckops translate handbook.docx --from zh --to en --model Standard

# Английский в китайский, модель Pro
deckops translate slides.pptx --from en --to zh --model Pro

# Автоопределение исходного языка, глоссарий и сохранение
deckops translate manual.pdf --from auto --to ja --model Pro --use-glossary -o ./translated.pdf
```

## Универсальное выполнение задач

### `run <task-type> <input-files...>`

Выполнить с явным типом задачи. Подходит для продвинутого использования или задач, не обёрнутых CLI.

| Опция | Описание |
|-------|----------|
| `--param <key=value>` | Параметры задачи (можно повторять; значения поддерживают JSON) |
| `-o, --out <path>` | Сохранить результат |
| `--no-wait` | Не ждать завершения |
| `--timeout <seconds>` | Таймаут в секундах |

**Примечание о нескольких файлах**: Следующие типы задач поддерживают несколько входных файлов как упорядоченный набор источников: `pptx.join`, `convertor.html2pptx`, `html.buildPlayer`, `generation`.

```bash
# PPT в PDF (явный тип задачи)
deckops run convertor.ppt2pdf demo.ppt

# Объединить PPT
deckops run pptx.join part1.pptx part2.pptx

# HTML в PPTX с параметрами
deckops run convertor.html2pptx page1.html page2.html --param width=1920 --param needEmbedFonts=true
```

## Управление задачами

### `task list`

Список задач в workspace.

| Опция | Описание |
|-------|----------|
| `--type <type>` | Фильтр по типу задачи |
| `--limit <n>` | Максимальное число (по умолчанию 50) |
| `--offset <n>` | Смещение пагинации (по умолчанию 0) |

```bash
# Список 10 последних задач
deckops task list --limit 10

# Только задачи конвертации
deckops task list --type convertor.ppt2pdf --limit 20

# Пагинированный запрос в JSON
deckops --json task list --offset 50 --limit 50
```

### `task get <task-id>`

Получить детали одной задачи.

| Опция | Описание |
|-------|----------|
| `-o, --out <path>` | Скачать и сохранить результат завершённой задачи |

```bash
# Просмотр деталей задачи
deckops task get abc123-task-id

# Скачать результат в файл
deckops task get abc123-task-id -o ./result.pdf

# Режим JSON
deckops --json task get abc123-task-id
```

### `task delete <task-id>`

Удалить указанную задачу.

```bash
# Удалить задачу
deckops task delete abc123-task-id

# Режим JSON
deckops --json task delete abc123-task-id

# Подтвердить список после удаления
deckops task delete abc123-task-id && deckops task list --limit 5
```

## Интерактивное дополнение

В среде TTY, если отсутствуют обязательные аргументы или опции, CLI попытается интерактивно их запросить (не срабатывает при `--json`). Например, при отсутствии `--to` команда `convert` предложит выбрать формат вывода.

## Вывод и поведение `-o`

- По умолчанию: читаемый текст + индикатор прогресса
- `--json`: структурированный JSON для разбора скриптами
- `-o, --out`: автоматически скачать результат после завершения задачи
  - Один файл → записать по указанному пути
  - Несколько файлов → записать в каталог; если путь заканчивается на `.zip`, упаковать в zip
  - Нет файлового результата → записать JSON

При указании `-o` CLI ожидает завершения задачи, чтобы скачать результат, даже если также передан `--no-wait`.

## Частые вопросы

**В: Когда допустим ввод нескольких файлов?**

Только некоторые задачи поддерживают упорядоченные несколько источников: `convert` для `html → pptx`, `join`, `create` (до 2 справочных файлов), и `run` для `pptx.join` / `convertor.html2pptx` и т.д.

## Связанные ссылки

- [Deckflow](https://app.deckflow.com)
- Сообщить о проблеме: [GitHub Issues](https://github.com/deckflow/deckops/issues)

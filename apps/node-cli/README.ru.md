**Языки:** [English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [Français](README.fr.md) | [Español](README.es.md) | **Русский** | [日本語](README.ja.md)

# deckops CLI

Deckops — это инструмент командной строки для [Deckflow](https://app.deckflow.com). Он позволяет загружать файлы, создавать асинхронные задачи и управлять конфигурацией и статусом задач. Внутри он вызывает API Deckflow через `@deckops/sdk`.

## Требования

- Node.js >= 18
- Действующий аккаунт Deckflow и workspace (space)

## Установка

### Использование в monorepo

```bash
pnpm install
pnpm --filter deckops build
node apps/node-cli/dist/cli.js --help
```

### Глобальная установка (после публикации)

```bash
npm install -g deckops
deckops --help
```

## Быстрый старт

1. Войдите и сохраните token:

```bash
deckops login
```

2. Просмотрите текущую конфигурацию:

```bash
deckops config show
```

3. Выполните конвертацию файла:

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
# Просмотр конфигурации в режиме JSON
deckops --json config show

# Просмотр версии
deckops --version

# Справка по подкоманде
deckops convert --help
```

## Конфигурация

Файл конфигурации по умолчанию сохраняется в `~/.deckops/config.json`. Для тестирования или изолированных сред укажите каталог через переменную окружения:

```bash
export DECKOPS_CONFIG_DIR=/tmp/my-deckops-config
deckops config show
```

### `config set-token`

Вручную установить токен аутентификации (обычно выполняется автоматически через `login`).

```bash
# Установить token напрямую
deckops config set-token "your-auth-token"

# Режим JSON
deckops --json config set-token "your-auth-token"

# Использование с переменными окружения в CI
deckops config set-token "$DECKOPS_TOKEN"
```

### `config set-space`

Установить ID workspace / space. Некоторым командам нужен space для создания задач.

```bash
# Установить ID workspace
deckops config set-space "your-space-id"

# Проверить, что применилось
deckops config show

# Вывод JSON
deckops --json config show
```

### `config set-api-base`

Настроить базовый URL API (по умолчанию `https://app.deckflow.com/v1`).

```bash
# Указать пользовательскую конечную точку API
deckops config set-api-base "https://staging.example.com/v1"

# Восстановить значение по умолчанию (установить снова)
deckops config set-api-base "https://app.deckflow.com/v1"

# Использовать с login
deckops config set-api-base "https://app.deckflow.com/v1" && deckops login
```

### `config show`

Просмотреть текущую конфигурацию. В читаемом режиме token частично маскируется.

```bash
# Читаемый вывод
deckops config show

# Вывод JSON (полный token)
deckops --json config show

# Проверить, отсутствует ли space
deckops config show | grep spaceId
```

## Вход

### `login`

Войти через OAuth в браузере и записать token в локальную конфигурацию.

```bash
# Порт по умолчанию 3737
deckops login

# Указать локальный порт обратного вызова
deckops login --port 8080

# Режим JSON
deckops --json login
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

## Интерактивный REPL

### `repl`

Войти в интерактивную командную строку для выполнения подкоманд по одной без перезапуска процесса.

```bash
# Запустить REPL
deckops repl
```

В REPL можно вводить те же команды, что и в обычном CLI, например:

```
deckflow> config show
deckflow> convert slides.pptx --to pdf
deckflow> task list --limit 5
```

Введите `exit` или `quit` для выхода.

## Интерактивное дополнение

В среде TTY, если отсутствуют обязательные аргументы или опции, CLI попытается интерактивно их запросить (не срабатывает при `--json`). Например, при отсутствии `--to` команда `convert` предложит выбрать формат вывода.

## Вывод и поведение `-o`

- По умолчанию: читаемый текст + индикатор прогресса
- `--json`: структурированный JSON для разбора скриптами
- `-o, --out`: автоматически скачать результат после завершения задачи
  - Один файл → записать по указанному пути
  - Несколько файлов → записать в каталог; если путь заканчивается на `.zip`, упаковать в zip
  - Нет файлового результата → записать JSON

При указании `-o` задача будет ожидаться, даже если `--wait` не передан явно.

## Частые вопросы

**В: Space ID missing?**

Сначала выполните `deckops login` или установите вручную через `deckops config set-space <space-id>`.

**В: Как использовать в CI?**

```bash
export DECKOPS_CONFIG_DIR=/tmp/deckops-ci
deckops config set-token "$DECKOPS_TOKEN"
deckops config set-space "$DECKOPS_SPACE_ID"
deckops --json convert input.pptx --to pdf -o output.pdf
```

**В: Когда допустим ввод нескольких файлов?**

Только некоторые задачи поддерживают упорядоченные несколько источников: `convert` для `html → pptx`, `join`, `create` (до 2 справочных файлов), и `run` для `pptx.join` / `convertor.html2pptx` и т.д.

## Связанные ссылки

- Корень monorepo: [README.md](../../README.ru.md)
- Документация SDK: [@deckops/sdk](../../sdks/nodejs/README.ru.md)
- Сообщить о проблеме: [GitHub Issues](https://github.com/deckflow/deckops/issues)

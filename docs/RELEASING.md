# Release process

## Формат версии

Новые релизы используют Semantic Versioning и тег с префиксом `v`:

```text
v0.1.6
v0.2.0
v1.0.0
```

Существующие исторические теги `0.1.3`, `0.1.4` и `0.1.5` не переименовываются.

## Перед релизом

1. Убедиться, что `main` содержит нужные изменения.
2. Проверить запуск через `start-server.bat`.
3. Проверить macOS-запуск через `start-server-macos.command` или команду `bash start-server-macos.command`.
4. Провести smoke-test затронутых игровых режимов.
5. Перенести изменения из секции `[Unreleased]` в новую версию в `CHANGELOG.md`.
6. Проверить, что в архив не попадают:
   - локальные leaderboard-файлы;
   - логи;
   - `__pycache__`;
   - browser/test profiles;
   - временные файлы.

## Release commit

Рекомендуемый коммит:

```text
chore(release): prepare v0.1.6
```

## Git tag

```bash
git tag -a v0.1.6 -m "TenderBomb v0.1.6"
git push origin v0.1.6
```

## Название GitHub Release

```text
TenderBomb v0.1.6
```

## Названия архивов

Использовать единый формат для новых релизов:

```text
TenderBomb-v0.1.6.zip
TenderBomb-v0.1.6-macOS.zip
```

RAR-дубликат не нужен, если ZIP содержит тот же набор файлов.

## Сборка macOS-архива

На macOS или Linux выполнить из корня репозитория:

```bash
bash scripts/build-macos.sh v0.1.6
```

Скрипт создаст:

```text
dist/TenderBomb-v0.1.6-macOS.zip
```

Внутри архива `start-server-macos.command` уже помечается исполняемым. Если пользователь запускает файл из исходников, можно один раз выполнить:

```bash
chmod +x start-server-macos.command
```

## Release notes

Структура описания релиза:

```markdown
## Что нового
- ...

## Улучшения
- ...

## Исправления
- ...

## Запуск
Windows: скачать TenderBomb-v0.1.6.zip, распаковать и запустить start-server.bat.
macOS: скачать TenderBomb-v0.1.6-macOS.zip, распаковать и запустить start-server-macos.command.
```

Release notes должны описывать пользовательский результат, а не список изменённых файлов.

## После публикации

- Проверить скачивание архивов.
- Проверить соответствие тега и версии.
- Убедиться, что GitHub Release не отмечен как draft или prerelease, если это стабильная версия.
- Оставить секцию `[Unreleased]` в `CHANGELOG.md` пустой для следующей разработки.

<div align="center">

<img src="assets/tenderbomb-logo.png" alt="TenderBomb" width="460">

# 💣 TenderBomb

**Браузерная аркада про тендеры, закрывашки и немного офисного хаоса.**

![Status](https://img.shields.io/badge/status-active_development-2ea44f?style=flat-square)
![Python](https://img.shields.io/badge/Python-3.x-3776AB?style=flat-square&logo=python&logoColor=white)
![JavaScript](https://img.shields.io/badge/JavaScript-ES6+-F7DF1E?style=flat-square&logo=javascript&logoColor=black)
![Platform](https://img.shields.io/badge/server-Windows-0078D4?style=flat-square&logo=windows&logoColor=white)

</div>

## О проекте

**TenderBomb** — локальная браузерная мини-игра с несколькими режимами, общей системой профилей, рекордов и кредитов.  
Клиент работает в браузере, а встроенный Python-сервер хранит состояние, лидерборды и игровые данные.

> [!NOTE]
> Проект находится в активной разработке. Текущая стабильная линия релизов: **0.1.x**.

## Игровые режимы

- 💣 **TenderBomb / Сапёр** — три уровня сложности: «Экспресс», «Госзаказ» и «Импортозамещение».
- ♟️ **Шашки** — одиночная игра с ботом и PvP.
- 🪖 **Танчики** — аркадный режим с очками и наградами.
- 🎰 **Casino** — слоты, ставки, джекпот, история крупных выигрышей и внутренняя кредитная система.
- 🏆 **Лидерборды** — результаты и профили игроков сохраняются на сервере.

## Быстрый запуск

### Windows

1. Установить **Python 3**.
2. Клонировать репозиторий.
3. Запустить:

```bat
start-server.bat
```

4. Открыть в браузере:

```text
http://localhost:8080/
```

Скрипт также выводит доступные LAN-адреса — их можно открыть с других компьютеров в локальной сети.

### Запуск вручную

```bash
python server.py 8080
```

Для запуска сервера в режиме системного трея используется:

```bat
start-server-tray.bat
```

## Технологии

| Часть | Технологии |
|---|---|
| Интерфейс | HTML5, CSS3, JavaScript ES6+ |
| Игровая логика | Vanilla JavaScript |
| Сервер | Python 3, `http.server`, стандартная библиотека |
| Локальный запуск | BAT / PowerShell |
| Хранилище | JSON-файлы, генерируемые сервером |

## Структура проекта

```text
TenderBomb/
├── assets/                 # логотипы, иконки и графика
├── index.html              # основная страница приложения
├── styles.css              # интерфейс и темы
├── game.js                 # TenderBomb / сапёр
├── checkers.js             # шашки
├── tanks.js                # танчики
├── casino.js               # казино и слоты
├── server.py               # HTTP-сервер, API, профили и лидерборды
├── start-server.bat        # обычный запуск
├── start-server-tray.bat   # запуск через tray-обёртку
├── server-tray.ps1         # PowerShell tray launcher
└── README.md
```

Во время работы сервер может создавать локальные файлы состояния, например `leaderboard-records.json`, `leaderboard-cache.js` и `.server-notice.json`. Они исключены из Git через `.gitignore`.

## Разработка

В проекте используется простой Git-flow вокруг ветки `main`.

Рекомендуемые имена веток:

```text
feat/<name>
fix/<name>
docs/<name>
refactor/<name>
chore/<name>
```

Коммиты оформляются по **Conventional Commits**:

```text
feat(casino): add jackpot history
fix(checkers): correct king capture logic
docs: update local launch instructions
chore(release): prepare v0.1.6
```

Подробные правила: [CONTRIBUTING.md](CONTRIBUTING.md).

## Версионирование и релизы

Новые версии выпускаются по **Semantic Versioning**:

```text
MAJOR.MINOR.PATCH
```

Для новых релизов используется формат тега:

```text
v0.1.6
```

Старые теги `0.1.3`–`0.1.5` сохраняются без переписывания истории.

Изменения между версиями фиксируются в [CHANGELOG.md](CHANGELOG.md), а порядок выпуска новой версии — в [docs/RELEASING.md](docs/RELEASING.md).

## Releases

Готовые сборки публикуются в разделе [GitHub Releases](https://github.com/schiz027/TenderBomb/releases).

Последний опубликованный релиз: **0.1.5**.

---

<div align="center">

Made for the tender battlefield 💣

</div>

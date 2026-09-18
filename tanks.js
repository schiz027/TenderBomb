(() => {
  const NAME_KEY = "tenderBombPlayerName";
  const LEADERBOARD_CACHE_KEY = "tenderBombTanksLeaderboard";
  const TILE = 32;
  const GRID = 16;
  const SIZE = GRID * TILE;
  const TANK = 24;
  const PLAYER_SPEED = 2.05;
  const BULLET_SPEED = 5.8;
  const BULLET_LIFE = Math.ceil((SIZE + TILE) / BULLET_SPEED);
  const BASE_COL = Math.floor((GRID - 1) / 2);
  const BASE_ROW = GRID - 1;
  const PLAYER_START_COL = Math.max(1, BASE_COL - 3);
  const PLAYER_START_ROW = GRID - 2;
  const POLL_MS = 5000;
  const NAME_REQUIRED_MESSAGE = "Введите никнейм и сохраните!";
  const NAME_TAKEN_MESSAGE = "Этот ник уже занят другим игроком.";
  const SERVER_OFFLINE_MESSAGE = "Сервер был отключен.";

  const DIRS = {
    up: { x: 0, y: -1 },
    down: { x: 0, y: 1 },
    left: { x: -1, y: 0 },
    right: { x: 1, y: 0 },
  };

  const KEY_DIR = {
    ArrowUp: "up",
    KeyW: "up",
    ArrowDown: "down",
    KeyS: "down",
    ArrowLeft: "left",
    KeyA: "left",
    ArrowRight: "right",
    KeyD: "right",
  };

  const tanksEls = {};
  const tanksState = {
    isOpen: false,
    serverActive: false,
    clientIp: "",
    pollId: null,
    rafId: null,
    lastTime: 0,
    leaderboard: [],
    nameError: "",
    serverNotice: "",
    godMode: false,
    status: "idle",
    level: 1,
    score: 0,
    lives: 3,
    enemiesLeft: 0,
    spawned: 0,
    destroyed: 0,
    doubleShot: false,
    plasmaShot: false,
    plasmaArmor: false,
    fastEnemiesUnlocked: false,
    iceUnlocked: false,
    totalEnemies: 0,
    runStartedAt: 0,
    pausedAt: 0,
    pausedTotalMs: 0,
    resumeStatus: "playing",
    elapsedSeconds: 0,
    submitted: false,
    waveDelay: 0,
    spawnCooldown: 0,
    map: [],
    player: null,
    enemies: [],
    bullets: [],
    powerups: [],
    effects: [],
    log: [],
    keys: {},
    lastDirection: null,
  };

  document.addEventListener("DOMContentLoaded", () => {
    cacheTanksElements();
    if (!tanksEls.openBtn) return;
    syncTanksName();
    bindTanksControls();
    loadOfflineTanksLeaderboard();
    renderTanksStatic();
  });

  function cacheTanksElements() {
    tanksEls.openBtn = document.querySelector("#openTanksBtn");
    tanksEls.closeBtn = document.querySelector("#closeTanksBtn");
    tanksEls.tenderView = document.querySelector("#tenderBombView");
    tanksEls.checkersView = document.querySelector("#checkersView");
    tanksEls.view = document.querySelector("#tanksView");
    tanksEls.name = document.querySelector("#tanksName");
    tanksEls.saveNameBtn = document.querySelector("#saveTanksNameBtn");
    tanksEls.startBtn = document.querySelector("#startTanksBtn");
    tanksEls.statusText = document.querySelector("#tanksStatusText");
    tanksEls.badge = document.querySelector("#tanksBadge");
    tanksEls.level = document.querySelector("#tanksLevel");
    tanksEls.score = document.querySelector("#tanksScore");
    tanksEls.lives = document.querySelector("#tanksLives");
    tanksEls.enemies = document.querySelector("#tanksEnemies");
    tanksEls.waveText = document.querySelector("#tanksWaveText");
    tanksEls.timer = document.querySelector("#tanksTimer");
    tanksEls.progressFill = document.querySelector("#tanksProgressFill");
    tanksEls.boardShell = document.querySelector(".tanks-board-shell");
    tanksEls.canvas = document.querySelector("#tanksCanvas");
    if (tanksEls.canvas) {
      tanksEls.canvas.width = SIZE;
      tanksEls.canvas.height = SIZE;
    }
    tanksEls.leaderboard = document.querySelector("#tanksLeaderboard");
    tanksEls.leaderboardCount = document.querySelector("#tanksLeaderboardCount");
    tanksEls.leaderboardBadge = document.querySelector("#tanksLeaderboardBadge");
    tanksEls.logTitle = document.querySelector("#tanksLogTitle");
    tanksEls.log = document.querySelector("#tanksLog");
  }

  function bindTanksControls() {
    tanksEls.openBtn.addEventListener("click", openTanks);
    tanksEls.closeBtn.addEventListener("click", closeTanks);
    tanksEls.startBtn.addEventListener("click", startTanksRun);
    tanksEls.saveNameBtn.addEventListener("click", saveTanksName);
    tanksEls.name.addEventListener("input", () => {
      const name = cleanTanksName(tanksEls.name.value);
      const mainName = document.querySelector("#playerName");
      if (mainName) mainName.value = name;
      if (isTanksNameSaved()) tanksState.nameError = "";
      renderTanksStatus();
    });
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", resetTanksKeys);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) resetTanksKeys();
    });
    window.addEventListener("resize", () => {
      if (!tanksState.isOpen) return;
      updateTanksCanvasSize();
      drawTanks();
    });
    window.addEventListener("tenderBombNameSaved", (event) => {
      const name = cleanTanksName(event.detail?.name);
      if (!name) return;
      tanksEls.name.value = name;
      tanksState.nameError = "";
      renderTanksStatus();
    });
    window.addEventListener("tenderBombOpenCheckers", () => {
      if (tanksState.isOpen) closeTanks({ showTender: false, submit: false });
    });
    window.addEventListener("tenderBombOpenCasino", () => {
      if (tanksState.isOpen) closeTanks({ showTender: false, submit: false });
    });
  }

  async function openTanks() {
    window.dispatchEvent(new CustomEvent("tenderBombOpenTanks"));
    tanksState.isOpen = true;
    tanksEls.tenderView.hidden = true;
    if (tanksEls.checkersView) tanksEls.checkersView.hidden = true;
    tanksEls.view.hidden = false;
    syncTanksName();
    renderTanksStatic();
    await initializeTanksServer();
    startTanksPolling();
    renderTanksStatic();
    updateTanksCanvasSize();
    drawTanks();
  }

  function closeTanks(options = {}) {
    const showTender = options.showTender !== false;
    if (isTanksRunActive()) {
      finishTanksRun("closed", { submit: options.submit === true });
    }
    tanksState.keys = {};
    tanksState.lastDirection = null;
    stopTanksLoop();
    stopTanksPolling();
    tanksState.isOpen = false;
    tanksEls.view.hidden = true;
    if (showTender) tanksEls.tenderView.hidden = false;
    renderTanksStatic();
  }

  async function initializeTanksServer() {
    if (window.location.protocol === "file:") {
      tanksState.serverActive = false;
      return;
    }
    try {
      const profile = await tanksApiGet("/api/profile");
      applyTanksServerNotice(profile);
      tanksState.clientIp = profile.ip || "";
      if (profile.player) {
        window.localStorage.setItem(NAME_KEY, profile.player);
        tanksEls.name.value = profile.player;
      }
      await refreshTanksLeaderboard();
      tanksState.serverActive = true;
    } catch (error) {
      tanksState.serverActive = false;
    }
  }

  function startTanksPolling() {
    stopTanksPolling();
    if (!tanksState.isOpen || window.location.protocol === "file:") return;
    tanksState.pollId = window.setInterval(refreshTanksLeaderboard, POLL_MS);
  }

  function stopTanksPolling() {
    if (tanksState.pollId) {
      window.clearInterval(tanksState.pollId);
      tanksState.pollId = null;
    }
  }

  async function refreshTanksLeaderboard() {
    try {
      const data = await tanksApiGet("/api/tanks/state");
      applyTanksServerState(data);
      tanksState.serverActive = true;
      renderTanksLeaderboard();
      renderTanksStatus();
    } catch (error) {
      const wasActive = tanksState.serverActive;
      tanksState.serverActive = false;
      if (wasActive) notifyTanksServerOffline();
      renderTanksStatus();
    }
  }

  function startTanksRun() {
    if (!requireSavedTanksName()) return;
    stopTanksLoop();
    tanksState.keys = {};
    tanksState.lastDirection = null;
    tanksState.status = "playing";
    tanksState.level = 1;
    tanksState.score = 0;
    tanksState.lives = 3;
    tanksState.destroyed = 0;
    tanksState.doubleShot = false;
    tanksState.plasmaShot = false;
    tanksState.plasmaArmor = false;
    tanksState.fastEnemiesUnlocked = false;
    tanksState.iceUnlocked = false;
    tanksState.runStartedAt = Date.now();
    tanksState.pausedAt = 0;
    tanksState.pausedTotalMs = 0;
    tanksState.resumeStatus = "playing";
    tanksState.elapsedSeconds = 0;
    tanksState.submitted = false;
    tanksState.effects = [];
    tanksState.bullets = [];
    tanksState.powerups = [];
    tanksState.log = [];
    addTanksLog("Старт", "База вышла на оборону.", "info");
    startTanksLevel();
    startTanksLoop();
  }

  function startTanksLevel() {
    tanksState.status = "playing";
    tanksState.map = createLevelMap(tanksState.level);
    tanksState.player = createPlayer();
    tanksState.enemies = [];
    tanksState.bullets = [];
    tanksState.powerups = [];
    tanksState.effects = [];
    tanksState.iceUnlocked = tanksState.level >= 4;
    tanksState.spawned = 0;
    tanksState.totalEnemies = Math.min(40, 6 + tanksState.level * 2);
    tanksState.enemiesLeft = tanksState.totalEnemies;
    tanksState.spawnCooldown = 0;
    tanksState.waveDelay = 0;
    placeLevelPowerups();
    addTanksLog(`Уровень ${tanksState.level}`, `Вражеская волна: ${tanksState.totalEnemies}.`, "info");
    renderTanksStatic();
    updateTanksCanvasSize();
    drawTanks();
  }

  function startTanksLoop() {
    stopTanksLoop();
    tanksState.lastTime = performance.now();
    tanksState.rafId = window.requestAnimationFrame(tanksFrame);
  }

  function stopTanksLoop() {
    if (tanksState.rafId) {
      window.cancelAnimationFrame(tanksState.rafId);
      tanksState.rafId = null;
    }
  }

  function isTanksRunLive(status = tanksState.status) {
    return status === "playing" || status === "wave-clear";
  }

  function isTanksRunActive(status = tanksState.status) {
    return isTanksRunLive(status) || status === "paused";
  }

  function toggleTanksPause() {
    if (tanksState.status === "paused") {
      resumeTanksRun();
      return;
    }
    if (!isTanksRunLive()) return;
    tanksState.resumeStatus = tanksState.status;
    tanksState.status = "paused";
    tanksState.pausedAt = Date.now();
    resetTanksKeys();
    stopTanksLoop();
    addTanksLog("Пауза", "Нажми ESC, чтобы продолжить.", "info");
    renderTanksStatic();
    drawTanks();
  }

  function resumeTanksRun() {
    if (tanksState.status !== "paused") return;
    if (tanksState.pausedAt) {
      tanksState.pausedTotalMs += Date.now() - tanksState.pausedAt;
    }
    tanksState.pausedAt = 0;
    tanksState.status = tanksState.resumeStatus || "playing";
    addTanksLog("Продолжаем", "Раунд снят с паузы.", "info");
    renderTanksStatic();
    startTanksLoop();
  }

  function currentTanksRunSeconds() {
    const current = Date.now();
    const activePauseMs = tanksState.status === "paused" && tanksState.pausedAt ? current - tanksState.pausedAt : 0;
    const elapsedMs = current - tanksState.runStartedAt - tanksState.pausedTotalMs - activePauseMs;
    return Math.max(0, Math.floor(elapsedMs / 1000));
  }

  function tanksFrame(time) {
    const dt = Math.min(33, time - tanksState.lastTime || 16) / 16.6667;
    tanksState.lastTime = time;
    updateTanks(dt);
    drawTanks(dt);
    renderTanksStats();
    if (tanksState.isOpen && isTanksRunLive()) {
      tanksState.rafId = window.requestAnimationFrame(tanksFrame);
    }
  }

  function updateTanks(dt) {
    tanksState.elapsedSeconds = currentTanksRunSeconds();
    if (tanksState.status === "wave-clear") {
      tanksState.waveDelay -= dt;
      if (tanksState.waveDelay <= 0) {
        tanksState.level += 1;
        startTanksLevel();
      }
      return;
    }
    if (tanksState.status !== "playing") return;

    spawnEnemies(dt);
    updatePlayer(dt);
    if (tanksState.status !== "playing") return;
    updatePowerups(dt);
    if (tanksState.status !== "playing") return;
    updateEnemies(dt);
    if (tanksState.status !== "playing") return;
    updateBullets(dt);
    if (tanksState.status !== "playing") return;
    updateEffects(dt);
    checkWaveClear();
  }

  function createPlayer() {
    return {
      x: PLAYER_START_COL * TILE + 4,
      y: PLAYER_START_ROW * TILE + 2,
      w: TANK,
      h: TANK,
      dir: "up",
      cooldown: 0,
      invuln: 90,
      sliding: false,
    };
  }

  function createEnemy(spawn) {
    const levelBoost = Math.min(1.1, tanksState.level * 0.035);
    let type = "normal";
    let hp = 1;
    if (tanksState.level >= 5 && tanksState.fastEnemiesUnlocked && Math.random() < 0.4) {
      type = "fast";
    } else if (tanksState.level % 4 === 0 && Math.random() < 0.35) {
      type = "heavy";
      hp = 2;
    }
    return {
      x: spawn.x,
      y: spawn.y,
      w: TANK,
      h: TANK,
      dir: "down",
      speed: type === "fast" ? 1.9 + levelBoost : 1.08 + levelBoost,
      cooldown: 40 + Math.random() * 45,
      turnTimer: 18 + Math.random() * 70,
      type,
      hp,
      wobble: Math.random() * 100,
      sliding: false,
    };
  }

  function createLevelMap(level) {
    const map = Array.from({ length: GRID }, () => Array.from({ length: GRID }, () => 0));
    const random = Math.random;
    const rand = seededRandom(level * 913 + 41);
    const middle = Math.floor(GRID / 2);

    for (let row = 2; row <= 5; row += 1) {
      [1, 3, 5].forEach((col) => {
        if (random() > 0.28) placeMirroredCell(map, row, col, 1);
      });
    }

    for (let row = 9; row <= 12; row += 1) {
      [1, 4, 6].forEach((col) => {
        if (random() > 0.34) placeMirroredCell(map, row, col, 1);
      });
    }

    [
      [4, 7],
      [6, 2],
      [7, 4],
      [8, 6],
      [10, 3],
      [11, 5],
    ].forEach(([row, col]) => placeMirroredCell(map, row, col, 2));

    if (level >= 5) {
      const steelCount = 2 + Math.floor(level / 3);
      for (let i = 0; i < steelCount; i += 1) {
        if (random() > 0.45) {
          const row = 3 + Math.floor(random() * (GRID - 8));
          const col = 2 + Math.floor(random() * (GRID - 4));
          if (map[row]?.[col] === 0 && !isProtectedTanksCell(row, col)) {
            placeMirroredCell(map, row, col, 2);
          }
        }
      }
    }

    if (level >= 4) {
      const icePatches = 2 + Math.floor(level / 4);
      for (let i = 0; i < icePatches; i += 1) {
        if (random() > 0.3) {
          const row = 4 + Math.floor(random() * (GRID - 9));
          const col = 3 + Math.floor(random() * (GRID - 6));
          if (map[row]?.[col] === 0 && !isProtectedTanksCell(row, col)) {
            placeMirroredCell(map, row, col, 5); // 5 is ice
          }
        }
      }
    }

    for (let col = 2; col < GRID - 2; col += 1) {
      if (col >= middle - 1 && col <= middle) continue;
      if (random() > 0.76) placeCell(map, middle - 1, col, 1);
      if (random() > 0.8) placeCell(map, middle + 1, col, 1);
    }

    clearSpawnAreas(map);
    placeTanksBase(map, level);
    placeLifeCrates(map, level, rand);
    return map;
  }

  function placeTanksBase(map, level = tanksState.level) {
    const baseRing = [
      [BASE_ROW - 1, BASE_COL - 1],
      [BASE_ROW - 1, BASE_COL],
      [BASE_ROW - 1, BASE_COL + 1],
      [BASE_ROW, BASE_COL - 1],
      [BASE_ROW, BASE_COL + 1],
    ];
    baseRing.forEach(([row, col]) => {
      map[row][col] = 1;
    });

    const steelGuard = [[BASE_ROW - 2, BASE_COL]];
    if (level >= 3) {
      steelGuard.push([BASE_ROW - 2, BASE_COL - 2], [BASE_ROW - 2, BASE_COL + 2]);
    }
    steelGuard.forEach(([row, col]) => {
      map[row][col] = 2;
    });
    map[BASE_ROW][BASE_COL] = 3;
  }

  function placeMirroredCell(map, row, col, value) {
    placeCell(map, row, col, value);
    placeCell(map, row, GRID - 1 - col, value);
  }

  function placeCell(map, row, col, value) {
    if (!map[row] || col < 0 || col >= GRID || isProtectedTanksCell(row, col)) return;
    map[row][col] = value;
  }

  function clearSpawnAreas(map) {
    enemySpawnPoints().forEach((spawn) => {
      const row = Math.floor(spawn.y / TILE);
      const col = Math.floor(spawn.x / TILE);
      clearTanksCells(map, row, row + 1, col - 1, col + 1);
    });
    clearTanksCells(map, PLAYER_START_ROW - 1, PLAYER_START_ROW, PLAYER_START_COL - 1, PLAYER_START_COL + 1);
    clearTanksCells(map, BASE_ROW - 2, BASE_ROW, BASE_COL - 2, BASE_COL + 2);
  }

  function clearTanksCells(map, top, bottom, left, right) {
    for (let row = Math.max(0, top); row <= Math.min(GRID - 1, bottom); row += 1) {
      for (let col = Math.max(0, left); col <= Math.min(GRID - 1, right); col += 1) {
        if (map[row]?.[col] !== 3) map[row][col] = 0;
      }
    }
  }

  function isProtectedTanksCell(row, col) {
    const nearTopSpawn = row <= 2 && (col <= 2 || col >= GRID - 3 || Math.abs(col - BASE_COL) <= 2);
    const nearBase = row >= BASE_ROW - 4 && Math.abs(col - BASE_COL) <= 3;
    const nearPlayer = row >= PLAYER_START_ROW - 1 && row <= PLAYER_START_ROW && col >= PLAYER_START_COL - 2 && col <= PLAYER_START_COL + 2;
    return nearTopSpawn || nearBase || nearPlayer;
  }

  function placeLifeCrates(map, level, rand) {
    const random = Math.random;
    if (level < 2) return;
    const target = level >= 3 ? 3 : 2 + (random() > 0.45 ? 1 : 0);
    let placed = 0;
    let attempts = 0;
    while (placed < target && attempts < 300) {
      attempts += 1;
      const row = 3 + Math.floor(random() * (GRID - 7));
      const col = 2 + Math.floor(random() * (GRID - 4));
      if (map[row]?.[col] !== 0 || isProtectedTanksCell(row, col)) continue;
      map[row][col] = 4;
      placed += 1;
    }
  }

  function placeLevelPowerups() {
    if (tanksState.level >= 5 && !tanksState.plasmaShot) {
      const row = 6;
      const col = Math.floor(GRID / 2);
      clearTanksCells(tanksState.map, row - 1, row + 1, col - 1, col + 1);
      tanksState.powerups.push({
        type: "plasma",
        x: col * TILE + 4,
        y: row * TILE + 4,
        w: 24,
        h: 24,
        age: 0,
      });
    }
    if (tanksState.level >= 3 && !tanksState.doubleShot) {
      const row = 10;
      const col = Math.floor(GRID / 2);
      clearTanksCells(tanksState.map, row - 1, row + 1, col - 1, col + 1);
      tanksState.powerups.push({
        type: "double",
        x: col * TILE + 4,
        y: row * TILE + 4,
        w: 24,
        h: 24,
        age: 0,
      });
    }
    if (tanksState.level >= 8) {
      const row = Math.floor(GRID / 2) - 1;
      const col = 4;
      clearTanksCells(tanksState.map, row - 1, row + 1, col - 1, col + 1);
      tanksState.powerups.push({
        type: "freeze",
        x: col * TILE + 4,
        y: row * TILE + 4,
        w: 24,
        h: 24,
        age: 0,
      });
      placeMirroredCell(tanksState.map, row, col, 0);
    }
  }

  function enemySpawnPoints() {
    return [
      { x: 4, y: 4 },
      { x: BASE_COL * TILE + 4, y: 4 },
      { x: (GRID - 1) * TILE + 4, y: 4 },
    ];
  }

  function seededRandom(seed) {
    let value = seed % 2147483647;
    return () => {
      value = (value * 16807) % 2147483647;
      return (value - 1) / 2147483646;
    };
  }

  function spawnEnemies(dt) {
    const maxActive = Math.min(5, 2 + Math.floor(tanksState.level / 2));
    if (tanksState.spawned >= tanksState.totalEnemies || tanksState.enemies.length >= maxActive) return;
    tanksState.spawnCooldown -= dt;
    if (tanksState.spawnCooldown > 0) return;
 
    for (let i = 0; i < 10; i += 1) {
      const col = Math.floor(Math.random() * GRID);
      const spawn = { x: col * TILE + 4, y: 4 };
      const probe = { x: spawn.x, y: spawn.y, w: TANK, h: TANK };
      if (!rectHitsSolid(probe) && !rectHitsTanks(probe, null)) {
        tanksState.enemies.push(createEnemy(spawn));
        tanksState.spawned += 1;
        tanksState.spawnCooldown = Math.max(18, 66 - tanksState.level * 2);
        return;
      }
    }
  }

  function updatePlayer(dt) {
    const player = tanksState.player;
    if (!player) return;
    player.cooldown = Math.max(0, player.cooldown - dt);
    player.invuln = Math.max(0, player.invuln - dt);

    const onIce = isOnIce(player);
    if (onIce) {
      player.sliding = true;
    } else if (player.sliding) {
      player.sliding = false;
    }

    const inputDir = activePlayerDirection();
    if (inputDir && !player.sliding) player.dir = inputDir;
    if (inputDir || player.sliding) {
      moveTank(player, player.dir, PLAYER_SPEED * dt, "player");
    }
    if (isFireActive()) fireBullet(player, "player");
  }

  function activePlayerDirection() {
    const order = ["up", "down", "left", "right"];
    if (tanksState.lastDirection && !order.includes(tanksState.lastDirection)) {
      tanksState.lastDirection = null;
    }
    return order.find((dir) => tanksState.keys[dir] && dir === tanksState.lastDirection) || order.find((dir) => tanksState.keys[dir]) || null;
  }

  function isFireActive() {
    return tanksState.keys.fire;
  }

  function updatePowerups(dt) {
    tanksState.powerups.forEach((powerup) => {
      powerup.age += dt;
    });
    if (!tanksState.player) return;
    for (let i = tanksState.powerups.length - 1; i >= 0; i -= 1) {
      const powerup = tanksState.powerups[i];
      if (!rectsOverlap(tankRect(tanksState.player), powerup)) continue;
      collectPowerup(powerup);
      tanksState.powerups.splice(i, 1);
    }
  }

  function collectPowerup(powerup) {
    if (powerup.type === "life") {
      tanksState.lives += 1;
      tanksState.score += 80 + tanksState.level * 12;
      addEffect(powerup.x + powerup.w / 2, powerup.y + powerup.h / 2, "heart");
      addTanksLog("Сердечко", `Жизни: ${tanksState.lives}.`, "good");
    } else if (powerup.type === "double") {
      tanksState.doubleShot = true;
      tanksState.score += 180;
      addEffect(powerup.x + powerup.w / 2, powerup.y + powerup.h / 2, "upgrade");
      addTanksLog("Апгрейд", "Двойной ствол активирован.", "good");
    } else if (powerup.type === "plasma") {
      tanksState.plasmaShot = true;
      tanksState.score += 350;
      addEffect(powerup.x + powerup.w / 2, powerup.y + powerup.h / 2, "plasma");
      addTanksLog("Плазма", "Снаряды пробивают сталь.", "good");
      tanksState.plasmaArmor = true;
      addTanksLog("Щит", "Плазменный щит поглотит одно попадание.", "good");
      if (tanksState.level >= 5 && !tanksState.fastEnemiesUnlocked) {
        tanksState.fastEnemiesUnlocked = true;
        addTanksLog("Внимание", "Противник вывел на поле быстрые танки!", "bad");
      }
    } else if (powerup.type === "freeze") {
      tanksState.score += 250;
      addEffect(powerup.x + powerup.w / 2, powerup.y + powerup.h / 2, "upgrade");
      addTanksLog("Заморозка", "Все враги на поле обездвижены.", "good");
      tanksState.enemies.forEach((enemy) => {
        enemy.frozen = 180;
        addEffect(enemy.x + enemy.w / 2, enemy.y + enemy.h / 2, "upgrade");
      });
    }
    renderTanksStatic();
  }

  function updateEnemies(dt) {
    tanksState.enemies.forEach((enemy) => {
      enemy.cooldown = Math.max(0, enemy.cooldown - dt);
      if (enemy.frozen > 0) {
        enemy.frozen -= dt;
        return;
      }

      enemy.turnTimer -= dt;
      const onIce = isOnIce(enemy);
      if (onIce) {
        enemy.sliding = true;
      } else if (enemy.sliding) {
        enemy.sliding = false;
      }

      if (enemy.turnTimer <= 0 && !enemy.sliding) {
        enemy.dir = chooseEnemyDirection(enemy);
        enemy.turnTimer = 28 + Math.random() * 80;
      }

      const moved = moveTank(enemy, enemy.dir, enemy.speed * dt, "enemy");
      if (!moved && !enemy.sliding) {
        enemy.dir = chooseEnemyDirection(enemy, true);
        enemy.turnTimer = 22 + Math.random() * 44;
      }

      if (enemy.cooldown <= 0 && Math.random() < 0.026 + tanksState.level * 0.002) {
        if (aimEnemy(enemy)) enemy.turnTimer = 16;
        fireBullet(enemy, "enemy");
      }
    });
  }

  function chooseEnemyDirection(enemy, forced = false) {
    const base = baseRect();
    const player = tanksState.player;
    const baseBias = tanksState.level === 1 ? 0.38 : 0.68;
    const target = Math.random() < baseBias || forced ? base : player || base;
    const horizontal = target.x + target.w / 2 < enemy.x + enemy.w / 2 ? "left" : "right";
    const vertical = target.y + target.h / 2 < enemy.y + enemy.h / 2 ? "up" : "down";
    const preferred = Math.random() < 0.58 ? vertical : horizontal;
    const options = [preferred, vertical, horizontal, "down", "left", "right", "up"];
    return options.find((dir) => canMoveTank(enemy, dir, enemy.speed * 4, "enemy")) || randomItem(["down", "left", "right", "up"]);
  }

  function aimEnemy(enemy) {
    const baseAimChance = tanksState.level === 1 ? 0.24 : 0.55;
    const target = Math.random() < baseAimChance ? baseRect() : tanksState.player;
    if (!target) return false;
    const dx = target.x + target.w / 2 - (enemy.x + enemy.w / 2);
    const dy = target.y + target.h / 2 - (enemy.y + enemy.h / 2);
    enemy.dir = Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? "left" : "right") : dy < 0 ? "up" : "down";
    return true;
  }

  function updateBullets(dt) {
    tanksState.bullets.forEach((bullet) => {
      bullet.x += bullet.dx * bullet.speed * dt;
      bullet.y += bullet.dy * bullet.speed * dt;
      bullet.life -= dt;
    });

    for (let i = tanksState.bullets.length - 1; i >= 0; i -= 1) {
      const bullet = tanksState.bullets[i];
      if (bullet.life <= 0 || bullet.x < -8 || bullet.y < -8 || bullet.x > SIZE + 8 || bullet.y > SIZE + 8) {
        tanksState.bullets.splice(i, 1);
        continue;
      }

      const tileHit = tileAtPoint(bullet.x, bullet.y);
      if (tileHit && tileHit.value) {
        handleBulletTileHit(bullet, tileHit);
        tanksState.bullets.splice(i, 1);
        continue;
      }

      if (bullet.owner === "player") {
        const enemyIndex = tanksState.enemies.findIndex((enemy) => rectsOverlap(bulletRect(bullet), tankRect(enemy)));
        if (enemyIndex >= 0) {
          hitEnemy(enemyIndex);
          tanksState.bullets.splice(i, 1);
          continue;
        }
      } else if (tanksState.player && tanksState.player.invuln <= 0 && rectsOverlap(bulletRect(bullet), tankRect(tanksState.player))) {
        hitPlayer();
        tanksState.bullets.splice(i, 1);
      }
    }
  }

  function updateEffects(dt) {
    tanksState.effects.forEach((effect) => {
      effect.life -= dt;
      effect.age += dt;
    });
    tanksState.effects = tanksState.effects.filter((effect) => effect.life > 0);
  }

  function checkWaveClear() {
    if (
      tanksState.status === "playing" &&
      tanksState.spawned >= tanksState.totalEnemies &&
      tanksState.enemies.length === 0 &&
      tanksState.enemiesLeft <= 0
    ) {
      tanksState.status = "wave-clear";
      tanksState.waveDelay = 95;
      const bonus = tanksState.level * 240 + tanksState.lives * 120;
      tanksState.score += bonus;
      addTanksLog("Волна отбита", `Бонус ${bonus}.`, "good");
      renderTanksStatic();
    }
  }

  function moveTank(tank, dir, distance, kind) {
    if (!dir || distance <= 0) return false;
    const vector = DIRS[dir];
    const next = { ...tank, x: tank.x + vector.x * distance, y: tank.y + vector.y * distance };
    next.x = Math.max(0, Math.min(SIZE - tank.w, next.x));
    next.y = Math.max(0, Math.min(SIZE - tank.h, next.y));
    if (rectHitsSolid(next) || rectHitsTanks(next, tank)) {
      return false;
    }
    if (kind === "enemy" && rectsOverlap(tankRect(next), baseRect())) {
      damageBase();
      return false;
    }
    tank.x = snapForTank(next.x);
    tank.y = snapForTank(next.y);
    return true;
  }

  function canMoveTank(tank, dir, distance, kind) {
    const vector = DIRS[dir];
    const next = { ...tank, x: tank.x + vector.x * distance, y: tank.y + vector.y * distance };
    return !rectHitsSolid(next) && !rectHitsTanks(next, tank) && !(kind === "enemy" && rectsOverlap(tankRect(next), baseRect()));
  }

  function snapForTank(value) {
    return Math.round(value * 10) / 10;
  }

  function rectHitsSolid(rect) {
    const cells = cellsForRect(rect);
    return cells.some(({ row, col }) => {
      const value = tanksState.map[row]?.[col] || 0;
      return value === 1 || value === 2 || value === 3 || value === 4; // Ice (5) is not solid
    });
  }

  function rectHitsTanks(rect, self) {
    const target = tankRect(rect);
    if (tanksState.player && self !== tanksState.player && rectsOverlap(target, tankRect(tanksState.player))) return true;
    return tanksState.enemies.some((enemy) => enemy !== self && rectsOverlap(target, tankRect(enemy)));
  }

  function cellsForRect(rect) {
    const left = Math.max(0, Math.floor(rect.x / TILE));
    const right = Math.min(GRID - 1, Math.floor((rect.x + rect.w - 1) / TILE));
    const top = Math.max(0, Math.floor(rect.y / TILE));
    const bottom = Math.min(GRID - 1, Math.floor((rect.y + rect.h - 1) / TILE));
    const cells = [];
    for (let row = top; row <= bottom; row += 1) {
      for (let col = left; col <= right; col += 1) {
        cells.push({ row, col });
      }
    }
    return cells;
  }

  function fireBullet(tank, owner) {
    if (!tank || tank.cooldown > 0) return;
    const vector = DIRS[tank.dir];
    const cx = tank.x + tank.w / 2;
    const cy = tank.y + tank.h / 2;
    const spread = owner === "player" && tanksState.doubleShot ? [-5, 5] : [0];
    const sideVector = tank.dir === "up" || tank.dir === "down" ? { x: 1, y: 0 } : { x: 0, y: 1 };
    spread.forEach((offset) => {
      tanksState.bullets.push({
        x: cx + vector.x * 15 + sideVector.x * offset,
        y: cy + vector.y * 15 + sideVector.y * offset,
        dx: vector.x,
        dy: vector.y,
        dir: tank.dir,
        speed: owner === "player" ? BULLET_SPEED : BULLET_SPEED * 0.84,
        owner,
        life: BULLET_LIFE,
      });
    });
    tank.cooldown = owner === "player" ? 19 : 58 - Math.min(22, tanksState.level * 2);
  }

  function handleBulletTileHit(bullet, tileHit) {
    const { row, col, value } = tileHit;
    const x = col * TILE + TILE / 2;
    const y = row * TILE + TILE / 2;
    if (value === 1) {
      tanksState.map[row][col] = 0;
      if (bullet.owner === "player") tanksState.score += tanksState.iceUnlocked ? 2 : 4;
      addEffect(x, y, "brick");
    } else if (value === 2) {
      if (bullet.owner === "player" && tanksState.plasmaShot) {
        tanksState.map[row][col] = 0;
        tanksState.score += 15;
      }
      addEffect(x, y, bullet.owner === "player" && tanksState.plasmaShot ? "brick" : "steel");
    } else if (value === 3) {
      damageBase();
    } else if (value === 4) {
      tanksState.map[row][col] = 0;
      if (bullet.owner === "player") tanksState.score += 20;
      spawnLifePowerup(row, col);
      addEffect(x, y, "crate");
    } else if (value === 5) {
      addEffect(x, y, "steel");
    }
  }

  function spawnLifePowerup(row, col) {
    const size = 22;
    tanksState.powerups.push({
      type: "life",
      x: col * TILE + (TILE - size) / 2,
      y: row * TILE + (TILE - size) / 2,
      w: size,
      h: size,
      age: 0,
    });
    addTanksLog("Ящик разбит", "Выпало сердечко.", "good");
  }

  function hitEnemy(index) {
    const enemy = tanksState.enemies[index];
    enemy.hp -= 1;
    addEffect(enemy.x + enemy.w / 2, enemy.y + enemy.h / 2, "hit");
    if (enemy.hp > 0) return;
    tanksState.enemies.splice(index, 1);
    tanksState.enemiesLeft = Math.max(0, tanksState.enemiesLeft - 1);
    tanksState.destroyed += 1;
    tanksState.score += enemy.type === "heavy" ? 230 + tanksState.level * 24 : 120 + tanksState.level * 18;
    addEffect(enemy.x + enemy.w / 2, enemy.y + enemy.h / 2, "blast");
  }

  function hitPlayer() {
    if (tanksState.godMode) {
      tanksState.player.invuln = 80;
      addEffect(tanksState.player.x + TANK / 2, tanksState.player.y + TANK / 2, "hit");
      addTanksLog("Режим бога", "Попадание не сняло жизнь.", "good");
      renderTanksStatic();
      return;
    }
    if (tanksState.plasmaArmor) {
      tanksState.plasmaArmor = false;
      tanksState.player.invuln = 80;
      addEffect(tanksState.player.x + TANK / 2, tanksState.player.y + TANK / 2, "plasma");
      addTanksLog("Щит пробит", "Плазменный щит разрушен.", "warn");
      renderTanksStatic();
      return;
    }
    tanksState.lives -= 1;
    addEffect(tanksState.player.x + TANK / 2, tanksState.player.y + TANK / 2, "blast");
    if (tanksState.lives <= 0) {
      finishTanksRun("lives");
      return;
    }
    tanksState.player = createPlayer();
    tanksState.player.invuln = 120;
    addTanksLog("Попадание", `Жизни: ${tanksState.lives}.`, "warn");
    renderTanksStatic();
  }

  function damageBase() {
    addEffect(BASE_COL * TILE + TILE / 2, BASE_ROW * TILE + TILE / 2, "blast");
    finishTanksRun("base");
  }

  function finishTanksRun(reason, options = {}) {
    if (tanksState.status === "gameover") return;
    const elapsedSeconds = Math.max(1, currentTanksRunSeconds());
    tanksState.status = "gameover";
    stopTanksLoop();
    tanksState.elapsedSeconds = elapsedSeconds;
    tanksState.pausedAt = 0;
    const reasonText = reason === "base" ? "База пробита." : reason === "lives" ? "Танк потерян." : "Раунд остановлен.";
    addTanksLog("Финиш", `${reasonText} Уровень ${tanksState.level}, очки: ${tanksState.score}.`, "bad");
    renderTanksStatic();
    drawTanks();
    if (options.submit === false) return;
    submitTanksResult(reason);
  }

  async function submitTanksResult(reason) {
    if (tanksState.submitted) return;
    tanksState.submitted = true;
    const payload = {
      player: getSavedTanksName(),
      level: tanksState.level,
      score: tanksState.score,
      seconds: tanksState.elapsedSeconds,
      mistakes: Math.max(0, 3 - tanksState.lives),
      combo: tanksState.destroyed,
      reason,
    };

    if (window.location.protocol === "file:") {
      saveLocalTanksResult(payload);
      addTanksLog("Рекорд локально", "Сервер не запущен, результат сохранен в браузере.", "warn");
      renderTanksStatic();
      return;
    }

    try {
      const data = await tanksApiPost("/api/tanks/result", payload);
      applyTanksServerState(data);
      tanksState.serverActive = true;
      announceTanksRecord(data.result);
      renderTanksStatic();
    } catch (error) {
      tanksState.serverActive = false;
      saveLocalTanksResult(payload);
      addTanksLog("Рекорд локально", tanksApiFallbackMessage(error), "warn");
      renderTanksStatic();
    }
  }

  function tanksApiFallbackMessage(error) {
    if (error?.status === 404) {
      return "Сервер запущен старой версией без танчиков, результат сохранен в браузере.";
    }
    return "Сервер не ответил, результат сохранен в браузере.";
  }

  function announceTanksRecord(result) {
    if (!result) return;
    if (result.reason === "first_record") {
      addTanksLog("Рекорд записан", `Уровень ${result.level}, ${result.score} очков.`, "good");
    } else if (result.reason === "improved") {
      addTanksLog("Рекорд обновлен", `Теперь уровень ${result.level}, ${result.score} очков.`, "good");
    } else if (result.reason === "not_improved") {
      addTanksLog("Рекорд устоял", `Лучший результат: уровень ${result.level}, ${result.score} очков.`, "info");
    } else if (result.reason === "invalid_player") {
      addTanksLog("Рекорд отклонен", NAME_REQUIRED_MESSAGE, "warn");
    } else if (result.reason === "name_taken") {
      addTanksLog("Рекорд отклонен", NAME_TAKEN_MESSAGE, "warn");
    }
    announceTanksCreditReward(result.credit_reward);
  }

  function announceTanksCreditReward(reward) {
    const amount = Number(reward?.amount) || 0;
    if (amount <= 0) return;
    const credits = Number(reward?.credits) || amount;
    addTanksLog("Кредиты начислены", `+${formatTanksCredits(amount)} за бой. Баланс: ${formatTanksCredits(credits)}.`, "good");
  }

  function formatTanksCredits(value) {
    return new Intl.NumberFormat("ru-RU").format(Math.max(0, Math.floor(Number(value) || 0)));
  }

  function drawTanks() {
    const canvas = tanksEls.canvas;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, SIZE, SIZE);
    ctx.fillStyle = tanksState.iceUnlocked ? "#343b54" : "#000";
    ctx.fillRect(0, 0, SIZE, SIZE);
    drawMap(ctx);
    tanksState.powerups.forEach((powerup) => drawPowerup(ctx, powerup));
    tanksState.bullets.forEach((bullet) => drawBullet(ctx, bullet));
    if (tanksState.player) drawTank(ctx, tanksState.player, "player");
    tanksState.enemies.forEach((enemy) => drawTank(ctx, enemy, enemy.type));
    tanksState.effects.forEach((effect) => drawEffect(ctx, effect));
    if (tanksState.status === "idle") drawOverlay(ctx, "ТАНЧИКИ");
    if (tanksState.status === "paused") drawOverlay(ctx, "ПАУЗА");
    if (tanksState.status === "gameover") drawOverlay(ctx, "ФИНИШ");
    if (tanksState.status === "wave-clear") drawOverlay(ctx, `УРОВЕНЬ ${tanksState.level + 1}`);
  }

  function updateTanksCanvasSize() {
    const shell = tanksEls.boardShell;
    const canvas = tanksEls.canvas;
    if (!shell || !canvas) return;
    const styles = window.getComputedStyle(shell);
    const paddingX = parseFloat(styles.paddingLeft) + parseFloat(styles.paddingRight);
    const paddingY = parseFloat(styles.paddingTop) + parseFloat(styles.paddingBottom);
    const availableWidth = shell.clientWidth - paddingX;
    const availableHeight = shell.clientHeight - paddingY;
    const size = Math.max(0, Math.floor(Math.min(SIZE, availableWidth, availableHeight)));
    if (!size) return;
    canvas.style.setProperty("--tanks-canvas-size", `${size}px`);
  }

  function drawMap(ctx) {
    for (let row = 0; row < GRID; row += 1) {
      for (let col = 0; col < GRID; col += 1) {
        const value = tanksState.map[row]?.[col] || 0;
        const x = col * TILE;
        const y = row * TILE;
        if (value === 1) drawBrick(ctx, x, y);
        if (value === 2) drawSteel(ctx, x, y);
        if (value === 3) drawBase(ctx, x, y);
        if (value === 4) drawCrate(ctx, x, y);
        if (value === 5) drawIce(ctx, x, y);
      }
    }
  }

  function drawBrick(ctx, x, y) {
    ctx.fillStyle = "#d33a18";
    ctx.fillRect(x, y, TILE, TILE);
    ctx.fillStyle = tanksState.iceUnlocked ? "#e0e8f7" : "#ff7b22";
    for (let yy = 2; yy < TILE; yy += 8) {
      ctx.fillRect(x + 1, y + yy, TILE - 2, 2);
    }
    ctx.fillStyle = tanksState.iceUnlocked ? "#6b7a9e" : "#641c15";
    for (let yy = 0; yy < TILE; yy += 8) {
      const offset = yy % 16 === 0 ? 0 : 8;
      for (let xx = offset; xx < TILE; xx += 16) {
        ctx.fillRect(x + xx, y + yy, 2, 8);
      }
    }
  }

  function drawSteel(ctx, x, y) {
    ctx.fillStyle = tanksState.iceUnlocked ? "#8c95b3" : "#aeb0ac";
    ctx.fillRect(x, y, TILE, TILE);
    ctx.fillStyle = tanksState.iceUnlocked ? "#f0f5ff" : "#f2f2ed";
    ctx.fillRect(x + 3, y + 3, 10, 10);
    ctx.fillRect(x + 19, y + 19, 10, 10);
    ctx.fillStyle = tanksState.iceUnlocked ? "#555c70" : "#666a6b";
    ctx.fillRect(x + 4, y + 20, 9, 8);
    ctx.fillRect(x + 20, y + 4, 8, 9);
  }

  function drawIce(ctx, x, y) {
    ctx.fillStyle = "#83a7d1";
    ctx.fillRect(x, y, TILE, TILE);
    ctx.fillStyle = "rgba(255, 255, 255, 0.4)";
    ctx.fillRect(x + 4, y + 4, 10, 3);
    ctx.fillRect(x + 18, y + 9, 10, 3);
    ctx.fillRect(x + 7, y + 22, 12, 4);
  }

  function drawCrate(ctx, x, y) {
    ctx.fillStyle = "#8c5528";
    ctx.fillRect(x + 3, y + 4, TILE - 6, TILE - 7);
    ctx.fillStyle = "#c3833e";
    ctx.fillRect(x + 6, y + 7, TILE - 12, 5);
    ctx.fillRect(x + 6, y + 20, TILE - 12, 5);
    ctx.fillStyle = "#56311d";
    ctx.fillRect(x + 3, y + 4, 4, TILE - 7);
    ctx.fillRect(x + TILE - 7, y + 4, 4, TILE - 7);
    ctx.fillRect(x + 7, y + 13, TILE - 14, 4);
    ctx.fillStyle = "#f2c46f";
    ctx.fillRect(x + 11, y + 9, 4, 4);
    ctx.fillRect(x + 17, y + 9, 4, 4);
    ctx.fillRect(x + 14, y + 13, 4, 4);
  }

  function drawBase(ctx, x, y) {
    ctx.fillStyle = "#5e5f5b";
    ctx.fillRect(x + 5, y + 12, 22, 17);
    ctx.fillStyle = "#2b2b2b";
    ctx.fillRect(x + 10, y + 18, 12, 11);
    ctx.fillStyle = "#bfc4bf";
    ctx.fillRect(x + 8, y + 7, 5, 9);
    ctx.fillRect(x + 19, y + 7, 5, 9);
    ctx.fillRect(x + 13, y + 4, 6, 9);
    ctx.fillStyle = "#ff6c16";
    ctx.beginPath();
    ctx.moveTo(x + 23, y + 3);
    ctx.lineTo(x + 31, y + 8);
    ctx.lineTo(x + 23, y + 10);
    ctx.closePath();
    ctx.fill();
  }

  function drawTank(ctx, tank, type) {
    const palette =
      type === "player"
        ? { body: "#e7f3ff", track: "#4d789c", dark: "#1d3148", light: "#ffffff" }
        : type === "heavy"
          ? { body: "#f0b949", track: "#8d4a18", dark: "#4b2410", light: "#ffe79b" }
          : type === "fast"
            ? { body: "#ff756b", track: "#b82e2e", dark: "#5c1a1a", light: "#ffc6c2" }
          : { body: "#b9c0be", track: "#686f71", dark: "#252b2c", light: "#f1f1ed" };
    const x = Math.round(tank.x);
    const y = Math.round(tank.y);
    const flashing = type === "player" && tank.invuln > 0 && Math.floor(tank.invuln / 8) % 2 === 0;
    if (flashing) return;

    if (tank.frozen > 0) {
      ctx.save();
      ctx.globalAlpha = 0.5 + Math.sin(performance.now() / 100) * 0.25;
      ctx.fillStyle = "#a6d6ff";
    }

    if (type === "player" && tanksState.plasmaArmor) {
      ctx.save();
      ctx.globalAlpha = 0.4 + Math.sin(performance.now() / 150) * 0.2;
      ctx.fillStyle = "#d86ce8";
      ctx.beginPath();
      ctx.arc(x + tank.w / 2, y + tank.h / 2, 18, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    ctx.save();
    ctx.translate(x + tank.w / 2, y + tank.h / 2);
    rotateToDir(ctx, tank.dir);
    ctx.translate(-tank.w / 2, -tank.h / 2);
    ctx.fillStyle = palette.track;
    ctx.fillRect(0, 2, 6, 20);
    ctx.fillRect(18, 2, 6, 20);
    ctx.fillStyle = palette.dark;
    for (let yy = 4; yy < 22; yy += 5) {
      ctx.fillRect(1, yy, 4, 2);
      ctx.fillRect(19, yy, 4, 2);
    }
    ctx.fillStyle = palette.body;
    ctx.fillRect(6, 5, 12, 15);
    ctx.fillStyle = palette.light;
    ctx.fillRect(9, 7, 6, 5);
    ctx.fillStyle = palette.dark;
    if (type === "player" && tanksState.doubleShot) {
      ctx.fillRect(7, -1, 3, 12);
      ctx.fillRect(14, -1, 3, 12);
    } else {
      ctx.fillRect(11, -1, 3, 12);
    }
    ctx.fillRect(9, 10, 7, 7);
    ctx.restore();

    if (tank.frozen > 0) {
      ctx.fillRect(x - 2, y - 2, tank.w + 4, tank.h + 4);
      ctx.restore();
    }
  }

  function rotateToDir(ctx, dir) {
    if (dir === "right") ctx.rotate(Math.PI / 2);
    if (dir === "down") ctx.rotate(Math.PI);
    if (dir === "left") ctx.rotate(-Math.PI / 2);
  }

  function drawBullet(ctx, bullet) {
    ctx.fillStyle = bullet.owner === "player" ? "#ffffff" : "#ff8a23";
    ctx.fillRect(Math.round(bullet.x - 2), Math.round(bullet.y - 2), 4, 4);
  }

  function drawPowerup(ctx, powerup) {
    const pulse = Math.floor(powerup.age / 12) % 2;
    if (powerup.type === "life") {
      drawPixelHeart(ctx, Math.round(powerup.x), Math.round(powerup.y + (pulse ? -1 : 0)), 3);
    } else if (powerup.type === "double") {
      drawDoubleBarrelUpgrade(ctx, Math.round(powerup.x), Math.round(powerup.y + (pulse ? -1 : 0)));
    } else if (powerup.type === "freeze") {
      drawFreezeUpgrade(ctx, Math.round(powerup.x), Math.round(powerup.y + (pulse ? -1 : 0)));
    } else if (powerup.type === "plasma") {
      drawPlasmaUpgrade(ctx, Math.round(powerup.x), Math.round(powerup.y + (pulse ? -1 : 0)));
    }
  }

  function drawDoubleBarrelUpgrade(ctx, x, y) {
    ctx.fillStyle = "#2469b8";
    ctx.fillRect(x + 2, y + 4, 20, 17);
    ctx.fillStyle = "#78b7ff";
    ctx.fillRect(x + 5, y + 7, 14, 4);
    ctx.fillStyle = "#122942";
    ctx.fillRect(x + 6, y + 1, 4, 14);
    ctx.fillRect(x + 14, y + 1, 4, 14);
    ctx.fillRect(x + 6, y + 15, 12, 4);
    ctx.fillStyle = "#f4f1ea";
    ctx.fillRect(x + 4, y + 22, 4, 3);
    ctx.fillRect(x + 10, y + 22, 4, 3);
    ctx.fillRect(x + 16, y + 22, 4, 3);
  }

  function drawPlasmaUpgrade(ctx, x, y) {
    ctx.fillStyle = "#481d5c";
    ctx.fillRect(x + 4, y + 2, 16, 20);
    ctx.fillStyle = "#d86ce8";
    ctx.fillRect(x + 7, y + 5, 10, 5);
    ctx.fillStyle = "#250d30";
    ctx.fillRect(x + 10, y, 4, 14);
    ctx.fillRect(x + 7, y + 15, 10, 4);
    ctx.fillStyle = "#f4f1ea";
    ctx.fillRect(x + 2, y + 23, 4, 3);
    ctx.fillRect(x + 10, y + 23, 4, 3);
    ctx.fillRect(x + 18, y + 23, 4, 3);
  }

  function drawFreezeUpgrade(ctx, x, y) {
    ctx.fillStyle = "#2469b8";
    ctx.fillRect(x + 4, y + 2, 16, 20);
    ctx.fillStyle = "#a6d6ff";
    ctx.fillRect(x + 7, y + 5, 10, 5);
    ctx.fillStyle = "#122942";
    ctx.fillRect(x + 10, y, 4, 14);
    ctx.fillRect(x + 7, y + 15, 10, 4);
    ctx.fillStyle = "#f4f1ea";
    ctx.fillRect(x + 2, y + 23, 4, 3);
    ctx.fillRect(x + 10, y + 23, 4, 3);
    ctx.fillRect(x + 18, y + 23, 4, 3);
  }

  function drawPixelHeart(ctx, x, y, scale) {
    const pixels = [
      [1, 0],
      [2, 0],
      [4, 0],
      [5, 0],
      [0, 1],
      [1, 1],
      [2, 1],
      [3, 1],
      [4, 1],
      [5, 1],
      [6, 1],
      [0, 2],
      [1, 2],
      [2, 2],
      [3, 2],
      [4, 2],
      [5, 2],
      [6, 2],
      [1, 3],
      [2, 3],
      [3, 3],
      [4, 3],
      [5, 3],
      [2, 4],
      [3, 4],
      [4, 4],
      [3, 5],
    ];
    ctx.fillStyle = "#ff6961";
    pixels.forEach(([px, py]) => {
      ctx.fillRect(x + px * scale, y + py * scale, scale, scale);
    });
    ctx.fillStyle = "#b92f35";
    ctx.fillRect(x + 0 * scale, y + 2 * scale, scale, scale);
    ctx.fillRect(x + 6 * scale, y + 2 * scale, scale, scale);
    ctx.fillRect(x + 3 * scale, y + 5 * scale, scale, scale);
    ctx.fillStyle = "#ffe3df";
    ctx.fillRect(x + 1 * scale, y + 1 * scale, scale, scale);
  }

  function drawEffect(ctx, effect) {
    const t = Math.max(0, 1 - effect.life / effect.maxLife);
    const radius = 5 + t * 17;
    ctx.fillStyle =
      effect.kind === "steel"
        ? "#c9ced1"
        : effect.kind === "brick" || effect.kind === "crate"
          ? "#ff8a23"
          : effect.kind === "heart"
            ? "#ff6961"
            : effect.kind === "upgrade"
              ? "#78b7ff"
              : effect.kind === "plasma"
                ? "#d86ce8"
              : "#f2f2ed";
    ctx.globalAlpha = Math.max(0, 1 - t);
    ctx.fillRect(Math.round(effect.x - radius / 2), Math.round(effect.y - radius / 2), Math.round(radius), Math.round(radius));
    ctx.globalAlpha = 1;
  }

  function drawOverlay(ctx, text) {
    ctx.fillStyle = "rgba(0, 0, 0, 0.48)";
    ctx.fillRect(0, 0, SIZE, SIZE);
    ctx.fillStyle = "#f4f1ea";
    ctx.font = "bold 28px monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, SIZE / 2, SIZE / 2);
  }

  function addEffect(x, y, kind) {
    tanksState.effects.push({ x, y, kind, life: 24, maxLife: 24, age: 0 });
  }

  function tileAtPoint(x, y) {
    const row = Math.floor(y / TILE);
    const col = Math.floor(x / TILE);
    if (row < 0 || col < 0 || row >= GRID || col >= GRID) return null;
    return { row, col, value: tanksState.map[row]?.[col] || 0 };
  }

  function tankRect(tank) {
    return { x: tank.x, y: tank.y, w: tank.w, h: tank.h };
  }

  function bulletRect(bullet) {
    return { x: bullet.x - 3, y: bullet.y - 3, w: 6, h: 6 };
  }

  function baseRect() {
    return { x: BASE_COL * TILE + 4, y: BASE_ROW * TILE + 4, w: 24, h: 24 };
  }

  function isOnIce(tank) {
    const tile = tileAtPoint(tank.x + tank.w / 2, tank.y + tank.h / 2);
    return tile?.value === 5;
  }

  function rectsOverlap(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }

  function randomItem(items) {
    return items[Math.floor(Math.random() * items.length)];
  }

  function handleKeyDown(event) {
    if (!tanksState.isOpen) return;
    if (isEditableTarget(event.target)) return;
    if (event.code === "Escape") {
      event.preventDefault();
      toggleTanksPause();
      return;
    }
    if (tanksState.status === "paused") {
      event.preventDefault();
      return;
    }
    const dir = KEY_DIR[event.code];
    if (dir) {
      event.preventDefault();
      tanksState.keys[dir] = true;
      tanksState.lastDirection = dir;
      return;
    }
    if (event.code === "Space") {
      event.preventDefault();
      tanksState.keys.fire = true;
      return;
    }
    if (event.code === "Enter" && !isTanksRunActive()) {
      event.preventDefault();
      startTanksRun();
    }
  }

  function handleKeyUp(event) {
    const dir = KEY_DIR[event.code];
    if (dir) {
      tanksState.keys[dir] = false;
      if (tanksState.lastDirection === dir) tanksState.lastDirection = null;
    }
    if (event.code === "Space") tanksState.keys.fire = false;
  }

  function resetTanksKeys() {
    tanksState.keys = {};
  }

  function isEditableTarget(target) {
    const tagName = target?.tagName?.toLowerCase();
    return tagName === "input" || tagName === "textarea" || target?.isContentEditable;
  }

  async function saveTanksName() {
    const name = cleanTanksName(tanksEls.name.value);
    if (!name) {
      showTanksNameError();
      return false;
    }

    tanksState.nameError = "";
    tanksEls.name.value = name;
    window.localStorage.setItem(NAME_KEY, name);
    const mainName = document.querySelector("#playerName");
    if (mainName) mainName.value = name;
    window.dispatchEvent(new CustomEvent("tenderBombNameSaved", { detail: { name } }));

    if (window.location.protocol !== "file:") {
      try {
        const data = await tanksApiPost("/api/profile", { player: name });
        applyTanksServerNotice(data);
        tanksState.serverActive = data.ok !== false;
        tanksState.clientIp = data.ip || tanksState.clientIp;
        if (data.ok === false) {
          showTanksProfileError(data);
          return false;
        }
        if (data.player) {
          tanksEls.name.value = data.player;
          window.localStorage.setItem(NAME_KEY, data.player);
        }
      } catch (error) {
        tanksState.serverActive = false;
      }
    }

    addTanksLog("Ник сохранен", `Результат пойдет как ${getSavedTanksName()}.`, "info");
    renderTanksStatic();
    return true;
  }

  function showTanksProfileError(data) {
    const message = data?.error === "name_taken" ? NAME_TAKEN_MESSAGE : NAME_REQUIRED_MESSAGE;
    tanksState.nameError = message;
    if (data?.player) {
      tanksEls.name.value = data.player;
      window.localStorage.setItem(NAME_KEY, data.player);
    } else {
      window.localStorage.removeItem(NAME_KEY);
    }
    const mainName = document.querySelector("#playerName");
    if (mainName) mainName.value = data?.player || tanksEls.name.value;
    addTanksLog(data?.error === "name_taken" ? "Ник занят" : "Ник не сохранен", message, "warn");
    renderTanksStatic();
    tanksEls.name.focus({ preventScroll: true });
  }

  function applyTanksServerState(data) {
    applyTanksServerNotice(data);
    const wasGod = tanksState.godMode;
    tanksState.godMode = Boolean(data?.god);
    if (tanksState.godMode && !wasGod) {
      addTanksLog("Режим бога", "Бессмертие включено сервером.", "good");
    }
    tanksState.leaderboard = normalizeTanksRows(data?.leaderboard);
    cacheTanksLeaderboard();
  }

  function applyTanksServerNotice(data) {
    const notice = String(data?.server_notice || "").trim();
    if (notice && notice !== tanksState.serverNotice) {
      tanksState.serverNotice = notice;
      addTanksLog("Сервер", notice, "warn");
    } else if (!notice) {
      tanksState.serverNotice = "";
    }
  }

  function notifyTanksServerOffline() {
    if (tanksState.serverNotice === SERVER_OFFLINE_MESSAGE) return;
    tanksState.serverNotice = SERVER_OFFLINE_MESSAGE;
    addTanksLog("Сервер", SERVER_OFFLINE_MESSAGE, "warn");
  }

  function syncTanksName() {
    tanksEls.name.value = getSavedTanksName();
  }

  function requireSavedTanksName() {
    if (isTanksNameSaved()) {
      tanksState.nameError = "";
      renderTanksStatus();
      return true;
    }
    showTanksNameError();
    return false;
  }

  function showTanksNameError() {
    tanksState.nameError = NAME_REQUIRED_MESSAGE;
    addTanksLog("Ник не сохранен", NAME_REQUIRED_MESSAGE, "warn");
    renderTanksStatic();
    tanksEls.name.focus({ preventScroll: true });
  }

  function cleanTanksName(value) {
    return String(value || "").trim().slice(0, 32);
  }

  function getSavedTanksName() {
    return cleanTanksName(window.localStorage.getItem(NAME_KEY));
  }

  function isTanksNameSaved() {
    const current = cleanTanksName(tanksEls.name.value);
    return Boolean(current && current === getSavedTanksName());
  }

  async function tanksApiGet(url) {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) throw tanksApiError(response);
    return response.json();
  }

  async function tanksApiPost(url, payload) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) throw tanksApiError(response);
    return response.json();
  }

  function tanksApiError(response) {
    const error = new Error(`HTTP ${response.status}`);
    error.status = response.status;
    return error;
  }

  function loadOfflineTanksLeaderboard() {
    const cached = readCachedTanksLeaderboard();
    if (cached) tanksState.leaderboard = cached;

    const seeded = recordsToTanksLeaderboard(window.TENDERBOMB_RECORDS?.records?.tanks);
    if (seeded) {
      tanksState.leaderboard = seeded;
      cacheTanksLeaderboard();
      return;
    }

    fetch("leaderboard-records.json", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        const rows = recordsToTanksLeaderboard(data?.records?.tanks);
        if (!rows) return;
        tanksState.leaderboard = rows;
        cacheTanksLeaderboard();
        renderTanksLeaderboard();
      })
      .catch(() => {});
  }

  function recordsToTanksLeaderboard(records) {
    if (!records || typeof records !== "object") return null;
    return normalizeTanksRows(records);
  }

  function normalizeTanksRows(rows) {
    const sourceRows = Array.isArray(rows) ? rows : rows && typeof rows === "object" ? Object.values(rows) : [];
    return sourceRows
      .filter((item) => item && typeof item === "object")
      .map((item) => ({
        ...item,
        player: cleanTanksName(item.player),
        level: Math.max(1, Number(item.level) || 1),
        score: Math.max(0, Number(item.score) || 0),
        seconds: Math.max(1, Number(item.seconds) || 1),
        updated_at: Number(item.updated_at) || 0,
      }))
      .filter((item) => item.player && item.score >= 0 && isPublicTanksOwner(item))
      .sort(compareTanksRows)
      .slice(0, 50);
  }

  function isPublicTanksOwner(item) {
    const owner = String(item?.client_ip || "").trim();
    return owner && !owner.startsWith("legacy:");
  }

  function upsertTanksRows(rows, row) {
    const byPlayer = new Map(normalizeTanksRows(rows).map((item) => [tanksPlayerKey(item.player), item]));
    const key = tanksPlayerKey(row.player);
    const existing = byPlayer.get(key);
    if (!existing || compareTanksRows(row, existing) < 0) {
      byPlayer.set(key, row);
    }
    return normalizeTanksRows(Array.from(byPlayer.values()));
  }

  function tanksPlayerKey(name) {
    return cleanTanksName(name).toLocaleLowerCase("ru-RU");
  }

  function compareTanksRows(a, b) {
    return b.score - a.score || b.level - a.level || a.seconds - b.seconds || (a.updated_at || 0) - (b.updated_at || 0);
  }

  function saveLocalTanksResult(payload) {
    tanksState.leaderboard = upsertTanksRows(tanksState.leaderboard, {
      player: payload.player,
      client_ip: tanksState.clientIp,
      level: payload.level,
      score: payload.score,
      seconds: payload.seconds,
      mistakes: payload.mistakes,
      combo: payload.combo,
      updated_at: Date.now(),
      local: true,
    });
    cacheTanksLeaderboard();
  }

  function cacheTanksLeaderboard() {
    window.localStorage.setItem(LEADERBOARD_CACHE_KEY, JSON.stringify(tanksState.leaderboard));
  }

  function readCachedTanksLeaderboard() {
    try {
      const cached = JSON.parse(window.localStorage.getItem(LEADERBOARD_CACHE_KEY) || "null");
      return cached ? normalizeTanksRows(cached) : null;
    } catch (error) {
      return null;
    }
  }

  function addTanksLog(title, text, tone = "info") {
    tanksState.log.unshift({ title, text, tone });
    tanksState.log = tanksState.log.slice(0, 9);
    renderTanksLog();
  }

  function renderTanksStatic() {
    renderTanksStatus();
    renderTanksStats();
    renderTanksLeaderboard();
    renderTanksLog();
  }

  function renderTanksStatus() {
    if (!tanksEls.statusText) return;
    tanksEls.name.classList.toggle("is-invalid", Boolean(tanksState.nameError));
    tanksEls.badge.textContent =
      tanksState.status === "playing"
        ? "LIVE"
        : tanksState.status === "wave-clear"
          ? "NEXT"
          : tanksState.status === "paused"
            ? "PAUSE"
          : tanksState.status === "gameover"
            ? "DONE"
            : "READY";
    tanksEls.startBtn.textContent = isTanksRunActive() ? "Заново" : "Старт";
    tanksEls.startBtn.disabled = !isTanksNameSaved();

    const currentName = cleanTanksName(tanksEls.name.value);
    const savedName = getSavedTanksName();
    tanksEls.statusText.textContent = tanksState.nameError
      ? tanksState.nameError
      : !currentName
        ? "Введите никнейм и сохраните, чтобы начать игру."
        : currentName !== savedName
          ? "Никнейм изменен. Нажмите «Сохранить ник», чтобы начать."
          : tanksState.status === "playing"
            ? "Волна идет. База держится."
            : tanksState.status === "paused"
              ? "Пауза. Нажмите ESC, чтобы продолжить."
              : tanksState.status === "gameover"
                ? "Раунд завершен. Можно стартовать снова."
                : "База готова к обороне.";
    tanksEls.leaderboardBadge.textContent = tanksState.serverActive ? "LAN" : "OFFLINE";
  }

  function renderTanksStats() {
    if (!tanksEls.level) return;
    const hasWave = tanksState.totalEnemies > 0;
    const total = hasWave ? Math.max(1, tanksState.totalEnemies) : 0;
    const defeated = hasWave ? Math.max(0, total - tanksState.enemiesLeft) : 0;
    const progress = hasWave ? Math.round((defeated / total) * 100) : 0;
    tanksEls.level.textContent = `${tanksState.level}/∞`;
    tanksEls.score.textContent = String(tanksState.score);
    tanksEls.lives.textContent = String(tanksState.lives);
    tanksEls.enemies.textContent = hasWave ? `${defeated}/${total}` : "0/0";
    tanksEls.waveText.textContent =
      tanksState.status === "gameover"
        ? `Финиш: уровень ${tanksState.level}, ${tanksState.score} очков`
        : tanksState.status === "paused"
          ? `Пауза: уровень ${tanksState.level}, осталось ${Math.max(0, tanksState.enemiesLeft)}`
          : tanksState.status === "wave-clear"
            ? `Волна отбита. Следующий уровень ${tanksState.level + 1}`
            : tanksState.status === "playing"
              ? `Волна ${tanksState.level}: осталось ${Math.max(0, tanksState.enemiesLeft)}`
              : "Готов к первой волне";
    tanksEls.timer.textContent = formatTanksTime(tanksState.elapsedSeconds);
    tanksEls.progressFill.style.width = `${progress}%`;
  }

  function renderTanksLeaderboard() {
    if (!tanksEls.leaderboard) return;
    if (tanksEls.leaderboardCount) tanksEls.leaderboardCount.textContent = String(tanksState.leaderboard.length);
    tanksEls.leaderboard.innerHTML = tanksState.leaderboard.length
      ? tanksState.leaderboard.map(tanksLeaderboardRow).join("")
      : '<li class="leaderboard-empty">Пока нет рекордов. Будь первым.</li>';
  }

  function tanksLeaderboardRow(item, index) {
    return `<li>
      ${tanksRankBadge(index)}
      <span>
        <span class="leaderboard-name">${escapeTanksHtml(item.player)}</span>
      </span>
      <span class="leaderboard-time">${item.score}</span>
    </li>`;
  }

  function tanksRankBadge(index) {
    const rank = index + 1;
    if (rank === 1) return '<span class="leaderboard-rank is-podium" aria-label="1 место"><span class="leaderboard-rank-symbol" aria-hidden="true">🏆</span></span>';
    if (rank === 2) return '<span class="leaderboard-rank is-podium" aria-label="2 место"><span class="leaderboard-rank-symbol" aria-hidden="true">🥈</span></span>';
    if (rank === 3) return '<span class="leaderboard-rank is-podium" aria-label="3 место"><span class="leaderboard-rank-symbol" aria-hidden="true">🥉</span></span>';
    return `<span class="leaderboard-rank">${rank}</span>`;
  }

  function renderTanksLog() {
    if (!tanksEls.log) return;
    tanksEls.logTitle.textContent =
      tanksState.status === "playing"
        ? `Уровень ${tanksState.level}`
        : tanksState.status === "paused"
          ? "Пауза"
          : tanksState.status === "gameover"
            ? "Финиш"
            : "Ожидание";
    tanksEls.log.innerHTML = tanksState.log.length
      ? tanksState.log
          .map((item) => `<li class="tone-${item.tone}"><strong>${escapeTanksHtml(item.title)}</strong><br>${escapeTanksHtml(item.text)}</li>`)
          .join("")
      : '<li class="tone-info">Здесь появится ход боя.</li>';
  }

  function formatTanksTime(seconds) {
    const safeSeconds = Math.max(0, Math.floor(Number(seconds) || 0));
    const minutes = Math.floor(safeSeconds / 60);
    const rest = safeSeconds % 60;
    return `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
  }

  function escapeTanksHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }
})();

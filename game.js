const MODES = {
  express: {
    label: "Экспресс",
    rows: 8,
    cols: 8,
    mines: 10,
    eventEvery: 5,
    fasCharges: 1,
  },
  state: {
    label: "Госзаказ",
    rows: 11,
    cols: 12,
    mines: 22,
    eventEvery: 6,
    fasCharges: 1,
  },
  registry: {
    label: "Импортозамещение",
    rows: 16,
    cols: 16,
    mines: 48,
    eventEvery: 7,
    fasCharges: 2,
  },
};

const TOPICS = [
  "срок поставки",
  "страна происхождения",
  "техническое задание",
  "реестр Минпромторга",
  "позиция из РУ",
  "кольцевидные расширения",
  "банковская гарантия",
  "опыт поставки",
  "эквивалент",
  "смета",
  "логистика",
  "приемка",
  "образцы",
  "протокол",
  "контракт",
  "ЕИС",
  "комиссия",
  "декларация",
];

const MODE_ORDER = ["express", "state", "registry"];
const LEADERBOARD_CACHE_KEY = "tenderBombLeaderboards";
const THEME_CACHE_KEY = "tenderBombTheme";
const THEMES = ["beige", "green", "purple", "pink", "blue", "dark"];
const RECORD_MIN_SECONDS = { express: 6, state: 18, registry: 45 };
const NAME_REQUIRED_MESSAGE = "Введите никнейм и сохраните!";
const NAME_TAKEN_MESSAGE = "Этот ник уже занят другим игроком.";

const els = {};

let state;
const multiplayer = {
  active: false,
  pollId: null,
  leaderboard: [],
  leaderboards: {},
  playerName: "",
  ip: "",
  nameError: "",
  serverNotice: "",
};

document.addEventListener("DOMContentLoaded", () => {
  cacheElements();
  initializeTheme();
  bindControls();
  setupStatusIcons();
  startGame("express");
  initializeMultiplayer();
});

function cacheElements() {
  els.board = document.querySelector("#board");
  els.boardShell = document.querySelector(".board-shell");
  els.modeButtons = Array.from(document.querySelectorAll(".mode-button"));
  els.newGameBtn = document.querySelector("#newGameBtn");
  els.modalNewGameBtn = document.querySelector("#modalNewGameBtn");
  els.closeModalBtn = document.querySelector("#closeModalBtn");
  els.resultModal = document.querySelector("#resultModal");
  els.resultEyebrow = document.querySelector("#resultEyebrow");
  els.resultTitle = document.querySelector("#resultTitle");
  els.resultText = document.querySelector("#resultText");
  els.roundStatus = document.querySelector("#roundStatus");
  els.risksLeft = document.querySelector("#risksLeft");
  els.flagsUsed = document.querySelector("#flagsUsed");
  els.safeLeft = document.querySelector("#safeLeft");
  els.timer = document.querySelector("#timer");
  els.flagModeBtn = document.querySelector("#flagModeBtn");
  els.fasBtn = document.querySelector("#fasBtn");
  els.fasCharges = document.querySelector("#fasCharges");
  els.extractBtn = document.querySelector("#extractBtn");
  els.extractCharges = document.querySelector("#extractCharges");
  els.progressFill = document.querySelector("#progressFill");
  els.eventLog = document.querySelector("#eventLog");
  els.riskMood = document.querySelector("#riskMood");
  els.multiplayerPanel = document.querySelector("#multiplayerPanel");
  els.playerName = document.querySelector("#playerName");
  els.saveNameBtn = document.querySelector("#saveNameBtn");
  els.raceStatus = document.querySelector("#raceStatus");
  els.raceBadge = document.querySelector("#raceBadge");
  els.leaderboards = document.querySelector("#leaderboards");
  els.themeButtons = Array.from(document.querySelectorAll(".theme-button"));
}

function bindControls() {
  els.newGameBtn.addEventListener("click", () => handleNewRound());
  els.modalNewGameBtn.addEventListener("click", () => handleNewRound());
  els.closeModalBtn.addEventListener("click", hideResult);
  els.flagModeBtn.addEventListener("click", () => {
    state.flagMode = !state.flagMode;
    render();
  });
  els.fasBtn.addEventListener("click", handleFas);
  els.fasBtn.dataset.tip = "Проверить область 3x3: вскрывает безопасные разделы и подсвечивает риски.";
  els.extractBtn.addEventListener("click", useExtract);

  els.modeButtons.forEach((button) => {
    button.addEventListener("click", () => selectMode(button.dataset.mode));
  });

  els.themeButtons.forEach((button) => {
    button.addEventListener("click", () => setTheme(button.dataset.theme));
  });

  els.playerName.addEventListener("input", () => {
    multiplayer.playerName = cleanPlayerName(els.playerName.value);
    if (isPlayerNameSaved()) multiplayer.nameError = "";
    renderMultiplayer();
  });
  els.saveNameBtn.addEventListener("click", savePlayerName);
  window.addEventListener("tenderBombNameSaved", (event) => {
    const name = cleanPlayerName(event.detail?.name);
    if (!name) return;
    multiplayer.playerName = name;
    multiplayer.nameError = "";
    els.playerName.value = name;
    renderMultiplayer();
  });
  window.addEventListener("resize", () => {
    if (!state) return;
    renderBoard();
  });

  // --- Delegated Board Event Listeners ---
  els.board.addEventListener("click", (event) => {
    const button = event.target.closest("button.cell");
    if (!button) return;
    const index = Number(button.dataset.index);
    if (state.fasTargetingMode) {
      applyFasCheck(index);
    } else if (state.flagMode) {
      toggleFlag(index);
    } else {
      revealCell(index);
    }
  });

  els.board.addEventListener("contextmenu", (event) => {
    const button = event.target.closest("button.cell");
    if (!button) return;
    event.preventDefault();
    const index = Number(button.dataset.index);
    toggleFlag(index);
  });

}

function setupStatusIcons() {
  const iconMap = {
    risksLeft: "assets/zakryvashka-bomb-icon.png",
    flagsUsed: "assets/icon-flag.svg",
    safeLeft: "assets/icon-grid.svg",
    timer: "assets/icon-clock.svg",
  };

  for (const id in iconMap) {
    const el = document.getElementById(id);
    if (el && el.parentElement && !el.parentElement.querySelector(".status-icon")) {
      const img = document.createElement("img");
      img.src = iconMap[id];
      img.alt = "";
      img.classList.add("status-icon");
      if (id === "risksLeft") {
        img.classList.add("status-icon-bomb");
      }
      el.parentElement.insertBefore(img, el.parentElement.firstChild);
    }
  }

  const styleId = "tenderbomb-status-icons-style";
  let style = document.getElementById(styleId);
  if (!style) {
    style = document.createElement("style");
    style.id = styleId;
    document.head.appendChild(style);
  }
  style.textContent = `
    .stats-row .stat {
      display: flex; 
      align-items: center; 
      justify-content: center; 
      gap: 0.5rem;
    }
    .status-icon { 
      width: 1.6rem; 
      height: 1.6rem; 
      object-fit: contain; 
    }
    .status-icon-bomb { width: 2rem; height: 2rem; }
  `;
}

function initializeTheme() {
  const storedTheme = window.localStorage.getItem(THEME_CACHE_KEY);
  setTheme(THEMES.includes(storedTheme) ? storedTheme : "beige", { persist: false });
}

function setTheme(theme, options = {}) {
  const nextTheme = THEMES.includes(theme) ? theme : "beige";
  document.documentElement.dataset.theme = nextTheme;
  if (options.persist !== false) {
    window.localStorage.setItem(THEME_CACHE_KEY, nextTheme);
  }
  renderThemeButtons(nextTheme);
}

function renderThemeButtons(activeTheme) {
  els.themeButtons.forEach((button) => {
    const active = button.dataset.theme === activeTheme;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

async function initializeMultiplayer() {
  multiplayer.playerName = getSavedPlayerName();
  els.playerName.value = multiplayer.playerName;
  await loadOfflineLeaderboards();

  if (window.location.protocol === "file:") {
    multiplayer.active = false;
    render();
    return;
  }

  try {
    await loadServerProfile();
    await loadLeaderboards(state.modeId);
    multiplayer.active = true;
    multiplayer.pollId = window.setInterval(() => refreshMultiplayerState(), 2500);
    render();
  } catch (error) {
    multiplayer.active = false;
    render();
  }
}

async function selectMode(modeId) {
  if (isModeSwitchLocked() && modeId !== state.modeId) {
    addLog("Раунд уже начат", "Сложность можно поменять после победы, провала или нового раунда.", "warn");
    render();
    return;
  }
  if (!requireSavedPlayerName()) return;
  startGame(modeId);
  if (multiplayer.active) await loadLeaderboards(modeId);
}

async function handleNewRound() {
  if (!requireSavedPlayerName()) return;
  startGame(state.modeId);
  if (multiplayer.active) {
    await loadLeaderboards(state.modeId);
    addLog("Новый раунд", "Это локальная партия только в твоем браузере. Рекорды общие.", "info");
    render();
  }
}

async function loadServerProfile() {
  const data = await apiGet("/api/profile");
  multiplayer.ip = data.ip || "";
  if (data.player) {
    multiplayer.playerName = data.player;
    els.playerName.value = data.player;
    window.localStorage.setItem("tenderBombPlayerName", data.player);
    multiplayer.nameError = "";
  }
}

async function loadLeaderboards(modeId) {
  const data = await apiGet(`/api/state?mode=${encodeURIComponent(modeId)}`);
  applyServerNotice(data);
  const leaderboards = filterLeaderboards(data.leaderboards || { [modeId]: data.leaderboard || [] });
  multiplayer.active = true;
  multiplayer.leaderboards = leaderboards;
  multiplayer.leaderboard = leaderboards[modeId] || [];
  cacheLeaderboards(multiplayer.leaderboards);
  renderMultiplayer();
}

async function refreshMultiplayerState() {
  if (!multiplayer.active || !state) return;
  try {
    const data = await apiGet(`/api/state?mode=${encodeURIComponent(state.modeId)}`);
    applyServerNotice(data);
    const leaderboards = filterLeaderboards(data.leaderboards || { [state.modeId]: data.leaderboard || [] });
    multiplayer.leaderboards = leaderboards;
    multiplayer.leaderboard = leaderboards[state.modeId] || [];
    cacheLeaderboards(multiplayer.leaderboards);
    renderMultiplayer();
  } catch (error) {
    multiplayer.active = false;
    renderMultiplayer();
  }
}

async function submitMultiplayerResult(status) {
  if (!multiplayer.active || state.resultSent) return;
  state.resultSent = true;
  const resultSeconds = status === "won" ? Math.max(1, state.seconds) : Math.max(0, state.seconds);
  try {
    const roundId = await serverRoundIdForResult(status);
    if (status === "won" && !roundId) {
      addLog("Рекорд не записан", "Серверный раунд не был создан, поэтому результат не принят в таблицу.", "warn");
      return;
    }
    const data = await apiPost("/api/result", {
      player: getPlayerName(),
      status,
      client_seconds: resultSeconds,
      round_id: roundId,
      mode: state.modeId,
      flags: state.flags,
      revealed: state.revealed,
    });
    applyServerNotice(data);
    multiplayer.leaderboard = data.leaderboard || data.state?.leaderboard || multiplayer.leaderboard;
    multiplayer.leaderboards = data.leaderboards || data.state?.leaderboards || multiplayer.leaderboards;
    cacheLeaderboards(multiplayer.leaderboards);
    if (status === "won") {
      announceRecordResult(data.result);
    }
    renderMultiplayer();
  } catch (error) {
    addLog("Результат не ушел", "Сервер не принял протокол. Возможно, окно сервера закрыто.", "warn");
  }
}

function beginServerRound() {
  if (!multiplayer.active || !state || state.serverRoundId || state.serverRoundPromise) {
    return state?.serverRoundPromise || Promise.resolve(null);
  }

  const modeId = state.modeId;
  state.serverRoundPromise = apiPost("/api/round/start", {
    player: getPlayerName(),
    mode: modeId,
  })
    .then((data) => {
      if (!data?.ok || !data.round_id) throw new Error(data?.error || "round_start_failed");
      if (state && state.modeId === modeId) {
        state.serverRoundId = data.round_id;
        state.serverStartedAt = Number(data.started_at) || 0;
      }
      return data;
    })
    .catch(() => {
      if (state?.status === "playing") {
        if (error.message === "name_taken") {
          addLog("Ник занят", NAME_TAKEN_MESSAGE, "warn");
        } else {
          addLog("Серверный раунд не создан", "Рекорд этой партии не будет записан в таблицу.", "warn");
        }
      }
      return null;
    });

  return state.serverRoundPromise;
}

async function serverRoundIdForResult(status) {
  if (!multiplayer.active || !state) return "";
  if (!state.serverRoundId && status === "won") {
    await beginServerRound();
  } else if (state.serverRoundPromise) {
    await state.serverRoundPromise;
  }
  return state.serverRoundId || "";
}

async function loadOfflineLeaderboards() {
  const cached = readCachedLeaderboards();
  if (cached) {
    multiplayer.leaderboards = cached;
    multiplayer.leaderboard = cached[state.modeId] || [];
  }

  if (window.TENDERBOMB_RECORDS?.records) {
    const seeded = recordsToLeaderboards(window.TENDERBOMB_RECORDS.records);
    if (seeded) {
      multiplayer.leaderboards = seeded;
      multiplayer.leaderboard = seeded[state.modeId] || [];
      cacheLeaderboards(seeded);
      return;
    }
  }

  try {
    const response = await fetch("leaderboard-records.json", { cache: "no-store" });
    if (!response.ok) return;
    const data = await response.json();
    const leaderboards = recordsToLeaderboards(data.records);
    if (leaderboards) {
      multiplayer.leaderboards = leaderboards;
      multiplayer.leaderboard = leaderboards[state.modeId] || [];
      cacheLeaderboards(leaderboards);
    }
  } catch (error) {
    // Opening through file:// may block reading the JSON file; cached records still work.
  }
}

function recordsToLeaderboards(records) {
  if (!records || typeof records !== "object") return null;
  return filterLeaderboards(records);
}

function filterLeaderboards(leaderboards) {
  return MODE_ORDER.reduce((result, modeId) => {
    result[modeId] = normalizeLeaderboardRows(modeId, leaderboards?.[modeId]);
    return result;
  }, {});
}

function normalizeLeaderboardRows(modeId, rows) {
  const sourceRows = Array.isArray(rows) ? rows : rows && typeof rows === "object" ? Object.values(rows) : [];
  return sourceRows
    .map((item) => ({ ...item, seconds: Number(item.seconds) || 0 }))
    .filter((item) => isPublicLeaderboardOwner(item) && item.seconds > 0)
    .sort((a, b) => a.seconds - b.seconds || (a.updated_at || 0) - (b.updated_at || 0))
    .slice(0, 50);
}

function isPublicLeaderboardOwner(item) {
  const owner = String(item?.client_ip || "").trim();
  return owner && !owner.startsWith("legacy:");
}

function cacheLeaderboards(leaderboards) {
  if (!leaderboards) return;
  window.localStorage.setItem(LEADERBOARD_CACHE_KEY, JSON.stringify(leaderboards));
}

function readCachedLeaderboards() {
  try {
    const cached = JSON.parse(window.localStorage.getItem(LEADERBOARD_CACHE_KEY) || "null");
    return cached && typeof cached === "object" ? cached : null;
  } catch (error) {
    return null;
  }
}

function announceRecordResult(result) {
  if (!result) return;
  if (result.reason === "first_record") {
    addLog("Рекорд записан", `Первый личный рекорд: ${formatTime(result.best_seconds)}.`, "good");
  } else if (result.reason === "improved") {
    addLog("Рекорд побит", `Улучшение на ${formatTime(result.improved_by)}. Новый рекорд: ${formatTime(result.best_seconds)}.`, "good");
  } else if (result.reason === "not_improved") {
    addLog("Рекорд устоял", `Не хватило ${formatTime(result.missed_by)} до личного рекорда ${formatTime(result.best_seconds)}.`, "warn");
  } else if (result.reason === "too_fast") {
    addLog(
      "Рекорд отклонен",
      `Сервер засек ${formatTime(result.server_seconds)}. Для этого режима минимум ${formatTime(result.min_seconds)}.`,
      "warn",
    );
  } else if (result.reason === "invalid_round") {
    addLog("Рекорд отклонен", "Сервер не нашел активный раунд для этого результата.", "warn");
  } else if (result.reason === "stat_mismatch") {
    addLog("Рекорд отклонен", "Итог поля не совпал с правилами режима.", "warn");
  } else if (result.reason === "invalid_player") {
    addLog("Рекорд отклонен", "Введите никнейм и сохраните его перед игрой.", "warn");
  } else if (result.reason === "name_taken") {
    addLog("Рекорд отклонен", NAME_TAKEN_MESSAGE, "warn");
  }
}

function applyServerNotice(data) {
  const notice = String(data?.server_notice || "").trim();
  if (notice && notice !== multiplayer.serverNotice) {
    multiplayer.serverNotice = notice;
    addLog("Сервер", notice, "warn");
  } else if (!notice) {
    multiplayer.serverNotice = "";
  }
}

async function apiGet(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function apiPost(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function savePlayerName() {
  const name = cleanPlayerName(els.playerName.value);
  if (!name) {
    showNameRequiredError();
    return false;
  }
  // Dispatch event before making API calls to ensure UI consistency
  window.dispatchEvent(new CustomEvent("tenderBombNameSaved", { detail: { name } }));
  multiplayer.playerName = name;
  multiplayer.nameError = "";
  window.localStorage.setItem("tenderBombPlayerName", name);
  els.playerName.value = name;
  if (multiplayer.active) {
    try {
      const data = await apiPost("/api/profile", { player: name });
      if (data.ok === false) {
        showProfileError(data);
        return false;
      }
      multiplayer.ip = data.ip || multiplayer.ip;
      if (data.player) {
        multiplayer.playerName = data.player;
        els.playerName.value = data.player;
        window.localStorage.setItem("tenderBombPlayerName", data.player);
      }
      // Dispatch again with server-confirmed name if it changed
      if (data.player && data.player !== name) window.dispatchEvent(new CustomEvent("tenderBombNameSaved", { detail: { name: data.player } }));
      addLog("Ник сохранен", `Ник ${multiplayer.playerName} закреплен за этим локальным IP.`, "info");
    } catch (error) {
      addLog("Ник сохранен локально", "Сервер не ответил, но браузер запомнил ник.", "warn");
    }
  } else {
    addLog("Ник сохранен", `Результаты будут записываться как ${name}.`, "info");
  }
  render();
  return true;
}

function showProfileError(data) {
  const message = data?.error === "name_taken" ? NAME_TAKEN_MESSAGE : NAME_REQUIRED_MESSAGE;
  multiplayer.nameError = message;
  if (data?.player) {
    multiplayer.playerName = data.player;
    els.playerName.value = data.player;
    window.localStorage.setItem("tenderBombPlayerName", data.player);
  } else {
    window.localStorage.removeItem("tenderBombPlayerName");
  }
  addLog(data?.error === "name_taken" ? "Ник занят" : "Ник не сохранен", message, "warn");
  renderMultiplayer();
  els.playerName.focus({ preventScroll: true });
}

function cleanPlayerName(value) {
  return String(value || "").trim().slice(0, 32);
}

function getSavedPlayerName() {
  return cleanPlayerName(window.localStorage.getItem("tenderBombPlayerName"));
}

function getPlayerName() {
  return getSavedPlayerName();
}

function isPlayerNameSaved() {
  const current = cleanPlayerName(els.playerName.value);
  return Boolean(current && current === getSavedPlayerName());
}

function requireSavedPlayerName() {
  if (isPlayerNameSaved()) {
    multiplayer.nameError = "";
    renderMultiplayer();
    return true;
  }
  showNameRequiredError();
  return false;
}

function showNameRequiredError() {
  multiplayer.nameError = NAME_REQUIRED_MESSAGE;
  if (state) addLog("Ник не сохранен", NAME_REQUIRED_MESSAGE, "warn");
  render();
  els.playerName.focus({ preventScroll: true });
}

function isModeSwitchLocked() {
  return state?.status === "playing";
}

function startGame(modeId) {
  const mode = MODES[modeId] || MODES.express;
  stopTimer();
  state = {
    modeId,
    mode,
    rows: mode.rows,
    cols: mode.cols,
    cells: createCells(mode.rows, mode.cols, modeId),
    firstMove: true,
    status: "ready",
    flags: 0,
    revealed: 0,
    seconds: 0,
    timerId: null,
    eventMeter: 0,
    flagMode: false,
    extractCharges: 0,
    extractAuthority: false,
    extractUsed: false,
    fasCharges: mode.fasCharges,
    logItems: [],
    fasTargetingMode: false,
    boardReady: false,
    resultSent: false,
    serverRoundId: "",
    serverRoundPromise: null,
    serverStartedAt: 0,
  };
  hideResult();
  addLog("Аукцион опубликован", "Документы загружены, риски закрыты в поле.", "info");
  render();
}

function createCells(rows, cols, modeId) {
  return Array.from({ length: rows * cols }, (_, index) => {
    const row = Math.floor(index / cols);
    const col = index % cols;
    const inactive = modeId === "state" && isCornerCell(row, col, rows, cols);
    return {
      index,
      row,
      col,
      inactive,
      topic: TOPICS[index % TOPICS.length],
      mine: false,
      extract: false,
      revealed: false,
      flagged: false,
      hinted: false,
      neutralized: false,
      adjacent: 0,
    };
  });
}

function isCornerCell(row, col, rows, cols) {
  return (row === 0 || row === rows - 1) && (col === 0 || col === cols - 1);
}

function generateBoard(safeIndex) {
  const excluded = new Set([safeIndex, ...getNeighbors(safeIndex)]);
  const mineCandidates = state.cells
    .filter((cell) => !cell.inactive)
    .map((cell) => cell.index)
    .filter((index) => !excluded.has(index));

  shuffle(mineCandidates)
    .slice(0, state.mode.mines)
    .forEach((index) => {
      state.cells[index].mine = true;
    });

  const extractCandidates = state.cells
    .filter((cell) => !cell.inactive && !cell.mine && !excluded.has(cell.index))
    .map((cell) => cell.index);
  const extractIndex = shuffle(extractCandidates)[0] ?? safeIndex;
  state.cells[extractIndex].extract = true;

  recalculateAdjacency();
}

function recalculateAdjacency() {
  state.cells.forEach((cell) => {
    if (cell.inactive) {
      cell.adjacent = 0;
      return;
    }
    cell.adjacent = getNeighbors(cell.index).filter((index) => state.cells[index].mine).length;
  });
}

function revealCell(index, source = "player") {
  if (!canPlay()) return 0;
  if (source === "player" && !requireSavedPlayerName()) return 0;

  if (state.firstMove) {
    if (!state.boardReady) {
      generateBoard(index);
      state.boardReady = true;
    }
    state.firstMove = false;
    state.status = "playing";
    beginServerRound();
    startTimer();
  }

  const cell = state.cells[index];
  if (!cell || cell.inactive || cell.revealed || cell.flagged) return 0;

  if (cell.mine) {
    lose(cell);
    render();
    return 0;
  }

  const before = state.revealed;
  openSafeRegion(index);
  const opened = state.revealed - before;

  if (opened > 0 && source === "player" && state.status === "playing") {
    state.eventMeter += 1;
    if (state.eventMeter >= state.mode.eventEvery) {
      state.eventMeter = 0;
      triggerTenderEvent();
    }
  }

  checkWin();
  render();
  return opened;
}

function openSafeRegion(index) {
  const queue = [index];
  const visited = new Set();

  while (queue.length) {
    const currentIndex = queue.shift();
    const cell = state.cells[currentIndex];
    if (!cell || cell.inactive || visited.has(currentIndex) || cell.revealed || cell.flagged || cell.mine) continue;
    visited.add(currentIndex);
    openCell(cell);

    if (cell.adjacent === 0) {
      getNeighbors(currentIndex).forEach((neighborIndex) => {
        const neighbor = state.cells[neighborIndex];
        if (neighbor && !neighbor.inactive && !neighbor.mine && !neighbor.revealed && !neighbor.flagged) {
          queue.push(neighborIndex);
        }
      });
    }
  }
}

function openCell(cell) {
  if (cell.inactive || cell.revealed) return;
  cell.revealed = true;
  cell.hinted = false;
  state.revealed += 1;

  if (cell.extract) {
    grantExtract("cell");
  }
}

function toggleFlag(index) {
  if (!canPlay()) return;
  if (!requireSavedPlayerName()) return;
  const cell = state.cells[index];
  if (!cell || cell.inactive || cell.revealed) return;

  cell.flagged = !cell.flagged;
  if (cell.flagged) {
    cell.hinted = false;
    state.flags += 1;
  } else {
    state.flags -= 1;
  }
  render();
}

function handleFas() {
  if (!canPlay() || state.firstMove || state.fasCharges <= 0) return;
  if (!requireSavedPlayerName()) return;

  state.fasTargetingMode = true;
  addLog("Жалоба в ФАС", "Выберите область 3x3 для проверки.", "info");
  render();
}

function useExtract() {
  if (!canPlay() || state.firstMove || state.extractCharges <= 0) return;
  if (!requireSavedPlayerName()) return;
  state.extractCharges -= 1;
  state.extractUsed = true;
  state.extractAuthority = true;

  const hinted = hintRandomMines(1);
  const opened = revealSingleSafe(1);

  addLog(
    "Выписка РФ",
    hinted || opened
      ? `Реестр помог точечно: подсвечено закрывашек ${hinted}, открыт безопасный раздел ${opened}.`
      : "Реестр подтвердил позицию, но поле уже почти полностью прочитано.",
    "good",
  );

  checkWin();
  render();
}

function applyFasCheck(index) {
  if (!canPlay() || state.fasCharges <= 0) return;

  state.fasCharges -= 1;
  state.fasTargetingMode = false;

  const area = [index, ...getNeighbors(index)];
  let hinted = 0;
  const before = state.revealed;

  area.forEach((cellIndex) => {
    const cell = state.cells[cellIndex];
    if (!cell || cell.inactive) return;

    if (cell.mine && !cell.revealed && !cell.flagged) {
      cell.hinted = true;
      hinted += 1;
    } else if (!cell.mine && !cell.revealed && !cell.flagged) {
      openSafeRegion(cellIndex);
    }
  });
  const opened = state.revealed - before;

  addLog("Проверка ФАС", `В области 3x3 подсвечено рисков: ${hinted}, открыто безопасных: ${opened}.`, "good");

  checkWin();
  render();
}

function triggerTenderEvent() {
  if (state.status !== "playing") return;

  const events = [
    eventClarification,
    eventSupplierQuote,
    eventFasWave,
    eventNoEquivalent,
    eventLongTerms,
    eventYesterdayDelivery,
    eventSingleParticipant,
  ];

  if (!state.extractAuthority && Math.random() < 0.24) {
    eventRegistryExtract();
    return;
  }

  randomItem(events)();
}

function eventClarification() {
  const opened = autoRevealSafe(2);
  addLog(
    "Запрос разъяснений",
    opened ? `Заказчик раскрыл безопасные разделы: ${opened}.` : "Разъяснение пришло, но поле уже почти чистое.",
    "info",
  );
}

function eventSupplierQuote() {
  const hinted = hintRandomMines(1);
  addLog(
    "Срочная КП",
    hinted ? "Поставщик шепнул, где торчит позиция из чужого РУ." : "Поставщик опоздал к самому интересному.",
    "info",
  );
}

function eventFasWave() {
  if (Math.random() < 0.52) {
    const neutralized = neutralizeMines(1);
    addLog(
      "Внеплановая ФАС",
      neutralized ? "Один риск снят без лишних разговоров." : "Снимать уже нечего.",
      "good",
    );
  } else {
    hintRandomMines(1);
    addLog("Внеплановая ФАС", "Письмо приняли, но пока только появился намек.", "warn");
  }
}

function eventNoEquivalent() {
  const hinted = hintRandomMines(2);
  addLog(
    "Эквивалент не допускается",
    hinted ? "Формулировка выдала закрывашки рядом." : "Все такие формулировки уже на виду.",
    "bad",
  );
}

function eventLongTerms() {
  state.seconds += 9;
  const opened = autoRevealSafe(1);
  addLog(
    "ТЗ на 186 страниц",
    opened ? "Время ушло на чтение, зато один раздел стал понятнее." : "Время ушло на чтение. Ничего нового.",
    "warn",
  );
}

function eventYesterdayDelivery() {
  state.seconds += 14;
  hintRandomMines(1);
  addLog("Поставка вчера", "Сроки давят, риск подсветился, таймер дернулся.", "bad");
}

function eventSingleParticipant() {
  if (state.extractAuthority) {
    const hinted = hintRandomMines(1);
    const opened = revealSingleSafe(1);
    addLog(
      "Один участник",
      hinted || opened
        ? `Выписка усилила позицию: подсветили рисков ${hinted}, открыли разделов ${opened}.`
        : "Выписка на руках, но поле уже почти без сюрпризов.",
      "good",
    );
    return;
  }

  const opened = autoRevealSafe(1);
  addLog(
    "Один участник",
    opened ? "Пока без выписки, но тишина на площадке помогла открыть раздел." : "Тишина подозрительная, а поле молчит.",
    "warn",
  );
}

function eventRegistryExtract() {
  grantExtract("event");
  addLog("Выписка из реестра", "Документ нашелся. У отдела появился тяжелый аргумент.", "good");
}

function grantExtract(source) {
  state.extractCharges += 1;
  state.extractAuthority = true;
  if (source === "cell") {
    addLog("Выписка найдена", "Появилась точечная проверка поля, но победу все равно надо доиграть.", "good");
  }
}

function neutralizeMines(count) {
  const mines = state.cells.filter((cell) => cell.mine && !cell.revealed);
  const chosen = shuffle(mines).slice(0, count);

  chosen.forEach((cell) => {
    cell.mine = false;
    cell.neutralized = true;
    cell.hinted = false;
    if (cell.flagged) {
      cell.flagged = false;
      state.flags -= 1;
    }
  });

  if (chosen.length) recalculateAdjacency();
  return chosen.length;
}

function autoRevealSafe(count) {
  const safe = state.cells.filter((cell) => !cell.inactive && !cell.mine && !cell.revealed && !cell.flagged);
  const chosen = shuffle(safe).slice(0, count);
  const before = state.revealed;
  chosen.forEach((cell) => openSafeRegion(cell.index));
  return state.revealed - before;
}

function revealSingleSafe(count) {
  const safe = state.cells.filter((cell) => !cell.inactive && !cell.mine && !cell.revealed && !cell.flagged && !cell.extract);
  const chosen = shuffle(safe).slice(0, count);
  chosen.forEach((cell) => openCell(cell));
  return chosen.length;
}

function hintRandomMines(count) {
  const mines = state.cells.filter((cell) => cell.mine && !cell.flagged && !cell.hinted);
  const chosen = shuffle(mines).slice(0, count);
  chosen.forEach((cell) => {
    cell.hinted = true;
  });
  return chosen.length;
}

function checkWin() {
  if (state.status !== "playing") return;
  const safeTotal = activeCellCount() - countMines();
  if (state.revealed >= safeTotal) {
    win("Поле прочитано, риски обойдены, заявка ушла без лишнего драматизма.");
  }
}

function win(reason) {
  if (state.status === "won") return;
  state.status = "won";
  stopTimer();
  state.seconds = Math.max(1, state.seconds);
  state.cells.forEach((cell) => {
    if (cell.mine) cell.flagged = true;
  });
  state.flags = countMines();
  addLog("Протокол победы", reason, "good");
  showResult("Победа в аукционе", reason, "итог");
  submitMultiplayerResult("won");
}

function lose(cell) {
  state.status = "lost";
  stopTimer();
  state.cells.forEach((c) => {
    if (c.mine) c.revealed = true;
  });
  const text = `На разделе "${cell.topic}" сработала закрывашка: позиция в ТЗ совпала с чужим РУ и закрыла вход остальным участникам.`;
  addLog("Закрывашка сработала", text, "bad");
  showResult("Аукцион был под своих", text, "итог");
  submitMultiplayerResult("lost");
}

function canPlay() {
  return state && state.status !== "won" && state.status !== "lost";
}

function startTimer() {
  if (state.timerId) return;
  state.timerId = window.setInterval(() => {
    state.seconds += 1;
    updateStatusOnly();
  }, 1000);
}

function stopTimer() {
  if (state?.timerId) {
    window.clearInterval(state.timerId);
    state.timerId = null;
  }
}

function showResult(title, text, eyebrow) {
  els.resultEyebrow.textContent = eyebrow;
  els.resultTitle.textContent = title;
  els.resultText.textContent = text;
  els.resultModal.hidden = false;
}

function hideResult() {
  els.resultModal.hidden = true;
}

function render() {
  renderControls();
  renderBoard();
  renderLog();
  renderMultiplayer();
  updateStatusOnly();
}

function renderControls() {
  els.modeButtons.forEach((button) => {
    const active = button.dataset.mode === state.modeId;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", String(active));
    button.disabled = isModeSwitchLocked() && !active;
  });

  els.boardShell.classList.toggle("is-fas-targeting", state.fasTargetingMode);
  els.flagModeBtn.setAttribute("aria-pressed", String(state.flagMode));
  els.fasBtn.disabled = state.firstMove || state.fasCharges <= 0 || !canPlay();
  els.extractBtn.disabled = state.firstMove || state.extractCharges <= 0 || !canPlay();
  els.extractBtn.classList.toggle("is-ready", state.extractCharges > 0);
  els.fasCharges.textContent = String(state.fasCharges);
  els.extractCharges.textContent = String(state.extractCharges);
  els.newGameBtn.textContent = "Новый раунд";
  els.modalNewGameBtn.textContent = "Новый раунд";
}

function renderBoard() {
  els.board.style.setProperty("--cols", state.cols);
  els.board.style.setProperty("--rows", state.rows);
  els.board.style.setProperty("--mode-cell-size", cellSizeForMode());
  els.board.innerHTML = state.cells.map(cellTemplate).join("");
}

function cellSizeForMode() {
  const gap = parseFloat(window.getComputedStyle(els.board).columnGap) || 4;
  const desired = state.modeId === "express" ? 78 : state.modeId === "state" ? 60 : 46;
  const shell = els.boardShell;
  if (!shell) return `${desired}px`;

  const styles = window.getComputedStyle(shell);
  const paddingX = parseFloat(styles.paddingLeft) + parseFloat(styles.paddingRight);
  const paddingY = parseFloat(styles.paddingTop) + parseFloat(styles.paddingBottom);
  const availableWidth = shell.clientWidth - paddingX;
  const availableHeight = shell.clientHeight - paddingY;
  const byWidth = (availableWidth - (state.cols - 1) * gap) / state.cols;
  const byHeight = (availableHeight - (state.rows - 1) * gap) / state.rows;
  const size = Math.max(22, Math.floor(Math.min(desired, byWidth, byHeight)));
  return `${size}px`;
}

function cellTemplate(cell) {
  if (cell.inactive) {
    return '<span class="cell cell-cut" aria-hidden="true"></span>';
  }

  const showMine = state.status === "lost" && cell.mine;
  const isOpen = cell.revealed || showMine;
  const classes = ["cell"];
  let content = "";
  let label = `Скрытый раздел: ${cell.topic}`;

  if (isOpen) classes.push("is-open");
  if (cell.flagged && !isOpen) {
    classes.push("is-flagged");
    content = '<img class="cell-icon" src="assets/icon-flag.svg" alt="">';
    label = `Не лезем: ${cell.topic}`;
  } else if (cell.hinted && !isOpen) {
    classes.push("is-hinted");
    content = "?";
    label = `Подозрительный раздел: ${cell.topic}`;
  } else if (showMine) {
    classes.push("is-danger");
    content = '<img class="cell-bomb-icon" src="assets/zakryvashka-bomb-icon.png" alt="">';
    label = `Закрывашка: ${cell.topic}`;
  } else if (cell.revealed && cell.extract) {
    classes.push("is-document");
    content = "РФ";
    label = `Выписка РФ: ${cell.topic}`;
  } else if (cell.revealed && cell.neutralized) {
    classes.push("is-neutralized");
    content = "Ф";
    label = `Снято ФАС: ${cell.topic}`;
  } else if (cell.revealed && cell.adjacent > 0) {
    classes.push(`number-${cell.adjacent}`);
    content = String(cell.adjacent);
    label = `Сигналов рядом: ${cell.adjacent}. ${cell.topic}`;
  } else if (cell.revealed) {
    label = `Чистый раздел: ${cell.topic}`;
  }

  const disabled = state.status === "won" || state.status === "lost" || cell.revealed;
  return `<button class="${classes.join(" ")}" type="button" data-index="${cell.index}" aria-label="${label}" title="${label}" ${
    disabled ? "disabled" : ""
  }>${content}</button>`;
}

function renderLog() {
  els.eventLog.innerHTML = state.logItems
    .map(
      (item) =>
        `<li class="tone-${item.tone}"><img class="event-icon" src="${item.icon}" alt=""><div><strong>${item.title}</strong><span>${item.text}</span></div></li>`,
    )
    .join("");
}

function renderMultiplayer() {
  if (!els.multiplayerPanel) return;

  const offlineRows = MODE_ORDER.reduce((total, modeId) => total + (multiplayer.leaderboards[modeId]?.length || 0), 0);
  const savedName = getSavedPlayerName();
  const currentName = cleanPlayerName(els.playerName.value);
  els.raceBadge.textContent = multiplayer.active ? "LAN" : "OFFLINE";
  els.playerName.classList.toggle("is-invalid", Boolean(multiplayer.nameError));
  els.raceStatus.textContent = multiplayer.nameError
    ? multiplayer.nameError
    : !currentName
      ? "Введите никнейм и сохраните, чтобы начать игру."
      : currentName !== savedName
        ? "Никнейм изменен. Нажмите «Сохранить», чтобы начать игру."
        : multiplayer.active
          ? `Ник привязан к IP ${multiplayer.ip}. Таблицы хранят постоянные рекорды.`
          : offlineRows
            ? "Сервер рекордов не подключен. Показан последний сохраненный снимок таблицы."
            : "Сервер рекордов не подключен. Запусти start-server.bat, чтобы сохранять и видеть рекорды отдела.";

  els.leaderboards.innerHTML = MODE_ORDER.map((modeId) => {
    const rows = multiplayer.leaderboards[modeId] || [];
    const title = MODES[modeId].label;
    const body = rows.length
      ? rows.map((item, index) => leaderboardRow(item, index)).join("")
      : '<li class="leaderboard-empty">Пока нет рекордов. Будь первым.</li>';
    return `<section class="leaderboard-table">
      <div class="leaderboard-title"><span>${title}</span><span>${rows.length}</span></div>
      <ol class="leaderboard">${body}</ol>
    </section>`;
  }).join("");
}

function leaderboardRow(item, index) {
  const status =
    item.improved_by === null || item.improved_by === undefined
      ? "первый рекорд"
      : `побит на ${formatTime(item.improved_by)}`;
  return `<li>
    ${leaderboardRankBadge(index)}
    <span>
      <span class="leaderboard-name">${escapeHtml(item.player)}</span>
      <span class="leaderboard-meta">${status}</span>
    </span>
    <span class="leaderboard-time">${formatTime(item.seconds)}</span>
  </li>`;
}

function leaderboardRankBadge(index) {
  const rank = index + 1;
  if (rank === 1) {
    return `<span class="leaderboard-rank is-podium is-gold" aria-label="1 место"><span class="leaderboard-rank-symbol" aria-hidden="true">🏆</span></span>`;
  }
  if (rank === 2) {
    return `<span class="leaderboard-rank is-podium is-silver" aria-label="2 место"><span class="leaderboard-rank-symbol" aria-hidden="true">🥈</span></span>`;
  }
  if (rank === 3) {
    return `<span class="leaderboard-rank is-podium is-bronze" aria-label="3 место"><span class="leaderboard-rank-symbol" aria-hidden="true">🥉</span></span>`;
  }
  return `<span class="leaderboard-rank">${rank}</span>`;
}

function updateStatusOnly() {
  const mines = countMines();
  const safeTotal = activeCellCount() - mines;
  const safeLeft = Math.max(safeTotal - state.revealed, 0);
  const progress = safeTotal ? Math.round((state.revealed / safeTotal) * 100) : 0;

  els.risksLeft.textContent = String(Math.max(mines - state.flags, 0));
  els.flagsUsed.textContent = String(state.flags);
  els.safeLeft.textContent = String(safeLeft);
  els.timer.textContent = formatTime(state.seconds);
  els.progressFill.style.width = `${progress}%`;

  if (state.status === "won") {
    els.roundStatus.textContent = "Протокол подписан";
    els.riskMood.textContent = "победа";
  } else if (state.status === "lost") {
    els.roundStatus.textContent = "Закрывашка сработала";
    els.riskMood.textContent = "больно";
  } else if (state.firstMove) {
    els.roundStatus.textContent = `${state.mode.label}: поле закрыто`;
    els.riskMood.textContent = "тихо";
  } else {
    els.roundStatus.textContent = `${state.mode.label}: ${progress}%`;
    els.riskMood.textContent = state.extractAuthority ? "выписка" : progress > 45 ? "жарко" : "рабоче";
  }
}

function addLog(title, text, tone = "info") {
  state.logItems.unshift({ title, text, tone, icon: iconForEvent(title, tone) });
  state.logItems = state.logItems.slice(0, 9);
}

function iconForEvent(title, tone) {
  if (title.includes("Выписка") || title.includes("Протокол")) return "assets/icon-extract-rf.svg";
  if (title.includes("ФАС") || title.includes("Жалоба")) return "assets/icon-fas.svg";
  if (title.includes("Закрывашка") || title.includes("Эквивалент") || title.includes("Поставка")) {
    return "assets/icon-zakryvashka.svg";
  }
  if (title.includes("Один участник") || title.includes("КП")) return "assets/icon-glove-ru.svg";
  if (tone === "bad") return "assets/icon-zakryvashka.svg";
  return "assets/icon-clarification.svg";
}

function getNeighbors(index) {
  const row = Math.floor(index / state.cols);
  const col = index % state.cols;
  const neighbors = [];

  for (let rowOffset = -1; rowOffset <= 1; rowOffset += 1) {
    for (let colOffset = -1; colOffset <= 1; colOffset += 1) {
      if (rowOffset === 0 && colOffset === 0) continue;
      const nextRow = row + rowOffset;
      const nextCol = col + colOffset;
      if (nextRow >= 0 && nextRow < state.rows && nextCol >= 0 && nextCol < state.cols) {
        const nextIndex = nextRow * state.cols + nextCol;
        if (!state.cells[nextIndex]?.inactive) {
          neighbors.push(nextIndex);
        }
      }
    }
  }

  return neighbors;
}

function countMines() {
  return state.cells.filter((cell) => !cell.inactive && cell.mine).length;
}

function activeCellCount() {
  return state.cells.filter((cell) => !cell.inactive).length;
}

function shuffle(items, rng = Math.random) {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const randomIndex = Math.floor(rng() * (index + 1));
    [copy[index], copy[randomIndex]] = [copy[randomIndex], copy[index]];
  }
  return copy;
}

function randomItem(items) {
  return items[Math.floor(Math.random() * items.length)];
}

function formatTime(seconds) {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

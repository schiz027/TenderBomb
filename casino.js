(() => {
  const NAME_KEY = "tenderBombPlayerName";
  const LEADERBOARD_CACHE_KEY = "tenderBombCasinoLeaderboard";
  const POLL_MS = 5000;
  const SPIN_DELAY_MS = 520;
  const BETS = [10, 25, 50, 100, 250];
  const DEFAULT_MIN_BET = 1;
  const DEFAULT_MAX_BET = 10000;
  const SYMBOLS = ["🍒", "🍋", "🍇", "🔔", "⭐", "💎"];
  const NAME_REQUIRED_MESSAGE = "Введите никнейм и сохраните!";
  const NAME_TAKEN_MESSAGE = "Этот ник уже занят другим игроком.";
  const SERVER_OFFLINE_MESSAGE = "Сервер был отключен.";

  const casinoEls = {};
  const casinoState = {
    isOpen: false,
    serverActive: false,
    clientIp: "",
    pollId: null,
    spinInterval: null,
    leaderboard: [],
    history: [],
    nameError: "",
    serverNotice: "",
    credits: null,
    spins: 0,
    wins: 0,
    losses: 0,
    pushes: 0,
    bet: 25,
    minBet: DEFAULT_MIN_BET,
    maxBet: DEFAULT_MAX_BET,
    lastPayout: 0,
    reels: ["🍒", "🍋", "🔔"],
    spinText: "Готово к крутке",
    spinning: false,
  };

  document.addEventListener("DOMContentLoaded", () => {
    cacheCasinoElements();
    if (!casinoEls.openBtn) return;
    syncCasinoName();
    bindCasinoControls();
    loadOfflineCasinoLeaderboard();
    renderCasinoStatic();
  });

  function cacheCasinoElements() {
    casinoEls.openBtn = document.querySelector("#openCasinoBtn");
    casinoEls.closeBtn = document.querySelector("#closeCasinoBtn");
    casinoEls.tenderView = document.querySelector("#tenderBombView");
    casinoEls.checkersView = document.querySelector("#checkersView");
    casinoEls.tanksView = document.querySelector("#tanksView");
    casinoEls.view = document.querySelector("#casinoView");
    casinoEls.name = document.querySelector("#casinoName");
    casinoEls.saveNameBtn = document.querySelector("#saveCasinoNameBtn");
    casinoEls.statusText = document.querySelector("#casinoStatusText");
    casinoEls.networkBadge = document.querySelector("#casinoNetworkBadge");
    casinoEls.leaderboardBadge = document.querySelector("#casinoLeaderboardBadge");
    casinoEls.badge = document.querySelector("#casinoBadge");
    casinoEls.credits = document.querySelector("#casinoCredits");
    casinoEls.creditsStat = document.querySelector("#casinoCreditsStat");
    casinoEls.betStat = document.querySelector("#casinoBetStat");
    casinoEls.payoutStat = document.querySelector("#casinoPayoutStat");
    casinoEls.reels = document.querySelector("#casinoReels");
    casinoEls.spinResult = document.querySelector("#casinoSpinResult");
    casinoEls.betButtons = Array.from(document.querySelectorAll("[data-casino-bet]"));
    casinoEls.customBet = document.querySelector("#casinoCustomBet");
    casinoEls.spinBtn = document.querySelector("#casinoSpinBtn");
    casinoEls.leaderboard = document.querySelector("#casinoLeaderboard");
    casinoEls.leaderboardCount = document.querySelector("#casinoLeaderboardCount");
    casinoEls.logTitle = document.querySelector("#casinoLogTitle");
    casinoEls.log = document.querySelector("#casinoLog");
  }

  function bindCasinoControls() {
    casinoEls.openBtn.addEventListener("click", openCasino);
    casinoEls.closeBtn.addEventListener("click", closeCasino);
    casinoEls.saveNameBtn.addEventListener("click", saveCasinoName);
    casinoEls.spinBtn.addEventListener("click", spinCasinoSlots);
    casinoEls.betButtons.forEach((button) => {
      button.addEventListener("click", () => selectCasinoBet(Number(button.dataset.casinoBet)));
    });
    casinoEls.customBet.addEventListener("input", handleCasinoCustomBetInput);
    casinoEls.customBet.addEventListener("change", commitCasinoCustomBet);
    casinoEls.name.addEventListener("input", () => {
      const name = cleanCasinoName(casinoEls.name.value);
      const mainName = document.querySelector("#playerName");
      if (mainName) mainName.value = name;
      if (isCasinoNameSaved()) casinoState.nameError = "";
      renderCasinoStatus();
    });
    window.addEventListener("tenderBombNameSaved", (event) => {
      const name = cleanCasinoName(event.detail?.name);
      if (!name) return;
      casinoEls.name.value = name;
      casinoState.nameError = "";
      if (casinoState.isOpen) refreshCasinoState();
      renderCasinoStatus();
    });
    window.addEventListener("tenderBombOpenCheckers", hideCasinoForExternalGame);
    window.addEventListener("tenderBombOpenTanks", hideCasinoForExternalGame);
  }

  async function openCasino() {
    window.dispatchEvent(new CustomEvent("tenderBombOpenCasino"));
    casinoState.isOpen = true;
    casinoEls.tenderView.hidden = true;
    if (casinoEls.checkersView) casinoEls.checkersView.hidden = true;
    if (casinoEls.tanksView) casinoEls.tanksView.hidden = true;
    casinoEls.view.hidden = false;
    syncCasinoName();
    renderCasinoStatic();
    await initializeCasinoServer();
    startCasinoPolling();
    renderCasinoStatic();
  }

  function closeCasino(options = {}) {
    const showTender = options.showTender !== false;
    stopCasinoPolling();
    stopSpinAnimation();
    casinoState.isOpen = false;
    casinoEls.view.hidden = true;
    if (showTender) casinoEls.tenderView.hidden = false;
    renderCasinoStatic();
  }

  function hideCasinoForExternalGame() {
    if (!casinoState.isOpen) return;
    closeCasino({ showTender: false });
  }

  async function initializeCasinoServer() {
    if (window.location.protocol === "file:") {
      casinoState.serverActive = false;
      casinoState.spinText = "Нужен сервер";
      return;
    }
    try {
      const profile = await casinoApiGet("/api/profile");
      applyCasinoServerNotice(profile);
      casinoState.clientIp = profile.ip || "";
      if (profile.player) {
        casinoEls.name.value = profile.player;
        window.localStorage.setItem(NAME_KEY, profile.player);
      }
      await refreshCasinoState();
      casinoState.serverActive = true;
    } catch (error) {
      casinoState.serverActive = false;
      casinoState.spinText = "Касса offline";
    }
  }

  function startCasinoPolling() {
    stopCasinoPolling();
    if (!casinoState.isOpen || window.location.protocol === "file:") return;
    casinoState.pollId = window.setInterval(refreshCasinoState, POLL_MS);
  }

  function stopCasinoPolling() {
    if (casinoState.pollId) {
      window.clearInterval(casinoState.pollId);
      casinoState.pollId = null;
    }
  }

  async function refreshCasinoState() {
    try {
      const data = await casinoApiGet("/api/casino/state");
      applyCasinoState(data);
      casinoState.serverActive = data.ok !== false;
      renderCasinoStatic();
    } catch (error) {
      const wasActive = casinoState.serverActive;
      casinoState.serverActive = false;
      if (wasActive) notifyCasinoServerOffline();
      renderCasinoStatic();
    }
  }

  async function saveCasinoName() {
    const name = cleanCasinoName(casinoEls.name.value);
    if (!name) {
      showCasinoNameError();
      return false;
    }

    casinoState.nameError = "";
    casinoEls.name.value = name;
    window.localStorage.setItem(NAME_KEY, name);
    const mainName = document.querySelector("#playerName");
    if (mainName) mainName.value = name;
    window.dispatchEvent(new CustomEvent("tenderBombNameSaved", { detail: { name } }));

    if (window.location.protocol !== "file:") {
      try {
        const data = await casinoApiPost("/api/profile", { player: name });
        applyCasinoServerNotice(data);
        casinoState.serverActive = data.ok !== false;
        casinoState.clientIp = data.ip || casinoState.clientIp;
        if (data.ok === false) {
          showCasinoProfileError(data);
          return false;
        }
        if (data.player) {
          casinoEls.name.value = data.player;
          window.localStorage.setItem(NAME_KEY, data.player);
        }
        await refreshCasinoState();
      } catch (error) {
        casinoState.serverActive = false;
        casinoState.spinText = "Ник сохранен локально";
      }
    }

    casinoState.spinText = "Ник сохранен";
    renderCasinoStatic();
    return true;
  }

  function showCasinoProfileError(data) {
    const message = data?.error === "name_taken" ? NAME_TAKEN_MESSAGE : NAME_REQUIRED_MESSAGE;
    casinoState.nameError = message;
    if (data?.player) {
      casinoEls.name.value = data.player;
      window.localStorage.setItem(NAME_KEY, data.player);
    } else {
      window.localStorage.removeItem(NAME_KEY);
    }
    const mainName = document.querySelector("#playerName");
    if (mainName) mainName.value = data?.player || casinoEls.name.value;
    casinoState.spinText = data?.error === "name_taken" ? "Ник занят" : "Ник не сохранен";
    renderCasinoStatic();
    casinoEls.name.focus({ preventScroll: true });
  }

  function selectCasinoBet(bet) {
    if (!isCasinoBetAllowed(bet)) return;
    casinoState.bet = bet;
    casinoState.spinText = `Ставка ${formatCredits(bet)}`;
    syncCasinoCustomBetInput();
    renderCasinoStatic();
  }

  function handleCasinoCustomBetInput() {
    const bet = casinoCustomBetValue();
    if (!isCasinoBetAllowed(bet)) {
      casinoState.spinText = casinoBetHint();
      renderCasinoStats();
      renderCasinoStatus();
      renderCasinoBets();
      return;
    }
    casinoState.bet = bet;
    casinoState.spinText = `Ставка ${formatCredits(bet)}`;
    renderCasinoStats();
    renderCasinoStatus();
    renderCasinoBets();
  }

  function commitCasinoCustomBet() {
    const bet = casinoCustomBetValue();
    if (isCasinoBetAllowed(bet)) {
      selectCasinoBet(bet);
      return true;
    }
    normalizeCasinoBet();
    syncCasinoCustomBetInput();
    casinoState.spinText = casinoBetHint();
    renderCasinoStatic();
    return false;
  }

  async function spinCasinoSlots() {
    if (casinoState.spinning) return;
    if (!requireSavedCasinoName()) return;
    if (!commitCasinoCustomBet()) return;
    if (window.location.protocol === "file:" || !casinoState.serverActive) {
      casinoState.spinText = "Запустите сервер";
      renderCasinoStatic();
      return;
    }
    if (casinoState.credits !== null && casinoState.credits < casinoState.bet) {
      casinoState.spinText = "Недостаточно кредитов";
      renderCasinoStatic();
      return;
    }

    startSpinAnimation();
    renderCasinoStatic();
    try {
      const data = await casinoApiPost("/api/casino/spin", {
        player: getSavedCasinoName(),
        bet: casinoState.bet,
      });
      await delay(SPIN_DELAY_MS);
      stopSpinAnimation(data?.result?.symbols);
      applyCasinoState(data);
      casinoState.serverActive = data.ok !== false;
      handleCasinoSpinResult(data?.result);
      renderCasinoStatic();
    } catch (error) {
      await delay(180);
      stopSpinAnimation();
      casinoState.serverActive = false;
      casinoState.spinText = "Касса не ответила";
      renderCasinoStatic();
    }
  }

  function handleCasinoSpinResult(result) {
    if (!result || result.ok === false) {
      casinoState.lastPayout = 0;
      casinoState.spinText = casinoErrorMessage(result?.reason || result?.error);
      return;
    }
    casinoState.reels = Array.isArray(result.symbols) ? result.symbols.slice(0, 3) : casinoState.reels;
    casinoState.lastPayout = Math.max(0, Number(result.payout) || 0);
    const net = Number(result.net) || 0;
    if (net > 0) {
      casinoState.spinText = `Выигрыш +${formatCredits(net)}`;
    } else if (net === 0) {
      casinoState.spinText = "Ставка вернулась";
    } else {
      casinoState.spinText = `Минус ${formatCredits(Math.abs(net))}`;
    }
  }

  function casinoErrorMessage(reason) {
    const messages = {
      invalid_player: NAME_REQUIRED_MESSAGE,
      name_taken: NAME_TAKEN_MESSAGE,
      invalid_bet: "Такой ставки нет.",
      not_enough_credits: "Недостаточно кредитов.",
    };
    return messages[reason] || "Крутка не принята.";
  }

  function applyCasinoState(data) {
    applyCasinoServerNotice(data);
    casinoState.clientIp = data?.ip || casinoState.clientIp;
    if (data?.player) {
      casinoEls.name.value = data.player;
      window.localStorage.setItem(NAME_KEY, data.player);
    }
    casinoState.credits = data?.credits === null || data?.credits === undefined ? null : Math.max(0, Number(data.credits) || 0);
    casinoState.spins = Math.max(0, Number(data?.spins) || 0);
    casinoState.wins = Math.max(0, Number(data?.wins) || 0);
    casinoState.losses = Math.max(0, Number(data?.losses) || 0);
    casinoState.pushes = Math.max(0, Number(data?.pushes) || 0);
    casinoState.minBet = Math.max(1, Number(data?.min_bet) || DEFAULT_MIN_BET);
    casinoState.maxBet = Math.max(casinoState.minBet, Number(data?.max_bet) || DEFAULT_MAX_BET);
    casinoState.history = normalizeCasinoHistory(data?.history);
    casinoState.leaderboard = normalizeCasinoRows(data?.leaderboard);
    normalizeCasinoBet();
    cacheCasinoLeaderboard();
  }

  function applyCasinoServerNotice(data) {
    const notice = String(data?.server_notice || "").trim();
    if (notice && notice !== casinoState.serverNotice) {
      casinoState.serverNotice = notice;
      casinoState.spinText = notice;
    } else if (!notice) {
      casinoState.serverNotice = "";
    }
  }

  function notifyCasinoServerOffline() {
    if (casinoState.serverNotice === SERVER_OFFLINE_MESSAGE) return;
    casinoState.serverNotice = SERVER_OFFLINE_MESSAGE;
    casinoState.spinText = SERVER_OFFLINE_MESSAGE;
  }

  function normalizeCasinoBet() {
    const minBet = casinoState.minBet || DEFAULT_MIN_BET;
    const maxBet = casinoState.maxBet || DEFAULT_MAX_BET;
    let nextBet = Math.max(minBet, Math.min(maxBet, Math.floor(Number(casinoState.bet) || 25)));
    if (casinoState.credits !== null && casinoState.credits > 0 && nextBet > casinoState.credits) {
      nextBet = Math.max(minBet, Math.min(maxBet, Math.floor(casinoState.credits)));
    }
    casinoState.bet = nextBet;
    syncCasinoCustomBetInput();
  }

  function startSpinAnimation() {
    stopSpinAnimation();
    casinoState.spinning = true;
    casinoState.spinText = "Крутим...";
    casinoState.spinInterval = window.setInterval(() => {
      casinoState.reels = Array.from({ length: 3 }, randomCasinoSymbol);
      renderCasinoReels();
    }, 75);
  }

  function stopSpinAnimation(finalReels) {
    if (casinoState.spinInterval) {
      window.clearInterval(casinoState.spinInterval);
      casinoState.spinInterval = null;
    }
    casinoState.spinning = false;
    if (Array.isArray(finalReels) && finalReels.length) {
      casinoState.reels = finalReels.slice(0, 3);
    }
    renderCasinoReels();
  }

  function randomCasinoSymbol() {
    return SYMBOLS[Math.floor(Math.random() * SYMBOLS.length)];
  }

  function syncCasinoName() {
    casinoEls.name.value = getSavedCasinoName();
  }

  function requireSavedCasinoName() {
    if (isCasinoNameSaved()) {
      casinoState.nameError = "";
      renderCasinoStatus();
      return true;
    }
    showCasinoNameError();
    return false;
  }

  function showCasinoNameError() {
    casinoState.nameError = NAME_REQUIRED_MESSAGE;
    casinoState.spinText = "Ник не сохранен";
    renderCasinoStatic();
    casinoEls.name.focus({ preventScroll: true });
  }

  function cleanCasinoName(value) {
    return String(value || "").trim().slice(0, 32);
  }

  function getSavedCasinoName() {
    return cleanCasinoName(window.localStorage.getItem(NAME_KEY));
  }

  function isCasinoNameSaved() {
    const current = cleanCasinoName(casinoEls.name.value);
    return Boolean(current && current === getSavedCasinoName());
  }

  async function casinoApiGet(url) {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) throw casinoApiError(response);
    return response.json();
  }

  async function casinoApiPost(url, payload) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) throw casinoApiError(response);
    return response.json();
  }

  function casinoApiError(response) {
    const error = new Error(`HTTP ${response.status}`);
    error.status = response.status;
    return error;
  }

  function loadOfflineCasinoLeaderboard() {
    const cached = readCachedCasinoLeaderboard();
    if (cached) casinoState.leaderboard = cached;

    const seeded = recordsToCasinoLeaderboard(window.TENDERBOMB_RECORDS?.records?.casino);
    if (seeded) {
      casinoState.leaderboard = seeded;
      cacheCasinoLeaderboard();
      return;
    }

    fetch("leaderboard-records.json", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        const rows = recordsToCasinoLeaderboard(data?.records?.casino);
        if (!rows) return;
        casinoState.leaderboard = rows;
        cacheCasinoLeaderboard();
        renderCasinoLeaderboard();
      })
      .catch(() => {});
  }

  function recordsToCasinoLeaderboard(records) {
    if (!records || typeof records !== "object") return null;
    return normalizeCasinoRows(records);
  }

  function normalizeCasinoRows(rows) {
    const sourceRows = Array.isArray(rows) ? rows : rows && typeof rows === "object" ? Object.values(rows) : [];
    return sourceRows
      .filter((item) => item && typeof item === "object")
      .map((item) => ({
        ...item,
        player: cleanCasinoName(item.player),
        credits: Math.max(0, Number(item.credits) || 0),
        spins: Math.max(0, Number(item.spins) || 0),
        wins: Math.max(0, Number(item.wins) || 0),
        updated_at: Number(item.updated_at) || 0,
      }))
      .filter((item) => item.player && item.credits >= 0 && isPublicCasinoOwner(item))
      .sort(compareCasinoRows)
      .slice(0, 50);
  }

  function normalizeCasinoHistory(items) {
    if (!Array.isArray(items)) return [];
    return items
      .filter((item) => item && typeof item === "object")
      .map((item) => ({
        symbols: Array.isArray(item.symbols) ? item.symbols.slice(0, 3).map((symbol) => String(symbol)) : [],
        bet: Math.max(0, Number(item.bet) || 0),
        payout: Math.max(0, Number(item.payout) || 0),
        net: Number(item.net) || 0,
        credits: Math.max(0, Number(item.credits) || 0),
        created_at: Number(item.created_at) || 0,
      }))
      .slice(0, 12);
  }

  function isPublicCasinoOwner(item) {
    const owner = String(item?.client_ip || "").trim();
    return owner && !owner.startsWith("legacy:");
  }

  function compareCasinoRows(a, b) {
    return b.credits - a.credits || b.wins - a.wins || a.spins - b.spins || (a.updated_at || 0) - (b.updated_at || 0);
  }

  function cacheCasinoLeaderboard() {
    window.localStorage.setItem(LEADERBOARD_CACHE_KEY, JSON.stringify(casinoState.leaderboard));
  }

  function readCachedCasinoLeaderboard() {
    try {
      const cached = JSON.parse(window.localStorage.getItem(LEADERBOARD_CACHE_KEY) || "null");
      return cached ? normalizeCasinoRows(cached) : null;
    } catch (error) {
      return null;
    }
  }

  function renderCasinoStatic() {
    renderCasinoStatus();
    renderCasinoStats();
    renderCasinoReels();
    renderCasinoBets();
    renderCasinoLeaderboard();
    renderCasinoLog();
  }

  function renderCasinoStatus() {
    if (!casinoEls.statusText) return;
    casinoEls.name.classList.toggle("is-invalid", Boolean(casinoState.nameError));
    casinoEls.badge.textContent = casinoState.spinning ? "SPIN" : casinoState.serverActive ? "READY" : "OFFLINE";
    casinoEls.networkBadge.textContent = casinoState.serverActive ? "LAN" : "OFFLINE";
    casinoEls.leaderboardBadge.textContent = casinoState.serverActive ? "LAN" : "OFFLINE";

    const currentName = cleanCasinoName(casinoEls.name.value);
    const savedName = getSavedCasinoName();
    const invalidBet = !isCasinoBetAllowed(casinoState.bet);
    const notEnough = casinoState.credits !== null && casinoState.credits < casinoState.bet;
    casinoEls.spinBtn.disabled =
      casinoState.spinning || !casinoState.serverActive || !isCasinoNameSaved() || casinoState.credits === null || invalidBet || notEnough;

    casinoEls.statusText.textContent = casinoState.nameError
      ? casinoState.nameError
      : !currentName
        ? "Введите никнейм и сохраните, чтобы открыть кассу."
        : currentName !== savedName
          ? "Никнейм изменен. Нажмите «Сохранить ник»."
          : casinoState.serverActive && casinoState.clientIp
            ? `Ник привязан к IP ${casinoState.clientIp}.`
            : "Сервер кассы не подключен.";
  }

  function renderCasinoStats() {
    const credits = casinoState.credits === null ? "-" : formatCredits(casinoState.credits);
    casinoEls.credits.textContent = credits;
    casinoEls.creditsStat.textContent = credits;
    casinoEls.betStat.textContent = formatCredits(casinoState.bet);
    casinoEls.payoutStat.textContent = formatCredits(casinoState.lastPayout);
    casinoEls.spinResult.textContent = casinoState.spinText;
  }

  function renderCasinoReels() {
    if (!casinoEls.reels) return;
    casinoEls.reels.classList.toggle("is-spinning", casinoState.spinning);
    casinoEls.reels.innerHTML = casinoState.reels
      .slice(0, 3)
      .map((symbol) => `<span class="casino-reel">${escapeCasinoHtml(symbol)}</span>`)
      .join("");
  }

  function renderCasinoBets() {
    casinoEls.betButtons.forEach((button) => {
      const bet = Number(button.dataset.casinoBet);
      const active = bet === casinoState.bet;
      button.classList.toggle("is-ready", active);
      button.setAttribute("aria-pressed", String(active));
      button.disabled = casinoState.spinning || (casinoState.credits !== null && casinoState.credits < bet);
    });
    if (casinoEls.customBet) {
      casinoEls.customBet.min = String(casinoState.minBet || DEFAULT_MIN_BET);
      casinoEls.customBet.max = String(casinoState.maxBet || DEFAULT_MAX_BET);
      casinoEls.customBet.disabled = casinoState.spinning;
      if (document.activeElement !== casinoEls.customBet) {
        syncCasinoCustomBetInput();
      }
    }
  }

  function casinoCustomBetValue() {
    const value = Number(casinoEls.customBet?.value);
    if (!Number.isFinite(value)) return 0;
    return Math.floor(value);
  }

  function syncCasinoCustomBetInput() {
    if (!casinoEls.customBet) return;
    casinoEls.customBet.value = String(Math.max(0, Math.floor(Number(casinoState.bet) || 0)));
  }

  function isCasinoBetAllowed(bet) {
    const value = Math.floor(Number(bet) || 0);
    return value >= casinoState.minBet && value <= casinoState.maxBet;
  }

  function casinoBetHint() {
    return `Ставка от ${formatCredits(casinoState.minBet)} до ${formatCredits(casinoState.maxBet)}`;
  }

  function renderCasinoLeaderboard() {
    if (!casinoEls.leaderboard) return;
    if (casinoEls.leaderboardCount) casinoEls.leaderboardCount.textContent = String(casinoState.leaderboard.length);
    casinoEls.leaderboard.innerHTML = casinoState.leaderboard.length
      ? casinoState.leaderboard.map(casinoLeaderboardRow).join("")
      : '<li class="leaderboard-empty">Пока нет кредитных рекордов.</li>';
  }

  function casinoLeaderboardRow(item, index) {
    const meta = item.spins ? `${item.spins} круток` : "банк открыт";
    return `<li>
      ${casinoRankBadge(index)}
      <span>
        <span class="leaderboard-name">${escapeCasinoHtml(item.player)}</span>
        <span class="leaderboard-meta">${escapeCasinoHtml(meta)}</span>
      </span>
      <span class="leaderboard-time">${formatCredits(item.credits)}</span>
    </li>`;
  }

  function casinoRankBadge(index) {
    const rank = index + 1;
    if (rank === 1) return '<span class="leaderboard-rank is-podium" aria-label="1 место"><span class="leaderboard-rank-symbol" aria-hidden="true">🏆</span></span>';
    if (rank === 2) return '<span class="leaderboard-rank is-podium" aria-label="2 место"><span class="leaderboard-rank-symbol" aria-hidden="true">🥈</span></span>';
    if (rank === 3) return '<span class="leaderboard-rank is-podium" aria-label="3 место"><span class="leaderboard-rank-symbol" aria-hidden="true">🥉</span></span>';
    return `<span class="leaderboard-rank">${rank}</span>`;
  }

  function renderCasinoLog() {
    if (!casinoEls.log) return;
    casinoEls.logTitle.textContent = casinoState.spinning ? "Крутка" : "Крутки";
    casinoEls.log.innerHTML = casinoState.history.length
      ? casinoState.history.map(casinoLogRow).join("")
      : '<li class="tone-info">Здесь появится лог круток.</li>';
  }

  function casinoLogRow(item) {
    const tone = item.net > 0 ? "good" : item.net < 0 ? "bad" : "warn";
    const title = item.net > 0 ? `Выигрыш +${formatCredits(item.net)}` : item.net < 0 ? `Проигрыш ${formatCredits(Math.abs(item.net))}` : "Возврат ставки";
    const symbols = item.symbols.length ? item.symbols.join(" ") : "???";
    const meta = `${symbols} · ставка ${formatCredits(item.bet)} · выплата ${formatCredits(item.payout)} · баланс ${formatCredits(item.credits)}`;
    return `<li class="tone-${tone}"><strong>${escapeCasinoHtml(title)}</strong><span class="casino-log-meta">${escapeCasinoHtml(meta)}</span></li>`;
  }

  function formatCredits(value) {
    return new Intl.NumberFormat("ru-RU").format(Math.max(0, Math.floor(Number(value) || 0)));
  }

  function delay(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function escapeCasinoHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }
})();

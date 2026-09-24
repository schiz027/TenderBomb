(() => {
  const POLL_MS = 900;
  const NAME_REQUIRED_MESSAGE = "Введите никнейм и сохраните!";
  const NAME_TAKEN_MESSAGE = "Этот ник уже занят другим игроком.";
  const SERVER_OFFLINE_MESSAGE = "Сервер был отключен.";
  const COLORS = {
    white: "Белые",
    black: "Черные",
  };
  const BOT_LEVELS = {
    1: { label: "Легко", openingDepth: 2, midgameDepth: 3, endgameDepth: 4, randomTop: 4, randomChance: 0.4 },
    2: { label: "Нормально", openingDepth: 3, midgameDepth: 4, endgameDepth: 5, randomTop: 3, randomChance: 0.22 },
    3: { label: "Сложно", openingDepth: 4, midgameDepth: 5, endgameDepth: 6, randomTop: 2, randomChance: 0.1 },
    4: { label: "Hard", openingDepth: 5, midgameDepth: 6, endgameDepth: 7, randomTop: 1, randomChance: 0 },
    5: { label: "Эксперт", openingDepth: 6, midgameDepth: 7, endgameDepth: 8, randomTop: 1, randomChance: 0 },
  };

  const checkersEls = {};
  const checkersState = {
    clientId: "",
    isOpen: false,
    joined: false,
    mode: "multiplayer",
    status: "idle",
    game: null,
    selected: null,
    legalMoves: [],
    error: "",
    notice: "",
    serverNotice: "",
    pollId: null,
    clockId: null,
    botTimerId: null,
  };

  document.addEventListener("DOMContentLoaded", () => {
    cacheCheckersElements();
    if (!checkersEls.openBtn) return;
    checkersState.clientId = getCheckersClientId();
    syncCheckersName();
    bindCheckersControls();
    renderCheckers();
  });

  function cacheCheckersElements() {
    checkersEls.openBtn = document.querySelector("#openCheckersBtn");
    checkersEls.closeBtn = document.querySelector("#closeCheckersBtn");
    checkersEls.tenderView = document.querySelector("#tenderBombView");
    checkersEls.view = document.querySelector("#checkersView");
    checkersEls.badge = document.querySelector("#checkersBadge");
    checkersEls.name = document.querySelector("#playerName") || document.querySelector("#checkersName");
    checkersEls.saveNameBtn = document.querySelector("#saveCheckersNameBtn");
    checkersEls.botDifficulty = document.querySelector("#checkersBotDifficulty");
    checkersEls.botDifficultyValue = document.querySelector("#checkersBotDifficultyValue");
    checkersEls.singleplayerBtn = document.querySelector("#singleplayerCheckersBtn");
    checkersEls.joinBtn = document.querySelector("#joinCheckersBtn");
    checkersEls.leaveBtn = document.querySelector("#leaveCheckersBtn");
    checkersEls.statusText = document.querySelector("#checkersStatusText");
    checkersEls.lobbyTitle = document.querySelector("#checkersLobbyTitle");
    checkersEls.you = document.querySelector("#checkersYou");
    checkersEls.opponent = document.querySelector("#checkersOpponent");
    checkersEls.boardShell = document.querySelector(".checkers-board-shell");
    checkersEls.board = document.querySelector("#checkersBoard");
    checkersEls.white = document.querySelector("#checkersWhite");
    checkersEls.black = document.querySelector("#checkersBlack");
    checkersEls.resultBadge = document.querySelector("#checkersResultBadge");
    checkersEls.whiteClock = document.querySelector("#checkersWhiteClock");
    checkersEls.blackClock = document.querySelector("#checkersBlackClock");
    checkersEls.turnTitle = document.querySelector("#checkersTurnTitle");
    checkersEls.log = document.querySelector("#checkersLog");
  }

  function bindCheckersControls() {
    checkersEls.openBtn.addEventListener("click", openCheckers);
    if (checkersEls.closeBtn) checkersEls.closeBtn.addEventListener("click", closeCheckers);
    checkersEls.singleplayerBtn.addEventListener("click", startSingleplayerCheckers);
    checkersEls.joinBtn.addEventListener("click", handleCheckersJoin);
    checkersEls.leaveBtn.addEventListener("click", () => leaveCheckers());
    if (checkersEls.saveNameBtn) checkersEls.saveNameBtn.addEventListener("click", saveCheckersName);
    checkersEls.botDifficulty.addEventListener("input", renderBotDifficulty);
    window.addEventListener("tenderBombOpenHome", () => {
      if (checkersState.isOpen) closeCheckers();
    });
    window.addEventListener("tenderBombOpenTanks", hideCheckersForExternalGame);
    window.addEventListener("tenderBombOpenCasino", hideCheckersForExternalGame);
    window.addEventListener("tenderBombNameSaved", (event) => {
      const name = cleanCheckersName(event.detail?.name);
      if (!name) return;
      checkersEls.name.value = name;
      checkersState.error = "";
      if (checkersState.isOpen) renderCheckers();
    });
    window.addEventListener("resize", () => {
      if (checkersState.isOpen) renderCheckersBoard();
    });
    checkersEls.name.addEventListener("input", () => {
      const name = cleanCheckersName(checkersEls.name.value);
      const mainName = document.querySelector("#playerName");
      if (mainName) mainName.value = name;
      checkersState.notice = "";
      if (isCheckersNameSaved()) checkersState.error = "";
      renderCheckersStatus();
      renderCheckersPlayers();
      renderCheckersLog();
    });
    renderBotDifficulty();
  }

  async function openCheckers() {
    window.dispatchEvent(new CustomEvent("tenderBombOpenCheckers"));
    checkersState.isOpen = true;
    checkersEls.tenderView.hidden = true;
    checkersEls.view.hidden = false;
    syncCheckersName();
    startClockTick();
    renderCheckers();
    if (!requireSavedCheckersName()) return;
    if (window.location.protocol !== "file:") {
      await handleCheckersJoin();
    } else {
      checkersState.status = "offline";
      checkersState.error = "Для шашек нужен запущенный сервер.";
      renderCheckers();
    }
  }

  function hideCheckersForExternalGame() {
    if (!checkersState.isOpen) return;
    if (checkersState.joined || checkersState.game) {
      leaveCheckers({ keepOpen: false });
    }
    stopCheckersPolling();
    stopClockTick();
    stopBotTimer();
    checkersState.isOpen = false;
    checkersState.mode = "multiplayer";
    checkersState.status = "idle";
    checkersState.game = null;
    checkersState.selected = null;
    checkersState.legalMoves = [];
    checkersEls.view.hidden = true;
    renderCheckers();
  }

  async function closeCheckers() {
    if (checkersState.joined || checkersState.game) {
      await leaveCheckers({ keepOpen: false });
    }
    stopCheckersPolling();
    stopClockTick();
    stopBotTimer();
    checkersState.isOpen = false;
    checkersState.mode = "multiplayer";
    checkersState.status = "idle";
    checkersState.game = null;
    checkersState.selected = null;
    checkersState.legalMoves = [];
    checkersEls.view.hidden = true;
    checkersEls.tenderView.hidden = false;
    renderCheckers();
  }

  async function handleCheckersJoin() {
    if (!requireSavedCheckersName()) return;
    stopBotTimer();
    if (checkersState.mode === "singleplayer") {
      checkersState.mode = "multiplayer";
      checkersState.game = null;
      checkersState.selected = null;
      checkersState.legalMoves = [];
    }

    if (window.location.protocol === "file:") {
      checkersState.status = "offline";
      checkersState.error = "Открой игру через сервер, чтобы работал мультиплеер.";
      renderCheckers();
      return;
    }

    if (checkersState.game?.status === "finished") {
      await leaveCheckers({ keepOpen: true });
    }

    checkersState.error = checkersState.serverNotice || "";
    checkersState.notice = "";
    checkersState.joined = true;
    checkersState.mode = "multiplayer";
    renderCheckers();

    try {
      const data = await checkersPost("/api/checkers/join", checkersPayload());
      applyCheckersData(data);
      startCheckersPolling();
    } catch (error) {
      checkersState.status = "offline";
      checkersState.joined = false;
      checkersState.error = "Сервер шашек не ответил.";
      renderCheckers();
    }
  }

  async function leaveCheckers(options = {}) {
    stopCheckersPolling();
    stopBotTimer();
    try {
      if (checkersState.mode === "multiplayer" && window.location.protocol !== "file:") {
        await checkersPost("/api/checkers/leave", checkersPayload());
      }
    } catch (error) {
      checkersState.error = "Не получилось выйти с сервера, состояние обновится само.";
    }
    checkersState.joined = false;
    checkersState.mode = "multiplayer";
    checkersState.status = "idle";
    checkersState.game = null;
    checkersState.selected = null;
    checkersState.legalMoves = [];
    if (options.keepOpen !== false) renderCheckers();
  }

  function startCheckersPolling() {
    stopCheckersPolling();
    checkersState.pollId = window.setInterval(pollCheckers, POLL_MS);
  }

  function stopCheckersPolling() {
    if (checkersState.pollId) {
      window.clearInterval(checkersState.pollId);
      checkersState.pollId = null;
    }
  }

  function startClockTick() {
    stopClockTick();
    checkersState.clockId = window.setInterval(renderCheckersClocks, 500);
  }

  function stopClockTick() {
    if (checkersState.clockId) {
      window.clearInterval(checkersState.clockId);
      checkersState.clockId = null;
    }
  }

  function stopBotTimer() {
    if (checkersState.botTimerId) {
      window.clearTimeout(checkersState.botTimerId);
      checkersState.botTimerId = null;
    }
  }

  async function pollCheckers() {
    if (!checkersState.isOpen || !checkersState.joined) return;
    try {
      const params = new URLSearchParams({
        client_id: checkersState.clientId,
        player: getSavedCheckersName(),
      });
      const data = await checkersGet(`/api/checkers/state?${params}`);
      applyCheckersData(data);
    } catch (error) {
      checkersState.status = "offline";
      checkersState.error = SERVER_OFFLINE_MESSAGE;
      checkersState.serverNotice = SERVER_OFFLINE_MESSAGE;
      checkersState.joined = false;
      stopCheckersPolling();
      window.TenderBombNotice?.show(SERVER_OFFLINE_MESSAGE);
      renderCheckers();
    }
  }

  function applyCheckersData(data) {
    if (!data) return;
    applyCheckersServerNotice(data);
    if (data.ok === false) {
      checkersState.error = checkersErrorText(data.error);
      if (data.game) {
        data.game.received_at = Date.now();
        checkersState.game = data.game;
      }
      renderCheckers();
      return;
    }
    checkersState.status = data.status || "idle";
    if (data.game) data.game.received_at = Date.now();
    checkersState.game = data.game || null;
    checkersState.error = "";
    if (checkersState.game?.status !== "playing") {
      checkersState.selected = null;
      checkersState.legalMoves = [];
    }
    renderCheckers();
  }

  function applyCheckersServerNotice(data) {
    const notice = String(data?.server_notice || "").trim();
    if (notice && notice !== checkersState.serverNotice) {
      checkersState.serverNotice = notice;
      checkersState.error = notice;
      window.TenderBombNotice?.show(notice);
    } else if (!notice && checkersState.serverNotice) {
      checkersState.serverNotice = "";
    }
  }

  async function startSingleplayerCheckers() {
    if (!requireSavedCheckersName()) return;
    if (checkersState.mode === "multiplayer" && (checkersState.joined || checkersState.game)) {
      await leaveCheckers({ keepOpen: false });
    }
    stopCheckersPolling();
    stopBotTimer();
    checkersState.mode = "singleplayer";
    checkersState.joined = false;
    checkersState.status = "playing";
    checkersState.selected = null;
    checkersState.legalMoves = [];
    checkersState.error = "";
    checkersState.notice = "";
    checkersState.game = createSingleplayerGame(getSavedCheckersName(), getBotDifficulty());
    renderCheckers();
  }

  function createSingleplayerGame(playerName, difficulty) {
    const botProfile = BOT_LEVELS[difficulty] || BOT_LEVELS[3];
    return {
      id: `single-${Date.now()}`,
      status: "playing",
      players: {
        white: { name: playerName },
        black: { name: `Бот ${botProfile.label}` },
      },
      botDifficulty: difficulty,
      you: "white",
      opponent: "black",
      board: createPreviewCheckersBoard(),
      turn: "white",
      winner: null,
      reason: null,
      must_continue_from: null,
      last_move: null,
      clocks: { white: 0, black: 0 },
      turn_started_at: Date.now(),
      creditSubmitted: false,
      log: [{ tone: "info", text: `Одиночная партия: ты играешь белыми против бота ${botProfile.label}.` }],
    };
  }

  async function moveCheckersPiece(from, to) {
    if (checkersState.mode === "singleplayer") {
      moveSingleplayerPiece(from, to);
      return;
    }

    try {
      const data = await checkersPost("/api/checkers/move", {
        ...checkersPayload(),
        game_id: checkersState.game?.id,
        from,
        to,
      });
      checkersState.selected = null;
      checkersState.legalMoves = [];
      applyCheckersData(data);
    } catch (error) {
      checkersState.error = "Ход не дошел до сервера.";
      renderCheckers();
    }
  }

  function moveSingleplayerPiece(from, to) {
    const game = checkersState.game;
    if (!game || game.status !== "playing" || game.turn !== game.you) return;

    const move = findLegalMove(game, from, to);
    if (!move) {
      checkersState.error = "Такой ход сейчас невозможен.";
      renderCheckers();
      return;
    }

    applyLocalMove(game, move, game.players[game.you].name);
    checkersState.selected = null;
    checkersState.legalMoves = [];
    checkersState.error = "";
    renderCheckers();

    if (game.status === "playing" && game.turn === game.opponent) {
      scheduleBotMove();
    }
  }

  function findLegalMove(game, from, to) {
    const moves =
      game.must_continue_from !== null
        ? captureMovesForPiece(game.board, game.must_continue_from)
        : allLegalMovesForColor(game.board, game.turn);
    return moves.find((move) => move.from === from && move.to === to) || null;
  }

  function applyLocalMove(game, move, playerName) {
    commitLocalClock(game);
    const piece = game.board[move.from];
    game.board[move.to] = piece;
    game.board[move.from] = null;
    if (move.capture !== null) game.board[move.capture] = null;
    promoteLocalPiece(piece, move.to);

    const separator = move.capture !== null ? "x" : "-";
    game.last_move = { from: move.from, to: move.to, capture: move.capture };
    game.log.unshift({
      tone: "info",
      text: `${playerName}: ${checkersCoord(move.from)}${separator}${checkersCoord(move.to)}`,
    });
    game.log = game.log.slice(0, 16);

    const nextCaptures = move.capture !== null ? captureMovesForPiece(game.board, move.to) : [];
    if (nextCaptures.length) {
      game.must_continue_from = move.to;
      game.turn_started_at = Date.now();
    } else {
      game.must_continue_from = null;
      game.turn = game.turn === "white" ? "black" : "white";
      game.turn_started_at = Date.now();
    }

    resolveLocalWinner(game);
  }

  function commitLocalClock(game) {
    if (!game || game.status !== "playing" || !game.turn) return;
    const now = Date.now();
    game.clocks[game.turn] = (Number(game.clocks[game.turn]) || 0) + Math.max(0, now - (game.turn_started_at || now));
    game.turn_started_at = now;
  }

  function promoteLocalPiece(piece, toIndex) {
    const row = Math.floor(toIndex / 8);
    if (piece.color === "white" && row === 0) piece.king = true;
    if (piece.color === "black" && row === 7) piece.king = true;
  }

  function resolveLocalWinner(game) {
    const whiteCount = game.board.filter((piece) => piece?.color === "white").length;
    const blackCount = game.board.filter((piece) => piece?.color === "black").length;
    if (whiteCount === 0) {
      finishLocalGame(game, "black", "no_pieces");
      return;
    }
    if (blackCount === 0) {
      finishLocalGame(game, "white", "no_pieces");
      return;
    }
    if (!allLegalMovesForColor(game.board, game.turn, game.must_continue_from).length) {
      finishLocalGame(game, game.turn === "white" ? "black" : "white", "no_moves");
    }
  }

  function finishLocalGame(game, winner, reason) {
    if (game.status === "finished") return;
    commitLocalClock(game);
    game.status = "finished";
    game.winner = winner;
    game.reason = reason;
    game.must_continue_from = null;
    const won = winner === game.you;
    game.log.unshift({ tone: won ? "good" : "bad", text: won ? "Победа!" : `Победа: ${game.players[winner].name}.` });
    game.log = game.log.slice(0, 16);
    if (won) submitSingleplayerCheckersReward(game);
  }

  async function submitSingleplayerCheckersReward(game) {
    if (!game || game.creditSubmitted || window.location.protocol === "file:") return;
    game.creditSubmitted = true;
    try {
      const data = await checkersPost("/api/checkers/singleplayer-result", {
        ...checkersPayload(),
        result_id: game.id,
        difficulty: game.botDifficulty,
        status: "won",
      });
      applyCheckersServerNotice(data);
      const reward = data?.result?.credit_reward;
      const amount = Number(reward?.amount) || 0;
      const credits = Number(reward?.credits) || 0;
      if (amount > 0) {
        game.log.unshift({
          tone: "good",
          text: `Кредиты начислены: +${formatCheckersCredits(amount)}. Баланс: ${formatCheckersCredits(credits)}.`,
        });
        game.log = game.log.slice(0, 16);
      }
      renderCheckers();
    } catch (error) {
      game.log.unshift({ tone: "warn", text: "Кредиты за победу не начислены: сервер не ответил." });
      game.log = game.log.slice(0, 16);
      renderCheckers();
    }
  }

  function scheduleBotMove() {
    stopBotTimer();
    checkersState.botTimerId = window.setTimeout(makeBotMove, 520);
  }

  function makeBotMove() {
    const game = checkersState.game;
    if (checkersState.mode !== "singleplayer" || !game || game.status !== "playing" || game.turn !== game.opponent) {
      return;
    }

    const move = chooseBotMove(game);
    if (!move) {
      finishLocalGame(game, game.you, "no_moves");
      renderCheckers();
      return;
    }

    applyLocalMove(game, move, game.players[game.opponent].name);
    checkersState.error = "";
    renderCheckers();

    if (game.status === "playing" && game.turn === game.opponent) {
      scheduleBotMove();
    }
  }

  function chooseBotMove(game) {
    const moves = orderedBotMoves(allLegalMovesForColor(game.board, game.turn, game.must_continue_from), game.board);
    if (!moves.length) return null;

    const piecesLeft = game.board.filter(Boolean).length;
    const profile = BOT_LEVELS[game.botDifficulty] || BOT_LEVELS[3];
    const depth = piecesLeft <= 8 ? profile.endgameDepth : piecesLeft <= 14 ? profile.midgameDepth : profile.openingDepth;
    const scoredMoves = [];

    moves.forEach((move) => {
      const next = simulateBotMove(game.board, game.turn, move);
      const score = minimaxCheckers(next.board, next.turn, next.must_continue_from, depth - 1, -Infinity, Infinity);
      scoredMoves.push({ move, score });
    });

    scoredMoves.sort((a, b) => b.score - a.score);
    if (profile.randomTop > 1 && Math.random() < profile.randomChance) {
      const pool = scoredMoves.slice(0, Math.min(profile.randomTop, scoredMoves.length));
      return pool[Math.floor(Math.random() * pool.length)].move;
    }

    const bestScore = scoredMoves[0].score;
    const bestMoves = scoredMoves.filter((item) => Math.abs(item.score - bestScore) <= 0.001);
    return bestMoves[Math.floor(Math.random() * bestMoves.length)].move;
  }

  function minimaxCheckers(board, turn, mustContinueFrom, depth, alpha, beta) {
    const winner = terminalCheckersWinner(board, turn, mustContinueFrom);
    if (winner) return winner === "black" ? 100000 + depth : -100000 - depth;
    if (depth <= 0) return evaluateCheckersBoard(board);

    const moves = orderedBotMoves(allLegalMovesForColor(board, turn, mustContinueFrom), board);
    if (!moves.length) return turn === "black" ? -100000 - depth : 100000 + depth;

    if (turn === "black") {
      let value = -Infinity;
      for (const move of moves) {
        const next = simulateBotMove(board, turn, move);
        value = Math.max(value, minimaxCheckers(next.board, next.turn, next.must_continue_from, depth - 1, alpha, beta));
        alpha = Math.max(alpha, value);
        if (alpha >= beta) break;
      }
      return value;
    }

    let value = Infinity;
    for (const move of moves) {
      const next = simulateBotMove(board, turn, move);
      value = Math.min(value, minimaxCheckers(next.board, next.turn, next.must_continue_from, depth - 1, alpha, beta));
      beta = Math.min(beta, value);
      if (alpha >= beta) break;
    }
    return value;
  }

  function terminalCheckersWinner(board, turn, mustContinueFrom) {
    const whiteCount = board.filter((piece) => piece?.color === "white").length;
    const blackCount = board.filter((piece) => piece?.color === "black").length;
    if (whiteCount === 0) return "black";
    if (blackCount === 0) return "white";
    if (!allLegalMovesForColor(board, turn, mustContinueFrom).length) {
      return turn === "white" ? "black" : "white";
    }
    return null;
  }

  function evaluateCheckersBoard(board) {
    let score = 0;
    board.forEach((piece, index) => {
      if (!piece) return;
      const row = Math.floor(index / 8);
      const col = index % 8;
      const center = col >= 2 && col <= 5 && row >= 2 && row <= 5 ? 10 : 0;
      const edgePenalty = col === 0 || col === 7 ? -5 : 0;
      const advancement = piece.color === "black" ? row * 5 : (7 - row) * 5;
      const value = (piece.king ? 180 : 100) + advancement + center + edgePenalty;
      score += piece.color === "black" ? value : -value;
    });

    const blackMoves = allLegalMovesForColor(board, "black").length;
    const whiteMoves = allLegalMovesForColor(board, "white").length;
    return score + (blackMoves - whiteMoves) * 4;
  }

  function orderedBotMoves(moves, board) {
    return [...moves].sort((a, b) => movePriority(b, board) - movePriority(a, board));
  }

  function movePriority(move, board) {
    const piece = board[move.from];
    if (!piece) return 0;
    const toRow = Math.floor(move.to / 8);
    const promotes = !piece.king && ((piece.color === "black" && toRow === 7) || (piece.color === "white" && toRow === 0));
    return (move.capture !== null ? 100 : 0) + (promotes ? 35 : 0) + (piece.king ? 8 : 0);
  }

  function simulateBotMove(board, turn, move) {
    const nextBoard = cloneCheckersBoard(board);
    const piece = nextBoard[move.from];
    nextBoard[move.to] = piece;
    nextBoard[move.from] = null;
    if (move.capture !== null) nextBoard[move.capture] = null;
    promoteLocalPiece(piece, move.to);

    const nextCaptures = move.capture !== null ? captureMovesForPiece(nextBoard, move.to) : [];
    if (nextCaptures.length) {
      return { board: nextBoard, turn, must_continue_from: move.to };
    }
    return { board: nextBoard, turn: turn === "white" ? "black" : "white", must_continue_from: null };
  }

  function cloneCheckersBoard(board) {
    return board.map((piece) => (piece ? { color: piece.color, king: Boolean(piece.king) } : null));
  }

  function handleCheckersCell(index) {
    const game = checkersState.game;
    if (!game || game.status !== "playing" || game.you !== game.turn) return;
    const board = game.board || [];
    const piece = board[index];

    if (checkersState.selected !== null) {
      const move = checkersState.legalMoves.find((item) => item.to === index);
      if (move) {
        moveCheckersPiece(checkersState.selected, index);
        return;
      }
    }

    if (piece?.color === game.you) {
      if (game.must_continue_from !== null && game.must_continue_from !== index) return;
      const legalMoves = legalCheckersMovesForPiece(board, index, game.you, game.must_continue_from);
      checkersState.selected = legalMoves.length ? index : null;
      checkersState.legalMoves = legalMoves;
      renderCheckersBoard();
    }
  }

  function renderCheckers() {
    if (!checkersEls.view) return;
    renderCheckersStatus();
    renderCheckersPlayers();
    renderCheckersClocks();
    renderCheckersBoard();
    renderCheckersLog();
  }

  function renderCheckersStatus() {
    const game = checkersState.game;
    const status = game?.status || checkersState.status;
    const isPlaying = status === "playing";
    const isWaiting = status === "waiting";
    const isFinished = status === "finished";
    const isSingleplayer = checkersState.mode === "singleplayer";

    checkersEls.badge.textContent = checkersBadgeText(status, game);
    checkersEls.lobbyTitle.textContent = isSingleplayer
      ? isFinished
        ? "Одиночная партия завершена"
        : "Одиночная партия"
      : isPlaying
      ? "Партия идет"
      : isWaiting
        ? "Ждем второго игрока"
        : isFinished
          ? "Партия завершена"
          : "Вход в партию";

    checkersEls.statusText.textContent = checkersStatusText(status, game);
    checkersEls.turnTitle.textContent = checkersTurnText(status, game);
    checkersEls.name.classList.toggle("is-invalid", Boolean(checkersState.error));

    checkersEls.singleplayerBtn.disabled = false;
    checkersEls.singleplayerBtn.textContent = "Старт одиночный режим";
    checkersEls.joinBtn.disabled = isWaiting || isPlaying || isSingleplayer;
    checkersEls.joinBtn.textContent = isFinished && !isSingleplayer
      ? "Новая партия"
      : isWaiting
        ? "В лобби (мультиплеер)"
        : isPlaying
          ? "Идет партия"
          : "Войти в лобби (мультиплеер)";
    checkersEls.leaveBtn.disabled = status === "idle" || status === "offline";

    renderCheckersResultBadge(status, game);
    checkersEls.white.classList.toggle("is-turn", game?.turn === "white" && isPlaying);
    checkersEls.black.classList.toggle("is-turn", game?.turn === "black" && isPlaying);
  }

  function renderCheckersResultBadge(status, game) {
    const badge = checkersEls.resultBadge;
    if (!badge) return;

    badge.classList.remove("is-win", "is-loose");
    if (status !== "finished" || !game?.winner || !game?.you) {
      badge.hidden = true;
      badge.textContent = "";
      return;
    }

    const won = game.winner === game.you;
    badge.hidden = false;
    badge.textContent = won ? "WIN" : "LOOSE";
    badge.classList.add(won ? "is-win" : "is-loose");
  }

  function renderCheckersPlayers() {
    const game = checkersState.game;
    const youName = getSavedCheckersName() || getCheckersName();
    const youLabel = game?.you ? `${COLORS[game.you]}: ${game.players[game.you]?.name || youName}` : youName;
    const opponentLabel = game?.opponent
      ? `${COLORS[game.opponent]}: ${game.players[game.opponent]?.name || "-"}`
      : checkersState.status === "waiting"
        ? "ожидание"
        : "-";

    checkersEls.you.querySelector("strong").textContent = youLabel;
    checkersEls.opponent.querySelector("strong").textContent = opponentLabel;
  }

  function renderCheckersClocks() {
    const game = checkersState.game;
    const status = game?.status || checkersState.status;
    const clocks = currentCheckersClocks(game);
    const isPlaying = status === "playing";

    checkersEls.whiteClock.querySelector("strong").textContent = formatCheckersClock(clocks.white);
    checkersEls.blackClock.querySelector("strong").textContent = formatCheckersClock(clocks.black);
    checkersEls.whiteClock.classList.toggle("is-turn", isPlaying && game?.turn === "white");
    checkersEls.blackClock.classList.toggle("is-turn", isPlaying && game?.turn === "black");
  }

  function currentCheckersClocks(game) {
    const base = {
      white: Number(game?.clocks?.white) || 0,
      black: Number(game?.clocks?.black) || 0,
    };
    if (!game || game.status !== "playing" || !game.turn) return base;

    if (checkersState.mode === "singleplayer") {
      const startedAt = Number(game.turn_started_at) || Date.now();
      base[game.turn] += Math.max(0, Date.now() - startedAt);
      return base;
    }

    const receivedAt = Number(game.received_at) || Date.now();
    base[game.turn] += Math.max(0, Date.now() - receivedAt);
    return base;
  }

  function checkersDisplayIndexes(game) {
    const indexes = Array.from({ length: 64 }, (_, index) => index);
    return game?.you === "black" ? indexes.reverse() : indexes;
  }

  function renderCheckersBoard() {
    const game = checkersState.game;
    const board = game?.board || createPreviewCheckersBoard();
    const legalTargets = new Set(checkersState.legalMoves.map((move) => move.to));
    const canMove = game?.status === "playing" && game.you === game.turn;
    updateCheckersBoardSize();

    checkersEls.board.innerHTML = checkersDisplayIndexes(game)
      .map((index) => {
        const piece = board[index];
        const row = Math.floor(index / 8);
        const col = index % 8;
        const playable = isCheckersPlayable(row, col);
        const classes = ["checker-cell", playable ? "checker-dark" : "checker-light"];
        if (index === checkersState.selected) classes.push("is-selected");
        if (legalTargets.has(index)) classes.push("is-legal");
        const content = piece ? checkerPieceTemplate(piece) : "";
        const label = checkerCellLabel(index, piece, playable);

        if (!playable) {
          return `<span class="${classes.join(" ")}" aria-hidden="true"></span>`;
        }

        return `<button class="${classes.join(" ")}" type="button" data-index="${index}" aria-label="${label}" ${
          canMove ? "" : "tabindex=\"-1\""
        }>${content}</button>`;
      })
      .join("");

    checkersEls.board.querySelectorAll("button.checker-cell").forEach((button) => {
      button.addEventListener("click", () => handleCheckersCell(Number(button.dataset.index)));
    });
  }

  function updateCheckersBoardSize() {
    const shell = checkersEls.boardShell;
    if (!shell) return;
    const styles = window.getComputedStyle(shell);
    const paddingX = parseFloat(styles.paddingLeft) + parseFloat(styles.paddingRight);
    const paddingY = parseFloat(styles.paddingTop) + parseFloat(styles.paddingBottom);
    const availableWidth = shell.clientWidth - paddingX;
    const availableHeight = shell.clientHeight - paddingY;
    const size = Math.max(180, Math.floor(Math.min(520, availableWidth, availableHeight)));
    checkersEls.board.style.setProperty("--checkers-board-size", `${size}px`);
  }

  function renderCheckersLog() {
    const game = checkersState.game;
    const rows = [];
    if (checkersState.error) {
      rows.push({ tone: "warn", text: checkersState.error });
    } else if (checkersState.notice) {
      rows.push({ tone: "good", text: checkersState.notice });
    }
    if (game?.log?.length) {
      rows.push(...game.log);
    } else {
      rows.push({ tone: "info", text: checkersStatusText(checkersState.status, game) });
    }

    checkersEls.log.innerHTML = rows
      .slice(0, 12)
      .map((item) => `<li class="tone-${item.tone || "info"}">${escapeCheckersHtml(item.text)}</li>`)
      .join("");
  }

  function checkersBadgeText(status, game) {
    if (status === "offline") return "OFFLINE";
    if (status === "waiting") return "LOBBY";
    if (status === "playing" && checkersState.mode === "singleplayer") {
      return game?.you === game?.turn ? "ТВОЙ ХОД" : "БОТ ДУМАЕТ";
    }
    if (status === "playing") return game?.you === game?.turn ? "ТВОЙ ХОД" : "ХОД СОПЕРНИКА";
    if (status === "finished") return game?.winner === game?.you ? "ПОБЕДА" : "ФИНИШ";
    return "BETA";
  }

  function checkersStatusText(status, game) {
    if (checkersState.error) return checkersState.error;
    if (checkersState.notice) return checkersState.notice;
    if (status === "offline") return "Запусти сервер, чтобы открыть лобби и играть с другим участником.";
    if (status === "waiting") return "Лобби создано. Партия начнется, когда зайдет второй игрок.";
    if (status === "playing") {
      if (game.must_continue_from !== null && game.you === game.turn) return "Нужно продолжить взятие этой же шашкой.";
      if (checkersState.mode === "singleplayer" && game.you !== game.turn) return "Бот думает.";
      return game.you === game.turn ? "Твой ход." : "Ждем ход соперника.";
    }
    if (status === "finished") {
      return game.winner === game.you ? "Партия за тобой." : "Партия завершена.";
    }
    return "Нажми вход, чтобы сервер подобрал второго игрока.";
  }

  function checkersTurnText(status, game) {
    if (status === "waiting") return "Ожидание";
    if (status === "playing" && checkersState.mode === "singleplayer" && game.you !== game.turn) return "Бот думает";
    if (status === "playing") return game.you === game.turn ? "Твой ход" : `Ход: ${COLORS[game.turn]}`;
    if (status === "finished") return game.winner ? `Победа: ${COLORS[game.winner]}` : "Финиш";
    return "Ожидание";
  }

  function checkerPieceTemplate(piece) {
    const classes = ["checker-piece", `checker-piece-${piece.color}`];
    if (piece.king) classes.push("is-king");
    return `<span class="${classes.join(" ")}"></span>`;
  }

  function checkerCellLabel(index, piece, playable) {
    if (!playable) return "";
    const coord = checkersCoord(index);
    if (!piece) return `Пустая клетка ${coord}`;
    const rank = piece.king ? "дамка" : "шашка";
    return `${COLORS[piece.color]}: ${rank} ${coord}`;
  }

  function legalCheckersMovesForPiece(board, index, color, mustContinueFrom) {
    if (mustContinueFrom !== null) {
      return captureMovesForPiece(board, index);
    }
    const captures = captureMovesForColor(board, color);
    if (captures.length) return captures.filter((move) => move.from === index);
    return simpleMovesForPiece(board, index);
  }

  function allLegalMovesForColor(board, color, mustContinueFrom = null) {
    if (mustContinueFrom !== null) {
      return captureMovesForPiece(board, mustContinueFrom);
    }
    const captures = captureMovesForColor(board, color);
    if (captures.length) return captures;

    const moves = [];
    board.forEach((piece, index) => {
      if (piece?.color === color) moves.push(...simpleMovesForPiece(board, index));
    });
    return moves;
  }

  function captureMovesForColor(board, color) {
    const moves = [];
    board.forEach((piece, index) => {
      if (piece?.color === color) moves.push(...captureMovesForPiece(board, index));
    });
    return moves;
  }

  function captureMovesForPiece(board, index) {
    const piece = board[index];
    if (!piece) return [];
    const row = Math.floor(index / 8);
    const col = index % 8;
    const opponent = piece.color === "white" ? "black" : "white";
    const moves = [];
    const dirs = [
      [-1, -1],
      [-1, 1],
      [1, -1],
      [1, 1],
    ];

    if (piece.king) {
      dirs.forEach(([rowDelta, colDelta]) => {
        let capturedIndex = null;
        let step = 1;

        while (true) {
          const scanRow = row + rowDelta * step;
          const scanCol = col + colDelta * step;
          if (!isCheckersPlayable(scanRow, scanCol)) break;

          const scanIndex = scanRow * 8 + scanCol;
          const scanPiece = board[scanIndex];

          if (capturedIndex === null) {
            if (!scanPiece) {
              step += 1;
              continue;
            }
            if (scanPiece.color === piece.color) break;
            capturedIndex = scanIndex;
            step += 1;
            continue;
          }

          if (scanPiece) break;
          moves.push({ from: index, to: scanIndex, capture: capturedIndex });
          step += 1;
        }
      });
      return moves;
    }

    dirs.forEach(([rowDelta, colDelta]) => {
      const midRow = row + rowDelta;
      const midCol = col + colDelta;
      const toRow = row + rowDelta * 2;
      const toCol = col + colDelta * 2;
      if (!isCheckersPlayable(toRow, toCol)) return;
      const middleIndex = midRow * 8 + midCol;
      const toIndex = toRow * 8 + toCol;
      if (board[middleIndex]?.color === opponent && !board[toIndex]) {
        moves.push({ from: index, to: toIndex, capture: middleIndex });
      }
    });
    return moves;
  }

  function simpleMovesForPiece(board, index) {
    const piece = board[index];
    if (!piece) return [];
    const row = Math.floor(index / 8);
    const col = index % 8;
    const dirs = piece.king
      ? [
          [-1, -1],
          [-1, 1],
          [1, -1],
          [1, 1],
        ]
      : piece.color === "white"
        ? [
            [-1, -1],
            [-1, 1],
          ]
        : [
            [1, -1],
            [1, 1],
          ];

    if (piece.king) {
      const moves = [];
      dirs.forEach(([rowDelta, colDelta]) => {
        let step = 1;
        while (true) {
          const toRow = row + rowDelta * step;
          const toCol = col + colDelta * step;
          if (!isCheckersPlayable(toRow, toCol)) break;

          const toIndex = toRow * 8 + toCol;
          if (board[toIndex]) break;

          moves.push({ from: index, to: toIndex, capture: null });
          step += 1;
        }
      });
      return moves;
    }

    return dirs
      .map(([rowDelta, colDelta]) => [row + rowDelta, col + colDelta])
      .filter(([toRow, toCol]) => isCheckersPlayable(toRow, toCol))
      .map(([toRow, toCol]) => toRow * 8 + toCol)
      .filter((toIndex) => !board[toIndex])
      .map((toIndex) => ({ from: index, to: toIndex, capture: null }));
  }

  function createPreviewCheckersBoard() {
    const board = Array.from({ length: 64 }, () => null);
    for (let row = 0; row < 3; row += 1) {
      for (let col = 0; col < 8; col += 1) {
        if (isCheckersPlayable(row, col)) board[row * 8 + col] = { color: "black", king: false };
      }
    }
    for (let row = 5; row < 8; row += 1) {
      for (let col = 0; col < 8; col += 1) {
        if (isCheckersPlayable(row, col)) board[row * 8 + col] = { color: "white", king: false };
      }
    }
    return board;
  }

  function isCheckersPlayable(row, col) {
    return row >= 0 && row < 8 && col >= 0 && col < 8 && (row + col) % 2 === 1;
  }

  function checkersCoord(index) {
    const row = Math.floor(index / 8);
    const col = index % 8;
    return `${String.fromCharCode(97 + col)}${8 - row}`;
  }

  function checkersPayload() {
    return {
      client_id: checkersState.clientId,
      player: getSavedCheckersName(),
    };
  }

  function getBotDifficulty() {
    const value = Number(checkersEls.botDifficulty?.value) || 3;
    return Math.max(1, Math.min(5, value));
  }

  function renderBotDifficulty() {
    const level = BOT_LEVELS[getBotDifficulty()] || BOT_LEVELS[3];
    if (checkersEls.botDifficultyValue) {
      checkersEls.botDifficultyValue.textContent = level.label;
    }
  }

  function formatCheckersClock(ms) {
    const totalSeconds = Math.floor(Math.max(0, Number(ms) || 0) / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours > 0) {
      return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
    }
    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  function formatCheckersCredits(value) {
    return new Intl.NumberFormat("ru-RU").format(Math.max(0, Math.floor(Number(value) || 0)));
  }

  function syncCheckersName() {
    if (checkersEls.name?.id === "playerName") return;
    const mainName = document.querySelector("#playerName")?.value;
    const stored = window.localStorage.getItem("tenderBombPlayerName");
    const current = checkersEls.name.value;
    checkersEls.name.value = cleanCheckersName(stored || mainName || current);
  }

  function syncMainPlayerName(name) {
    const mainName = document.querySelector("#playerName");
    if (mainName && mainName !== checkersEls.name) mainName.value = name;
  }

  function getCheckersName() {
    const name = cleanCheckersName(checkersEls.name.value);
    checkersEls.name.value = name;
    return name;
  }

  function cleanCheckersName(value) {
    return String(value || "").trim().slice(0, 32);
  }

  function getSavedCheckersName() {
    return cleanCheckersName(window.localStorage.getItem("tenderBombPlayerName"));
  }

  function isCheckersNameSaved() {
    const current = cleanCheckersName(checkersEls.name.value);
    return Boolean(current && current === getSavedCheckersName());
  }

  function requireSavedCheckersName() {
    if (isCheckersNameSaved()) {
      checkersState.error = "";
      renderCheckers();
      return true;
    }
    checkersState.error = NAME_REQUIRED_MESSAGE;
    checkersState.notice = "";
    checkersEls.name.classList.add("is-invalid");
    renderCheckers();
    checkersEls.name.focus({ preventScroll: true });
    return false;
  }

  async function saveCheckersName() {
    const name = getCheckersName();
    if (!name) {
      checkersState.error = NAME_REQUIRED_MESSAGE;
      checkersState.notice = "";
      renderCheckers();
      checkersEls.name.focus({ preventScroll: true });
      return false;
    }

    window.localStorage.setItem("tenderBombPlayerName", name);
    syncMainPlayerName(name);
    checkersState.error = "";
    checkersState.notice = "Ник сохранен. Можно начинать.";
    window.dispatchEvent(new CustomEvent("tenderBombNameSaved", { detail: { name } }));

    if (window.location.protocol !== "file:") {
      try {
        const data = await checkersPost("/api/profile", { player: name });
        if (data.ok === false) {
          checkersState.error = checkersErrorText(data.error);
          checkersState.notice = "";
          if (data.player) {
            checkersEls.name.value = data.player;
            window.localStorage.setItem("tenderBombPlayerName", data.player);
            syncMainPlayerName(data.player);
          } else {
            window.localStorage.removeItem("tenderBombPlayerName");
          }
          renderCheckers();
          return false;
        }
      } catch (error) {
        checkersState.notice = "Ник сохранен в браузере. Сервер обновится позже.";
      }
    }

    renderCheckers();
    return true;
  }

  function getCheckersClientId() {
    const existing = window.sessionStorage.getItem("tenderBombCheckersClientId");
    if (existing) return existing;
    const created = window.crypto?.randomUUID?.() || `checkers-${Date.now()}-${Math.random()}`;
    window.sessionStorage.setItem("tenderBombCheckersClientId", created);
    return created;
  }

  async function checkersGet(url) {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  async function checkersPost(url, payload) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  function checkersErrorText(error) {
    const labels = {
      bad_move: "Сервер не понял ход.",
      bad_piece: "Этой шашкой ходить нельзя.",
      invalid_player: NAME_REQUIRED_MESSAGE,
      name_taken: NAME_TAKEN_MESSAGE,
      game_not_found: "Партия уже не найдена.",
      illegal_move: "Такой ход сейчас невозможен.",
      must_continue: "Нужно продолжить взятие выбранной шашкой.",
      not_your_turn: "Сейчас ход соперника.",
    };
    return labels[error] || "Ход не принят.";
  }

  function escapeCheckersHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }
})();

from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse
import json
import os
import secrets
import socket
import subprocess
import sys
import threading
import time
import uuid


MODE_RULES = {
    "express": {"active": 64, "mines": 10, "min_win_seconds": 6},
    "state": {"active": 128, "mines": 22, "min_win_seconds": 18},
    "registry": {"active": 256, "mines": 48, "min_win_seconds": 45},
}
SAPPER_CREDIT_REWARDS = {
    "express": 500,
    "state": 1000,
    "registry": 2000,
}
MODES = set(MODE_RULES)
TANKS_MODE = "tanks"
CASINO_MODE = "casino"
RECORD_MODES = MODES | {TANKS_MODE, CASINO_MODE}
TANKS_CREDIT_DIVISOR = 50
TANKS_CREDIT_CAP = 1200
CHECKERS_CREDIT_REWARD = 1000
CHECKERS_CREDIT_REASONS = {"no_pieces", "no_moves"}
CASINO_STARTING_CREDITS = 1000
CASINO_PRESET_BETS = {10, 25, 50, 100, 250}
CASINO_MIN_BET = 1
CASINO_MAX_BET = 10_000
CASINO_HISTORY_LIMIT = 12
CASINO_SYMBOLS = [
    {"symbol": "🍒", "weight": 28, "two": 1, "three": 5},
    {"symbol": "🍋", "weight": 24, "two": 1, "three": 6},
    {"symbol": "🍇", "weight": 20, "two": 2, "three": 8},
    {"symbol": "🔔", "weight": 14, "two": 2, "three": 12},
    {"symbol": "⭐", "weight": 9, "two": 3, "three": 18},
    {"symbol": "💎", "weight": 5, "two": 5, "three": 35},
]
LOCK = threading.Lock()
RECORDS_PATH = Path(__file__).resolve().with_name("leaderboard-records.json")
LEADERBOARD_CACHE_PATH = Path(__file__).resolve().with_name("leaderboard-cache.js")
SERVER_NOTICE_PATH = Path(__file__).resolve().with_name(".server-notice.json")
STATE = {"records": {mode: {} for mode in RECORD_MODES}, "profiles": {}}
SERVER_CONTROL = {"server": None, "restart": False, "stealth": False, "notice": "", "notice_until": 0}
TANKS_GOD_OWNERS = set()
ROUND_TTL_MS = 2 * 60 * 60 * 1000
ROUND_STATE = {"rounds": {}}
CHECKERS_QUEUE_TTL_MS = 90_000
CHECKERS_GAME_TTL_MS = 45 * 60 * 1000
CHECKERS_STATE = {"queue": [], "games": {}}


def now_ms():
    return int(time.time() * 1000)


def clean_player(value):
    text = str(value or "").strip()
    return text[:32]


def clean_round_id(value):
    text = str(value or "").strip()
    if not text:
        return ""
    return "".join(char for char in text[:80] if char.isalnum() or char in {"-", "_"})


def safe_int(value, default=0):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def record_owner_key(client_ip):
    return str(client_ip or "").strip()


def profile_name_for_owner(owner_key, fallback=""):
    owner = record_owner_key(owner_key)
    if owner and not owner.startswith("legacy:"):
        player = STATE["profiles"].get(owner)
        if player:
            return player
    return clean_player(fallback)


def is_public_owner(owner_key):
    owner = record_owner_key(owner_key)
    return bool(owner and not owner.startswith("legacy:"))


def server_notice():
    if SERVER_CONTROL.get("notice") and now_ms() <= safe_int(SERVER_CONTROL.get("notice_until"), 0):
        return SERVER_CONTROL["notice"]
    SERVER_CONTROL["notice"] = ""
    SERVER_CONTROL["notice_until"] = 0
    return ""


def set_server_notice(message, ttl_ms=15_000):
    SERVER_CONTROL["notice"] = str(message or "").strip()
    SERVER_CONTROL["notice_until"] = now_ms() + ttl_ms if SERVER_CONTROL["notice"] else 0


def write_next_start_notice(message, ttl_ms=120_000):
    message = str(message or "").strip()
    if not message:
        return
    payload = {"message": message, "notice_until": now_ms() + ttl_ms}
    try:
        SERVER_NOTICE_PATH.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    except OSError:
        pass


def load_next_start_notice():
    if not SERVER_NOTICE_PATH.exists():
        return
    try:
        payload = json.loads(SERVER_NOTICE_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        payload = {}
    try:
        SERVER_NOTICE_PATH.unlink()
    except OSError:
        pass

    message = str(payload.get("message") or "").strip() if isinstance(payload, dict) else ""
    notice_until = safe_int(payload.get("notice_until"), 0) if isinstance(payload, dict) else 0
    if message and notice_until > now_ms():
        SERVER_CONTROL["notice"] = message
        SERVER_CONTROL["notice_until"] = notice_until


def player_name_owner(player):
    player_key = clean_player(player).casefold()
    if not player_key:
        return ""
    for ip, name in STATE["profiles"].items():
        if clean_player(name).casefold() == player_key:
            return ip
    return ""


def is_player_name_taken(client_ip, player):
    owner = record_owner_key(client_ip)
    taken_by = player_name_owner(player)
    return bool(taken_by and taken_by != owner)


def profile_error_response(client_ip, error):
    return {"ok": False, "error": error, "ip": client_ip, "player": STATE["profiles"].get(client_ip, "")}


def resolve_profile_owner(player):
    owner = player_name_owner(player)
    if owner:
        return owner, STATE["profiles"].get(owner, clean_player(player))
    return "", ""


def tanks_record_rank(record):
    return (
        safe_int(record.get("score"), 0),
        safe_int(record.get("level"), 0),
        -safe_int(record.get("seconds"), 999999),
    )


def casino_record_rank(record):
    return (
        safe_int(record.get("credits"), 0),
        safe_int(record.get("wins"), 0),
        safe_int(record.get("spins"), 0),
        -safe_int(record.get("updated_at"), 999999999999),
    )


def is_better_record(mode, candidate, existing):
    if existing is None:
        return True
    if mode == TANKS_MODE:
        return tanks_record_rank(candidate) > tanks_record_rank(existing)
    if mode == CASINO_MODE:
        return casino_record_rank(candidate) > casino_record_rank(existing)
    candidate_seconds = safe_int(candidate.get("seconds"), 999999)
    existing_seconds = safe_int(existing.get("seconds"), 999999)
    if candidate_seconds != existing_seconds:
        return candidate_seconds < existing_seconds
    return safe_int(candidate.get("updated_at"), 999999999999) < safe_int(existing.get("updated_at"), 999999999999)


def profile_ips_by_name():
    name_to_ips = {}
    for ip, name in STATE["profiles"].items():
        key = clean_player(name).casefold()
        if key:
            name_to_ips.setdefault(key, []).append(ip)
    return name_to_ips


def infer_record_owner(stored_key, record, name_to_ips):
    client_ip = record_owner_key(record.get("client_ip"))
    if client_ip and not client_ip.startswith("legacy:"):
        return client_ip

    key_text = record_owner_key(stored_key)
    if key_text in STATE["profiles"]:
        return key_text

    for value in (record.get("player"), stored_key):
        name_key = clean_player(value).casefold()
        if not name_key:
            continue
        ips = name_to_ips.get(name_key, [])
        if len(ips) == 1:
            return ips[0]

    return ""


def public_record(record):
    item = dict(record)
    owner = record_owner_key(item.get("client_ip"))
    player = profile_name_for_owner(owner, item.get("player"))
    if player:
        item["player"] = player
    return item


def normalize_all_records_by_ip():
    changed = False
    name_to_ips = profile_ips_by_name()

    for mode in RECORD_MODES:
        mode_records = STATE["records"].get(mode, {})
        if not isinstance(mode_records, dict):
            STATE["records"][mode] = {}
            changed = True
            continue

        normalized = {}
        for stored_key, record in mode_records.items():
            if not isinstance(record, dict):
                changed = True
                continue

            owner = infer_record_owner(stored_key, record, name_to_ips)
            if not owner:
                changed = True
                continue
            next_record = dict(record)
            next_record["mode"] = mode
            next_record["client_ip"] = owner
            player = profile_name_for_owner(owner, next_record.get("player"))
            if player:
                next_record["player"] = player

            existing = normalized.get(owner)
            if is_better_record(mode, next_record, existing):
                normalized[owner] = next_record
            if str(stored_key) != owner or next_record != record or existing is not None:
                changed = True

        if mode_records != normalized:
            STATE["records"][mode] = normalized
            changed = True

    return changed


def sync_profile_records(client_ip, player=None):
    owner = record_owner_key(client_ip)
    player = clean_player(player or STATE["profiles"].get(owner))
    if not owner or not player:
        return False

    changed = False
    for mode_records in STATE["records"].values():
        if not isinstance(mode_records, dict):
            continue
        for record in mode_records.values():
            if not isinstance(record, dict):
                continue
            if record_owner_key(record.get("client_ip")) != owner:
                continue
            if record.get("player") != player:
                record["player"] = player
                changed = True
            if record.get("client_ip") != owner:
                record["client_ip"] = owner
                changed = True
    return changed


def set_profile(client_ip, player):
    owner = record_owner_key(client_ip)
    player = clean_player(player)
    if not owner or not player:
        return False

    changed = STATE["profiles"].get(owner) != player
    STATE["profiles"][owner] = player
    if sync_profile_records(owner, player):
        changed = True
    if normalize_all_records_by_ip():
        changed = True
    return changed


def load_records():
    if not RECORDS_PATH.exists():
        return False
    try:
        data = json.loads(RECORDS_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return False
    records = data.get("records", {})
    if not isinstance(records, dict):
        return False
    changed = False
    for mode in RECORD_MODES:
        mode_records = records.get(mode, {})
        if isinstance(mode_records, dict):
            STATE["records"][mode] = mode_records
    profiles = data.get("profiles", {})
    if isinstance(profiles, dict):
        cleaned_profiles = {}
        for ip, name in profiles.items():
            player = clean_player(name)
            if str(ip).strip() and player:
                cleaned_profiles[str(ip)] = player
        STATE["profiles"] = cleaned_profiles
    if normalize_all_records_by_ip():
        changed = True
    return changed


def save_records():
    data = {"records": STATE["records"], "profiles": STATE["profiles"]}
    RECORDS_PATH.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    save_leaderboard_cache(data)


def save_leaderboard_cache(data=None):
    payload = data or {"records": STATE["records"], "profiles": STATE["profiles"]}
    cache = "window.TENDERBOMB_RECORDS = " + json.dumps(payload, ensure_ascii=False) + ";\n"
    LEADERBOARD_CACHE_PATH.write_text(cache, encoding="utf-8")


def public_scores(mode="express"):
    scores = sorted(
        (
            item
            for item in STATE["records"].get(mode, {}).values()
            if is_public_owner(item.get("client_ip")) and safe_int(item.get("seconds"), 0) > 0
        ),
        key=lambda item: (
            item["seconds"],
            item["updated_at"],
        ),
    )
    return [public_record(item) for item in scores[:50]]


def public_leaderboards():
    return {mode: public_scores(mode) for mode in sorted(MODES)}


def with_server_notice(payload):
    notice = server_notice()
    if notice:
        payload["server_notice"] = notice
    return payload


def public_state(mode="express"):
    return with_server_notice({
        "ok": True,
        "leaderboard": public_scores(mode),
        "leaderboards": public_leaderboards(),
        "server_time": now_ms(),
    })


def public_tanks_scores():
    scores = sorted(
        (
            item
            for item in STATE["records"].get(TANKS_MODE, {}).values()
            if is_public_owner(item.get("client_ip"))
            and safe_int(item.get("score"), -1) >= 0
            and safe_int(item.get("level"), 0) > 0
        ),
        key=lambda item: (
            -safe_int(item.get("score"), 0),
            -safe_int(item.get("level"), 0),
            safe_int(item.get("seconds"), 999999),
            safe_int(item.get("updated_at"), 0),
        ),
    )
    return [public_record(item) for item in scores[:50]]


def public_tanks_state(client_ip=""):
    owner = record_owner_key(client_ip)
    return with_server_notice({
        "ok": True,
        "leaderboard": public_tanks_scores(),
        "server_time": now_ms(),
        "god": bool(owner and owner in TANKS_GOD_OWNERS),
    })


def clean_casino_history(items):
    if not isinstance(items, list):
        return []
    history = []
    for item in items[:CASINO_HISTORY_LIMIT]:
        if not isinstance(item, dict):
            continue
        symbols = item.get("symbols")
        if not isinstance(symbols, list):
            symbols = []
        history.append({
            "symbols": [str(symbol)[:4] for symbol in symbols[:3]],
            "bet": max(0, safe_int(item.get("bet"), 0)),
            "payout": max(0, safe_int(item.get("payout"), 0)),
            "net": safe_int(item.get("net"), 0),
            "credits": max(0, safe_int(item.get("credits"), 0)),
            "created_at": max(0, safe_int(item.get("created_at"), 0)),
        })
    return history


def ensure_casino_record(client_ip, player):
    owner = record_owner_key(client_ip)
    player = clean_player(player or STATE["profiles"].get(owner))
    if not owner or not player:
        return None, False

    casino_records = STATE["records"].setdefault(CASINO_MODE, {})
    current = now_ms()
    record = casino_records.get(owner)
    if not isinstance(record, dict):
        record = {
            "player": player,
            "client_ip": owner,
            "mode": CASINO_MODE,
            "credits": CASINO_STARTING_CREDITS,
            "spins": 0,
            "wins": 0,
            "losses": 0,
            "pushes": 0,
            "wagered": 0,
            "paid": 0,
            "earned": 0,
            "spent": 0,
            "history": [],
            "created_at": current,
            "updated_at": current,
        }
        casino_records[owner] = record
        return record, True

    changed = False
    defaults = {
        "mode": CASINO_MODE,
        "credits": CASINO_STARTING_CREDITS,
        "spins": 0,
        "wins": 0,
        "losses": 0,
        "pushes": 0,
        "wagered": 0,
        "paid": 0,
        "earned": 0,
        "spent": 0,
        "history": [],
        "created_at": current,
        "updated_at": current,
    }
    for key, value in defaults.items():
        if key not in record:
            record[key] = value
            changed = True
    if record.get("player") != player:
        record["player"] = player
        changed = True
    if record.get("client_ip") != owner:
        record["client_ip"] = owner
        changed = True
    cleaned_history = clean_casino_history(record.get("history"))
    if record.get("history") != cleaned_history:
        record["history"] = cleaned_history
        changed = True
    for key in ("credits", "spins", "wins", "losses", "pushes", "wagered", "paid", "earned", "spent"):
        normalized = max(0, safe_int(record.get(key), 0))
        if record.get(key) != normalized:
            record[key] = normalized
            changed = True
    return record, changed


def add_casino_credits(client_ip, player, amount, source):
    amount = max(0, safe_int(amount, 0))
    if amount <= 0:
        return None, False

    record, dirty = ensure_casino_record(client_ip, player)
    if not record:
        return None, dirty

    current = now_ms()
    previous = max(0, safe_int(record.get("credits"), 0))
    record["credits"] = previous + amount
    record["earned"] = max(0, safe_int(record.get("earned"), 0)) + amount
    record["updated_at"] = current
    record["last_credit_award"] = {
        "source": str(source or "")[:48],
        "amount": amount,
        "created_at": current,
    }
    return {
        "amount": amount,
        "credits": record["credits"],
        "previous_credits": previous,
        "source": str(source or "")[:48],
    }, True


def casino_credit_balance(client_ip):
    owner = record_owner_key(client_ip)
    record = STATE["records"].get(CASINO_MODE, {}).get(owner)
    if isinstance(record, dict):
        return max(0, safe_int(record.get("credits"), CASINO_STARTING_CREDITS))
    return CASINO_STARTING_CREDITS


def attach_credit_summary(result, client_ip, source):
    if not isinstance(result, dict) or result.get("credit_reward"):
        return result
    credits = casino_credit_balance(client_ip)
    result["credit_reward"] = {
        "amount": 0,
        "credits": credits,
        "previous_credits": credits,
        "source": str(source or "")[:48],
    }
    return result


def public_casino_scores():
    scores = sorted(
        (
            item
            for item in STATE["records"].get(CASINO_MODE, {}).values()
            if is_public_owner(item.get("client_ip")) and safe_int(item.get("credits"), -1) >= 0
        ),
        key=lambda item: (
            -safe_int(item.get("credits"), 0),
            -safe_int(item.get("wins"), 0),
            safe_int(item.get("spins"), 999999),
            safe_int(item.get("updated_at"), 0),
        ),
    )
    return [public_record(item) for item in scores[:50]]


def public_casino_state(client_ip="", create=True):
    owner = record_owner_key(client_ip)
    player = STATE["profiles"].get(owner, "")
    record = None
    dirty = False
    if owner and player:
        if create:
            record, dirty = ensure_casino_record(owner, player)
        else:
            record = STATE["records"].get(CASINO_MODE, {}).get(owner)
    if dirty:
        save_records()

    return with_server_notice({
        "ok": True,
        "ip": client_ip,
        "player": player,
        "credits": safe_int(record.get("credits"), CASINO_STARTING_CREDITS) if record else None,
        "spins": safe_int(record.get("spins"), 0) if record else 0,
        "wins": safe_int(record.get("wins"), 0) if record else 0,
        "losses": safe_int(record.get("losses"), 0) if record else 0,
        "pushes": safe_int(record.get("pushes"), 0) if record else 0,
        "earned": safe_int(record.get("earned"), 0) if record else 0,
        "spent": safe_int(record.get("spent"), 0) if record else 0,
        "history": clean_casino_history(record.get("history")) if record else [],
        "leaderboard": public_casino_scores(),
        "bets": sorted(CASINO_PRESET_BETS),
        "min_bet": CASINO_MIN_BET,
        "max_bet": CASINO_MAX_BET,
        "starting_credits": CASINO_STARTING_CREDITS,
        "server_time": now_ms(),
    })


def weighted_casino_symbol():
    total = sum(max(0, safe_int(item.get("weight"), 0)) for item in CASINO_SYMBOLS)
    ticket = secrets.randbelow(max(total, 1))
    cursor = 0
    for item in CASINO_SYMBOLS:
        cursor += max(0, safe_int(item.get("weight"), 0))
        if ticket < cursor:
            return item["symbol"]
    return CASINO_SYMBOLS[0]["symbol"]


def casino_symbol_rule(symbol):
    for item in CASINO_SYMBOLS:
        if item["symbol"] == symbol:
            return item
    return CASINO_SYMBOLS[0]


def evaluate_casino_spin(symbols, bet):
    counts = {}
    for symbol in symbols:
        counts[symbol] = counts.get(symbol, 0) + 1
    symbol, count = max(counts.items(), key=lambda item: item[1])
    rule = casino_symbol_rule(symbol)
    if count >= 3:
        payout = bet * safe_int(rule.get("three"), 0)
    elif count == 2:
        payout = bet * safe_int(rule.get("two"), 0)
    else:
        payout = 0
    return payout, payout - bet


def casino_state_with_result(client_ip, result):
    state = public_casino_state(client_ip, create=False)
    state["result"] = result
    return state


def register_casino_spin(payload, client_ip):
    player = clean_player(payload.get("player") or STATE["profiles"].get(client_ip))
    if not player:
        return casino_state_with_result(client_ip, {"ok": False, "reason": "invalid_player", "error": "invalid_player"})
    if is_player_name_taken(client_ip, player):
        return casino_state_with_result(client_ip, {"ok": False, "reason": "name_taken", "error": "name_taken"})

    bet = safe_int(payload.get("bet"), 0)
    if bet < CASINO_MIN_BET or bet > CASINO_MAX_BET:
        return casino_state_with_result(client_ip, {"ok": False, "reason": "invalid_bet", "error": "invalid_bet"})

    dirty = set_profile(client_ip, player)
    record, record_dirty = ensure_casino_record(client_ip, player)
    dirty = dirty or record_dirty
    if not record:
        return casino_state_with_result(client_ip, {"ok": False, "reason": "invalid_player", "error": "invalid_player"})

    credits = max(0, safe_int(record.get("credits"), 0))
    if credits < bet:
        if dirty:
            save_records()
        return casino_state_with_result(
            client_ip,
            {
                "ok": False,
                "reason": "not_enough_credits",
                "error": "not_enough_credits",
                "credits": credits,
                "bet": bet,
            },
        )

    symbols = [weighted_casino_symbol() for _ in range(3)]
    payout, net = evaluate_casino_spin(symbols, bet)
    current = now_ms()
    credits = max(0, credits - bet + payout)

    record["credits"] = credits
    record["spins"] = max(0, safe_int(record.get("spins"), 0)) + 1
    record["wagered"] = max(0, safe_int(record.get("wagered"), 0)) + bet
    record["paid"] = max(0, safe_int(record.get("paid"), 0)) + payout
    record["updated_at"] = current
    if net > 0:
        record["wins"] = max(0, safe_int(record.get("wins"), 0)) + 1
    elif net < 0:
        record["losses"] = max(0, safe_int(record.get("losses"), 0)) + 1
    else:
        record["pushes"] = max(0, safe_int(record.get("pushes"), 0)) + 1
    record["history"] = [
        {
            "symbols": symbols,
            "bet": bet,
            "payout": payout,
            "net": net,
            "credits": credits,
            "created_at": current,
        },
        *clean_casino_history(record.get("history")),
    ][:CASINO_HISTORY_LIMIT]

    save_records()

    return casino_state_with_result(
        client_ip,
        {
            "ok": True,
            "reason": "spin",
            "symbols": symbols,
            "bet": bet,
            "payout": payout,
            "net": net,
            "credits": credits,
        },
    )


def public_profile(client_ip):
    return with_server_notice({
        "ok": True,
        "ip": client_ip,
        "player": STATE["profiles"].get(client_ip, ""),
    })


def cleanup_rounds_locked(current=None):
    current = current or now_ms()
    ROUND_STATE["rounds"] = {
        round_id: round_data
        for round_id, round_data in ROUND_STATE["rounds"].items()
        if not round_data.get("used") and current - int(round_data.get("started_at", 0)) <= ROUND_TTL_MS
    }


def result_response(mode, result):
    state = public_state(mode)
    state["result"] = result
    return state


def start_round(payload, client_ip):
    cleanup_rounds_locked()
    mode = str(payload.get("mode") or "express")
    if mode not in MODES:
        mode = "express"

    player = clean_player(payload.get("player") or STATE["profiles"].get(client_ip))
    if not player:
        return {"ok": False, "error": "invalid_player"}
    if is_player_name_taken(client_ip, player):
        return profile_error_response(client_ip, "name_taken")

    current = now_ms()
    round_id = uuid.uuid4().hex
    ROUND_STATE["rounds"][round_id] = {
        "client_ip": client_ip,
        "player": player,
        "mode": mode,
        "started_at": current,
        "used": False,
    }
    if set_profile(client_ip, player):
        save_records()
    return {
        "ok": True,
        "round_id": round_id,
        "mode": mode,
        "player": player,
        "started_at": current,
        "server_time": current,
        "min_win_seconds": MODE_RULES[mode]["min_win_seconds"],
    }


def save_profile(client_ip, payload):
    player = clean_player(payload.get("player"))
    if not player:
        return profile_error_response(client_ip, "invalid_player")
    if is_player_name_taken(client_ip, player):
        return profile_error_response(client_ip, "name_taken")
    set_profile(client_ip, player)
    save_records()
    return public_profile(client_ip)


def register_result(payload, client_ip):
    cleanup_rounds_locked()
    mode = str(payload.get("mode") or "express")
    if mode not in MODES:
        mode = "express"

    status = str(payload.get("status") or "")
    if status not in {"won", "lost"}:
        status = "lost"

    player = clean_player(payload.get("player") or STATE["profiles"].get(client_ip))
    if not player:
        return result_response(mode, {"recorded": False, "reason": "invalid_player", "error": "invalid_player"})
    if is_player_name_taken(client_ip, player):
        return result_response(mode, {"recorded": False, "reason": "name_taken", "error": "name_taken"})

    flags = max(0, safe_int(payload.get("flags"), 0))
    revealed = max(0, safe_int(payload.get("revealed"), 0))
    round_id = clean_round_id(payload.get("round_id"))
    round_data = ROUND_STATE["rounds"].get(round_id)

    if status != "won":
        if (
            round_data
            and round_data.get("client_ip") == client_ip
            and round_data.get("mode") == mode
            and clean_player(round_data.get("player")).casefold() == player.casefold()
        ):
            round_data["used"] = True
        return result_response(mode, attach_credit_summary({"recorded": False, "reason": status}, client_ip, f"sapper:{mode}"))

    if (
        not round_data
        or round_data.get("used")
        or round_data.get("client_ip") != client_ip
        or round_data.get("mode") != mode
        or clean_player(round_data.get("player")).casefold() != player.casefold()
    ):
        return result_response(
            mode,
            attach_credit_summary({"recorded": False, "reason": "invalid_round", "error": "invalid_round"}, client_ip, f"sapper:{mode}"),
        )

    current = now_ms()
    elapsed_ms = max(0, current - int(round_data.get("started_at", current)))
    seconds = max(1, min((elapsed_ms + 999) // 1000, 60 * 60))
    round_data["used"] = True

    rules = MODE_RULES[mode]
    if flags > rules["mines"] or revealed > rules["active"] or flags + revealed != rules["active"]:
        return result_response(
            mode,
            attach_credit_summary(
                {
                    "recorded": False,
                    "reason": "stat_mismatch",
                    "error": "stat_mismatch",
                    "flags": flags,
                    "revealed": revealed,
                    "expected_total": rules["active"],
                },
                client_ip,
                f"sapper:{mode}",
            ),
        )

    min_win_seconds = rules["min_win_seconds"]
    if seconds < min_win_seconds:
        return result_response(
            mode,
            attach_credit_summary(
                {
                    "recorded": False,
                    "reason": "too_fast",
                    "error": "too_fast",
                    "server_seconds": seconds,
                    "min_seconds": min_win_seconds,
                },
                client_ip,
                f"sapper:{mode}",
            ),
        )

    dirty = set_profile(client_ip, player)
    owner_key = record_owner_key(client_ip)
    mode_records = STATE["records"].setdefault(mode, {})
    existing = mode_records.get(owner_key)
    result = {"recorded": False, "reason": status}

    if status == "won":
        timestamp = now_ms()
        if existing is None:
            mode_records[owner_key] = {
                "player": player,
                "client_ip": owner_key,
                "seconds": seconds,
                "mode": mode,
                "flags": int(payload.get("flags") or 0),
                "revealed": int(payload.get("revealed") or 0),
                "created_at": timestamp,
                "updated_at": timestamp,
                "previous_seconds": None,
                "improved_by": None,
            }
            dirty = True
            result = {"recorded": True, "reason": "first_record", "best_seconds": seconds}
        elif seconds < int(existing.get("seconds", 999999)):
            previous_seconds = int(existing["seconds"])
            improved_by = previous_seconds - seconds
            existing.update(
                {
                    "player": player,
                    "client_ip": owner_key,
                    "seconds": seconds,
                    "flags": int(payload.get("flags") or 0),
                    "revealed": int(payload.get("revealed") or 0),
                    "updated_at": timestamp,
                    "previous_seconds": previous_seconds,
                    "improved_by": improved_by,
                }
            )
            dirty = True
            result = {
                "recorded": True,
                "reason": "improved",
                "best_seconds": seconds,
                "previous_seconds": previous_seconds,
                "improved_by": improved_by,
            }
        else:
            best_seconds = int(existing["seconds"])
            result = {
                "recorded": False,
                "reason": "not_improved",
                "best_seconds": best_seconds,
                "missed_by": seconds - best_seconds,
            }
            if existing.get("player") != player or existing.get("client_ip") != owner_key:
                existing["player"] = player
                existing["client_ip"] = owner_key
                dirty = True

        credit_reward, reward_dirty = add_casino_credits(client_ip, player, SAPPER_CREDIT_REWARDS.get(mode, 0), f"sapper:{mode}")
        if credit_reward:
            result["credit_reward"] = credit_reward
        if reward_dirty:
            dirty = True

    if dirty:
        save_records()

    state = public_state(mode)
    state["result"] = result
    return state


def register_tanks_result(payload, client_ip):
    player = clean_player(payload.get("player") or STATE["profiles"].get(client_ip))
    if not player:
        state = public_tanks_state(client_ip)
        state["result"] = {"recorded": False, "reason": "invalid_player", "error": "invalid_player"}
        return state
    if is_player_name_taken(client_ip, player):
        state = public_tanks_state(client_ip)
        state["result"] = {"recorded": False, "reason": "name_taken", "error": "name_taken"}
        return state

    level = max(1, min(safe_int(payload.get("level"), 1), 1_000_000))
    score = max(0, min(safe_int(payload.get("score"), 0), 2_000_000_000))
    seconds = max(1, min(safe_int(payload.get("seconds"), 1), 24 * 60 * 60))
    mistakes = max(0, min(safe_int(payload.get("mistakes"), 0), 99))
    combo = max(1, min(safe_int(payload.get("combo"), 1), 9999))
    reason = str(payload.get("reason") or "finished")[:32]

    current = now_ms()
    dirty = set_profile(client_ip, player)

    owner_key = record_owner_key(client_ip)
    tanks_records = STATE["records"].setdefault(TANKS_MODE, {})
    existing = tanks_records.get(owner_key)
    next_record = {
        "player": player,
        "client_ip": owner_key,
        "level": level,
        "score": score,
        "seconds": seconds,
        "mistakes": mistakes,
        "combo": combo,
        "mode": TANKS_MODE,
        "reason": reason,
        "updated_at": current,
    }

    if existing is None:
        tanks_records[owner_key] = {
            **next_record,
            "created_at": current,
            "previous_level": None,
            "previous_score": None,
        }
        dirty = True
        result = {"recorded": True, "reason": "first_record", "level": level, "score": score}
    elif tanks_record_rank(next_record) > tanks_record_rank(existing):
        previous_level = safe_int(existing.get("level"), 0)
        previous_score = safe_int(existing.get("score"), 0)
        existing.update(
            {
                **next_record,
                "previous_level": previous_level,
                "previous_score": previous_score,
            }
        )
        dirty = True
        result = {
            "recorded": True,
            "reason": "improved",
            "level": level,
            "score": score,
            "previous_level": previous_level,
            "previous_score": previous_score,
        }
    else:
        result = {
            "recorded": False,
            "reason": "not_improved",
            "level": safe_int(existing.get("level"), 1),
            "score": safe_int(existing.get("score"), 0),
        }
        if existing.get("player") != player or existing.get("client_ip") != owner_key:
            existing["player"] = player
            existing["client_ip"] = owner_key
            dirty = True

    credit_reward, reward_dirty = add_casino_credits(
        client_ip,
        player,
        min(TANKS_CREDIT_CAP, score // TANKS_CREDIT_DIVISOR),
        "tanks",
    )
    if credit_reward:
        result["credit_reward"] = credit_reward
    if reward_dirty:
        dirty = True

    if dirty:
        save_records()

    state = public_tanks_state(client_ip)
    state["result"] = result
    return state


def clean_client_id(value):
    text = str(value or "").strip()
    if not text:
      return uuid.uuid4().hex
    return "".join(char for char in text[:80] if char.isalnum() or char in {"-", "_"})


def checkers_coord(index):
    row = index // 8
    col = index % 8
    return f"{chr(97 + col)}{8 - row}"


def checkers_opponent(color):
    return "black" if color == "white" else "white"


def checkers_playable(row, col):
    return 0 <= row < 8 and 0 <= col < 8 and (row + col) % 2 == 1


def create_checkers_board():
    board = [None for _ in range(64)]
    for row in range(3):
        for col in range(8):
            if checkers_playable(row, col):
                board[row * 8 + col] = {"color": "black", "king": False}
    for row in range(5, 8):
        for col in range(8):
            if checkers_playable(row, col):
                board[row * 8 + col] = {"color": "white", "king": False}
    return board


def checkers_log(game, tone, text):
    game["log"].insert(0, {"tone": tone, "text": text, "at": now_ms()})
    game["log"] = game["log"][:16]


def checkers_live_clocks(game, current=None):
    current = current or now_ms()
    clocks = {
        "white": int(game.get("clocks", {}).get("white", 0)),
        "black": int(game.get("clocks", {}).get("black", 0)),
    }
    if game.get("status") == "playing":
        turn = game.get("turn")
        started_at = int(game.get("turn_started_at") or current)
        if turn in clocks:
            clocks[turn] += max(0, current - started_at)
    return clocks


def checkers_commit_clock(game, current=None):
    current = current or now_ms()
    if game.get("status") != "playing":
        return
    turn = game.get("turn")
    if turn not in {"white", "black"}:
        return
    clocks = game.setdefault("clocks", {"white": 0, "black": 0})
    started_at = int(game.get("turn_started_at") or current)
    clocks[turn] = int(clocks.get(turn, 0)) + max(0, current - started_at)
    game["turn_started_at"] = current


def cleanup_checkers_locked():
    current = now_ms()
    CHECKERS_STATE["queue"] = [
        entry
        for entry in CHECKERS_STATE["queue"]
        if current - int(entry.get("last_seen", 0)) <= CHECKERS_QUEUE_TTL_MS
    ]
    for game_id, game in list(CHECKERS_STATE["games"].items()):
        if current - int(game.get("updated_at", 0)) > CHECKERS_GAME_TTL_MS:
            del CHECKERS_STATE["games"][game_id]


def find_checkers_game(client_id):
    for game in CHECKERS_STATE["games"].values():
        if any(player["client_id"] == client_id for player in game["players"].values()):
            return game
    return None


def find_checkers_color(game, client_id):
    for color, player in game["players"].items():
        if player["client_id"] == client_id:
            return color
    return None


def find_checkers_queue_entry(client_id):
    for entry in CHECKERS_STATE["queue"]:
        if entry["client_id"] == client_id:
            return entry
    return None


def remove_checkers_queue_entry(client_id):
    before = len(CHECKERS_STATE["queue"])
    CHECKERS_STATE["queue"] = [
        entry for entry in CHECKERS_STATE["queue"] if entry["client_id"] != client_id
    ]
    return len(CHECKERS_STATE["queue"]) != before


def touch_checkers_name(client_id, player, client_ip=""):
    owner = record_owner_key(client_ip)
    game = find_checkers_game(client_id)
    if game:
        color = find_checkers_color(game, client_id)
        if color:
            game["players"][color]["name"] = player
            if owner:
                game["players"][color]["client_ip"] = owner
            game["updated_at"] = now_ms()
    entry = find_checkers_queue_entry(client_id)
    if entry:
        entry["player"] = player
        if owner:
            entry["client_ip"] = owner
        entry["last_seen"] = now_ms()


def create_checkers_game(waiting, joining):
    game_id = uuid.uuid4().hex[:12]
    game = {
        "id": game_id,
        "status": "playing",
        "players": {
            "white": {
                "client_id": waiting["client_id"],
                "name": waiting["player"],
                "client_ip": record_owner_key(waiting.get("client_ip")),
            },
            "black": {
                "client_id": joining["client_id"],
                "name": joining["player"],
                "client_ip": record_owner_key(joining.get("client_ip")),
            },
        },
        "board": create_checkers_board(),
        "turn": "white",
        "winner": None,
        "reason": None,
        "must_continue_from": None,
        "last_move": None,
        "clocks": {"white": 0, "black": 0},
        "turn_started_at": now_ms(),
        "log": [],
        "created_at": now_ms(),
        "updated_at": now_ms(),
    }
    checkers_log(
        game,
        "info",
        f"Партия собрана: {waiting['player']} против {joining['player']}. Белые начинают.",
    )
    CHECKERS_STATE["games"][game_id] = game
    return game


def public_checkers_game(game, client_id):
    color = find_checkers_color(game, client_id)
    opponent = checkers_opponent(color) if color else None
    return {
        "id": game["id"],
        "status": game["status"],
        "players": {
            side: {"name": player["name"]} for side, player in game["players"].items()
        },
        "you": color,
        "opponent": opponent,
        "board": game["board"],
        "turn": game["turn"],
        "winner": game["winner"],
        "reason": game["reason"],
        "must_continue_from": game["must_continue_from"],
        "last_move": game["last_move"],
        "clocks": checkers_live_clocks(game),
        "log": game["log"],
        "updated_at": game["updated_at"],
    }


def public_checkers_state(client_id, player=None, client_ip=""):
    client_id = clean_client_id(client_id)
    if player is not None:
        cleaned_player = clean_player(player)
        if cleaned_player:
            touch_checkers_name(client_id, cleaned_player, client_ip)
    cleanup_checkers_locked()

    game = find_checkers_game(client_id)
    if game:
        return with_server_notice({"ok": True, "status": game["status"], "game": public_checkers_game(game, client_id)})

    entry = find_checkers_queue_entry(client_id)
    if entry:
        entry["last_seen"] = now_ms()
        return with_server_notice({
            "ok": True,
            "status": "waiting",
            "queue_size": len(CHECKERS_STATE["queue"]),
            "player": entry["player"],
        })

    return with_server_notice({"ok": True, "status": "idle", "queue_size": len(CHECKERS_STATE["queue"])})


def join_checkers(payload, client_ip=""):
    cleanup_checkers_locked()
    client_id = clean_client_id(payload.get("client_id"))
    player = clean_player(payload.get("player"))
    owner = record_owner_key(client_ip)
    if not player:
        return {"ok": False, "error": "invalid_player", "status": "idle", "queue_size": len(CHECKERS_STATE["queue"])}
    if client_ip and is_player_name_taken(client_ip, player):
        return {"ok": False, "error": "name_taken", "status": "idle", "queue_size": len(CHECKERS_STATE["queue"])}
    if client_ip and set_profile(client_ip, player):
        save_records()
    existing_game = find_checkers_game(client_id)
    if existing_game:
        touch_checkers_name(client_id, player, client_ip)
        return public_checkers_state(client_id, client_ip=client_ip)

    existing_entry = find_checkers_queue_entry(client_id)
    if existing_entry:
        touch_checkers_name(client_id, player, client_ip)
        return public_checkers_state(client_id, client_ip=client_ip)

    while CHECKERS_STATE["queue"]:
        waiting = CHECKERS_STATE["queue"].pop(0)
        if waiting["client_id"] != client_id:
            game = create_checkers_game(waiting, {"client_id": client_id, "player": player, "client_ip": owner})
            return {
                "ok": True,
                "status": "playing",
                "game": public_checkers_game(game, client_id),
            }

    CHECKERS_STATE["queue"].append(
        {
            "client_id": client_id,
            "player": player,
            "client_ip": owner,
            "joined_at": now_ms(),
            "last_seen": now_ms(),
        }
    )
    return public_checkers_state(client_id, client_ip=client_ip)


def leave_checkers(payload):
    cleanup_checkers_locked()
    client_id = clean_client_id(payload.get("client_id"))
    removed = remove_checkers_queue_entry(client_id)
    game = find_checkers_game(client_id)

    if game:
        color = find_checkers_color(game, client_id)
        if game["status"] == "playing" and color:
            winner = checkers_opponent(color)
            finish_checkers_game(game, winner, "opponent_left")
            checkers_log(game, "warn", f"{game['players'][color]['name']} вышел из партии.")
        else:
            del CHECKERS_STATE["games"][game["id"]]
    return {"ok": True, "status": "idle", "removed": removed}


def checkers_capture_dirs(piece):
    return [(-1, -1), (-1, 1), (1, -1), (1, 1)]


def checkers_simple_dirs(piece):
    if piece.get("king"):
        return checkers_capture_dirs(piece)
    return [(-1, -1), (-1, 1)] if piece["color"] == "white" else [(1, -1), (1, 1)]


def checkers_capture_moves_for_piece(board, index):
    piece = board[index]
    if not piece:
        return []
    row = index // 8
    col = index % 8
    opponent = checkers_opponent(piece["color"])
    moves = []
    if piece.get("king"):
        for row_delta, col_delta in checkers_capture_dirs(piece):
            captured_index = None
            step = 1
            while True:
                scan_row = row + row_delta * step
                scan_col = col + col_delta * step
                if not checkers_playable(scan_row, scan_col):
                    break

                scan_index = scan_row * 8 + scan_col
                scan_piece = board[scan_index]
                if captured_index is None:
                    if scan_piece is None:
                        step += 1
                        continue
                    if scan_piece["color"] == piece["color"]:
                        break
                    captured_index = scan_index
                    step += 1
                    continue

                if scan_piece is not None:
                    break
                moves.append({"from": index, "to": scan_index, "capture": captured_index})
                step += 1
        return moves

    for row_delta, col_delta in checkers_capture_dirs(piece):
        mid_row = row + row_delta
        mid_col = col + col_delta
        to_row = row + row_delta * 2
        to_col = col + col_delta * 2
        if not checkers_playable(to_row, to_col):
            continue
        middle_index = mid_row * 8 + mid_col
        to_index = to_row * 8 + to_col
        middle = board[middle_index]
        if middle and middle["color"] == opponent and board[to_index] is None:
            moves.append({"from": index, "to": to_index, "capture": middle_index})
    return moves


def checkers_simple_moves_for_piece(board, index):
    piece = board[index]
    if not piece:
        return []
    row = index // 8
    col = index % 8
    moves = []
    if piece.get("king"):
        for row_delta, col_delta in checkers_simple_dirs(piece):
            step = 1
            while True:
                to_row = row + row_delta * step
                to_col = col + col_delta * step
                if not checkers_playable(to_row, to_col):
                    break
                to_index = to_row * 8 + to_col
                if board[to_index] is not None:
                    break
                moves.append({"from": index, "to": to_index, "capture": None})
                step += 1
        return moves

    for row_delta, col_delta in checkers_simple_dirs(piece):
        to_row = row + row_delta
        to_col = col + col_delta
        if not checkers_playable(to_row, to_col):
            continue
        to_index = to_row * 8 + to_col
        if board[to_index] is None:
            moves.append({"from": index, "to": to_index, "capture": None})
    return moves


def checkers_capture_moves_for_color(board, color):
    moves = []
    for index, piece in enumerate(board):
        if piece and piece["color"] == color:
            moves.extend(checkers_capture_moves_for_piece(board, index))
    return moves


def checkers_legal_moves_for_color(board, color):
    captures = checkers_capture_moves_for_color(board, color)
    if captures:
        return captures
    moves = []
    for index, piece in enumerate(board):
        if piece and piece["color"] == color:
            moves.extend(checkers_simple_moves_for_piece(board, index))
    return moves


def promote_checkers_piece(piece, to_index):
    row = to_index // 8
    if piece["color"] == "white" and row == 0:
        piece["king"] = True
    if piece["color"] == "black" and row == 7:
        piece["king"] = True


def finish_checkers_game(game, winner, reason):
    if game["status"] == "finished":
        return
    checkers_commit_clock(game)
    game["status"] = "finished"
    game["winner"] = winner
    game["reason"] = reason
    game["must_continue_from"] = None
    game["updated_at"] = now_ms()
    award_checkers_credits(game, winner, reason)
    checkers_log(game, "good", f"Победа: {game['players'][winner]['name']}.")


def award_checkers_credits(game, winner, reason):
    if reason not in CHECKERS_CREDIT_REASONS or game.get("credit_awarded"):
        return None
    player = game.get("players", {}).get(winner, {})
    client_ip = record_owner_key(player.get("client_ip"))
    name = clean_player(player.get("name"))
    if not client_ip or not name:
        return None

    reward, dirty = add_casino_credits(client_ip, name, CHECKERS_CREDIT_REWARD, "checkers")
    if not reward:
        return None
    game["credit_awarded"] = reward
    checkers_log(game, "good", f"Кредиты: +{reward['amount']} за победу в шашках.")
    if dirty:
        save_records()
    return reward


def resolve_checkers_winner(game):
    board = game["board"]
    white_count = sum(1 for piece in board if piece and piece["color"] == "white")
    black_count = sum(1 for piece in board if piece and piece["color"] == "black")
    if white_count == 0:
        finish_checkers_game(game, "black", "no_pieces")
        return
    if black_count == 0:
        finish_checkers_game(game, "white", "no_pieces")
        return
    if not checkers_legal_moves_for_color(board, game["turn"]):
        finish_checkers_game(game, checkers_opponent(game["turn"]), "no_moves")


def move_checkers(payload):
    cleanup_checkers_locked()
    client_id = clean_client_id(payload.get("client_id"))
    game = find_checkers_game(client_id)
    if not game:
        return {"ok": False, "error": "game_not_found"}
    if game["status"] != "playing":
        return public_checkers_state(client_id)

    color = find_checkers_color(game, client_id)
    if color != game["turn"]:
        return {"ok": False, "error": "not_your_turn", "game": public_checkers_game(game, client_id)}

    try:
        from_index = int(payload.get("from"))
        to_index = int(payload.get("to"))
    except (TypeError, ValueError):
        return {"ok": False, "error": "bad_move", "game": public_checkers_game(game, client_id)}

    if not (0 <= from_index < 64 and 0 <= to_index < 64):
        return {"ok": False, "error": "bad_move", "game": public_checkers_game(game, client_id)}

    board = game["board"]
    piece = board[from_index]
    if not piece or piece["color"] != color:
        return {"ok": False, "error": "bad_piece", "game": public_checkers_game(game, client_id)}

    if game["must_continue_from"] is not None and from_index != game["must_continue_from"]:
        return {"ok": False, "error": "must_continue", "game": public_checkers_game(game, client_id)}

    if game["must_continue_from"] is not None:
        valid_moves = checkers_capture_moves_for_piece(board, from_index)
    else:
        captures = checkers_capture_moves_for_color(board, color)
        valid_moves = captures if captures else checkers_simple_moves_for_piece(board, from_index)

    matching_move = next((move for move in valid_moves if move["to"] == to_index), None)
    if not matching_move:
        return {"ok": False, "error": "illegal_move", "game": public_checkers_game(game, client_id)}

    current = now_ms()
    checkers_commit_clock(game, current)

    board[to_index] = piece
    board[from_index] = None
    if matching_move["capture"] is not None:
        board[matching_move["capture"]] = None
    promote_checkers_piece(piece, to_index)

    separator = "x" if matching_move["capture"] is not None else "-"
    game["last_move"] = {"from": from_index, "to": to_index, "capture": matching_move["capture"]}
    checkers_log(
        game,
        "info",
        f"{game['players'][color]['name']}: {checkers_coord(from_index)}{separator}{checkers_coord(to_index)}",
    )

    if matching_move["capture"] is not None:
        next_captures = checkers_capture_moves_for_piece(board, to_index)
        if next_captures:
            game["must_continue_from"] = to_index
        else:
            game["must_continue_from"] = None
            game["turn"] = checkers_opponent(color)
    else:
        game["must_continue_from"] = None
        game["turn"] = checkers_opponent(color)

    game["turn_started_at"] = current
    game["updated_at"] = current
    resolve_checkers_winner(game)
    return public_checkers_state(client_id)


class TenderBombHandler(SimpleHTTPRequestHandler):
    server_version = "TenderBombLAN/1.0"

    def log_message(self, format, *args):
        return

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def send_json(self, data, status=200):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length <= 0 or length > 100_000:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError:
            return {}

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        if path == "/api/state":
            query = parse_qs(parsed.query)
            mode = str((query.get("mode") or ["express"])[0])
            with LOCK:
                self.send_json(public_state(mode))
            return
        if path == "/api/health":
            self.send_json({"ok": True})
            return
        if path == "/api/tanks/state":
            with LOCK:
                self.send_json(public_tanks_state(self.client_address[0]))
            return
        if path == "/api/casino/state":
            with LOCK:
                self.send_json(public_casino_state(self.client_address[0]))
            return
        if path == "/api/profile":
            with LOCK:
                self.send_json(public_profile(self.client_address[0]))
            return
        if path == "/api/checkers/state":
            query = parse_qs(parsed.query)
            client_id = (query.get("client_id") or [""])[0]
            player = (query.get("player") or [None])[0]
            with LOCK:
                self.send_json(public_checkers_state(client_id, player, self.client_address[0]))
            return
        super().do_GET()

    def do_POST(self):
        path = urlparse(self.path).path
        payload = self.read_json()

        if path == "/api/result":
            with LOCK:
                self.send_json(register_result(payload, self.client_address[0]))
            return

        if path == "/api/tanks/result":
            with LOCK:
                self.send_json(register_tanks_result(payload, self.client_address[0]))
            return

        if path == "/api/casino/spin":
            with LOCK:
                self.send_json(register_casino_spin(payload, self.client_address[0]))
            return

        if path == "/api/profile":
            with LOCK:
                self.send_json(save_profile(self.client_address[0], payload))
            return

        if path == "/api/round/start":
            with LOCK:
                self.send_json(start_round(payload, self.client_address[0]))
            return

        if path == "/api/checkers/join":
            with LOCK:
                self.send_json(join_checkers(payload, self.client_address[0]))
            return

        if path == "/api/checkers/leave":
            with LOCK:
                self.send_json(leave_checkers(payload))
            return

        if path == "/api/checkers/move":
            with LOCK:
                self.send_json(move_checkers(payload))
            return

        self.send_json({"ok": False, "error": "not_found"}, status=404)


def local_ips():
    ips = set()
    hostname = socket.gethostname()
    try:
        for item in socket.getaddrinfo(hostname, None, socket.AF_INET):
            ip = item[4][0]
            if not ip.startswith("127."):
                ips.add(ip)
    except OSError:
        pass
    return sorted(ips)


def request_server_stop(restart=False):
    SERVER_CONTROL["restart"] = bool(restart)
    server = SERVER_CONTROL.get("server")
    if server:
        threading.Thread(target=server.shutdown, daemon=True).start()


def request_stealth_mode():
    SERVER_CONTROL["restart"] = False
    SERVER_CONTROL["stealth"] = True
    server = SERVER_CONTROL.get("server")
    if server:
        threading.Thread(target=server.shutdown, daemon=True).start()


def launch_tray_server():
    root = Path(__file__).resolve().parent
    tray_script = root / "server-tray.ps1"
    if not tray_script.exists():
        print("Tray launch failed: server-tray.ps1 not found.")
        return
    subprocess.Popen(
        [
            "powershell.exe",
            "-NoProfile",
            "-STA",
            "-ExecutionPolicy",
            "Bypass",
            "-WindowStyle",
            "Hidden",
            "-File",
            str(tray_script),
        ],
        cwd=str(root),
        shell=False,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )


def set_tanks_god(player, enabled=None):
    owner, saved_player = resolve_profile_owner(player)
    if not owner:
        print(f"God mode: player not found: {player}")
        return
    if enabled is None:
        enabled = owner not in TANKS_GOD_OWNERS
    if enabled:
        TANKS_GOD_OWNERS.add(owner)
        print(f"God mode enabled for {saved_player} ({owner}).")
    else:
        TANKS_GOD_OWNERS.discard(owner)
        print(f"God mode disabled for {saved_player} ({owner}).")


def handle_console_command(line):
    command = str(line or "").strip()
    if not command:
        return
    lowered = command.casefold()
    if lowered in {"exit", "quit"}:
        message = "Сервер был отключен."
        with LOCK:
            set_server_notice(message, 10_000)
        print(message)
        threading.Timer(6.0, lambda: request_server_stop(False)).start()
        return
    if lowered == "restart":
        message = "Сервер перезапускается. После рестарта обновите страницу с помощью F5."
        next_message = "Сервер был перезапущен, обновите страницу с помощью F5."
        with LOCK:
            set_server_notice(message)
            write_next_start_notice(next_message)
        print(message)
        threading.Timer(1.5, lambda: request_server_stop(True)).start()
        return
    if lowered == "stealth":
        print("Switching server to tray mode...")
        request_stealth_mode()
        return
    if lowered.startswith("god "):
        player = command[4:].strip()
        if not player:
            print("Usage: god <nick>")
            return
        with LOCK:
            set_tanks_god(player)
        return
    if lowered.startswith("ungod "):
        player = command[6:].strip()
        if not player:
            print("Usage: ungod <nick>")
            return
        with LOCK:
            set_tanks_god(player, False)
        return
    print("Unknown command. Available: god <nick>, ungod <nick>, stealth, restart, exit, quit")


def console_command_loop():
    while True:
        try:
            line = sys.stdin.readline()
        except OSError:
            return
        if not line:
            return
        handle_console_command(line)


def main():
    port = 8080
    if len(sys.argv) > 1:
        try:
            port = int(sys.argv[1])
        except ValueError:
            pass

    os.chdir(Path(__file__).resolve().parent)
    with LOCK:
        records_changed = load_records()
        if records_changed:
            save_records()
        else:
            save_leaderboard_cache()
        load_next_start_notice()

    print()
    print("TenderBomb records server")
    print("=========================")
    print(f"Local: http://localhost:{port}/")
    for ip in local_ips():
        print(f"LAN:   http://{ip}:{port}/")
    print()
    print("Commands: god <nick>, ungod <nick>, stealth, restart, exit, quit")
    print("Keep this window open while colleagues are playing.")
    print()

    server = ThreadingHTTPServer(("0.0.0.0", port), TenderBombHandler)
    SERVER_CONTROL["server"] = server
    threading.Thread(target=console_command_loop, daemon=True).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServer stopped.")
    finally:
        server.server_close()
        SERVER_CONTROL["server"] = None

    if SERVER_CONTROL.get("restart"):
        SERVER_CONTROL["restart"] = False
        os.execv(sys.executable, [sys.executable, *sys.argv])

    if SERVER_CONTROL.get("stealth"):
        SERVER_CONTROL["stealth"] = False
        launch_tray_server()
        sys.exit(77)


if __name__ == "__main__":
    main()

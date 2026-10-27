from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse
from contextlib import contextmanager
import copy
import json
import math
import os
import posixpath
import secrets
import socket
import subprocess
import sys
import threading
import time
import uuid

from sapper_engine import SapperGame
from tanks_engine import TanksGame
from server_security import RecordStoreBusy, RequestLimiter, RequestRejected, record_store_lock


MODE_RULES = {
    "express": {"active": 64, "mines": 10, "min_win_seconds": 1},
    "state": {"active": 128, "mines": 22, "min_win_seconds": 1},
    "registry": {"active": 256, "mines": 48, "min_win_seconds": 1},
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
CHECKERS_BOT_CREDIT_REWARDS = {level: level * 300 for level in range(1, 6)}
CASINO_STARTING_CREDITS = 1000
CASINO_PRESET_BETS = {10, 25, 50, 100, 250, 500, 1000}
CASINO_MIN_BET = 10
CASINO_MAX_BET = 10_000
CASINO_HISTORY_LIMIT = 12
CASINO_BIG_WINS_LIMIT = 10
CASINO_BIG_WIN_THRESHOLD = 1000
CASINO_JACKPOT_SEED = 500
CASINO_JACKPOT_RATE_PERCENT = 4
CASINO_JACKPOT_SYMBOL = "tenderbomb"
CASINO_JACKPOT_FULL_BET = max(CASINO_PRESET_BETS)
CASINO_JACKPOT_MIN_BET = 100
CASINO_SPIN_INTERVAL_MS = 1500
CASINO_MINUTE_LIMIT = 30
CASINO_HOUR_LIMIT = 600
CASINO_VIOLATION_LIMIT = 8
CASINO_BLOCK_MS = 30_000
CASINO_TOKEN_TTL_SECONDS = 120
CREDIT_LEDGER_LIMIT = 1000
CREDIT_RECEIPT_LIMIT = 128
CASINO_SPIN_STATE = {}
REQUEST_LIMITER = RequestLimiter()
CASINO_SYMBOLS = [
    {
        "symbol": "document",
        "label": "Документы",
        "asset": "assets/casino-symbol-document.png",
        "weight": 28,
        "two": 1,
        "three": 4,
    },
    {
        "symbol": "seal",
        "label": "Печать",
        "asset": "assets/casino-symbol-seal.png",
        "weight": 24,
        "two": 1,
        "three": 6,
    },
    {
        "symbol": "supply",
        "label": "Поставка",
        "asset": "assets/casino-symbol-supply.png",
        "weight": 20,
        "two": 2,
        "three": 8,
    },
    {
        "symbol": "fas",
        "label": "ФАС",
        "asset": "assets/casino-symbol-fas.png",
        "weight": 14,
        "two": 1,
        "three": 12,
    },
    {
        "symbol": "goszakaz",
        "label": "Госзаказ",
        "asset": "assets/casino-symbol-goszakaz.png",
        "weight": 9,
        "two": 3,
        "three": 18,
    },
    {
        "symbol": "tenderbomb",
        "label": "TenderBomb",
        "asset": "assets/casino-symbol-tenderbomb.png",
        "weight": 5,
        "two": 5,
        "three": 35,
    },
]
LOCK = threading.Lock()
RECORDS_PATH = Path(__file__).resolve().with_name("leaderboard-records.json")
LEADERBOARD_CACHE_PATH = Path(__file__).resolve().with_name("leaderboard-cache.js")
SERVER_NOTICE_PATH = Path(__file__).resolve().with_name(".server-notice.json")
ONLINE_STATE_PATH = Path(__file__).resolve().with_name(".online-state.json")
CHAT_HISTORY_LIMIT = 150
CHAT_MESSAGE_LIMIT = 300
ONLINE_TTL_MS = 15_000
STATE = {
    "records": {mode: {} for mode in RECORD_MODES},
    "profiles": {},
    "casino": {"jackpot": CASINO_JACKPOT_SEED, "big_wins": []},
    "chat": {"next_id": 1, "messages": []},
    "credit_ledger": [],
}
SERVER_CONTROL = {"server": None, "restart": False, "stealth": False, "notice": "", "notice_until": 0}
ONLINE_STATE = {"clients": {}}
TANKS_GOD_OWNERS = set()
ROUND_TTL_MS = 2 * 60 * 60 * 1000
ROUND_STATE = {"rounds": {}}
TANKS_SESSIONS = {}
CHECKERS_BOT_GAMES = {}
CHECKERS_QUEUE_TTL_MS = 90_000
CHECKERS_GAME_TTL_MS = 45 * 60 * 1000
CHECKERS_STATE = {"queue": [], "games": {}}


class TenderBombHTTPServer(ThreadingHTTPServer):
    allow_reuse_address = False

    def __init__(self, *args, **kwargs):
        self.request_slots = threading.BoundedSemaphore(64)
        self.client_slots = {}
        self.client_slots_lock = threading.Lock()
        super().__init__(*args, **kwargs)

    def reject_busy(self, request):
        try:
            request.settimeout(.02)
            try:
                request.recv(16_384)
            except OSError:
                pass
            request.settimeout(1)
            request.sendall(b"HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\nRetry-After: 2\r\n\r\n")
            request.shutdown(socket.SHUT_WR)
            # Drain a bounded amount so Windows does not replace the 503 with a TCP reset.
            request.settimeout(.02)
            for _ in range(2):
                if not request.recv(16_384):
                    break
        except OSError:
            pass
        self.shutdown_request(request)

    def release_request_slot(self, client_address):
        with self.client_slots_lock:
            owner = client_address[0]
            remaining = self.client_slots.get(owner, 1) - 1
            if remaining:
                self.client_slots[owner] = remaining
            else:
                self.client_slots.pop(owner, None)
        self.request_slots.release()

    def process_request(self, request, client_address):
        if not self.request_slots.acquire(blocking=False):
            self.reject_busy(request)
            return
        with self.client_slots_lock:
            owner = client_address[0]
            allowed = self.client_slots.get(owner, 0) < 8
            if allowed:
                self.client_slots[owner] = self.client_slots.get(owner, 0) + 1
        if not allowed:
            self.request_slots.release()
            self.reject_busy(request)
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self.release_request_slot(client_address)
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.release_request_slot(client_address)

    def server_bind(self):
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


def now_ms():
    return int(time.time() * 1000)


def clean_player(value):
    text = str(value or "").strip()
    return text[:32]


def clean_chat_text(value):
    text = " ".join(str(value or "").strip().split())
    return text[:CHAT_MESSAGE_LIMIT]


def clean_round_id(value):
    text = str(value or "").strip()
    if not text:
        return ""
    return "".join(char for char in text[:80] if char.isalnum() or char in {"-", "_"})


def safe_int(value, default=0):
    try:
        return int(value)
    except (TypeError, ValueError, OverflowError):
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


def clean_online_view(value):
    text = str(value or "").strip().casefold()
    if text in {"sapper", "casino", "checkers", "tanks"}:
        return text
    return "sapper"


def normalize_online_clients(clients, current=None):
    current = current or now_ms()
    normalized = {}
    if not isinstance(clients, dict):
        return normalized

    for owner, item in clients.items():
        if not isinstance(item, dict):
            continue
        ip = record_owner_key(item.get("ip") or owner)
        last_seen = safe_int(item.get("last_seen"), 0)
        if not ip or current - last_seen > ONLINE_TTL_MS:
            continue
        normalized[ip] = {
            "ip": ip,
            "player": clean_player(STATE["profiles"].get(ip) or item.get("player")),
            "view": clean_online_view(item.get("view")),
            "last_seen": last_seen,
        }
    return normalized


def read_online_clients_file():
    try:
        payload = json.loads(ONLINE_STATE_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    if not isinstance(payload, dict):
        return {}
    return payload.get("clients", {})


def write_online_clients_file(clients):
    payload = {"clients": clients, "updated_at": now_ms()}
    temp_path = ONLINE_STATE_PATH.with_name(f"{ONLINE_STATE_PATH.name}.{os.getpid()}.{threading.get_ident()}.tmp")
    try:
        temp_path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        os.replace(temp_path, ONLINE_STATE_PATH)
    except OSError:
        try:
            temp_path.unlink()
        except OSError:
            pass


def cleanup_online_locked(current=None, persist=True):
    current = current or now_ms()
    merged = normalize_online_clients(read_online_clients_file(), current)
    merged.update(normalize_online_clients(ONLINE_STATE.get("clients"), current))
    ONLINE_STATE["clients"] = merged
    if persist:
        write_online_clients_file(merged)


def online_rows(current=None):
    current = current or now_ms()
    cleanup_online_locked(current)
    rows = []
    for owner, item in ONLINE_STATE["clients"].items():
        ip = record_owner_key(item.get("ip") or owner)
        if not ip:
            continue
        player = clean_player(STATE["profiles"].get(ip) or item.get("player"))
        rows.append(
            {
                "ip": ip,
                "player": player,
                "view": clean_online_view(item.get("view")),
                "last_seen": safe_int(item.get("last_seen"), current),
            }
        )
    return sorted(rows, key=lambda row: ((row["player"] or "яяя").casefold(), row["ip"]))


def public_online_state():
    rows = online_rows()
    return {
        "ok": True,
        "count": len(rows),
        "players": rows,
        "ttl_ms": ONLINE_TTL_MS,
    }


def register_online_heartbeat(payload, client_ip):
    owner = record_owner_key(client_ip)
    if not owner:
        return public_online_state()
    payload = payload if isinstance(payload, dict) else {}
    current = now_ms()
    cleanup_online_locked(current, persist=False)
    player = clean_player(STATE["profiles"].get(owner) or payload.get("player"))
    ONLINE_STATE["clients"][owner] = {
        "ip": owner,
        "player": player,
        "view": clean_online_view(payload.get("view")),
        "last_seen": current,
    }
    cleanup_online_locked(current)
    return public_online_state()


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
    for key in ("credit_receipts", "last_spin_id", "last_spin_result", "last_spin_at", "casino_guard"):
        item.pop(key, None)
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


def clean_chat_state(chat=None):
    source = chat if isinstance(chat, dict) else {}
    raw_messages = source.get("messages", [])
    messages = []
    max_id = 0

    if isinstance(raw_messages, list):
        for item in raw_messages[-CHAT_HISTORY_LIMIT:]:
            if not isinstance(item, dict):
                continue
            player = clean_player(item.get("player"))
            text = clean_chat_text(item.get("text"))
            message_id = safe_int(item.get("id"), 0)
            created_at = safe_int(item.get("created_at"), 0)
            if not player or not text or message_id <= 0:
                continue
            max_id = max(max_id, message_id)
            messages.append({
                "id": message_id,
                "player": player,
                "text": text,
                "created_at": created_at or now_ms(),
            })

    next_id = max(safe_int(source.get("next_id"), 1), max_id + 1, 1)
    return {"next_id": next_id, "messages": messages[-CHAT_HISTORY_LIMIT:]}


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
    ledger = data.get("credit_ledger", [])
    STATE["credit_ledger"] = [item for item in ledger if isinstance(item, dict)][-CREDIT_LEDGER_LIMIT:] if isinstance(ledger, list) else []
    cleaned_casino = clean_casino_meta(data.get("casino"))
    if STATE.get("casino") != cleaned_casino:
        STATE["casino"] = cleaned_casino
        if data.get("casino") != cleaned_casino:
            changed = True
    elif "casino" not in data:
        changed = True
    cleaned_chat = clean_chat_state(data.get("chat"))
    if STATE.get("chat") != cleaned_chat:
        STATE["chat"] = cleaned_chat
        if data.get("chat") != cleaned_chat:
            changed = True
    elif "chat" not in data:
        changed = True
    if normalize_all_records_by_ip():
        changed = True
    return changed


def save_records():
    data = {"records": STATE["records"], "profiles": STATE["profiles"], "casino": STATE["casino"], "chat": STATE["chat"], "credit_ledger": STATE.get("credit_ledger", [])}
    temporary = RECORDS_PATH.with_name(RECORDS_PATH.name + ".tmp")
    with temporary.open("w", encoding="utf-8") as handle:
        handle.write(json.dumps(data, ensure_ascii=False, indent=2))
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, RECORDS_PATH)
    try:
        save_leaderboard_cache(data)
    except OSError as exc:
        print(f"Leaderboard cache update failed; records are saved: {exc}")


def save_leaderboard_cache(data=None):
    payload = public_records_snapshot(data)
    cache = "window.TENDERBOMB_RECORDS = " + json.dumps(payload, ensure_ascii=False) + ";\n"
    LEADERBOARD_CACHE_PATH.write_text(cache, encoding="utf-8")


def public_records_snapshot(data=None):
    source = data if data is not None else STATE
    return {
        "records": {mode: {owner: public_record(record) for owner, record in records.items()}
                    for mode, records in source["records"].items()},
        "profiles": source["profiles"], "casino": source["casino"], "chat": source["chat"],
    }


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


def public_chat_message(message):
    return {
        "id": safe_int(message.get("id"), 0),
        "player": clean_player(message.get("player")),
        "text": clean_chat_text(message.get("text")),
        "created_at": safe_int(message.get("created_at"), 0),
    }


def public_chat_state(after_id=0, client_ip=""):
    after = safe_int(after_id, 0)
    messages = [
        public_chat_message(message)
        for message in STATE["chat"].get("messages", [])
        if safe_int(message.get("id"), 0) > after
    ]
    return with_server_notice({
        "ok": True,
        "messages": messages,
        "server_time": now_ms(),
        "player": STATE["profiles"].get(record_owner_key(client_ip), ""),
    })


def register_chat_message(payload, client_ip):
    owner = record_owner_key(client_ip)
    player = STATE["profiles"].get(owner, "")
    if not owner or not player:
        return with_server_notice({"ok": False, "error": "invalid_player", "messages": []})

    text = clean_chat_text(payload.get("text"))
    if not text:
        return with_server_notice({"ok": False, "error": "empty_message", "messages": []})

    chat = clean_chat_state(STATE.get("chat"))
    message_id = safe_int(chat.get("next_id"), 1)
    message = {
        "id": message_id,
        "player": player,
        "text": text,
        "created_at": now_ms(),
    }
    chat["next_id"] = message_id + 1
    chat["messages"] = [*chat.get("messages", []), message][-CHAT_HISTORY_LIMIT:]
    STATE["chat"] = chat
    save_records()
    return public_chat_state(safe_int(payload.get("after"), 0), client_ip)


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


def clean_casino_big_wins(items):
    if not isinstance(items, list):
        return []
    big_wins = []
    for item in items[:CASINO_BIG_WINS_LIMIT]:
        if not isinstance(item, dict):
            continue
        symbols = item.get("symbols")
        if not isinstance(symbols, list):
            symbols = []
        player = clean_player(item.get("player"))
        if not player:
            continue
        big_wins.append({
            "player": player,
            "symbols": [str(symbol)[:32] for symbol in symbols[:3]],
            "bet": max(0, safe_int(item.get("bet"), 0)),
            "payout": max(0, safe_int(item.get("payout"), 0)),
            "net": max(0, safe_int(item.get("net"), 0)),
            "jackpot": max(0, safe_int(item.get("jackpot"), 0)),
            "jackpot_hit": bool(item.get("jackpot_hit")),
            "created_at": max(0, safe_int(item.get("created_at"), 0)),
        })
    return big_wins


def clean_casino_meta(meta=None):
    if not isinstance(meta, dict):
        meta = {}
    jackpot = max(0, safe_int(meta.get("jackpot"), CASINO_JACKPOT_SEED))
    return {
        "jackpot": jackpot,
        "big_wins": clean_casino_big_wins(meta.get("big_wins")),
        "contribution_remainder": max(0, safe_int(meta.get("contribution_remainder"), 0)) % 100,
    }


def ensure_casino_meta():
    cleaned = clean_casino_meta(STATE.get("casino"))
    changed = STATE.get("casino") != cleaned
    STATE["casino"] = cleaned
    return cleaned, changed


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
            "symbols": [str(symbol)[:32] for symbol in symbols[:3]],
            "bet": max(0, safe_int(item.get("bet"), 0)),
            "payout": max(0, safe_int(item.get("payout"), 0)),
            "net": safe_int(item.get("net"), 0),
            "credits": max(0, safe_int(item.get("credits"), 0)),
            "jackpot": max(0, safe_int(item.get("jackpot"), 0)),
            "jackpot_contribution": max(0, safe_int(item.get("jackpot_contribution"), 0)),
            "jackpot_win": max(0, safe_int(item.get("jackpot_win"), 0)),
            "jackpot_hit": bool(item.get("jackpot_hit")),
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
        record_credit_event(f"opening:{owner}", owner, "opening", 0, CASINO_STARTING_CREDITS)
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


def verified_credit_reward(client_ip, award_id):
    if not isinstance(award_id, str) or ":" not in award_id:
        return None
    kind, token = award_id.split(":", 1)
    if kind == "sapper":
        session = ROUND_STATE["rounds"].get(token)
        if session and session["client_ip"] == client_ip and session["used"] and session["game"].status == "won":
            mode = session["mode"]
            return SAPPER_CREDIT_REWARDS[mode], f"sapper:{mode}"
    elif kind == "tanks":
        session = TANKS_SESSIONS.get(token)
        if session and session["client_ip"] == client_ip and session["used"]:
            game = session["game"]
            if game.ranked and game.state["status"] == "gameover":
                return min(TANKS_CREDIT_CAP, game.state["score"] // TANKS_CREDIT_DIVISOR), "tanks"
    elif kind == "checkers":
        session = CHECKERS_BOT_GAMES.get(token)
        game = session["game"] if session else CHECKERS_STATE["games"].get(token)
        if game and game["status"] == "finished" and game["reason"] in CHECKERS_CREDIT_REASONS:
            winner = game["players"].get(game["winner"], {})
            if winner.get("client_ip") == client_ip:
                difficulty = game.get("bot_difficulty")
                return (CHECKERS_BOT_CREDIT_REWARDS[difficulty], f"checkers:bot:{difficulty}") if difficulty else (CHECKERS_CREDIT_REWARD, "checkers")
    return None


def record_credit_event(event_id, client_ip, source, before, after, details=None):
    ledger = STATE.setdefault("credit_ledger", [])
    ledger.append({
        "id": event_id, "client_ip": client_ip, "player": STATE["profiles"].get(client_ip, ""),
        "source": source, "before": before, "after": after, "delta": after - before,
        "created_at": now_ms(), "details": details or {},
    })
    del ledger[:-CREDIT_LEDGER_LIMIT]


def add_casino_credits(client_ip, award_id):
    proof = verified_credit_reward(client_ip, award_id)
    player = STATE["profiles"].get(client_ip, "")
    if not proof or not player:
        return None, False
    amount, source = proof
    if amount <= 0:
        return None, False

    record, dirty = ensure_casino_record(client_ip, player)
    if not record:
        return None, dirty
    receipts = record.get("credit_receipts")
    if not isinstance(receipts, dict):
        receipts = {}
        record["credit_receipts"] = receipts
    if award_id in receipts:
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
    receipts[award_id] = current
    while len(receipts) > CREDIT_RECEIPT_LIMIT:
        del receipts[next(iter(receipts))]
    record_credit_event(award_id, client_ip, source, previous, record["credits"])
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


def public_casino_payouts():
    return [
        {
            "symbol": str(item.get("symbol", ""))[:32],
            "label": str(item.get("label", ""))[:32],
            "asset": str(item.get("asset", ""))[:96],
            "two": max(0, safe_int(item.get("two"), 0)),
            "three": max(0, safe_int(item.get("three"), 0)),
            "jackpot": item.get("symbol") == CASINO_JACKPOT_SYMBOL,
        }
        for item in CASINO_SYMBOLS
    ]


def casino_spin_state(client_ip):
    state = CASINO_SPIN_STATE.get(client_ip)
    if state is None:
        record = STATE["records"].get(CASINO_MODE, {}).get(client_ip, {})
        elapsed = max(0, now_ms() - safe_int(record.get("last_spin_at"), 0))
        wait = max(0, CASINO_SPIN_INTERVAL_MS - elapsed)
        state = {"token": secrets.token_hex(24), "issued_at": time.monotonic(), "ready_at": time.monotonic() + wait / 1000, "violations": []}
        CASINO_SPIN_STATE[client_ip] = state
    elif time.monotonic() - state["issued_at"] >= CASINO_TOKEN_TTL_SECONDS:
        state["token"] = secrets.token_hex(24)
        state["issued_at"] = time.monotonic()
    return state


def casino_guard(record):
    source = record.get("casino_guard", {})
    if not isinstance(source, dict):
        source = {}
    current = now_ms()
    stamps = source.get("spin_times", [])
    return {
        "spin_times": sorted(stamp for stamp in stamps if type(stamp) is int and current - stamp < 3_600_000)[-CASINO_HOUR_LIMIT:] if isinstance(stamps, list) else [],
        "blocked_until": max(0, safe_int(source.get("blocked_until"), 0)),
        "block_count": max(0, safe_int(source.get("block_count"), 0)),
    }


def casino_wait(client_ip):
    record = STATE["records"].get(CASINO_MODE, {}).get(client_ip, {})
    guard = casino_guard(record)
    current = now_ms()
    if guard["blocked_until"] > current:
        return guard["blocked_until"] - current, "casino_blocked"
    stamps = guard["spin_times"]
    if len(stamps) >= CASINO_HOUR_LIMIT:
        return max(1, stamps[-CASINO_HOUR_LIMIT] + 3_600_000 - current), "casino_hour_limit"
    recent = [stamp for stamp in stamps if current - stamp < 60_000]
    if len(recent) >= CASINO_MINUTE_LIMIT:
        return max(1, recent[-CASINO_MINUTE_LIMIT] + 60_000 - current), "casino_minute_limit"
    wait = max(0, math.ceil((casino_spin_state(client_ip)["ready_at"] - time.monotonic()) * 1000))
    return wait, "spin_too_fast" if wait else ""


def reject_casino_spin(client_ip, reason):
    if STATE["profiles"].get(client_ip) and reason in ("invalid_bet", "invalid_spin", "spin_conflict", "spin_too_fast"):
        gate = casino_spin_state(client_ip)
        current = time.monotonic()
        gate["violations"] = [stamp for stamp in gate["violations"] if current - stamp < 10]
        gate["violations"].append(current)
        record = STATE["records"].get(CASINO_MODE, {}).get(client_ip)
        if record is not None:
            guard = casino_guard(record)
            if guard["blocked_until"] > now_ms():
                reason = "casino_blocked"
            elif len(gate["violations"]) >= CASINO_VIOLATION_LIMIT:
                guard["block_count"] += 1
                guard["blocked_until"] = now_ms() + min(300_000, CASINO_BLOCK_MS * 2 ** min(guard["block_count"] - 1, 4))
                record["casino_guard"] = guard
                gate["violations"] = []
                balance = record["credits"]
                record_credit_event("block:" + secrets.token_hex(16), client_ip, "casino:block", balance, balance, {"reason": reason, "blocked_until": guard["blocked_until"]})
                save_records()
                reason = "casino_blocked"
    return casino_state_with_result(client_ip, {"ok": False, "reason": reason, "error": reason})


@contextmanager
def casino_transaction(client_ip):
    records = STATE["records"][CASINO_MODE]
    previous = copy.deepcopy(records.get(client_ip))
    casino = copy.deepcopy(STATE["casino"])
    ledger = list(STATE.get("credit_ledger", []))
    gate = copy.deepcopy(CASINO_SPIN_STATE.get(client_ip))
    try:
        yield
    except OSError:
        if previous is None:
            records.pop(client_ip, None)
        else:
            records[client_ip] = previous
        STATE["casino"] = casino
        STATE["credit_ledger"] = ledger
        if gate is None:
            CASINO_SPIN_STATE.pop(client_ip, None)
        else:
            CASINO_SPIN_STATE[client_ip] = gate
        raise


def public_casino_state(client_ip="", create=True):
    owner = record_owner_key(client_ip)
    player = STATE["profiles"].get(owner, "")
    record = None
    dirty = False
    casino_meta, meta_dirty = ensure_casino_meta()
    dirty = dirty or meta_dirty
    if owner and player:
        if create:
            record, dirty = ensure_casino_record(owner, player)
            dirty = dirty or meta_dirty
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
        "jackpot": safe_int(casino_meta.get("jackpot"), CASINO_JACKPOT_SEED),
        "jackpot_symbol": CASINO_JACKPOT_SYMBOL,
        "jackpot_seed": CASINO_JACKPOT_SEED,
        "jackpot_rate_percent": CASINO_JACKPOT_RATE_PERCENT,
        "jackpot_full_bet": CASINO_JACKPOT_FULL_BET,
        "jackpot_min_bet": CASINO_JACKPOT_MIN_BET,
        "spin_token": casino_spin_state(owner)["token"] if owner and player else None,
        "spin_cooldown_ms": casino_wait(owner)[0] if owner and player else 0,
        "casino_wait_reason": casino_wait(owner)[1] if owner and player else "",
        "spins_per_minute": CASINO_MINUTE_LIMIT,
        "spins_per_hour": CASINO_HOUR_LIMIT,
        "big_wins": clean_casino_big_wins(casino_meta.get("big_wins")),
        "payouts": public_casino_payouts(),
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


def casino_jackpot_contribution(bet, remainder=0):
    bet = max(0, safe_int(bet, 0))
    return divmod(bet * CASINO_JACKPOT_RATE_PERCENT + remainder, 100)


def casino_jackpot_share(bank, bet):
    if bank <= 0 or bet < CASINO_JACKPOT_MIN_BET:
        return 0
    return min(bank, max(1, bank * min(bet, CASINO_JACKPOT_FULL_BET) // CASINO_JACKPOT_FULL_BET))


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
    return {
        "symbol": symbol,
        "count": count,
        "payout": payout,
        "net": payout - bet,
    }


def casino_state_with_result(client_ip, result):
    state = public_casino_state(client_ip, create=False)
    state["result"] = result
    return state


def register_casino_spin(payload, client_ip):
    player = STATE["profiles"].get(client_ip, "")
    if not player or clean_player(payload.get("player") or player) != player:
        return casino_state_with_result(client_ip, {"ok": False, "reason": "invalid_player", "error": "invalid_player"})
    if is_player_name_taken(client_ip, player):
        return casino_state_with_result(client_ip, {"ok": False, "reason": "name_taken", "error": "name_taken"})

    bet = payload.get("bet")
    if type(bet) is not int or bet < CASINO_MIN_BET or bet > CASINO_MAX_BET:
        return reject_casino_spin(client_ip, "invalid_bet")

    spin_id = payload.get("spin_token")
    if not isinstance(spin_id, str) or len(spin_id) != 48:
        return reject_casino_spin(client_ip, "invalid_spin")
    existing = STATE["records"].get(CASINO_MODE, {}).get(client_ip, {})
    last_result = existing.get("last_spin_result")
    if spin_id == existing.get("last_spin_id") and isinstance(last_result, dict):
        if bet != last_result.get("bet"):
            return reject_casino_spin(client_ip, "spin_conflict")
        return casino_state_with_result(client_ip, {**last_result, "replayed": True})
    gate = casino_spin_state(client_ip)
    if not secrets.compare_digest(spin_id.encode("utf-8"), gate["token"].encode("utf-8")):
        return reject_casino_spin(client_ip, "invalid_spin")
    wait, reason = casino_wait(client_ip)
    if wait:
        return reject_casino_spin(client_ip, reason)

    dirty = False
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

    try:
        with casino_transaction(client_ip):
            return settle_casino_spin(client_ip, player, record, gate, bet, spin_id)
    except OSError:
        return casino_state_with_result(client_ip, {"ok": False, "reason": "storage_error", "error": "storage_error"})


def settle_casino_spin(client_ip, player, record, gate, bet, spin_id):
    credits = record["credits"]
    casino_meta, _ = ensure_casino_meta()
    jackpot_before = max(0, safe_int(casino_meta.get("jackpot"), CASINO_JACKPOT_SEED))
    jackpot_contribution, remainder = casino_jackpot_contribution(bet, casino_meta["contribution_remainder"])
    symbols = [weighted_casino_symbol() for _ in range(3)]
    spin_value = evaluate_casino_spin(symbols, bet)
    base_payout = max(0, safe_int(spin_value.get("payout"), 0))
    jackpot_hit = spin_value.get("count") >= 3 and spin_value.get("symbol") == CASINO_JACKPOT_SYMBOL and bet >= CASINO_JACKPOT_MIN_BET
    jackpot_total = jackpot_before + jackpot_contribution
    jackpot_win = casino_jackpot_share(jackpot_total, bet) if jackpot_hit else 0
    payout = base_payout + jackpot_win
    net = payout - bet
    current = now_ms()
    previous_credits = credits
    credits = credits - bet + payout
    remaining_bank = jackpot_total - jackpot_win
    casino_meta["jackpot"] = CASINO_JACKPOT_SEED if jackpot_hit and remaining_bank == 0 else remaining_bank
    casino_meta["contribution_remainder"] = remainder

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
            "jackpot": safe_int(casino_meta.get("jackpot"), CASINO_JACKPOT_SEED),
            "jackpot_contribution": jackpot_contribution,
            "jackpot_win": jackpot_win,
            "jackpot_hit": jackpot_hit,
            "created_at": current,
        },
        *clean_casino_history(record.get("history")),
    ][:CASINO_HISTORY_LIMIT]

    is_big_win = net > 0 and (jackpot_hit or net >= max(CASINO_BIG_WIN_THRESHOLD, bet * 10))
    if is_big_win:
        casino_meta["big_wins"] = [
            {
                "player": player,
                "symbols": symbols,
                "bet": bet,
                "payout": payout,
                "net": net,
                "jackpot": jackpot_win,
                "jackpot_hit": jackpot_hit,
                "created_at": current,
            },
            *clean_casino_big_wins(casino_meta.get("big_wins")),
        ][:CASINO_BIG_WINS_LIMIT]

    result = {
            "ok": True,
            "reason": "spin",
            "symbols": symbols,
            "bet": bet,
            "payout": payout,
            "net": net,
            "credits": credits,
            "jackpot": safe_int(casino_meta.get("jackpot"), CASINO_JACKPOT_SEED),
            "jackpot_contribution": jackpot_contribution,
            "jackpot_win": jackpot_win,
            "jackpot_hit": jackpot_hit,
            "big_win": is_big_win,
            "spin_id": spin_id,
        }
    record["last_spin_id"] = spin_id
    record["last_spin_result"] = result
    record["last_spin_at"] = current
    guard = casino_guard(record)
    guard["spin_times"].append(current)
    record["casino_guard"] = guard
    gate["token"] = secrets.token_hex(24)
    gate["issued_at"] = time.monotonic()
    gate["ready_at"] = time.monotonic() + CASINO_SPIN_INTERVAL_MS / 1000
    record_credit_event(f"spin:{spin_id}", client_ip, "casino:spin", previous_credits, credits,
                        {"bet": bet, "payout": payout, "jackpot_win": jackpot_win, "symbols": symbols})
    save_records()
    return casino_state_with_result(client_ip, result)


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
        if current - int(round_data.get("created_at", 0)) <= ROUND_TTL_MS
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
    if STATE["profiles"].get(client_ip) != player:
        return profile_error_response(client_ip, "invalid_player")

    current = now_ms()
    for old_id, old in list(ROUND_STATE["rounds"].items()):
        if old["client_ip"] == client_ip:
            del ROUND_STATE["rounds"][old_id]
    round_id = secrets.token_hex(24)
    game = SapperGame(mode)
    ROUND_STATE["rounds"][round_id] = {
        "client_ip": client_ip,
        "player": player,
        "mode": mode,
        "created_at": current,
        "game": game,
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
        "round": game.snapshot(),
    }


def act_round(payload, client_ip):
    cleanup_rounds_locked()
    round_id = clean_round_id(payload.get("round_id"))
    session = ROUND_STATE["rounds"].get(round_id)
    if not session or session["client_ip"] != client_ip:
        return with_server_notice({"ok": False, "error": "invalid_round"})
    game = session["game"]
    if type(payload.get("revision")) is not int or payload["revision"] != game.revision:
        return with_server_notice({"ok": False, "error": "stale_action", "round": game.snapshot()})
    error = game.action(payload.get("action"), payload.get("index"))
    if error:
        return with_server_notice({"ok": False, "error": error, "round": game.snapshot()})
    response = with_server_notice({"ok": True})
    if game.status in ("won", "lost") and not session["used"]:
        response = register_result({"round_id": round_id, "mode": session["mode"]}, client_ip)
    response["round"] = game.snapshot()
    return response


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
    round_id = clean_round_id(payload.get("round_id"))
    round_data = ROUND_STATE["rounds"].get(round_id)
    mode = str(round_data.get("mode") if round_data else payload.get("mode") or "express")
    if mode not in MODES:
        mode = "express"

    player = clean_player(payload.get("player") or STATE["profiles"].get(client_ip))
    if not player:
        return result_response(mode, {"recorded": False, "reason": "invalid_player", "error": "invalid_player"})
    if is_player_name_taken(client_ip, player):
        return result_response(mode, {"recorded": False, "reason": "name_taken", "error": "name_taken"})

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

    game = round_data.get("game")
    if not game or game.status not in ("won", "lost"):
        return result_response(mode, {"recorded": False, "reason": "unverified_result", "error": "unverified_result"})
    status = game.status
    round_data["used"] = True
    if status == "lost":
        return result_response(mode, attach_credit_summary({"recorded": False, "reason": "lost"}, client_ip, f"sapper:{mode}"))
    seconds = max(1, game.elapsed_ms() // 1000)
    flags, revealed = game.flags, game.revealed

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
                "flags": flags,
                "revealed": revealed,
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
                    "flags": flags,
                    "revealed": revealed,
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

        credit_reward, reward_dirty = add_casino_credits(client_ip, f"sapper:{round_id}")
        if credit_reward:
            result["credit_reward"] = credit_reward
        if reward_dirty:
            dirty = True

    if dirty:
        save_records()

    state = public_state(mode)
    state["result"] = result
    return state


def cleanup_game_sessions(sessions):
    current = now_ms()
    for session_id, session in list(sessions.items()):
        if current - session["created_at"] > ROUND_TTL_MS:
            del sessions[session_id]


def start_tanks_session(payload, client_ip):
    cleanup_game_sessions(TANKS_SESSIONS)
    player = STATE["profiles"].get(client_ip, "")
    if not player or clean_player(payload.get("player") or player) != player:
        return with_server_notice({"ok": False, "error": "invalid_player"})
    for session_id, session in list(TANKS_SESSIONS.items()):
        if session["client_ip"] == client_ip:
            del TANKS_SESSIONS[session_id]
    session_id = secrets.token_hex(24)
    game = TanksGame(god=client_ip in TANKS_GOD_OWNERS)
    TANKS_SESSIONS[session_id] = {"client_ip": client_ip, "player": player, "created_at": now_ms(), "used": False, "game": game}
    return with_server_notice({"ok": True, "session_id": session_id, "game": game.snapshot()})


def control_tanks_session(payload, client_ip):
    cleanup_game_sessions(TANKS_SESSIONS)
    session_id = clean_round_id(payload.get("session_id"))
    session = TANKS_SESSIONS.get(session_id)
    if not session or session["client_ip"] != client_ip:
        return with_server_notice({"ok": False, "error": "invalid_round"})
    game = session["game"]
    if type(payload.get("seq")) is not int or payload["seq"] != game.seq + 1:
        return with_server_notice({"ok": False, "error": "stale_action", "game": game.snapshot()})
    action = payload.get("action", "input")
    if action not in ("input", "pause", "resume", "finish", "cancel"):
        return with_server_notice({"ok": False, "error": "invalid_action"})
    game.advance(god=client_ip in TANKS_GOD_OWNERS)
    game.control(action, payload.get("direction"), payload.get("fire"))
    game.seq += 1
    response = with_server_notice({"ok": True})
    if game.state["status"] == "gameover" and not session["used"]:
        response = register_tanks_result({"session_id": session_id}, client_ip)
    response["game"] = game.snapshot()
    return response


def register_tanks_result(payload, client_ip):
    cleanup_game_sessions(TANKS_SESSIONS)
    session_id = clean_round_id(payload.get("session_id"))
    session = TANKS_SESSIONS.get(session_id)
    if not session or session["client_ip"] != client_ip or session["used"]:
        response = public_tanks_state(client_ip)
        response["result"] = {"recorded": False, "reason": "invalid_round", "error": "invalid_round"}
        return response
    game = session["game"]
    if game.state["status"] != "gameover":
        response = public_tanks_state(client_ip)
        response["result"] = {"recorded": False, "reason": "unverified_result", "error": "unverified_result"}
        return response
    session["used"] = True
    if not game.ranked:
        response = public_tanks_state(client_ip)
        response["result"] = {"recorded": False, "reason": "unranked"}
        return response
    player = session["player"]
    if not player:
        state = public_tanks_state(client_ip)
        state["result"] = {"recorded": False, "reason": "invalid_player", "error": "invalid_player"}
        return state
    if is_player_name_taken(client_ip, player):
        state = public_tanks_state(client_ip)
        state["result"] = {"recorded": False, "reason": "name_taken", "error": "name_taken"}
        return state

    level = game.state["level"]
    score = game.state["score"]
    seconds = max(1, game.state["elapsedSeconds"])
    mistakes = max(0, 3 - game.state["lives"])
    combo = game.state["destroyed"]
    reason = game.reason

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

    credit_reward, reward_dirty = add_casino_credits(client_ip, f"tanks:{session_id}")
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


def register_checkers_singleplayer_result(payload, client_ip):
    cleanup_game_sessions(CHECKERS_BOT_GAMES)
    session = CHECKERS_BOT_GAMES.get(clean_round_id(payload.get("game_id") or payload.get("result_id")))
    valid = bool(session and session["client_ip"] == client_ip)
    won = valid and session["game"]["status"] == "finished" and session["game"]["winner"] == "white"
    # Winning moves award credits once. A claim endpoint never awards anything.
    reason = "duplicate" if won else "unverified_result" if valid else "invalid_round"
    return with_server_notice({"ok": bool(won), "result": {"recorded": False, "reason": reason}})


def checkers_bot_response(session):
    game = session["game"]
    return with_server_notice({"ok": True, "status": game["status"], "game": public_checkers_game(game, game["players"]["white"]["client_id"])})


def start_checkers_bot(payload, client_ip):
    cleanup_game_sessions(CHECKERS_BOT_GAMES)
    player = STATE["profiles"].get(client_ip, "")
    if not player or clean_player(payload.get("player") or player) != player:
        return with_server_notice({"ok": False, "error": "invalid_player"})
    for game_id, session in list(CHECKERS_BOT_GAMES.items()):
        if session["client_ip"] == client_ip:
            del CHECKERS_BOT_GAMES[game_id]
    difficulty = max(1, min(5, safe_int(payload.get("difficulty"), 3)))
    token = secrets.token_hex(24)
    labels = {1: "Легко", 2: "Нормально", 3: "Сложно", 4: "Hard", 5: "Эксперт"}
    game = create_checkers_game(
        {"client_id": token, "client_ip": client_ip, "player": player},
        {"client_id": "bot-" + token, "player": "Бот " + labels[difficulty]},
    )
    del CHECKERS_STATE["games"][game["id"]]
    game.update(id=token, bot_difficulty=difficulty, revision=0)
    session = {"client_ip": client_ip, "player": player, "created_at": now_ms(), "game": game}
    CHECKERS_BOT_GAMES[token] = session
    return checkers_bot_response(session)


def checkers_bot_legal(board, color, forced=None):
    return checkers_capture_moves_for_piece(board, forced) if forced is not None else checkers_legal_moves_for_color(board, color)


def checkers_bot_simulate(board, color, move):
    board = [dict(piece) if piece else None for piece in board]
    piece = board[move["from"]]
    board[move["from"]], board[move["to"]] = None, piece
    if move["capture"] is not None:
        board[move["capture"]] = None
    promote_checkers_piece(piece, move["to"])
    if move["capture"] is not None and checkers_capture_moves_for_piece(board, move["to"]):
        return board, color, move["to"]
    return board, checkers_opponent(color), None


def choose_checkers_bot_move(game):
    board, color, forced = game["board"], game["turn"], game["must_continue_from"]
    level = game["bot_difficulty"]
    budget = [0]
    deadline = time.monotonic() + .25
    node_limit = (400, 1200, 3000, 6000, 10000)[level - 1]

    def evaluate(position):
        total = 0
        for index, piece in enumerate(position):
            if not piece:
                continue
            row, col = divmod(index, 8)
            value = (180 if piece.get("king") else 100) + (row if piece["color"] == "black" else 7 - row) * 5
            value += 10 if 2 <= col <= 5 and 2 <= row <= 5 else 0
            value -= 5 if col in (0, 7) else 0
            total += value if piece["color"] == "black" else -value
        return total

    def search(position, turn, continuation, depth, alpha, beta):
        budget[0] += 1
        if budget[0] > node_limit or time.monotonic() > deadline:
            raise TimeoutError
        moves = checkers_bot_legal(position, turn, continuation)
        if not moves:
            return -100000 - depth if turn == "black" else 100000 + depth
        if depth <= 0:
            return evaluate(position)
        moves.sort(key=lambda move: move["capture"] is None)
        value = float("-inf") if turn == "black" else float("inf")
        for move in moves:
            next_board, next_turn, next_forced = checkers_bot_simulate(position, turn, move)
            score = search(next_board, next_turn, next_forced, depth - 1, alpha, beta)
            if turn == "black":
                value, alpha = max(value, score), max(alpha, score)
            else:
                value, beta = min(value, score), min(beta, score)
            if alpha >= beta:
                break
        return value

    moves = checkers_bot_legal(board, color, forced)
    if not moves:
        return None
    scored = [(0, move) for move in moves]
    pieces_left = sum(bool(piece) for piece in board)
    max_depth = level + 1 + (2 if pieces_left <= 8 else 1 if pieces_left <= 14 else 0)
    for depth in range(1, max_depth + 1):
        try:
            current = []
            for move in moves:
                next_board, next_turn, next_forced = checkers_bot_simulate(board, color, move)
                current.append((search(next_board, next_turn, next_forced, depth - 1, float("-inf"), float("inf")), move))
            scored = sorted(current, key=lambda pair: pair[0], reverse=True)
        except TimeoutError:
            break
    random_chance = {1: .4, 2: .22, 3: .1}.get(level, 0)
    if secrets.SystemRandom().random() < random_chance:
        return secrets.choice(scored[:min(5 - level, len(scored))])[1]
    best = scored[0][0]
    return secrets.choice([move for score, move in scored if score == best])


def move_checkers_bot(payload, client_ip):
    cleanup_game_sessions(CHECKERS_BOT_GAMES)
    session = CHECKERS_BOT_GAMES.get(clean_round_id(payload.get("game_id")))
    if not session or session["client_ip"] != client_ip:
        return with_server_notice({"ok": False, "error": "invalid_round"})
    game = session["game"]
    if game["status"] != "playing":
        return checkers_bot_response(session)
    if type(payload.get("revision")) is not int or payload["revision"] != game["revision"]:
        response = checkers_bot_response(session)
        response.update(ok=False, error="stale_action")
        return response
    error = apply_checkers_move(game, "white", payload.get("from"), payload.get("to"))
    if error:
        response = checkers_bot_response(session)
        response.update(ok=False, error=error)
        return response
    while game["status"] == "playing" and game["turn"] == "black":
        move = choose_checkers_bot_move(game)
        if not move:
            resolve_checkers_winner(game)
            break
        apply_checkers_move(game, "black", move["from"], move["to"])
    return checkers_bot_response(session)


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
        "revision": 0,
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
        "revision": game.get("revision", 0),
        "serverAuthoritative": True,
        "botDifficulty": game.get("bot_difficulty"),
    }


def public_checkers_state(client_id, player=None, client_ip=""):
    client_id = clean_client_id(client_id)
    owned_game = find_checkers_game(client_id)
    owned_entry = find_checkers_queue_entry(client_id)
    if owned_game:
        color = find_checkers_color(owned_game, client_id)
        if owned_game["players"][color].get("client_ip") != client_ip:
            return with_server_notice({"ok": False, "error": "invalid_round"})
    if owned_entry and owned_entry.get("client_ip") != client_ip:
        return with_server_notice({"ok": False, "error": "invalid_round"})
    if player is not None:
        cleaned_player = STATE["profiles"].get(client_ip, "")
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
    if STATE["profiles"].get(client_ip) != player:
        return {"ok": False, "error": "invalid_player", "status": "idle"}
    existing_game = find_checkers_game(client_id)
    existing_entry = find_checkers_queue_entry(client_id)
    if existing_game and existing_game["players"][find_checkers_color(existing_game, client_id)].get("client_ip") != client_ip:
        return {"ok": False, "error": "invalid_round"}
    if existing_entry and existing_entry.get("client_ip") != client_ip:
        return {"ok": False, "error": "invalid_round"}
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


def leave_checkers(payload, client_ip=""):
    cleanup_checkers_locked()
    client_id = clean_client_id(payload.get("client_id"))
    game = find_checkers_game(client_id)
    entry = find_checkers_queue_entry(client_id)
    if game and game["players"][find_checkers_color(game, client_id)].get("client_ip") != client_ip:
        return {"ok": False, "error": "invalid_round"}
    if entry and entry.get("client_ip") != client_ip:
        return {"ok": False, "error": "invalid_round"}
    removed = remove_checkers_queue_entry(client_id)

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

    reward, dirty = add_casino_credits(client_ip, f"checkers:{game['id']}")
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


def move_checkers(payload, client_ip=""):
    cleanup_checkers_locked()
    client_id = clean_client_id(payload.get("client_id"))
    game = find_checkers_game(client_id)
    if not game:
        return {"ok": False, "error": "game_not_found"}
    color = find_checkers_color(game, client_id)
    if not color or game["players"][color].get("client_ip") != client_ip:
        return {"ok": False, "error": "invalid_round"}
    if game["status"] != "playing":
        return public_checkers_state(client_id, client_ip=client_ip)
    if type(payload.get("revision")) is not int or payload["revision"] != game.get("revision", 0):
        return {"ok": False, "error": "stale_action", "game": public_checkers_game(game, client_id)}
    error = apply_checkers_move(game, color, payload.get("from"), payload.get("to"))
    if error:
        return {"ok": False, "error": error, "game": public_checkers_game(game, client_id)}
    return public_checkers_state(client_id, client_ip=client_ip)


def apply_checkers_move(game, color, from_index, to_index):
    if game["status"] != "playing":
        return "game_finished"
    if color != game["turn"]:
        return "not_your_turn"
    if type(from_index) is not int or type(to_index) is not int or not (0 <= from_index < 64 and 0 <= to_index < 64):
        return "bad_move"

    board = game["board"]
    piece = board[from_index]
    if not piece or piece["color"] != color:
        return "bad_piece"

    if game["must_continue_from"] is not None and from_index != game["must_continue_from"]:
        return "must_continue"

    if game["must_continue_from"] is not None:
        valid_moves = checkers_capture_moves_for_piece(board, from_index)
    else:
        captures = checkers_capture_moves_for_color(board, color)
        valid_moves = captures if captures else checkers_simple_moves_for_piece(board, from_index)

    matching_move = next((move for move in valid_moves if move["to"] == to_index), None)
    if not matching_move:
        return "illegal_move"

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
    game["revision"] = game.get("revision", 0) + 1
    resolve_checkers_winner(game)
    return None


class TenderBombHandler(SimpleHTTPRequestHandler):
    server_version = "TenderBombLAN/1.0"

    def setup(self):
        super().setup()
        self.connection.settimeout(10)

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
        if self.headers.get("Transfer-Encoding") or len(self.headers.get_all("Content-Length", [])) != 1:
            raise RequestRejected(400, "invalid_body")
        if self.headers.get_content_type() != "application/json":
            raise RequestRejected(415, "json_required")
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            raise RequestRejected(400, "invalid_body")
        if length <= 0:
            raise RequestRejected(400, "invalid_body")
        if length > 16_384:
            raise RequestRejected(413, "body_too_large")
        raw = self.rfile.read(length)

        def unique_keys(pairs):
            data = {}
            for key, value in pairs:
                if key in data:
                    raise ValueError("duplicate_key")
                data[key] = value
            return data

        def reject_constant(value):
            raise ValueError("invalid_number")

        try:
            data = json.loads(raw.decode("utf-8"), object_pairs_hook=unique_keys, parse_constant=reject_constant)
            if not isinstance(data, dict):
                raise ValueError("object_required")
            return data
        except (ValueError, UnicodeDecodeError, RecursionError):
            raise RequestRejected(400, "invalid_json")

    def do_GET(self):
        parsed = urlparse(self.path)
        path = "/" + posixpath.normpath(unquote(parsed.path).replace("\\", "/")).lstrip("/")
        path = "/".join(part.split(":", 1)[0].rstrip(" .") for part in path.split("/"))
        if (path.startswith("/api/") or path.casefold() == "/leaderboard-records.json") and not REQUEST_LIMITER.allow(self.client_address[0]):
            self.send_json({"ok": False, "error": "too_many_requests", "retry_after_ms": 2000}, 429)
            return
        if path.casefold() == "/leaderboard-records.json":
            with LOCK:
                self.send_json(public_records_snapshot())
            return
        if any(part.startswith(".") or part.casefold() in ("dist", "__pycache__") for part in path.split("/")) or path.casefold().endswith((".bak", ".tmp", ".lock")):
            self.send_error(403)
            return
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
        if path == "/api/chat":
            query = parse_qs(parsed.query)
            after = safe_int((query.get("after") or ["0"])[0], 0)
            with LOCK:
                self.send_json(public_chat_state(after, self.client_address[0]))
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
        if not REQUEST_LIMITER.allow(self.client_address[0]) or (path == "/api/casino/spin" and not REQUEST_LIMITER.allow(self.client_address[0], "casino")):
            self.send_header_retry(429, "too_many_requests")
            return
        origin = self.headers.get("Origin")
        if self.headers.get("Sec-Fetch-Site") == "cross-site" or origin and urlparse(origin).netloc.casefold() != self.headers.get("Host", "").casefold():
            self.send_json({"ok": False, "error": "foreign_origin"}, 403)
            return
        try:
            payload = self.read_json()
        except RequestRejected as exc:
            self.send_json({"ok": False, "error": exc.error}, exc.status)
            return

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

        if path == "/api/chat":
            with LOCK:
                self.send_json(register_chat_message(payload, self.client_address[0]))
            return

        if path == "/api/online/heartbeat":
            with LOCK:
                self.send_json(register_online_heartbeat(payload, self.client_address[0]))
            return

        if path == "/api/round/start":
            with LOCK:
                self.send_json(start_round(payload, self.client_address[0]))
            return

        session_actions = {
            "/api/round/action": act_round,
            "/api/tanks/session/start": start_tanks_session,
            "/api/tanks/session/control": control_tanks_session,
            "/api/checkers/bot/start": start_checkers_bot,
            "/api/checkers/bot/move": move_checkers_bot,
        }
        if path in session_actions:
            with LOCK:
                self.send_json(session_actions[path](payload, self.client_address[0]))
            return

        if path == "/api/checkers/join":
            with LOCK:
                self.send_json(join_checkers(payload, self.client_address[0]))
            return

        if path == "/api/checkers/leave":
            with LOCK:
                self.send_json(leave_checkers(payload, self.client_address[0]))
            return

        if path == "/api/checkers/singleplayer-result":
            with LOCK:
                self.send_json(register_checkers_singleplayer_result(payload, self.client_address[0]))
            return

        if path == "/api/checkers/move":
            with LOCK:
                self.send_json(move_checkers(payload, self.client_address[0]))
            return

        self.send_json({"ok": False, "error": "not_found"}, status=404)

    def send_header_retry(self, status, error):
        body = json.dumps({"ok": False, "error": error, "retry_after_ms": 2000}).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Retry-After", "2")
        self.end_headers()
        self.wfile.write(body)


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


def print_online_players():
    rows = online_rows()
    if not rows:
        print("Online players: 0")
        return
    print(f"Online players: {len(rows)}")
    for row in rows:
        player = row["player"] or "без ника"
        print(f"- {row['ip']} - {player}")


def handle_console_command(line):
    command = str(line or "").strip()
    if not command:
        return
    lowered = command.casefold()
    if lowered in {"exit", "quit", "stop"}:
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
    if lowered == "list":
        with LOCK:
            print_online_players()
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
    print("Unknown command. Available: list, god <nick>, ungod <nick>, stealth, restart, exit, quit, stop")


def console_command_loop():
    while True:
        try:
            line = sys.stdin.readline()
        except OSError:
            return
        if not line:
            return
        handle_console_command(line)


def run_server():
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

    print("Commands: list, god <nick>, ungod <nick>, stealth, restart, exit, quit, stop")
    print("Keep this window open while colleagues are playing.")
    print()

    try:
        server = TenderBombHTTPServer(("0.0.0.0", port), TenderBombHandler)
    except OSError as exc:
        print(f"Порт {port} уже занят. Закройте старое окно сервера TenderBomb и запустите сервер снова.")
        print(f"Details: {exc}")
        sys.exit(1)
    SERVER_CONTROL["server"] = server
    threading.Thread(target=console_command_loop, daemon=True).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServer stopped.")
    finally:
        server.server_close()
        SERVER_CONTROL["server"] = None


def main():
    try:
        with record_store_lock(RECORDS_PATH):
            run_server()
    except RecordStoreBusy as exc:
        print(f"Файл рекордов уже используется другим сервером. Закройте старый процесс перед запуском. {exc}")
        sys.exit(1)

    if SERVER_CONTROL.get("restart"):
        SERVER_CONTROL["restart"] = False
        os.execv(sys.executable, [sys.executable, *sys.argv])

    if SERVER_CONTROL.get("stealth"):
        SERVER_CONTROL["stealth"] = False
        launch_tray_server()
        sys.exit(77)


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
GhostChat - anonymer Messenger (Web-App).

  * Anmeldung nur mit Nickname + Passwort (keine Mail, keine Telefonnummer)
  * Raeume: Lobby (oeffentlich), Gruppen, 1:1-Gespraeche
  * Marktplatz fuer private Anzeigen
  * Sprachanrufe ueber den Server (Audio-Relay, PCM-Weiterleitung)
  * Speicherung lokal in SQLite, keine externen Dienste

Start:   python server.py            (http://127.0.0.1:8080)
Optionen:
  GHOSTCHAT_PORT=8080   GHOSTCHAT_HOST=0.0.0.0   GHOSTCHAT_DB=pfad.db
"""

import json
import os
import secrets
import sqlite3
import struct
import threading
import time
from hashlib import pbkdf2_hmac

from flask import Flask, abort, jsonify, request, send_from_directory
from simple_websocket import ConnectionClosed, Server as WSServer

BASE = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get("GHOSTCHAT_DB", os.path.join(BASE, "ghostchat.db"))
HOST = os.environ.get("GHOSTCHAT_HOST", "0.0.0.0")
PORT = int(os.environ.get("GHOSTCHAT_PORT") or os.environ.get("PORT") or 8080)
PBKDF2_ROUNDS = 120_000
MAX_MSG = 4000

app = Flask(__name__, static_folder="static", template_folder="templates")
db_lock = threading.RLock()


# ------------------------------------------------------------------ Datenbank
def connect():
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    return conn


def query(sql, args=(), one=False):
    with db_lock:
        conn = connect()
        try:
            rows = conn.execute(sql, args).fetchall()
            return (rows[0] if rows else None) if one else rows
        finally:
            conn.close()


def write(sql, args=()):
    with db_lock:
        conn = connect()
        try:
            cur = conn.execute(sql, args)
            conn.commit()
            return cur.lastrowid
        finally:
            conn.close()


SCHEMA = """
CREATE TABLE IF NOT EXISTS users(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nick TEXT NOT NULL UNIQUE COLLATE NOCASE,
    pw_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    created REAL NOT NULL,
    is_system INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sessions(
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS rooms(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    name TEXT,
    dm_key TEXT UNIQUE,
    created REAL NOT NULL,
    owner INTEGER
);
CREATE TABLE IF NOT EXISTS members(
    room_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    last_read REAL NOT NULL DEFAULT 0,
    PRIMARY KEY(room_id, user_id)
);
CREATE TABLE IF NOT EXISTS messages(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    text TEXT NOT NULL,
    created REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_msg_room ON messages(room_id, id);
CREATE TABLE IF NOT EXISTS listings(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    seller INTEGER NOT NULL,
    title TEXT NOT NULL,
    price TEXT NOT NULL DEFAULT '',
    descr TEXT NOT NULL DEFAULT '',
    created REAL NOT NULL,
    open INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS calllog(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id INTEGER NOT NULL,
    started REAL NOT NULL,
    ended REAL NOT NULL DEFAULT 0,
    who TEXT NOT NULL DEFAULT ''
);
"""


def hash_password(password, salt):
    return pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("utf-8"),
                       PBKDF2_ROUNDS).hex()


def init_db():
    with db_lock:
        conn = connect()
        try:
            conn.executescript(SCHEMA)
            conn.commit()
        finally:
            conn.close()
    seed()


def seed():
    """System-Account + oeffentliche Lobby anlegen."""
    now = time.time()
    system = query("SELECT id FROM users WHERE is_system=1", one=True)
    if not system:
        salt = secrets.token_hex(16)
        write("INSERT INTO users(nick, pw_hash, salt, created, is_system) "
              "VALUES(?,?,?,?,1)",
              ("ghost", hash_password(secrets.token_urlsafe(24), salt), salt, now))
    lobby = query("SELECT id FROM rooms WHERE kind='public'", one=True)
    if not lobby:
        room_id = write("INSERT INTO rooms(kind, name, created) VALUES('public',?,?)",
                        ("Lobby", now))
        write("INSERT INTO messages(room_id, user_id, text, created) "
              "SELECT ?, id, ?, ? FROM users WHERE is_system=1",
              (room_id,
               "Willkommen in der Lobby. Hier ist alles anonym - nur ein "
               "Nickname, keine Mail, keine Nummer. Bitte keine privaten "
               "Daten von anderen Personen posten.",
               now + 0.1))


# ------------------------------------------------------------------ Nutzer
def clean_nick(raw):
    nick = " ".join(str(raw or "").split())
    if not 2 <= len(nick) <= 24:
        return None
    if any(not (ch.isalnum() or ch in "_.- ") for ch in nick):
        return None
    return nick


def user_by_nick(nick):
    return query("SELECT * FROM users WHERE nick=?", (str(nick or "").strip(),), one=True)


def make_session(user_id):
    token = secrets.token_urlsafe(28)
    write("INSERT INTO sessions(token, user_id, created) VALUES(?,?,?)",
          (token, user_id, time.time()))
    return token


def current_user():
    auth = request.headers.get("Authorization", "")
    token = auth[7:] if auth.startswith("Bearer ") else request.args.get("token", "")
    if not token:
        return None
    return query(
        "SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=?",
        (token,), one=True)


def require_user():
    user = current_user()
    if not user:
        abort(401)
    return user


def member_uids(room_id):
    return [r["user_id"] for r in query(
        "SELECT user_id FROM members WHERE room_id=?", (room_id,))]


def is_member(room_id, user_id):
    return query("SELECT 1 FROM members WHERE room_id=? AND user_id=?",
                 (room_id, user_id), one=True) is not None


# ------------------------------------------------------------------ Hub / Anrufe
class Hub:
    """Verwaltet Websocket-Verbindungen und laufende Anrufe."""

    def __init__(self):
        self.lock = threading.RLock()
        self.conns = {}          # user_id -> [(ws, send_lock), ...]
        self.calls = {}          # room_id -> {user_id: {"rate": int, "nick": str}}
        self.call_started = {}   # room_id -> timestamp
        self.last_send = {}      # user_id -> timestamp (Throttle)

    def add(self, user_id, ws):
        with self.lock:
            self.conns.setdefault(user_id, []).append([ws, threading.Lock()])

    def remove(self, user_id, ws):
        with self.lock:
            entries = self.conns.get(user_id, [])
            for entry in list(entries):
                if entry[0] is ws:
                    entries.remove(entry)
            if not entries:
                self.conns.pop(user_id, None)
        # Verbindung weg -> aus allen Anrufen raus
        for room_id in list(self.calls):
            if user_id in self.calls.get(room_id, {}):
                leave_call(user_id, room_id, reason="getrennt")

    def send_json(self, user_ids, payload):
        data = json.dumps(payload, ensure_ascii=False)
        for uid in set(user_ids):
            with self.lock:
                entries = list(self.conns.get(uid, []))
            for ws, block in entries:
                try:
                    with block:
                        ws.send(data)
                except Exception:
                    pass

    def send_bytes(self, user_ids, blob, exclude=None):
        for uid in set(user_ids):
            if exclude is not None and uid == exclude:
                continue
            with self.lock:
                entries = list(self.conns.get(uid, []))
            for ws, block in entries:
                try:
                    with block:
                        ws.send(blob)
                except Exception:
                    pass


hub = Hub()


def broadcast_room(room_id, payload, only_members=True):
    uids = member_uids(room_id) if only_members else [
        r["id"] for r in query("SELECT id FROM users")]
    hub.send_json(uids, payload)


def call_participants(room_id):
    with hub.lock:
        return dict(hub.calls.get(room_id, {}))


def call_state_payload(room_id):
    parts = call_participants(room_id)
    return {
        "type": "call_state",
        "room": room_id,
        "active": bool(parts),
        "started": hub.call_started.get(room_id, 0),
        "participants": [{"nick": v["nick"], "rate": v["rate"]}
                         for v in parts.values()],
    }


def broadcast_call_state(room_id):
    broadcast_room(room_id, call_state_payload(room_id))


def join_call(user, room_id, rate):
    if not is_member(room_id, user["id"]):
        return
    with hub.lock:
        first = room_id not in hub.calls or not hub.calls[room_id]
        hub.calls.setdefault(room_id, {})[user["id"]] = {
            "rate": int(rate or 48000), "nick": user["nick"]}
        if first:
            hub.call_started[room_id] = time.time()
        here = list(hub.calls.get(room_id, {}))
    print(f"[call] join room={room_id} user={user['nick']} da={here}", flush=True)
    broadcast_call_state(room_id)


def leave_call(user_id, room_id, reason="aufgelegt"):
    row = query("SELECT nick FROM users WHERE id=?", (user_id,), one=True)
    nick = row["nick"] if row else "?"
    with hub.lock:
        room = hub.calls.get(room_id, {})
        room.pop(user_id, None)
        if not room:
            started = hub.call_started.pop(room_id, 0)
            hub.calls.pop(room_id, None)
        else:
            started = hub.call_started.get(room_id, 0)
            started = started or 0
        here = list(hub.calls.get(room_id, {}))
    print(f"[call] leave room={room_id} user={nick} da={here} "
          f"started={started}", flush=True)
    if not call_participants(room_id):
        if started:
            nicks = ", ".join(sorted({
                r["nick"] for r in query(
                    "SELECT nick FROM users WHERE id IN (SELECT user_id FROM members WHERE room_id=?)",
                    (room_id,))}))
            write("INSERT INTO calllog(room_id, started, ended, who) VALUES(?,?,?,?)",
                  (room_id, started, time.time(), nicks))
    broadcast_call_state(room_id)


# ------------------------------------------------------------------ API: Auth
@app.post("/api/register")
def api_register():
    data = request.get_json(silent=True) or {}
    nick = clean_nick(data.get("nick"))
    password = str(data.get("password") or "")
    if not nick:
        return jsonify(error="Nickname: 2-24 Zeichen, nur Buchstaben, Zahlen, _ . -"), 400
    if len(password) < 4:
        return jsonify(error="Passwort braucht mindestens 4 Zeichen"), 400
    salt = secrets.token_hex(16)
    try:
        user_id = write(
            "INSERT INTO users(nick, pw_hash, salt, created) VALUES(?,?,?,?)",
            (nick, hash_password(password, salt), salt, time.time()))
    except sqlite3.IntegrityError:
        return jsonify(error="Dieser Nickname ist bereits vergeben"), 409
    for room in query("SELECT id FROM rooms WHERE kind='public'"):
        write("INSERT OR IGNORE INTO members(room_id, user_id) VALUES(?,?)",
              (room["id"], user_id))
    token = make_session(user_id)
    return jsonify(token=token, user=public_user(user_id, nick))


@app.post("/api/login")
def api_login():
    data = request.get_json(silent=True) or {}
    user = user_by_nick(data.get("nick"))
    password = str(data.get("password") or "")
    if not user or user["pw_hash"] != hash_password(password, user["salt"]):
        return jsonify(error="Nickname oder Passwort stimmt nicht"), 403
    token = make_session(user["id"])
    return jsonify(token=token, user=public_user(user["id"], user["nick"]))


def public_user(user_id, nick):
    return {"id": user_id, "nick": nick}


@app.get("/api/me")
def api_me():
    user = require_user()
    return jsonify(user=public_user(user["id"], user["nick"]))


@app.post("/api/logout")
def api_logout():
    user = require_user()
    auth = request.headers.get("Authorization", "")
    token = auth[7:] if auth.startswith("Bearer ") else ""
    if token:
        write("DELETE FROM sessions WHERE token=?", (token,))
    return jsonify(ok=True, nick=user["nick"])


# ------------------------------------------------------------------ API: Raeume
def room_payload(row, viewer_id):
    kind = row["kind"]
    members = [r["nick"] for r in query(
        "SELECT u.nick FROM members m JOIN users u ON u.id=m.user_id "
        "WHERE m.room_id=? ORDER BY u.nick", (row["id"],))]
    last = query(
        "SELECT m.id, m.text, m.created, u.nick FROM messages m "
        "JOIN users u ON u.id=m.user_id WHERE m.room_id=? "
        "ORDER BY m.id DESC LIMIT 1", (row["id"],), one=True)
    last_read = query(
        "SELECT last_read FROM members WHERE room_id=? AND user_id=?",
        (row["id"], viewer_id), one=True)
    unread = query(
        "SELECT COUNT(*) AS c FROM messages WHERE room_id=? AND created>? "
        "AND user_id!=?", (row["id"], last_read["last_read"] if last_read else 0,
                           viewer_id), one=True)["c"]
    title = row["name"] or ""
    if kind == "dm":
        others = [n for n in members if n.lower() != _nick_of(viewer_id).lower()]
        title = others[0] if others else _nick_of(viewer_id)
    return {
        "id": row["id"], "kind": kind, "title": title, "members": members,
        "unread": unread,
        "last": {"text": last["text"], "created": last["created"],
                 "nick": last["nick"]} if last else None,
        "created": row["created"],
    }


def _nick_of(user_id):
    row = query("SELECT nick FROM users WHERE id=?", (user_id,), one=True)
    return row["nick"] if row else "?"


@app.get("/api/rooms")
def api_rooms():
    user = require_user()
    rows = query(
        "SELECT r.*, m.last_read FROM rooms r "
        "JOIN members m ON m.room_id=r.id AND m.user_id=? "
        "ORDER BY r.kind='public' DESC, r.id", (user["id"],))
    rooms = [room_payload(r, user["id"]) for r in rows]
    rooms.sort(key=lambda x: x["last"]["created"] if x["last"] else x["created"],
               reverse=True)
    return jsonify(rooms=rooms)


@app.post("/api/rooms")
def api_create_room():
    user = require_user()
    data = request.get_json(silent=True) or {}
    kind = data.get("kind")
    now = time.time()
    if kind == "dm":
        other = user_by_nick(data.get("nick"))
        if not other or other["id"] == user["id"]:
            return jsonify(error="Unbekannter Nickname"), 404
        a, b = sorted([user["id"], other["id"]])
        dm_key = f"{a}:{b}"
        room = query("SELECT * FROM rooms WHERE dm_key=?", (dm_key,), one=True)
        if room:
            write("INSERT OR IGNORE INTO members(room_id, user_id) VALUES(?,?)",
                  (room["id"], user["id"]))
            return jsonify(room=room_payload(room, user["id"]))
        room_id = write("INSERT INTO rooms(kind, name, dm_key, created, owner) "
                        "VALUES('dm', NULL, ?, ?, ?)", (dm_key, now, user["id"]))
        write("INSERT OR IGNORE INTO members(room_id, user_id) VALUES(?,?)",
              (room_id, user["id"]))
        write("INSERT OR IGNORE INTO members(room_id, user_id) VALUES(?,?)",
              (room_id, other["id"]))
        room = query("SELECT * FROM rooms WHERE id=?", (room_id,), one=True)
        return jsonify(room=room_payload(room, user["id"]))

    if kind == "group":
        name = " ".join(str(data.get("name") or "").split())[:40]
        if len(name) < 2:
            return jsonify(error="Gruppenname zu kurz"), 400
        room_id = write("INSERT INTO rooms(kind, name, created, owner) "
                        "VALUES('group', ?, ?, ?)", (name, now, user["id"]))
        write("INSERT INTO members(room_id, user_id) VALUES(?,?)",
              (room_id, user["id"]))
        invited = data.get("members") or []
        if isinstance(invited, list):
            for nick in invited[:40]:
                other = user_by_nick(nick)
                if other:
                    write("INSERT OR IGNORE INTO members(room_id, user_id) "
                          "VALUES(?,?)", (room_id, other["id"]))
        room = query("SELECT * FROM rooms WHERE id=?", (room_id,), one=True)
        return jsonify(room=room_payload(room, user["id"]))

    return jsonify(error="Unbekannter Raum-Typ"), 400


@app.post("/api/rooms/<int:room_id>/join")
def api_join_room(room_id):
    user = require_user()
    room = query("SELECT * FROM rooms WHERE id=?", (room_id,), one=True)
    if not room:
        return jsonify(error="Raum unbekannt"), 404
    write("INSERT OR IGNORE INTO members(room_id, user_id) VALUES(?,?)",
          (room_id, user["id"]))
    return jsonify(room=room_payload(room, user["id"]))


@app.get("/api/rooms/<int:room_id>/messages")
def api_messages(room_id):
    user = require_user()
    if not is_member(room_id, user["id"]):
        return jsonify(error="Kein Zugriff"), 403
    before = request.args.get("before", type=int) or 0
    limit = min(request.args.get("limit", type=int) or 50, 200)
    sql = ("SELECT m.id, m.room_id, m.user_id, m.text, m.created, u.nick, "
           "u.is_system FROM messages m JOIN users u ON u.id=m.user_id "
           "WHERE m.room_id=?")
    args = [room_id]
    if before:
        sql += " AND m.id<?"
        args.append(before)
    sql += " ORDER BY m.id DESC LIMIT ?"
    args.append(limit)
    rows = list(reversed(query(sql, tuple(args))))
    reads = {r["nick"]: r["last_read"] for r in query(
        "SELECT u.nick, m.last_read FROM members m JOIN users u ON u.id=m.user_id "
        "WHERE m.room_id=?", (room_id,))}
    messages = [{
        "id": r["id"], "room": r["room_id"], "uid": r["user_id"],
        "nick": r["nick"], "text": r["text"], "created": r["created"],
        "system": bool(r["is_system"]),
    } for r in rows]
    return jsonify(messages=messages, reads=reads, me=user["id"])


@app.post("/api/rooms/<int:room_id>/read")
def api_read(room_id):
    user = require_user()
    data = request.get_json(silent=True) or {}
    ts = float(data.get("ts") or time.time())
    if is_member(room_id, user["id"]):
        write("UPDATE members SET last_read=? WHERE room_id=? AND user_id=? "
              "AND last_read<?", (ts, room_id, user["id"], ts))
    return jsonify(ok=True)


@app.get("/api/users")
def api_users():
    user = require_user()
    q = str(request.args.get("q") or "").strip()
    if not q:
        return jsonify(users=[])
    rows = query(
        "SELECT nick FROM users WHERE is_system=0 AND nick!=? AND nick LIKE ? "
        "ORDER BY nick LIMIT 12", (user["nick"], q.replace("%", "") + "%"))
    return jsonify(users=[r["nick"] for r in rows])


def build_message(user, room_id, text):
    """Nachricht speichern; None bei Ablehnung."""
    text = str(text or "").strip()
    if not text or len(text) > MAX_MSG:
        return None
    if not room_id or not is_member(room_id, user["id"]):
        return None
    now = time.time()
    msg_id = write("INSERT INTO messages(room_id, user_id, text, created) "
                   "VALUES(?,?,?,?)", (room_id, user["id"], text, now))
    return {"id": msg_id, "room": room_id, "uid": user["id"],
            "nick": user["nick"], "text": text, "created": now,
            "system": bool(user["is_system"])}


@app.post("/api/rooms/<int:room_id>/messages")
def api_send_message(room_id):
    user = require_user()
    data = request.get_json(silent=True) or {}
    msg = build_message(user, room_id, data.get("text"))
    if not msg:
        return jsonify(error="Nachricht nicht gesendet"), 400
    broadcast_room(room_id, {"type": "msg", "room": room_id, "msg": msg})
    return jsonify(msg=msg)


@app.get("/api/rooms/<int:room_id>/reads")
def api_reads(room_id):
    user = require_user()
    if not is_member(room_id, user["id"]):
        return jsonify(error="Kein Zugriff"), 403
    reads = {r["nick"]: r["last_read"] for r in query(
        "SELECT u.nick, m.last_read FROM members m JOIN users u ON u.id=m.user_id "
        "WHERE m.room_id=?", (room_id,))}
    return jsonify(reads=reads, me=user["id"])


@app.get("/api/rooms/<int:room_id>/call")
def api_room_call(room_id):
    user = require_user()
    if not is_member(room_id, user["id"]):
        return jsonify(error="Kein Zugriff"), 403
    return jsonify(call_state_payload(room_id))


# ------------------------------------------------------------------ API: Marktplatz
@app.get("/api/market")
def api_market():
    user = require_user()
    rows = query(
        "SELECT * FROM listings ORDER BY open DESC, id DESC LIMIT 100")
    return jsonify(items=[{
        "id": r["id"], "title": r["title"], "price": r["price"],
        "descr": r["descr"], "seller": r["seller"],
        "open": bool(r["open"]), "created": r["created"],
        "mine": r["seller"].lower() == user["nick"].lower(),
    } for r in rows])


@app.post("/api/market")
def api_market_create():
    user = require_user()
    data = request.get_json(silent=True) or {}
    title = " ".join(str(data.get("title") or "").split())[:80]
    price = " ".join(str(data.get("price") or "").split())[:24]
    descr = str(data.get("descr") or "").strip()[:600]
    if len(title) < 3:
        return jsonify(error="Titel zu kurz"), 400
    item_id = write(
        "INSERT INTO listings(seller, title, price, descr, created) VALUES(?,?,?,?,?)",
        (user["nick"], title, price, descr, time.time()))
    return jsonify(id=item_id)


@app.post("/api/market/<int:item_id>/toggle")
def api_market_toggle(item_id):
    user = require_user()
    row = query("SELECT * FROM listings WHERE id=?", (item_id,), one=True)
    if not row or row["seller"] != user["nick"]:
        return jsonify(error="Nicht deine Anzeige"), 403
    write("UPDATE listings SET open=CASE open WHEN 1 THEN 0 ELSE 1 END WHERE id=?",
          (item_id,))
    return jsonify(ok=True)


# ------------------------------------------------------------------ API: Anrufe
@app.get("/api/calls")
def api_calls():
    require_user()
    rows = query(
        "SELECT c.id, c.room_id, c.started, c.ended, c.who, r.name, r.kind "
        "FROM calllog c LEFT JOIN rooms r ON r.id=c.room_id "
        "ORDER BY c.id DESC LIMIT 50")
    return jsonify(calls=[{
        "id": r["id"], "room": r["room_id"], "started": r["started"],
        "ended": r["ended"], "who": r["who"], "name": r["name"],
        "kind": r["kind"],
        "duration": max(0, int((r["ended"] or r["started"]) - r["started"])),
    } for r in rows])


# ------------------------------------------------------------------ Websocket
def handle_text(user, ws, raw):
    try:
        data = json.loads(raw)
    except Exception:
        return
    kind = data.get("type")
    room_id = int(data.get("room") or 0)

    if kind == "send":
        text = str(data.get("text") or "").strip()
        if not text or len(text) > MAX_MSG or not room_id:
            return
        if not is_member(room_id, user["id"]):
            return
        now = time.time()
        with hub.lock:
            last = hub.last_send.get(user["id"], 0)
            if now - last < 0.25:
                return
            hub.last_send[user["id"]] = now
        msg = build_message(user, room_id, text)
        if not msg:
            return
        broadcast_room(room_id, {"type": "msg", "room": room_id, "msg": msg})
        return

    if kind == "typing":
        if room_id and is_member(room_id, user["id"]):
            uids = [u for u in member_uids(room_id) if u != user["id"]]
            hub.send_json(uids, {"type": "typing", "room": room_id,
                                 "nick": user["nick"]})
        return

    if kind == "call_join":
        if room_id and is_member(room_id, user["id"]):
            join_call(user, room_id, data.get("rate"))
        return

    if kind == "call_leave":
        if room_id:
            leave_call(user["id"], room_id)
        return

    if kind == "ping":
        hub.send_json([user["id"]], {"type": "pong"})
        return


def handle_audio(user, blob):
    if len(blob) < 6:
        return
    (room_id,) = struct.unpack(">I", blob[:4])
    parts = call_participants(room_id)
    if user["id"] not in parts:
        return
    hub.send_bytes(list(parts), blob, exclude=user["id"])


@app.get("/ws", websocket=True)
def ws_endpoint():
    user = current_user()
    if not user:
        abort(401)
    try:
        ws = WSServer.accept(request.environ, ping_interval=25)
    except Exception as exc:
        print("[ws] handshake fehlgeschlagen:", exc)
        abort(400)
    if ws is None:
        abort(400)
    hub.add(user["id"], ws)
    hub.send_json([user["id"]], {"type": "ready", "you": user["nick"]})
    try:
        while True:
            message = ws.receive()
            if message is None:
                break
            if isinstance(message, (bytes, bytearray)):
                handle_audio(user, bytes(message))
            else:
                try:
                    handle_text(user, ws, message)
                except Exception as exc:      # pragma: no cover - defensive
                    print("[ws] Fehler:", exc)
    except ConnectionClosed:
        pass
    except Exception as exc:                  # pragma: no cover - defensive
        print("[ws]", exc)
    finally:
        hub.remove(user["id"], ws)
    return ""


# ------------------------------------------------------------------ Seiten
@app.get("/")
def index():
    return send_from_directory(os.path.join(BASE, "templates"), "index.html")


@app.get("/healthz")
def healthz():
    return jsonify(ok=True, app="ghostchat", time=time.time())


@app.errorhandler(401)
def unauthorized(_err):
    return jsonify(error="Nicht angemeldet"), 401


def main():
    init_db()
    print("=" * 60)
    print("  GhostChat  -  anonymer Messenger")
    print(f"  Lokal:   http://127.0.0.1:{PORT}")
    print(f"  DB:      {DB_PATH}")
    print("=" * 60)
    app.run(host=HOST, port=PORT, threaded=True, debug=False)


if __name__ == "__main__":
    main()

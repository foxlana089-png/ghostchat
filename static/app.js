/* GhostChat – Oberfläche, Websocket, Marktplatz, Sprachanrufe */
"use strict";

/* ---------------------------------------------------------- Helfer */
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = text;
  return n;
}

const state = {
  token: localStorage.getItem("gc_token") || null,
  me: null,
  rooms: [],
  msgs: {},
  reads: {},
  activeRoom: null,
  tab: "chats",
  ws: null,
  market: [],
  editId: null,
  calls: [],
  callStates: {},
  call: null,
  typing: {},
  playCtx: null,
  nextPlay: 0,
  toastTimer: null,
  reconnectDelay: 1000,
};

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || (opts.body ? "POST" : "GET"),
    headers: Object.assign(
      { "Content-Type": "application/json" },
      state.token ? { Authorization: "Bearer " + state.token } : {}
    ),
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch (e) { /* leer */ }
  if (!res.ok) throw new Error(data.error || ("Fehler " + res.status));
  return data;
}

function toast(text, ms = 2800) {
  const t = $("#toast");
  t.textContent = text;
  t.classList.remove("hidden");
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => t.classList.add("hidden"), ms);
}

const AV = [
  "linear-gradient(135deg,#4fae4e,#2b7f7a)",
  "linear-gradient(135deg,#5b8def,#7c5cff)",
  "linear-gradient(135deg,#f0a63a,#e05252)",
  "linear-gradient(135deg,#3ec8c8,#2b6fa8)",
  "linear-gradient(135deg,#e06bb0,#8a4fd0)",
  "linear-gradient(135deg,#8fd34f,#2f9e5b)",
];

function setAvatar(node, nick) {
  const name = String(nick || "?");
  node.textContent = name.slice(0, 1).toUpperCase();
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 9973;
  node.style.background = AV[h % AV.length];
}

function fmtTime(ts) {
  return new Date(ts * 1000).toLocaleTimeString("de-DE",
    { hour: "2-digit", minute: "2-digit" });
}

function dayKey(ts) {
  const d = new Date(ts * 1000);
  return d.getFullYear() + "-" + d.getMonth() + "-" + d.getDate();
}

function fmtDayLabel(ts) {
  const d = new Date(ts * 1000);
  const today = new Date();
  const yest = new Date(Date.now() - 86400000);
  if (dayKey(ts) === dayKey(today.getTime() / 1000)) return "Heute";
  if (dayKey(ts) === dayKey(yest.getTime() / 1000)) return "Gestern";
  return d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function listTime(ts) {
  const today = dayKey(Date.now() / 1000);
  if (dayKey(ts) === today) return fmtTime(ts);
  return new Date(ts * 1000).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" });
}

function dur(sec) {
  sec = Math.max(0, Math.floor(sec));
  const m = Math.floor(sec / 60), s = sec % 60;
  return String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
}

function linkify(text) {
  const frag = document.createDocumentFragment();
  const re = /(https?:\/\/[^\s<>"']+)/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
    const a = el("a");
    a.href = m[1];
    a.textContent = m[1];
    a.target = "_blank";
    a.rel = "noopener noreferrer nofollow";
    frag.appendChild(a);
    last = m.index + m[0].length;
  }
  if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
  return frag;
}

function beep() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = state.playCtx || (state.playCtx = new Ctx());
    if (ctx.state === "suspended") ctx.resume();
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = "sine";
    o.frequency.setValueAtTime(880, ctx.currentTime);
    o.frequency.exponentialRampToValueAtTime(620, ctx.currentTime + 0.12);
    g.gain.setValueAtTime(0.06, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.2);
    o.connect(g); g.connect(ctx.destination);
    o.start(); o.stop(ctx.currentTime + 0.22);
  } catch (e) { /* ohne Ton auskommen */ }
}

/* ---------------------------------------------------------- Anmeldung */
$("#authForm").addEventListener("submit", (e) => { e.preventDefault(); doAuth("login"); });
$("#btnRegister").addEventListener("click", () => doAuth("register"));

async function doAuth(mode) {
  const nick = $("#nick").value.trim();
  const pw = $("#pw").value;
  const err = $("#authError");
  err.textContent = "";
  if (nick.length < 2) { err.textContent = "Nickname braucht mindestens 2 Zeichen."; return; }
  if (pw.length < 4) { err.textContent = "Passwort braucht mindestens 4 Zeichen."; return; }
  try {
    const data = await api(mode === "login" ? "/api/login" : "/api/register",
      { body: { nick, password: pw } });
    state.token = data.token;
    state.me = data.user;
    localStorage.setItem("gc_token", state.token);
    await enterApp();
  } catch (e) {
    err.textContent = e.message;
  }
}

async function boot() {
  if (state.token) {
    try {
      const data = await api("/api/me");
      state.me = data.user;
      await enterApp();
      return;
    } catch (e) {
      localStorage.removeItem("gc_token");
      state.token = null;
    }
  }
  $("#auth").classList.remove("hidden");
}

$("#btnLogout").addEventListener("click", async () => {
  try { await api("/api/logout", { body: {} }); } catch (e) { /* egal */ }
  localStorage.removeItem("gc_token");
  location.reload();
});

/* ---------------------------------------------------------- App starten */
async function enterApp() {
  $("#auth").classList.add("hidden");
  $("#app").classList.remove("hidden");
  $("#meNick").textContent = state.me.nick;
  setAvatar($("#meAvatar"), state.me.nick);
  await loadRooms();
  await Promise.all([loadMarket(), loadCalls()]);
  connectWS();
  if (!state.activeRoom && state.rooms.length) openRoom(state.rooms[0].id);
  renderChatList();
}

async function loadRooms() {
  const data = await api("/api/rooms");
  state.rooms = data.rooms;
  renderChatList();
}

/* ---------------------------------------------------------- Websocket */
function connectWS() {
  if (state.ws && state.ws.readyState <= 1) return;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  let ws;
  try {
    ws = new WebSocket(proto + "://" + location.host + "/ws?token=" +
      encodeURIComponent(state.token));
  } catch (e) {
    setTimeout(connectWS, 3000);
    return;
  }
  ws.binaryType = "arraybuffer";
  state.ws = ws;
  ws.onopen = () => {
    state.reconnectDelay = 1000;
    $("#meStatus").textContent = "verbunden";
  };
  ws.onmessage = (ev) => {
    if (typeof ev.data === "string") {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      handleWS(msg);
    } else {
      onAudioChunk(ev.data);
    }
  };
  ws.onclose = () => {
    state.ws = null;
    $("#meStatus").textContent = "getrennt – versuche erneut…";
    setTimeout(connectWS, state.reconnectDelay);
    state.reconnectDelay = Math.min(15000, state.reconnectDelay * 1.7);
  };
  ws.onerror = () => { try { ws.close(); } catch (e) { /* egal */ } };
}

function wsSend(obj) {
  if (state.ws && state.ws.readyState === 1) {
    state.ws.send(typeof obj === "string" ? obj : JSON.stringify(obj));
    return true;
  }
  return false;
}

function handleWS(msg) {
  switch (msg.type) {
    case "msg": onIncoming(msg.msg); break;
    case "typing": onTyping(msg); break;
    case "call_state": onCallState(msg); break;
    case "ready": break;
    default: break;
  }
}

/* ---------------------------------------------------------- Chats */
async function openRoom(id) {
  state.activeRoom = id;
  state.tab = "chats";
  switchView("chats");
  document.body.classList.add("in-chat");
  $$(".chat-item").forEach((n) => n.classList.toggle("active",
    Number(n.dataset.id) === id));
  const data = await api(`/api/rooms/${id}/messages?limit=60`);
  state.msgs[id] = data.messages;
  state.reads[id] = data.reads;
  try {
    const cs = await api(`/api/rooms/${id}/call`);
    state.callStates[id] = cs;
  } catch (e) { /* egal */ }
  const room = state.rooms.find((r) => r.id === id);
  if (room) { room.unread = 0; }
  renderChatList();
  renderMessages();
  updateChatHeader();
  updateCallBadge();
  markRead(id, Date.now() / 1000);
  $("#msgInput").focus();
}

function currentRoom() {
  return state.rooms.find((r) => r.id === state.activeRoom) || null;
}

function updateChatHeader() {
  const room = currentRoom();
  if (!room) return;
  $("#roomTitle").textContent = room.title || "Gespräch";
  setAvatar($("#roomAvatar"), room.title || "?");
  const other = room.members.filter((n) => n.toLowerCase() !== state.me.nick.toLowerCase());
  const typingNick = state.typing[room.id];
  const sub = $("#roomSub");
  if (typingNick) {
    sub.textContent = typingNick + " schreibt …";
    sub.classList.add("typing");
  } else {
    sub.classList.remove("typing");
    sub.textContent = room.kind === "dm"
      ? (other[0] ? "@" + other[0] : "Gespräch")
      : room.members.length + " Mitglieder";
  }
}

function renderChatList() {
  const list = $("#chatList");
  list.innerHTML = "";
  const rooms = state.rooms.slice().sort((a, b) =>
    ((b.last && b.last.created) || b.created) - ((a.last && a.last.created) || a.created));
  for (const room of rooms) {
    const li = el("li", "chat-item");
    li.dataset.id = room.id;
    if (room.id === state.activeRoom && state.tab === "chats") li.classList.add("active");
    const av = el("div", "avatar small");
    setAvatar(av, room.title || "?");
    const body = el("div", "body");
    const top = el("div", "top");
    top.appendChild(el("span", "name", room.title || "Gespräch"));
    if (room.last) top.appendChild(el("span", "time", listTime(room.last.created)));
    const bottom = el("div", "bottom");
    const preview = el("span", "preview");
    if (room.last) {
      preview.textContent = room.kind === "dm"
        ? room.last.text
        : room.last.nick + ": " + room.last.text;
    } else {
      preview.textContent = "noch keine Nachrichten";
    }
    bottom.appendChild(preview);
    if (room.unread > 0) bottom.appendChild(el("span", "badge", String(room.unread)));
    body.appendChild(top);
    body.appendChild(bottom);
    li.appendChild(av);
    li.appendChild(body);
    li.addEventListener("click", () => openRoom(room.id));
    list.appendChild(li);
  }
  const total = state.rooms.reduce((s, r) => s + (r.unread || 0), 0);
  document.title = (total ? "(" + total + ") " : "") + "GhostChat";
}

function renderMessages() {
  const box = $("#messages");
  box.innerHTML = "";
  const msgs = state.msgs[state.activeRoom] || [];
  const reads = state.reads[state.activeRoom] || {};
  let maxOtherRead = 0;
  Object.keys(reads).forEach((n) => {
    if (n.toLowerCase() !== state.me.nick.toLowerCase()) {
      maxOtherRead = Math.max(maxOtherRead, reads[n]);
    }
  });

  let prevMsg = null, prevMeta = null;
  for (const m of msgs) {
    if (!prevMsg || dayKey(prevMsg.created) !== dayKey(m.created)) {
      box.appendChild(el("div", "msg-day", fmtDayLabel(m.created)));
      prevMsg = null;
      prevMeta = null;
    }
    const mine = m.uid === state.me.id || m.nick === state.me.nick;
    const grouped = prevMsg && prevMeta && prevMsg.nick === m.nick &&
      !m.system && !prevMsg.system && (m.created - prevMsg.created) < 300;

    let meta = prevMeta;
    if (!grouped) {
      const wrap = el("div", "msg" + (mine ? " mine" : "") + (m.system ? " sysmsg" : ""));
      const bubble = el("div", "bubble");
      if (!mine && !m.system) bubble.appendChild(el("span", "nick", m.nick));
      const text = el("div", "text");
      text.appendChild(linkify(m.text));
      bubble.appendChild(text);
      meta = el("span", "meta");
      bubble.appendChild(meta);
      wrap.appendChild(bubble);
      box.appendChild(wrap);
    }
    meta.textContent = "";
    meta.appendChild(document.createTextNode(fmtTime(m.created) + " "));
    if (mine && !m.system) {
      meta.appendChild(el("span", "ticks",
        maxOtherRead >= m.created ? "\u2713\u2713" : "\u2713"));
    }
    prevMeta = meta;
    prevMsg = m;
  }
  scrollBottom(true);
}

function scrollBottom(force) {
  const box = $("#messages");
  if (force || box.scrollHeight - box.scrollTop - box.clientHeight < 160) {
    box.scrollTop = box.scrollHeight;
  }
}

$("#messages").addEventListener("scroll", async () => {
  const box = $("#messages");
  if (box.scrollTop > 40 || !state.activeRoom) return;
  const msgs = state.msgs[state.activeRoom] || [];
  if (!msgs.length || box._loading) return;
  box._loading = true;
  try {
    const data = await api(`/api/rooms/${state.activeRoom}/messages?before=${msgs[0].id}&limit=50`);
    if (data.messages.length) {
      const height = box.scrollHeight;
      state.msgs[state.activeRoom] = data.messages.concat(msgs);
      state.reads[state.activeRoom] = data.reads;
      renderMessages();
      box.scrollTop = box.scrollHeight - height;
    }
  } catch (e) { /* egal */ }
  box._loading = false;
});

function pushLocal(roomId, msg) {
  if (!state.msgs[roomId]) state.msgs[roomId] = [];
  if (state.msgs[roomId].some((m) => m.id === msg.id)) return;
  state.msgs[roomId].push(msg);
}

function onIncoming(msg) {
  const room = state.rooms.find((r) => r.id === msg.room);
  const active = state.tab === "chats" && state.activeRoom === msg.room;
  const mine = msg.nick === state.me.nick;
  if (room) {
    room.last = { text: msg.text, created: msg.created, nick: msg.nick };
    if (!active && !mine) room.unread = (room.unread || 0) + 1;
    // Reihenfolge anpassen
    state.rooms = [room].concat(state.rooms.filter((r) => r.id !== room.id));
  }
  if (state.msgs[msg.room]) pushLocal(msg.room, msg);
  renderChatList();
  if (active) {
    renderMessages();
    updateChatHeader();
    markRead(msg.room, msg.created);
    refreshReads(msg.room);
  } else if (!mine) {
    beep();
    const where = room ? room.title : "Gespräch";
    toast(where + " · " + msg.nick + ": " +
      (msg.text.length > 70 ? msg.text.slice(0, 70) + "…" : msg.text));
  }
}

async function refreshReads(roomId) {
  try {
    const data = await api(`/api/rooms/${roomId}/reads`);
    state.reads[roomId] = data.reads;
    if (state.activeRoom === roomId) renderMessages();
  } catch (e) { /* egal */ }
}

async function markRead(roomId, ts) {
  try {
    await api(`/api/rooms/${roomId}/read`, { body: { ts } });
    const room = state.rooms.find((r) => r.id === roomId);
    if (room) { room.unread = 0; renderChatList(); }
  } catch (e) { /* egal */ }
}

function onTyping(msg) {
  if (msg.room !== state.activeRoom || msg.nick === state.me.nick) return;
  state.typing[msg.room] = msg.nick;
  updateChatHeader();
  clearTimeout(state.typing["_t"]);
  state.typing["_t"] = setTimeout(() => {
    delete state.typing[msg.room];
    updateChatHeader();
  }, 3000);
}

/* ---------------------------------------------------------- Senden */
let lastTypingSent = 0;
$("#msgInput").addEventListener("input", () => {
  const now = Date.now();
  if (now - lastTypingSent > 2000 && state.activeRoom && state.ws) {
    lastTypingSent = now;
    wsSend({ type: "typing", room: state.activeRoom });
  }
});

$("#msgInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});
$("#btnSend").addEventListener("click", sendMessage);

async function sendMessage() {
  const input = $("#msgInput");
  const text = input.value.trim();
  const roomId = state.activeRoom;
  if (!text || !roomId) return;
  input.value = "";
  if (wsSend({ type: "send", room: roomId, text })) return;
  try {
    const data = await api(`/api/rooms/${roomId}/messages`, { body: { text } });
    pushLocal(roomId, data.msg);
    renderMessages();
  } catch (e) {
    toast("Senden fehlgeschlagen: " + e.message);
  }
}

/* ---------------------------------------------------------- Suche / neu */
const searchInput = $("#search");
searchInput.addEventListener("input", async () => {
  const q = searchInput.value.trim();
  const box = $("#searchResults");
  if (!q) { box.classList.add("hidden"); box.innerHTML = ""; return; }
  const local = state.rooms.filter((r) =>
    (r.title || "").toLowerCase().includes(q.toLowerCase()));
  let users = [];
  try { users = (await api("/api/users?q=" + encodeURIComponent(q))).users; } catch (e) { /* egal */ }
  box.innerHTML = "";
  const openers = new Map();
  local.slice(0, 5).forEach((r) => openers.set(r.title, { room: r.id }));
  users.forEach((n) => { if (!openers.has(n)) openers.set(n, { user: n }); });
  if (!openers.size) {
    box.appendChild(el("div", "hint", "Kein Treffer – Enter im Chat öffnet nichts."));
  }
  openers.forEach((info, label) => {
    const row = el("div", null, info.room ? label + "  ·  Gespräch öffnen"
                                          : "@" + label + "  ·  Chat starten");
    row.addEventListener("click", async () => {
      box.classList.add("hidden");
      searchInput.value = "";
      try {
        if (info.room) { openRoom(info.room); return; }
        const data = await api("/api/rooms", { body: { kind: "dm", nick: info.user } });
        await loadRooms();
        openRoom(data.room.id);
      } catch (e) { toast(e.message); }
    });
    box.appendChild(row);
  });
  box.classList.remove("hidden");
});
searchInput.addEventListener("blur", () =>
  setTimeout(() => $("#searchResults").classList.add("hidden"), 180));

/* ---------------------------------------------------------- Tabs / Ansichten */
$$("#tabs .tab").forEach((btn) => {
  btn.addEventListener("click", () => switchView(btn.dataset.tab));
});

function switchView(tab) {
  state.tab = tab;
  $$("#tabs .tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  $("#emptyState").classList.toggle("hidden", !(tab === "chats" && !state.activeRoom));
  $("#chatView").classList.toggle("hidden", tab !== "chats");
  $("#marketView").classList.toggle("hidden", tab !== "market");
  $("#callsView").classList.toggle("hidden", tab !== "calls");
  document.body.classList.toggle("in-chat", tab !== "chats" || !!state.activeRoom);
  renderChatList();
  if (tab === "market") loadMarket();
  if (tab === "calls") loadCalls();
  if (tab === "chats") {
    $$(".chat-item").forEach((n) => n.classList.toggle("active",
      Number(n.dataset.id) === state.activeRoom));
    updateCallBadge();
  }
}

$("#btnBack").addEventListener("click", () => {
  document.body.classList.remove("in-chat");
});

/* ---------------------------------------------------------- Marktplatz */
function resetListingForm() {
  const f = $("#listingForm");
  f.reset();
  f.classList.add("hidden");
  state.editId = null;
  $("#btnListingSubmit").textContent = "Veröffentlichen";
}

function openListingForm(item = null) {
  const f = $("#listingForm");
  if (item) {
    state.editId = item.id;
    $("#lTitle").value = item.title;
    $("#lPrice").value = item.price || "";
    $("#lDescr").value = item.descr || "";
    $("#btnListingSubmit").textContent = "Speichern";
    toast("Anzeige bearbeiten – Speichern übernimmt die Änderung");
  } else {
    state.editId = null;
    $("#btnListingSubmit").textContent = "Veröffentlichen";
  }
  f.classList.remove("hidden");
  f.scrollIntoView({ block: "nearest" });
  $("#lTitle").focus();
}

$("#btnNewListing").addEventListener("click", () => {
  if (state.editId !== null) { resetListingForm(); return; }
  const f = $("#listingForm");
  if (f.classList.contains("hidden")) openListingForm(null);
  else f.classList.add("hidden");
});

$("#btnCancelListing").addEventListener("click", resetListingForm);

$("#listingForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const payload = {
    title: $("#lTitle").value,
    price: $("#lPrice").value,
    descr: $("#lDescr").value,
  };
  const editing = state.editId;
  try {
    if (editing) {
      await api(`/api/market/${editing}/edit`, { body: payload });
    } else {
      await api("/api/market", { body: payload });
    }
    resetListingForm();
    await loadMarket();
    toast(editing ? "Anzeige aktualisiert" : "Anzeige veröffentlicht");
  } catch (err) { toast(err.message); }
});

async function loadMarket() {
  try {
    const data = await api("/api/market");
    state.market = data.items;
    renderMarket();
  } catch (e) { /* egal */ }
}

function renderMarket() {
  const grid = $("#marketGrid");
  grid.innerHTML = "";
  if (!state.market.length) {
    grid.appendChild(el("div", "empty-note", "Noch keine Anzeigen – sei der Erste."));
    return;
  }
  for (const item of state.market) {
    const card = el("div", "card");
    card.appendChild(el("div", "t", item.title));
    if (item.price) card.appendChild(el("div", "price", item.price));
    if (item.descr) card.appendChild(el("div", "d", item.descr));
    const foot = el("div", "foot");
    foot.appendChild(el("span", "seller", "von @" + item.seller +
      (item.mine ? " (du)" : "")));
    if (item.mine) {
      const sold = el("button", "chip dim",
        item.open ? "Als verkauft" : "Wieder aktivieren");
      sold.addEventListener("click", async () => {
        try { await api(`/api/market/${item.id}/toggle`, { body: {} }); await loadMarket(); }
        catch (e) { toast(e.message); }
      });
      const edit = el("button", "chip dim", "Bearbeiten");
      edit.addEventListener("click", () => openListingForm(item));
      const del = el("button", "chip danger", "Löschen");
      del.addEventListener("click", async () => {
        if (!window.confirm('Anzeige "' + item.title + '" wirklich löschen?')) return;
        try {
          await api(`/api/market/${item.id}/delete`, { body: {} });
          if (state.editId === item.id) resetListingForm();
          await loadMarket();
          toast("Anzeige gelöscht");
        } catch (e) { toast(e.message); }
      });
      const actions = el("div", "mine-actions");
      actions.appendChild(sold);
      actions.appendChild(edit);
      actions.appendChild(del);
      foot.appendChild(actions);
    } else if (item.open) {
      const chip = el("button", "chip", "💬 Kontakt");
      chip.addEventListener("click", async () => {
        try {
          const data = await api("/api/rooms", { body: { kind: "dm", nick: item.seller } });
          await loadRooms();
          switchView("chats");
          openRoom(data.room.id);
        } catch (e) { toast(e.message); }
      });
      foot.appendChild(chip);
    } else {
      foot.appendChild(el("span", "sold", "verkauft"));
    }
    card.appendChild(foot);
    if (!item.open) card.style.opacity = ".6";
    grid.appendChild(card);
  }
}

/* ---------------------------------------------------------- Anrufverlauf */
async function loadCalls() {
  try {
    const data = await api("/api/calls");
    state.calls = data.calls;
    renderCalls();
  } catch (e) { /* egal */ }
}

function renderCalls() {
  const list = $("#callList");
  list.innerHTML = "";
  if (!state.calls.length) {
    list.appendChild(el("div", "empty-note", "Noch keine Anrufe. Öffne ein Gespräch und drück auf 📞"));
    return;
  }
  for (const call of state.calls) {
    const row = el("div", "call-row");
    row.appendChild(el("div", "ico", "📞"));
    const info = el("div", "info");
    info.appendChild(el("b", null, call.name || call.who || "Gespräch"));
    info.appendChild(el("span", null, new Date(call.started * 1000).toLocaleString("de-DE") +
      (call.who ? " · " + call.who : "")));
    row.appendChild(info);
    row.appendChild(el("div", "dur", dur(call.duration)));
    list.appendChild(row);
  }
}

/* ---------------------------------------------------------- Sprachanrufe */
function updateCallBadge() {
  const st = state.callStates[state.activeRoom];
  const others = st && st.active
    ? st.participants.filter((p) => p.nick !== state.me.nick) : [];
  const badge = $("#callBadge");
  const btn = $("#btnCall");
  if (state.call && state.call.roomId === state.activeRoom) {
    badge.textContent = "🔊 Anruf aktiv";
    badge.classList.remove("hidden");
    btn.textContent = "◼";
    btn.title = "Anruf anzeigen";
  } else if (others.length) {
    badge.textContent = "🔊 Anruf läuft – beitreten";
    badge.classList.remove("hidden");
    btn.textContent = "📞";
    btn.title = "Beitreten";
  } else {
    badge.classList.add("hidden");
    btn.textContent = "📞";
    btn.title = "Sprachanruf starten";
  }
}

$("#btnCall").addEventListener("click", () => {
  if (state.call && state.call.roomId === state.activeRoom) {
    $("#callOverlay").classList.remove("hidden");
    return;
  }
  startCall(state.activeRoom);
});

async function startCall(roomId) {
  if (!roomId) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    toast("Dein Browser erlaubt keine Mikrofonfreigabe (HTTPS oder localhost nötig).", 4000);
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (e) {
    toast("Mikrofon verweigert: " + e.message, 4000);
    return;
  }
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!state.micCtx) state.micCtx = new Ctx();     // einmal anlegen, wiederverwenden
    const ctx = state.micCtx;
    if (ctx.state === "suspended") await ctx.resume();
    if (!state.playCtx) state.playCtx = new Ctx();
    const src = ctx.createMediaStreamSource(stream);
    const proc = ctx.createScriptProcessor(1024, 1, 1);
    const sink = ctx.createGain();
    sink.gain.value = 0;              // Prozessor antreiben, ohne eigenes Echo
    const call = {
      roomId, stream, ctx, proc, sink, src,
      startedAt: Date.now(), muted: false, rate: ctx.sampleRate,
    };
    proc.onaudioprocess = (e) => {
      if (!state.call || state.call.muted) return;
      const data = e.inputBuffer.getChannelData(0);
      let peak = 0;
      for (let i = 0; i < data.length; i += 8) {
        const v = data[i] < 0 ? -data[i] : data[i];
        if (v > peak) peak = v;
      }
      if (peak < 0.012) return;       // Stille mitschicken wäre Verschwendung
      const buf = new ArrayBuffer(4 + data.length * 4);
      new DataView(buf).setUint32(0, roomId);
      new Float32Array(buf, 4).set(data);
      if (state.ws && state.ws.readyState === 1) state.ws.send(buf);
    };
    src.connect(proc);
    proc.connect(sink);
    sink.connect(ctx.destination);
    state.call = call;
    wsSend({ type: "call_join", room: roomId, rate: ctx.sampleRate });
    showCallOverlay();
    startCallTimer();
    updateCallBadge();
  } catch (e) {
    toast("Anruf fehlgeschlagen: " + e.message);
    stream.getTracks().forEach((t) => t.stop());
  }
}

function showCallOverlay() {
  const room = currentRoom();
  $("#callTitle").textContent = room ? room.title : "Anruf";
  $("#callStatus").textContent = "Verbindung wird hergestellt…";
  $("#callTimer").textContent = "00:00";
  const avs = $("#callAvatars");
  avs.innerHTML = "";
  avs.appendChild(avatarNode(state.me.nick));
  if (room) {
    room.members
      .filter((n) => n.toLowerCase() !== state.me.nick.toLowerCase())
      .slice(0, 2)
      .forEach((n) => avs.appendChild(avatarNode(n)));
  }
  $("#btnMute").classList.remove("muted");
  $("#btnMute").querySelector(".lbl").textContent = "Mikro an";
  $("#callOverlay").classList.remove("hidden");
}

function avatarNode(nick) {
  const a = el("div", "avatar");
  setAvatar(a, nick);
  a.title = nick;
  return a;
}

let callTimerHandle = null;
function startCallTimer() {
  clearInterval(callTimerHandle);
  callTimerHandle = setInterval(() => {
    if (!state.call) { clearInterval(callTimerHandle); return; }
    $("#callTimer").textContent = dur((Date.now() - state.call.startedAt) / 1000);
  }, 500);
}

$("#btnMute").addEventListener("click", () => {
  if (!state.call) return;
  state.call.muted = !state.call.muted;
  const btn = $("#btnMute");
  btn.classList.toggle("muted", state.call.muted);
  btn.querySelector(".lbl").textContent = state.call.muted ? "Mikro stumm" : "Mikro an";
  btn.querySelector(".ico").textContent = state.call.muted ? "🔇" : "🎙️";
});

$("#btnHangup").addEventListener("click", () => endCall(true));

function endCall(notify) {
  const call = state.call;
  if (!call) { $("#callOverlay").classList.add("hidden"); return; }
  try {
    if (notify) wsSend({ type: "call_leave", room: call.roomId });
    if (call.proc) { call.proc.onaudioprocess = null; call.proc.disconnect(); }
    if (call.src) call.src.disconnect();
    if (call.sink) call.sink.disconnect();
    if (call.stream) call.stream.getTracks().forEach((t) => t.stop());
  } catch (e) { /* egal */ }
  state.call = null;
  state.nextPlay = 0;
  clearInterval(callTimerHandle);
  $("#callOverlay").classList.add("hidden");
  updateCallBadge();
}

function onCallState(msg) {
  const prev = state.callStates[msg.room];
  state.callStates[msg.room] = msg;
  const others = msg.participants.filter((p) => p.nick !== state.me.nick);

  if (state.call && state.call.roomId === msg.room) {
    const status = $("#callStatus");
    const avs = $("#callAvatars");
    if (!others.length) {
      status.textContent = "Warte auf Teilnehmer …";
    } else {
      status.textContent = "Verbunden mit " + others.map((p) => p.nick).join(", ");
      avs.innerHTML = "";
      avs.appendChild(avatarNode(state.me.nick));
      others.forEach((p) => avs.appendChild(avatarNode(p.nick)));
    }
    if (!msg.active) endCall(false);
  } else if (others.length && (!prev || !prev.active)) {
    const room = state.rooms.find((r) => r.id === msg.room);
    const where = room ? room.title : "Gespräch";
    if (msg.room === state.activeRoom && state.tab === "chats") {
      toast("🔊 Sprachanruf in diesem Gespräch – mit 📞 beitreten", 3500);
    } else if (room) {
      toast("🔊 Anruf in " + where, 3500);
    }
  }
  updateCallBadge();
}

/* ---------------------------------------------------------- Audio-Wiedergabe */
function onAudioChunk(buffer) {
  if (!state.call || buffer.byteLength < 8) return;
  const view = new DataView(buffer);
  const roomId = view.getUint32(0);
  if (roomId !== state.call.roomId) return;
  const samples = new Float32Array(buffer, 4);
  const st = state.callStates[roomId];
  let rate = 48000;
  if (st) {
    const other = st.participants.find((p) => p.nick !== state.me.nick);
    if (other && other.rate) rate = other.rate;
  }
  playSamples(samples, rate);
}

function playSamples(samples, rate) {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = state.playCtx || (state.playCtx = new Ctx());
    if (ctx.state === "suspended") ctx.resume();
    const buf = ctx.createBuffer(1, samples.length, rate);
    buf.getChannelData(0).set(samples);
    const node = ctx.createBufferSource();
    node.buffer = buf;
    node.connect(ctx.destination);
    const now = ctx.currentTime;
    if (!state.nextPlay || state.nextPlay < now || state.nextPlay > now + 0.6) {
      state.nextPlay = now + 0.05;
    }
    node.start(state.nextPlay);
    state.nextPlay += buf.duration;
    node.onended = () => { try { node.disconnect(); } catch (e) { /* egal */ } };
  } catch (e) { /* egal */ }
}

/* ---------------------------------------------------------- Sonstiges */
window.addEventListener("offline", () => toast("Internetverbindung verloren…", 4000));
window.addEventListener("online", () => toast("Wieder online", 2000));
window.addEventListener("beforeunload", () => { if (state.call) endCall(true); });

boot().catch((e) => toast("Start fehlgeschlagen: " + e.message, 5000));

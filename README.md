# 👻 GhostChat

Anonymer Messenger im Browser – **Nickname + Passwort**, kein Handy, keine Mail, kein Name.
Selbst gehostet: eigener Server, keine Werbung, kein Tracking, keine externen Dienste.

## Features

- **💬 Chats** – öffentliche Lobby, 1:1-Gespräche, eigene Gruppen, Lesebestätigungen (✓/✓✓), Tipp-Anzeige, Unread-Badges, ältere Nachrichten nachladen
- **📞 Sprachanrufe** – echter Ton über den Server (Mikrofon → Server → Gegenspieler), Beitreten-Live, Mikro stumm, Anrufverlauf mit Dauer
- **🛒 Marktplatz** – eigene Anzeigen mit Preis, „Kontakt"-Button öffnet direkt den Chat zum Verkäufer, als verkauft markieren
- **🔍 Suche** – bestehende Chats filtern oder per Nickname neuen Chat starten
- **📱 Responsive** – läuft am Laptop und am Handy, Telegram-artiges Dark-Theme

## Schnellstart (lokal)

Voraussetzung: **Python 3.10+** ([python.org](https://www.python.org/downloads/), „Add to PATH" aktivieren)

| Weg | Aktion |
|---|---|
| einfach | `install.bat` doppelklicken (installiert die Pakete + Desktop-Verknüpfung „GhostChat"), danach `start.bat` |
| manuell | `pip install -r requirements.txt` und `python server.py` |

Dann im Browser öffnen: **http://127.0.0.1:8080**

> Für Mehrbenutzer-Betrieb: Link/Die Adresse `http://<deine-IP>:8080` im selben Netz teilen –
> das Mikrofon funktioniert im Browser nur über **HTTPS** oder **localhost**.

## Öffentlich erreichbar machen

GhostChat braucht nur einen beliebigen Host mit Python 3 (VPS, Cloud, Raspberry Pi …):

```bash
pip install -r requirements.txt
python server.py          # bindet 0.0.0.0, PORT/VARIANTE siehe unten
```

Empfehlungen:

- **Reverse-Proxy mit HTTPS** (Caddy/Nginx/Let's Encrypt) – ohne HTTPS kein Mikrofon im Browser
- **SQLite-Datei** `ghostchat.db` liegt direkt neben `server.py` – bei vielen kostenlosen Hosts
  der Datenspeicher bei jedem Deploy/Neustart leer (dann lieber kleine Platte/VPS nehmen)
- **Render-Beispiel**: Build `pip install -r requirements.txt`, Start `python server.py`
- Der eingebaute Werkzeug-Server reicht für private Nutzung und kleine Gruppen; für mehr
  z. B. `gunicorn -w 1 --threads 8 server:app` (oder Waitress) davorhängen

### Umgebungsvariablen

| Variable | Bedeutung | Standard |
|---|---|---|
| `PORT` / `GHOSTCHAT_PORT` | Port | `8080` |
| `GHOSTCHAT_HOST` | Bind-Adresse | `0.0.0.0` |
| `GHOSTCHAT_DB` | Pfad zur SQLite-Datei | `./ghostchat.db` |

## Regeln

- **Nur legale Waren** im Marktplatz (keine Waffen, Drogen, Betäubungsmittel, gestohlene Ware …)
- **Keine privaten Daten von Personen** posten (Adresse, Telefonnummer, Ausweis, Bilder) –
  GhostChat ist kein Werkzeug zum Doxxen oder Belästigen
- Kein Spam, keine Beleidigungs-/Hetzbeiträge

Es gibt keine Wiederherstellung: Passwort vergessen = neuer Nick.

## Technik

- **Flask + simple-websocket** (WSGI), **SQLite** (kein Redis, keine Cloud, kein externer Dienst)
- Nachrichten live per **WebSocket**, Fallback auf REST
- Sprachaudio als **PCM-Relay über WebSocket** (48 kHz, Mono) – Stille wird nicht mitgeschickt,
  nichts wird aufgezeichnet oder gespeichert
- Passwörter: **PBKDF2-HMAC-SHA256**, 120.000 Runden, eigener Salz pro Konto; Sitzungen als
  Zufalls-Token (nur hash-vergleichend)
- Alle Inhalte werden per `textContent` eingefügt (kein `innerHTML` mit Nutzerdaten → kein XSS),
  URLs werden nur als `http(s)-Links` gesetzt

## API (Auszug)

Alle Endpunkte brauchen `Authorization: Bearer <token>` (Ausnahme: Login/Register/Startseite).

```
POST /api/register          {nick, password}
POST /api/login             {nick, password}
GET  /api/me
GET  /api/rooms             Raumliste mit Vorschau + Unread
POST /api/rooms             {kind:"dm", nick} | {kind:"group", name, members:[…]}
GET  /api/rooms/<id>/messages?before=<id>&limit=50
POST /api/rooms/<id>/messages   {text}          (REST-Fallback zum WS-Senden)
GET  /api/rooms/<id>/reads | /call
GET  /api/market | POST /api/market | POST /api/market/<id>/toggle
GET  /api/calls
GET  /ws?token=<token>                      (WebSocket: send/typing/call_join/call_leave)
```

WebSocket-Nachrichten (JSON): `{"type":"send","room":1,"text":"hi"}`,
`{"type":"typing","room":1}`, `{"type":"call_join","room":1,"rate":48000}`,
`{"type":"call_leave","room":1}`.
Audio-Frames: `4 Byte Raum-ID (uint32 BE)` + Float32-PCM-Samples.

## Lizenz

MIT – siehe [LICENSE](LICENSE).

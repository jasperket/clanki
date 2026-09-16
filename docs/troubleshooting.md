# Troubleshooting

Almost every failure in this server is the same failure: it cannot reach
AnkiConnect. Anki is a desktop app, and AnkiConnect is an add-on that opens a
small HTTP server inside it. If that server is not listening, every tool here
returns a connection error, regardless of which tool you called.

## Check the connection first

With Anki running, send AnkiConnect its simplest request:

```bash
curl -X POST http://127.0.0.1:8765 -d "{\"action\":\"version\",\"version\":6}"
```

A working setup replies:

```json
{ "result": 6, "error": null }
```

On Windows PowerShell, `curl` is an alias for `Invoke-WebRequest` and takes
different arguments. Use this instead:

```powershell
Invoke-RestMethod -Uri http://127.0.0.1:8765 -Method Post -Body '{"action":"version","version":6}'
```

If you get `6` back, AnkiConnect is fine and the problem is elsewhere — check
that `claude_desktop_config.json` points at an absolute path to `build/index.js`
and that you have run `npm run build`.

If the request fails, work through the causes below.

## AnkiConnect is not installed

Install it from within Anki: **Tools → Add-ons → Get Add-ons**, code
`2055492159`.

## Anki was not restarted after installing

Add-ons load at startup. Installing AnkiConnect into a running Anki does
nothing until you fully quit and reopen the app. Closing the window is not
always enough on Windows — confirm `anki.exe` is gone from Task Manager.

## Anki is not running

There is no background service. AnkiConnect exists only while the Anki window
is open, so the server cannot reach it if Anki is closed, and a tool call that
worked earlier will start failing the moment you quit Anki.

## Something else is using port 8765

AnkiConnect binds `127.0.0.1:8765` by default, and this server connects to
exactly that address (see `ANKI_CONNECT_URL` in `src/index.ts`). If another
program holds the port, AnkiConnect cannot listen.

On Windows, find the process holding it:

```powershell
Get-NetTCPConnection -LocalPort 8765 | Select-Object OwningProcess
```

The address is not configurable in this server, so changing AnkiConnect's
`webBindPort` will break it rather than fix it. Free the port instead.

## A firewall is blocking it

Traffic here never leaves your machine — `127.0.0.1` is the loopback address,
meaning the request goes from your computer straight back to itself. Most
firewall rules do not apply to loopback, but some Windows endpoint-security
suites filter it anyway. If everything above checks out and the connection is
still refused, try the `version` check with the security software's protection
temporarily paused to confirm whether it is the cause.

## About AnkiConnect's configuration

You should not need to change AnkiConnect's config at all. Its defaults —
`webBindAddress: "127.0.0.1"`, `webBindPort: 8765`, `apiKey: null` — are
already what this server expects.

In particular, **do not add `"*"` to `webCorsOriginList`.** CORS is a rule
about which *web pages* may call a server: the browser attaches an `Origin`
header naming the page, and AnkiConnect refuses the request unless that origin
is on the list. This server is a Node process using the plain `http` module, so
it sends no `Origin` header at all and is never subject to the check.

You can see both halves of that. A request with no origin, which is what this
server sends, succeeds:

```console
$ curl -s -X POST http://127.0.0.1:8765 -d "{\"action\":\"version\",\"version\":6}"
{"result": 6, "error": null}
```

A request claiming to come from a web page not on the list is rejected with
HTTP 403:

```console
$ curl -s -o /dev/null -w "%{http_code}\n" -X POST http://127.0.0.1:8765 -H "Origin: http://evil.example" -d "{\"action\":\"version\",\"version\":6}"
403
```

That 403 is the protection working. Adding `"*"` turns it into a normal
success, granting any page open in your browser permission to read, edit and
delete your collection — while doing nothing for this server, which was never
blocked in the first place.

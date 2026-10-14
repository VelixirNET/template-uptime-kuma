# Uptime Kuma

[![Deploy on velixir](https://velixir.net/img/deploy-on-velixir.svg)](https://velixir.net/new?template=uptime-kuma)

Know the moment your sites go down. [Uptime Kuma](https://uptime.kuma.pet) checks your websites
and APIs around the clock, alerts you through Telegram, Slack, ntfy, Pushover, webhooks
and dozens more, and gives your users a public status page. This template runs it in the EU, keeps
its history on a persistent volume, and starts locked to you.

[Deploy it on velixir](https://velixir.net/new?template=uptime-kuma), open the deploy log for your
password, and add your first monitor.

## What you get

- **Uptime Kuma 2.5.6**, the upstream release, with its full web interface.
- **History that survives.** The template adds a persistent volume and keeps Uptime Kuma's data
  folder (its database, uploaded logos and settings) there, so monitors, alerts and months of
  history survive restarts and redeploys. Snapshots are taken daily and can be restored from the
  app's Volume tab.
- **An instance only you can sign in to.** A fresh Uptime Kuma lets whoever opens it first create
  the admin account. Here the first start creates it before the app goes public, and prints the
  password once to the deploy log.
- **No database questions.** SQLite on the volume is chosen for you, so the "which database?" page
  never appears.
- **Ready for alerts.** The app's public URL is filled in for the links in notifications, and
  visitors' real addresses reach Uptime Kuma's login log and rate limits.
- **Always running.** It runs on a plan that never sleeps, so checks keep going when nobody has the
  dashboard open.

## Signing in

After the first deploy, open the app's log and find the box that begins **Uptime Kuma is ready**.
It holds the username (`admin`) and a random password. It is printed once. Sign in at your app's
address, then change the password under **Settings > Security**, and turn on two-factor
authentication there while you are at it.

Lost it? Set `KUMA_ADMIN_PASSWORD` on the app's Environment tab (mark it as secret). On every start
the app sets that password for the admin user, so saving it (which redeploys) gets you back in.
Remove it again afterwards if you prefer to manage the password in Uptime Kuma.

| Variable | Required | What it does |
| --- | --- | --- |
| `KUMA_ADMIN_PASSWORD` | no | Sets the admin password on every start, or picks the first password. |
| `KUMA_ADMIN_USERNAME` | no | The admin username, `admin` unless you set it before the first start. Also the user `KUMA_ADMIN_PASSWORD` applies to. |
| `PUBLIC_URL` | no | Your own domain, for example `https://status.example.com`, once you have added it to the app. Used as the base URL in notifications while Uptime Kuma's own setting is empty. |

Everything else is set in Uptime Kuma's **Settings** and kept on the volume.

## What it can check

velixir apps reach the internet over the web ports (80 and 443) and DNS, so checks run from EU
data centres with these monitor types:

| Works | Does not reach its target |
| --- | --- |
| HTTP(S), HTTP(S) keyword and JSON query on ports 80 and 443 | Ping (ICMP) |
| DNS | TCP port checks on other ports |
| Push (your service calls Uptime Kuma) | SMTP, database, game server, MQTT, gRPC and other non-web monitors |
| Certificate expiry and domain expiry on web monitors | HTTP(S) on non-standard ports such as `:8080` |
| Groups and status pages | Real browser monitors (there is no browser in this image) |

For a server you can only reach on another port, use a **push** monitor: a cron job or script on
that server calls the push URL Uptime Kuma gives you, and you are alerted when the calls stop.

Notifications work through any service with an HTTPS API (Telegram, Slack, ntfy,
Pushover, Gotify, Matrix, webhooks and many more). Email over SMTP does not, because outbound SMTP
is blocked; use a webhook to an email API such as Resend, Postmark or Brevo instead.

## Status pages on your own domain

Create a status page in Uptime Kuma, add your domain to the app on velixir (for example
`status.example.com`), then enter the same domain in the status page's settings under
**Domain Names**. Visitors to that domain see the status page; your dashboard stays on the app's
own address.

## Things to know

**It needs a paid plan.** Volumes come with paid plans, and on the Free plan the app would sleep
when idle and stop checking. In testing it used about 140 MB with a few monitors; the smallest paid
plan (512 MB) leaves room for a few hundred.

**Without a volume, everything resets.** If you untick the volume, Uptime Kuma still runs, but
monitors, history and the admin account start from scratch on every restart and redeploy. The log
says so on every start.

**One replica, one location.** Uptime Kuma keeps its state in SQLite on the volume, so it runs as
one copy. All checks come from that one place, so a network problem between it and your site shows
as downtime. Pair it with a second monitor elsewhere if that matters to you.

**Data grows with history.** Uptime Kuma keeps a year of heartbeats by default. Change that under
**Settings > Monitor History** if the volume fills up, or raise the volume's size on its tab.

**Health check:** Uptime Kuma has no dedicated health endpoint; point the platform's health probe
at `/robots.txt`, which answers 200 once it is up. While it starts, `/healthz` answers 200 and other
pages show a short "starting" page.

## What this repo is

A thin wrapper, not a fork. `package.json` pins an Uptime Kuma release and the SHA-256 of its
prebuilt web interface, and:

- `build-kuma.js` runs during the build. It does what upstream's own non-Docker install does: the
  tagged source from GitHub, its production dependencies from its lockfile, and the release's
  `dist.tar.gz`, refused unless its checksum matches the pin. It all ends up in `./uptime-kuma`.
- `start.js` runs Uptime Kuma, translating what velixir provides:

| velixir provides | Uptime Kuma gets |
| --- | --- |
| `PORT` | `UPTIME_KUMA_PORT`, on `0.0.0.0` |
| `VELIXIR_VOLUME_PATH` | `DATA_DIR` on the volume (or the container disk, with a warning) |
| `VELIXIR_APP_SLUG` / `PUBLIC_URL` | the primary base URL, while it is unset |
| nothing | SQLite chosen, the admin created on loopback before going public, the edge trusted for client addresses, signals forwarded so the database closes cleanly |

`nixpacks.toml` keeps the builder from adding a browser and starts `node start.js` directly, so the
stop signal on a redeploy reaches Uptime Kuma.

To upgrade, change `uptimeKuma.version` in `package.json` and `uptimeKuma.distSha256` to the
SHA-256 GitHub shows next to that release's `dist.tar.gz`, then deploy. Read the
[release notes](https://github.com/louislam/uptime-kuma/releases) first, and take a volume
snapshot before a major version.

## Running it locally

```bash
npm run build
npm start
```

Then open http://localhost:8080 and sign in with the password printed in the terminal. It needs
Node 22 or newer. Data goes in `.kuma-data/` in this folder.

## Upstream

Uptime Kuma is MIT-licensed open source by Louis Lam and contributors. This wrapper is MIT too.

- Wiki: https://github.com/louislam/uptime-kuma/wiki
- Source: https://github.com/louislam/uptime-kuma

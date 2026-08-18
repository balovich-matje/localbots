# Running Localbots on a server with Docker

This guide is for the person hosting Localbots for a group. You do not need to
know anything about the project — the container builds SimulationCraft itself,
so there is nothing to install by hand.

Everyone in the group then opens `http://your-server:4747` in a browser and
sims from there. No client install, no accounts.

---

## Before you start

You need **Docker** with the **Compose** plugin. On a fresh Debian/Ubuntu box:

```bash
curl -fsSL https://get.docker.com | sh
```

Check it works:

```bash
docker compose version
```

**What the machine needs:**

| | |
|---|---|
| CPU | 2 cores works; 4+ makes sims noticeably faster |
| RAM | **4 GB minimum** — compiling SimulationCraft is the memory-hungry part, not running it |
| Disk | give it 5 GB free — the build stage is much larger than the final image, and Docker keeps both until you prune |
| Time | **15–45 minutes for the first build**, depending on core count. It compiles SimulationCraft from source. Later builds reuse the cache and are much quicker. |

The build tools are thrown away at the end: only the finished 122 MB simc
binary, Node and the app ship in the running image.

Reclaim the leftover build layers once you are happy it works:

```bash
docker builder prune
```

---

## Setup

```bash
git clone https://github.com/balovich-matje/localbots.git
```

```bash
cd localbots && docker compose up -d --build
```

That is the whole install. Go and do something else while it compiles.

When it finishes, check it came up:

```bash
docker compose ps
```

You want to see `localbots` with status `running (healthy)`. Health takes about
10 seconds to report after start.

### One thing to do in the browser

Open `http://your-server:4747`, go to the **Droptimizer** tab, and click
**Refresh data**. That downloads about 60 MB of game tables. It is a one-time
step — the data is kept in a Docker volume and survives restarts and rebuilds.

Until you do it, sims still work but the Droptimizer has no items to offer.

---

## Day-to-day

```bash
docker compose logs -f
```

```bash
docker compose restart
```

```bash
docker compose stop
```

```bash
docker compose up -d
```

The in-page **"Shut down server"** button is deliberately hidden in the
container. On a shared server any visitor could otherwise stop everyone's sims.
Stop it from the shell instead. If you want the button back, set
`LOCALBOTS_ALLOW_SHUTDOWN: "1"` in `docker-compose.yml`.

---

## Updating

### When Localbots itself changes

```bash
cd localbots && git pull && docker compose up -d --build
```

Your game data and everyone's sim history are in volumes, so they survive.

### On WoW patch day

The one-click **Simc** update button in the header is hidden in the container
on purpose — there is no source tree inside the image to update. Instead:

```bash
cd localbots && git pull && docker compose build --no-cache && docker compose up -d
```

`--no-cache` forces a fresh clone and rebuild of SimulationCraft, which is what
picks up the new patch. Then click **Refresh data** in the Droptimizer tab once
to re-download the game tables for the new build.

That click is still needed here. On a desktop install the Simc update button
refreshes the game data by itself, but in the container simc is replaced by a
rebuild rather than by that button, so nothing triggers the download for you.

The header has a **Simc** light that turns orange when the simc in the image is
older than the live game build — that is your cue to run the above.

### When a new expansion lands

SimulationCraft renames its branch each expansion. Change `SIMC_BRANCH` in
`docker-compose.yml` (currently `midnight`) and rebuild.

---

## What "shared" actually means

- **Sims run one at a time.** If three people press Sim at once, they queue and
  each person sees their position in the queue. Nobody's run is dropped.
- **The History page is shared.** Everyone sees everyone's saved sims, including
  character names. That is fine for a friend group; just know it is not private.
- **Everything else is per-browser.** The profile you paste stays in your own tab.

---

## Security — read this before opening it to the internet

**Localbots has no login and no passwords.** Anyone who can reach port 4747 can
run sims, see the shared history, and download game data on your bandwidth.

That is fine on a home LAN or a private VPN. If you want to reach it from
outside, do one of these rather than forwarding the port directly:

- **Tailscale / WireGuard** — simplest. Everyone joins the private network and
  uses the server's private address. Nothing is exposed publicly.
- **A reverse proxy with a password** — Caddy, nginx or Traefik in front of
  Localbots, with basic auth and HTTPS.

To keep it strictly local-only, bind the port to loopback in
`docker-compose.yml` and reach it through an SSH tunnel or proxy:

```yaml
ports:
  - "127.0.0.1:4747:4747"
```

---

## Where the data lives

Two Docker volumes:

| Volume | Holds | Safe to delete? |
|---|---|---|
| `localbots-cache` | downloaded game tables (~60 MB) | yes — click Refresh data again |
| `localbots-history` | everyone's saved sims | no — this is the only copy |

Back up the history:

```bash
docker run --rm -v localbots-history:/h -v "$PWD":/out alpine tar czf /out/localbots-history.tar.gz -C /h .
```

---

## Changing the port

If 4747 is taken, edit `docker-compose.yml`:

```yaml
ports:
  - "8080:4747"
```

Left side is the port on the server, right side is inside the container — leave
the right side alone.

---

## If something goes wrong

**The build fails partway through compiling simc.** Almost always out of memory.
Give the machine more RAM or add swap, then rebuild. A 2 GB VPS will not compile
SimulationCraft.

**The build fails at `git clone`.** The branch name changed. Check what branches
exist at `github.com/simulationcraft/simc` and update `SIMC_BRANCH` in
`docker-compose.yml`.

**The page loads but every sim fails.** Check the logs:

```bash
docker compose logs --tail=50
```

**The Droptimizer says data is missing or from the wrong game build.** Click
**Refresh data**. If it still complains, the simc in the image is older than the
live game — rebuild with `--no-cache` as described under patch day.

**Nothing responds on the port.** Confirm the container is healthy with
`docker compose ps`, then check the server's firewall allows 4747.

**Start completely fresh** (this deletes saved sims):

```bash
docker compose down -v && docker compose up -d --build
```

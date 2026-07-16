# League of Peppers: data maintenance

## Two layers of data

| Layer | Source | Updates | Your effort |
|-------|--------|---------|-------------|
| Champions, items, art, patch number | Riot **Data Dragon** (fetched live) | Automatic, always latest patch | None |
| Which picks are spicy / duos / comps / builds | **`data.js`** (hand-curated) | Only when you edit it | This is the work |

The app always pulls the newest patch, so **new champions and renamed items appear automatically** in art. What it can't know is your *judgment*. That lives in `data.js`.

## The validator (your drift alarm)

On every page load, `validateCuration()` in `app.js` checks every curated champion id and item name against the **live** ddragon data and logs the result to the browser console (F12):

- ✓ green line = everything still resolves.
- ⚠️ warning = a champion id or item name no longer exists this patch → go fix it in `data.js`.

**Routine:** after a big patch, open the site, open the console, and act on whatever it flags.

## What ages fast vs slow

- **Evergreen (review a few times a year):** comp archetypes, duo synergies, off-meta pick identities. "Wombo dive" and "Malphite + Yasuo" don't change.
- **Volatile (review when items change):** the `build.path` arrays. Item *systems* get reworked ~yearly; individual items shift most patches. We curate *identity builds* (the core items that define the playstyle), not patch-perfect optimal builds, so they drift slowly, but the validator will tell you when a name breaks.

## How to edit `data.js`

- **Champion ids** must match ddragon exactly: `Kog'Maw` → `"KogMaw"`, `Wukong` → `"MonkeyKing"`, `Jarvan IV` → `"JarvanIV"`. Full list: `https://ddragon.leagueoflegends.com/cdn/<patch>/data/en_US/champion.json`
- **Item names** are plain display names (`"Rabadon's Deathcap"`); the app resolves them to icons. Straight vs curly apostrophes and spacing don't matter (names are normalized).
- **Runes** are `'Keystone · Secondary tree'` strings, conventional ones live in the `RUNES` map, off-meta picks carry a `rune:` field inside their inline build. Keystone names are validated against the live `runesReforged.json` (that's how we caught Phase Rush becoming Stormraider's Surge in 16.14).
- Bump `CURATION_META.reviewedPatch` when you do a review pass, so the console stamp reflects reality.

## Adding entries

Just append to the `SPICY`, `CLASSIC`, `DUOS`, `SPICY_DUOS`, or `COMPS` arrays; no other file needs touching. More entries = rarer repeats = a better tool. Targets to aim for: 15+ solo picks **per role, per flavor**, 40+ duos, 15+ comps.

The Solo Pick tab has a Classic / Spicy flavor toggle (same mechanic as the Duo tab):

- **`SPICY`**, off-meta picks. Each entry is self-contained and carries an inline `build: { rune, skill, path }`, because it plays the champion out of their conventional role.
- **`CLASSIC`**, conventional meta picks. Entries are lean (`{ id, role, why }`); the build and runes are pulled from the shared `BUILDS[id]` / `RUNES[id]` libraries (their *conventional*-role build). So **every classic champ needs a `BUILDS` and `RUNES` entry**, the validator flags any that are missing (it would otherwise fall back to a generic template / show no rune chip).

`SPICY_DUOS` entries likewise play champions out of role, so they carry an optional `builds: { adc, sup }` override; when present it wins over the shared `BUILDS[id]` entry.

## SEO / AI discovery

The static reference page **`picks.html`** mirrors the whole dataset as crawlable text (search engines and AI crawlers don't run our JS, so this is how they read the picks). **It does not auto-update.** After you change `data.js`, regenerate it and re-deploy, then ping IndexNow so Bing/Copilot re-crawl fast:

```
# 1. regenerate picks.html + llms.txt from data.js (the generator lives in the scratchpad)
# 2. scp picks.html llms.txt sitemap.xml to the server (fix perms as usual)
# 3. tell search + AI engines to re-crawl:
./indexnow-ping.sh
```

- **`indexnow-ping.sh`**, dev-only helper (kept OUT of the web root). Submits URLs to IndexNow; 200/202 = accepted. Pass URLs as args to ping specific pages.
- **`<key>.txt`** in the web root (e.g. `e5512bca…​.txt`) is the IndexNow ownership key, must stay reachable at the site root or pings are rejected. The matching key is hard-coded in `indexnow-ping.sh`.
- **`llms.txt`**, markdown site summary for LLMs. **`robots.txt`** explicitly allows the AI crawlers (GPTBot, ClaudeBot, PerplexityBot, Google-Extended, …).

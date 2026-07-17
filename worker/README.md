# Roll counter worker

A Cloudflare Worker backing the "rolls so far" number on the site. Keeps a single
running total in KV. Deployed separately from the static site.

## Deploy

```
cd worker
npx wrangler login                          # opens a browser once
npx wrangler kv namespace create COUNTER    # prints an id
```

Paste that id into `wrangler.toml` (`id = "..."`), then:

```
npx wrangler deploy
```

Wrangler prints the live URL, e.g. `https://lop-counter.<subdomain>.workers.dev`.
Put that URL in `COUNTER_API` at the top of `../app.js`.

## Endpoints

| Method | Path     | Does                                  |
|--------|----------|---------------------------------------|
| `GET`  | `/count` | Returns `{ total }`, no side effects  |
| `POST` | `/count` | Increments, returns the new `{ total }` |

Test it:

```
curl https://lop-counter.<subdomain>.workers.dev/count
curl -X POST https://lop-counter.<subdomain>.workers.dev/count
```

## Seeding a starting number

The counter starts at 0. To set it to something else:

```
npx wrangler kv key put --binding=COUNTER "rolls:total" "12345" --remote
```

Only do this if the number means something. A fabricated total shown to visitors
as real usage is a lie, just a small one.

## Known limits

- **Inflatable.** No auth and no server-side rate limit; anyone can POST in a loop.
  A KV-based per-IP throttle was tried and removed: KV's minimum `expirationTtl`
  is 60s, so it capped real users at one roll per minute. An unauthenticated public
  endpoint can't be meaningfully protected anyway, so the client just debounces
  double-clicks. The total is decoration, not analytics — the honest traffic
  numbers are in Cloudflare Web Analytics. If inflation ever actually happens,
  use Cloudflare's dashboard rate limiting rather than rolling it into the Worker.
- **Undercounts under load.** The increment is a read-modify-write, so concurrent
  rolls can clobber each other. Durable Objects would make it exact; not worth it here.
- **Eventually consistent.** A fresh total can lag a few seconds behind reality.
- **CORS is origin-locked** to league-of-peppers.com (+ localhost:8000 for dev).
  Add origins in `ALLOWED_ORIGINS` in `src/index.js` if that changes.

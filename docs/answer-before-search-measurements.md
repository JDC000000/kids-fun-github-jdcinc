# Front door: static → dynamic, measured

**Unit A5.** `app/page.tsx` was statically prerendered; `<ThreeThings />` evaluates a real search
in process, so the page is now `force-dynamic`. The Operator made that call; this document is the
before/after the design doc asked for and did not want assumed
(`docs/answer-before-search-design.md` §9.2 A5: *"a real change to the product's fastest page and
needs its own before/after measurement"*).

Measured 2026-08-19. Before = `origin/main` @ `27d2b47`; after = `feat/kf-answer-before-search`.
Both built with `next build` and served with `next start` on the same machine, minutes apart,
default search backend (fixture — see the caveat in §3, it is the important one).

---

## 1. What the build says

| | Before (`○` static) | After (`ƒ` dynamic) |
|---|---|---|
| `/` route size | 3.19 kB | **2.22 kB** |
| `/` First Load JS | 146 kB | **137 kB** |
| Render mode | prerendered at build | server-rendered per request |

**The client bundle got smaller, by 9 kB.** That is not a rounding artefact and it is worth stating
plainly because it runs opposite to the intuition that "dynamic costs more": `HomeTodayStrip` was a
client island — `useState`, `useEffect`, a `fetch`, the response mappers and `partitionSections`
all shipped to the browser to render three cards. `ThreeThings` is a server component, so none of
that crosses the wire. The front door now ships **less** JavaScript and has the answer in its HTML
instead of fetching it after hydration.

## 2. What the server says

25 sequential warm requests to `/`, TTLB:

| | Before | After |
|---|---|---|
| p50 | 5.8 ms | **14.5 ms** |
| p95 | 8.4 ms | **17.8 ms** |
| max | 10.8 ms | 22.9 ms |
| HTML | 27,560 B | 33,677 B |
| `Cache-Control` | `s-maxage=31536000, stale-while-revalidate` | `private, no-cache, no-store, max-age=0, must-revalidate` |
| `x-nextjs-cache` | `HIT` | *(absent — nothing to cache)* |

**+8.7 ms at p50 on a warm instance**, for three engine passes and the render.

## 3. The caveat that matters more than the number above

**That 8.7 ms was measured against the FIXTURE catalogue (~40 listings), not the live one (1,781
cards as of this measurement).** The three slot queries are filter → rank → sort → collapse →
venue-cap passes whose cost scales with the candidate set, so the fixture figure is a floor, not an
estimate of production.

The honest upper bound available from here: staging `/api/search`, warm, for the three real slot
queries — `min 0.147–0.159 s`, `p50 0.156–0.281 s` each. That number includes HTTP, TLS, the
Vercel function hop and JSON serialisation of up to 100 rows, none of which the in-process path
pays, so the true in-process cost sits somewhere well below it. It is quoted because it is a real
measurement rather than a guess, not because it is the answer.

**What is not measured, and cannot be from this environment:** a cold instance. The catalogue load
is cached per warm instance (`getCachedPostgresListings`; 60 s TTL when this was measured, 10 min
since 2026-09-23) and was measured at 428 ms in `postgres-repository.ts`. A static page never paid
that on any request; a dynamic one pays it
whenever it lands on a cold instance or an expired cache. Somebody should watch this after deploy.

## 4. The change that is bigger than the latency

`/` is no longer CDN-cacheable. Before, Vercel served the front door from the edge with a one-year
`s-maxage`; after, every visit executes a function. The design document's framing — *"cost is
bounded, the catalogue load is already cached per warm instance"* — is true about the catalogue and
understates this: the bound applies to the *work inside* the render, not to the number of renders,
and that number went from "once per deploy" to "once per visitor".

Stated plainly rather than buried, per the brief: **this is the real cost of A5, it is larger than
the 8.7 ms, and it was an accepted consequence of the Operator's ruling rather than a surprise.**
The premise being bought is that the answer is in the HTML on arrival. If the traffic profile ever
makes that trade look wrong, the exit is not to re-hydrate the block client-side (which is the
thing the ruling rejected) but to give the page a short `revalidate` window — the three things
change on the scale of hours, not seconds, so a 60-second shared cache would restore most of the
edge benefit and cost at most a minute of staleness. That is a product call, not this unit's.

## 5. It renders

The block, served from the built app (fixture backend, so most of the catalogue is out of date
relative to the wall clock — which is what makes it a good demonstration of the empty states):

```
Three things you could do today
On today across Metro Vancouver — confirmed listings only, each with its source and last-checked date.

  Something free
    Nothing free is listed for today yet.                            [See what is on →]

  Something indoors
    Aquarium Daily Visit · Vancouver Aquarium
    Available any day · Open 9 AM–5 PM · All ages · $40 approx.
    ✓ Confirmed · fixture source · Checked 39 days ago

  Something near downtown Vancouver
    We have listings near downtown Vancouver today, but none we can
    confirm is for children.                                         [See what is on →]

See everything on today →
```

One filled slot, two honest empty ones, each saying which kind of empty it is — `nothing_on`
("nothing free is listed") versus `none_showable` ("we have listings, but none we can confirm is
for children"). Nothing was broadened to fill anything; every request behind this carried
`minResults: 0`.

# SkyBlock XP Planner

A web app for answering **"what's the cheapest way to get the next N SkyBlock XP?"** — grouped by category, with low-value filler filtered out.

## The problem with existing tools

Current bots (SkyHelper `/level` and similar) sort every remaining task by **coins per SkyBlock XP**, ascending, across 30+ pages. That's technically correct and practically useless:

- The top of the list is dominated by 1 XP tasks. Clearing page 1 might net you 15 XP.
- Tasks are shown as a flat list, so a museum donation sits between two minion crafts and an Abiphone contact — three different islands, three different interfaces.
- Prerequisite chains aren't priced in. "Craft Lily Pad Minion 5" quietly requires tiers 1–4 and the collection unlock.

## Design principles

**1. Don't model time.** Time-per-task is unquantifiable in practice — some tasks are two clicks in a menu you already have open, others need a warp, an NPC, and a quest step. Any per-task second estimate would be fiction. Use two honest proxies instead:

- **XP chunk size** — a user-set floor (e.g. "hide anything under 5 XP") that removes the death-by-a-thousand-clicks problem without pretending to know how long anything takes.
- **Category grouping** — tasks in the same category share a location and an interface, so doing five of them costs barely more than doing one.

**2. Coins are the budget, XP is the goal.** Invert the existing query. Instead of "sort everything by efficiency," ask "I want N XP — what's the cheapest set of tasks that gets me there?"

**3. Score prerequisite closures, not leaves.** A task's real cost includes every unmet prerequisite.

---

## Core queries the app answers

### A. Cheapest path to N XP
User inputs an XP target (or a target SkyBlock level). App returns the minimum-coin set of tasks that reaches it, respecting the XP floor filter.

This is a **min-cost knapsack**: minimise `sum(cost)` subject to `sum(xp) >= N`. Greedy by coins-per-XP over the eligible set gets within a percent or two of optimal and is instant; a DP over XP (bucket size 1 XP, target rarely exceeds a few thousand) gives exact answers if you want them.

### B. Category browser
Every category as its own panel: total XP still available, total coin cost, count of remaining tasks, and the tasks themselves sorted by coins/XP. This is the "I'm at the Abiphone anyway, what else can I buy here" view.

### C. Batch plan
The output of query A, regrouped by category/location rather than by efficiency rank, so the user does one trip per category. Order categories by total XP in the batch, descending.

---

## Data model

```ts
type Task = {
  id: string;              // "minion_lily_pad_5"
  category: Category;
  name: string;
  xp: number;              // SkyBlock XP awarded
  requires: string[];      // task ids that must be completed first
  cost: CostSpec;          // see below
  repeatable: false;       // all SkyBlock XP tasks are one-time
};

type CostSpec =
  | { kind: "bazaar";   items: { id: string; qty: number }[] }
  | { kind: "auction";  itemId: string }
  | { kind: "npc";      coins: number }          // fixed price
  | { kind: "essence";  type: EssenceType; amount: number }
  | { kind: "none" };                            // grind-only, no coin cost

type Category =
  | "museum" | "minions" | "abiphone" | "fast_travel" | "bank"
  | "essence_shop" | "fairy_souls" | "accessory_bag" | "pet_score"
  | "collections" | "skills" | "dungeons" | "events" | "rift";
```

`cost` resolves to a live coin figure at query time. Tasks with `kind: "none"` (skill levels, dungeon floors, fairy soul hunting) have infinite coins-per-XP and should be excluded from the cheapest-path solver but still shown in the category browser with a "grind" tag — they're often the largest single XP awards available and the user should see them.

### Prerequisite closure

For each task, compute the transitive set of unmet prerequisites. The **bundle** is that closure plus the task itself.

```
bundle_cost(t) = sum(cost(u) for u in closure(t) if not done(u))
bundle_xp(t)   = sum(xp(u)   for u in closure(t) if not done(u))
efficiency(t)  = bundle_cost(t) / bundle_xp(t)
```

Rank on `efficiency`, display on the bundle. Critically: **recompute after every selection.** Bundles overlap heavily — once tiers I–IV of a minion are bought for one T12, every other deep tier in that family gets much cheaper. A static sort computed once will be wrong by the third item.

---

## XP values by category

Worth encoding as a table rather than scraping per-task, since most categories are formulaic. Source: Hypixel SkyBlock Wiki, `SkyBlock_Levels/Tasks`.

| Category | XP structure | Total available |
|---|---|---|
| Skills | +5 (lv 1–10), +10 (11–25), +20 (26–50), +30 (51–60) per level | 8,710 |
| Museum | milestone-based, see Museum/Milestones | 3,646 |
| Minions | +1 per tier I–VI, +2 VII, +3 VIII, +4 IX, +6 X, **+12 XI, +24 XII** | 3,164 |
| Collections | +4 per milestone | 3,160 |
| Accessory bag | +1 per magical power | ~2,121 |
| Pet score | +3 per pet score | ~1,527 |
| Catacombs | +20 per level (1–39), +40 (40–50) | 1,220 |
| Dungeon classes | +4 per level | 1,000 |
| Fairy souls | +10 per 5 souls | 570 |
| Fast travel | +15 per scroll | 360 |
| Master mode floors | +50 each | 350 |
| Bank upgrades | 20 / 25 / 30 / 35 / 40 / 50 | 200 |
| Catacombs floors | +20 (F1–4), +30 (F5–7) | 190 |
| Essence shops | +2/+2/+3/+5/+7 per perk tier, higher for deep perks | varies |
| Abiphone | +10 per contact | varies |
| Event perk shops | +2/+2/+3/+5/+7 per tier | 49 per shop |

SkyBlock levels are **flat: 100 XP per level, always**. No curve to model, no diminishing returns — 100 XP is one level whether you're at 300 or 500.

### Notes on individual categories

- **Minions**: the tier curve is the whole story. Tiers I–VI are 1 XP each; XI is 12 and XII is 24. Depth beats breadth by a huge margin. Any category view should let the user filter to "tier ≥ XI only."
- **Accessory bag**: 1 XP per magical power, ~2,100 XP available, and it's almost purely coin-gated. This is the single best place to convert coins into XP without grinding. Recombobulators and enrichments count.
- **Fast travel scrolls**: 15 XP each for one purchase with no prerequisite chain. Should surface near the top of almost any plan.
- **Bank upgrades**: 200 XP total across six purchases. Pure coins.
- **Pet score**: 3 XP per point; buying an already-maxed pet off AH is one transaction for a chunky jump.

---

## Data sources

| What | Where |
|---|---|
| Player's completed tasks | Hypixel API `/v2/skyblock/profiles`, `member.leveling` |
| Current SkyBlock XP | same, `leveling.experience` |
| Bazaar prices | Hypixel API `/v2/skyblock/bazaar` |
| Auction prices | `/v2/skyblock/auctions` (paginated) or a lowest-BIN aggregator |
| Static task table | scraped from the wiki, committed to the repo as JSON |

Cache the bazaar snapshot — a 60s TTL is plenty. These items don't move fast enough for live pricing to change any ranking, and it keeps you well inside rate limits.

`leveling` in the profile response tells you completed tasks but not always in the granularity you want; you may need to derive some completions from other profile fields (minion tiers from `crafted_generators`, fairy souls from `fairy_souls`, accessory power from the accessory bag contents).

---

## UI sketch

**Controls (persistent):**
- XP target — number input, or "get me to level N"
- Minimum XP per task — slider, default 5. This is the key knob; it's what makes the tool feel different from what exists.
- Coin budget — optional cap
- Category toggles — exclude categories the user doesn't want to touch

**Main view:** the plan, grouped by category. Each group shows category name, total XP, total cost, and an expandable task list. A running total at the top: XP gained, levels gained, coins spent.

**Secondary view:** full category browser, all categories, all remaining tasks, sorted by coins/XP within each.

Show the bundle explicitly when a task has prerequisites — "Lily Pad Minion V (requires I–IV) — 5 XP for 46.2K total" rather than pretending tier V costs 29.6K on its own.

---

## Build order

1. Static task table as JSON + the XP formula table above.
2. Profile fetch → mark completed tasks.
3. Bazaar/AH price resolution → live cost per task.
4. Prerequisite closure + efficiency ranking.
5. XP floor filter and category grouping (this is where it starts being better than what exists).
6. Cheapest-path-to-N-XP solver.

Steps 1–5 are already a more useful tool than the current bots. The solver in step 6 is the differentiator.

## Open questions

- Should grind-only tasks (skills, dungeon floors) appear in the cheapest-path result with a "free but slow" tag, or stay browser-only? Leaning browser-only, since mixing them into a coin-optimised plan makes the totals meaningless.
- Event-gated tasks (Spooky Festival, Mining Fiesta, Hoppity's Hunt) are only actionable during their event window. Worth a separate "available now" section driven by the SkyBlock calendar.
- Museum donations lock the item away permanently. Some are cheap in coins but expensive in "I might want that item." Possibly a warning flag on high-value donations.

---

# Build state

Steps 1-6 of the build order are in place for the categories listed below. `DATA.md` records
where every number comes from and what is still missing.

There are two ways to run it, and they share all their logic.

### 1. The standalone file (no server)

`dist/skyblock-xp-planner.html` is one self-contained file — inlined data, inlined script, no
install and no server. **Double-click it.** Type a username, pick a profile, and it calls
Hypixel straight from the page.

This works because Hypixel's CORS policy is fully open: the preflight explicitly permits the
`API-Key` header, so a `file://` page can call the API directly. Mojang's own name lookup does
*not* send CORS headers, so name→UUID goes through a mirror that does (ashcon, falling back to
playerdb); you can also paste a UUID directly.

Rebuild it after changing anything:

```bash
npm run build:html
```

No API key is baked in by default. The page has a **Get an API key** link right above the key
field, pointing at the [Hypixel developer dashboard](https://developer.hypixel.net/dashboard);
paste the key you get there into the field and it's remembered in `localStorage` from then on —
it never leaves the browser and is never sent anywhere but Hypixel.

For a private, self-hosted build where baking a key in is a deliberate choice, `--key YOUR_KEY`
or `--from-env` (reads `.env.local`) will do it — **never commit a build made with either flag**,
since the key would be sitting in plain text inside the HTML.

### 2. The Next.js app (keeps the key server-side)

```bash
npm install
cp .env.example .env.local   # add your Hypixel API key
npm run gen:data             # rebuild the static task tables from the resources API
npm run dev                  # http://localhost:3000
```

Use this one if the key must not sit in a file you might share.

`npm test` runs 21 tests over the solver, the NBT decoder and formatting; `npm run typecheck`
and `npm run build` are clean.

### Which does what

|  | Standalone HTML | Next.js app |
|---|---|---|
| Needs a server | no | yes |
| API key location | inside the file / localStorage | server-side `.env.local` |
| Changing the XP floor | instant, no network | round-trip to the server |
| Auction sweep | on demand, cached 10 min in localStorage | on demand, cached 10 min in memory |
| Refresh prices | button — re-pulls both feeds, ignoring the cache | same button, `?refresh=1` clears the server cache |

Both call `buildReport` from `src/lib/report.ts` and the same solver, so identical inputs give
identical answers — verified against a live profile: both report 1,684 MP computed and the same
353 XP / 2.90B plan.

## What works

- **Query A** — cheapest path to N XP, or to a target level. Greedy with a full recompute after
  every pick, plus a prune pass that drops picks the plan outgrew. A `exact` min-cost knapsack
  is also available.
- **Packages** — the affordable work split into fixed-size spending chunks: "here is the best
  10M you can spend, then the next 10M". The size is whatever you type (`10M`, `250k`, `1.5B`),
  and **Packages ahead** sets how many to plan. Each package is grouped by category like the batch
  plan, and carries its own coins/XP rate plus how much worse it is than package 1 — which is
  the actual stop signal, since the rate climbs steeply as the cheap XP runs out. Each package
  also reports what it **bled**: the XP given up to keep the spending convenient.
- **Grind order** — the free XP, ordered by how much work it looks like, across every category
  at once. There is no price to rank these on, so the ordering comes from how many real players
  have already finished each task; see `DATA.md` for what that does and doesn't measure.
- **Query B** — category browser, every remaining task sorted by coins/XP, grind-only tasks
  tagged rather than hidden.
- **Query C** — the plan regrouped by category, ordered by XP in the batch.
- The XP floor, coin budget and category toggles re-solve live — see the note on solve cost below.

## Modelled categories

All 16, ~40,000 XP, 4,964 tasks. `DATA.md` has the provenance for each number.

| Category | XP available | Source of the task list | Source of completion |
|---|---|---|---|
| Skills | 8,440 | resources API | profile skill XP |
| Slayer | 7,220 | wiki curves + harvested ids | slayer XP per boss |
| Museum | 3,644 | `museum_data.donation_xp` in the items API | `/skyblock/museum` |
| Minions | 3,165 | resources API | `crafted_generators` |
| Attribute Shards | 1,810 | wiki attribute list | `attributes.stacks` |
| Misc | 3,180 | harvested ids | `completed_tasks` |
| Collections | 3,016 | resources API | `unlocked_coll_tiers` |
| Dungeons | 2,760 | wiki curve (catacombs + 5 classes + floors) | dungeon XP |
| Essence shops | 2,074 | harvested ids | `completed_tasks` |
| Accessory bag | 1,872 | items API + magical power | talisman bag NBT |
| Pets | 1,470 | auction house listings | `pets_data.pets` |
| Abiphone | 840 | harvested ids | `completed_tasks` |
| Events | 749 | harvested ids | `completed_tasks` |
| Fairy souls | 570 | formula | `total_collected` |
| Fast travel | 360 | harvested ids | `completed_tasks` |
| Bank | 310 | harvested ids | `completed_tasks` |
| Rift | 295 | harvested ids | `completed_tasks` |

Attribute levels (1,810, priced from bazaar shards), Heart of the Mountain (1,175), Center of
the Forest (250) and the garden's plots, crop upgrades and composter (542) are all modelled — see `DATA.md` for where
each one hides in the API.

Still missing, and named in the UI: bestiary (~4,370), the rest of the garden (~1,063), and
Peak of the Mountain plus Heart of the Forest (~1,545 — their XP tables are published but the
API exposes no tier field, so modelling them would show everyone zero progress). The app shows
what percentage of your earned XP it can account for, so the gap is visible rather than implied.

## Where the data comes from

Three sources, in order of preference — full detail in `DATA.md`.

1. **The Hypixel API**, wherever it publishes anything. It turns out to publish more than the
   spec assumed: skills and collections ship `"+5 SkyBlock XP"` strings in their unlock lists,
   and every museum item carries `museum_data.donation_xp`. There's also an undocumented
   `/skyblock/museum` endpoint giving donations per profile.
2. **Live players**, for the task-id namespace. `completed_tasks` holds Hypixel's internal ids
   but nothing lists which exist, so `npm run gen:ids` samples players from the auction house
   and unions their completions — 1,056 distinct ids from 140 players, saturating by ~30.
3. **The wiki**, for XP values the API doesn't publish, via the MediaWiki API. Its tables are
   rowspan-heavy, so the parsers rebuild the grid before reading rows.

The join between (2) and (3) is by structural rule rather than by name, because wiki display
names and internal ids don't correspond. Every rule is checked against the wiki's own totals —
that check is what caught a wrong slayer curve and a mis-spelled essence perk.

```bash
npm run gen:ids    # resample the task-id namespace from live players (slow, ~140 API calls)
npm run gen:all    # rebuild every table: API resources, wiki tasks, wiki curves, the join
```

## Deviations from the spec above

Three, all deliberate:

1. **`CostSpec` gained a `"unknown"` kind.** Minion tiers I-XI have real XP and no recipe data
   in the API. Inventing a price would poison every ranking; dropping the task would hide real
   XP. `unknown` keeps it in the browser and out of the solver.

2. **Tasks gained `exclusiveGroup`.** Accessory families compete rather than stack — Bat
   Talisman, Ring and Artifact are 3, 8 and 12 magical power, but owning all three is still
   worth 12. Without this the bag advertised 3,329 XP against a real ceiling near 2,000, and a
   plan would buy the same magical power three times over. Both solvers respect it; a second
   purchase in a family is only credited the difference it adds.

3. **Categories beyond the spec's list.** The game has task families the spec's `Category`
   union didn't cover — slayers, the dojo, trophy fish, harp songs, reputation, Jacob's
   contests — so `slayer` and `misc` were added rather than dropping ~4,200 XP on the floor.

4. **The exact solver is a group knapsack, not a plain DP over XP.** Overlapping prerequisite
   bundles break the independence a 1-D knapsack assumes: the same minion tiers I-IV appear in
   the closure of every deep tier in that family, so summing bundles double-counts. Chains
   become mutually-exclusive prefix options and families become option groups, which makes the
   DP exact for the priced pool as it actually is (nearly all standalone purchases) instead of
   approximate everywhere.

## Open questions from the spec, answered

- **Grind-only tasks in the cheapest path?** Browser-only, as the spec leaned. They have
  infinite coins/XP and would make the plan's totals meaningless. They're tagged `grind` in the
  browser and shown with their XP, since they're often the largest awards available.
- **Museum donation warnings?** Deferred with the category. Worth a flag when it lands.

## Known limitations

- The accessory bag has a slot limit tied to bag upgrades; the planner doesn't model it, so a
  long accessory plan may exceed what the player can actually carry.
- The XP floor filters on a bundle's total XP, not per click. A five-tier minion bundle worth
  5 XP passes a floor of 5 while being five actions.
- Accessory family coverage is best-effort; see `DATA.md`.

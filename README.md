# SkyBlock XP Planner

A web app for answering **"what's the cheapest way to get the next N SkyBlock XP?"** — grouped by category, with low-value filler filtered out.

The page has a second half. **Bazaar** — flips and crafts off a live read of Hypixel, ranked on
coins per hour rather than on the spread — needs no API key and no profile, and is documented
separately in [BAZAAR.md](BAZAAR.md).

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

**The material on a row is click-to-copy.** Every attribute row reads "30× Voracious Spider Shard",
and the next thing anyone does with that sentence is type the shard's name into the bazaar's search
box — by hand, off a screen, with the count and the multiplication sign in the way. Clicking the
name copies it. The count stays plain text, because nothing is ever searched for by its count.

Attribute shards get a **Group maxed** toggle in the panel. There are 181 attributes of ten levels each, and the per-level rows differ only in how many of the same shard they want, so listed individually they're 1,810 near-identical lines shown forty at a time. Grouped, each attribute is one row — the levels you're missing, the shards they add up to, and the price of the lot — because maxing an attribute is one decision, not ten. The grouping is built from the untruncated set, so it isn't assembled out of whichever forty levels survived the cut, and the XP floor is applied to the grouped row rather than to its levels.

### D. Cheapest first
Everything buyable in one list, cheapest coins-per-XP first, category walls down. The browser answers "I'm at the Abiphone anyway, what else"; this answers the blunter question underneath — of everything in the game, what is the next cheapest XP, wherever it lives. Ordered on the same figure the rows display (bundle coins over bundle XP) so the list reads as monotonic.

Its **Group maxed** toggle folds each multi-tier thing into the single purchase it really is, and the two shapes don't fold the same way. Tiers you buy *through* — attribute levels, minion tiers, museum tool marks — are summed, because they all count. Tiers that *replace* — pets, accessory families — collapse to the best member alone, because owning the epic makes the rare worthless; summing those would quote uncommon + rare + epic for a pet you buy once. On a maxed profile that takes 2,288 buyable tasks down to 819 purchases.

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

### Rebuilding

```bash
npm install
npm run build:html      # -> dist/skyblock-xp-planner.html
npm test                # 70 tests over the solver, grouping, NBT and data wiring
npm run typecheck
```

There is no server and no framework. The whole app is `src/browser/` (the page and its API
calls) over `src/lib/` (the model: catalog, resolver, solver, report), bundled by esbuild into
one file with the data tables inlined. `npm run gen:data` refreshes those tables from the
Hypixel resources API when the game changes; the wiki-derived and curated tables under
`data/` are rebuilt by the other `gen:` scripts.

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
- **Bag slots in the buy lists.** An accessory needs somewhere to sit, so a plan that buys
  accessories into a full bag buys Jacobus's upgrades to hold them — one per two new families,
  paid for out of the same budget, and listed at the head of the accessory bag group because
  nothing else in it can be bought first. The browser has always placed them where the room runs
  out; the plan and the packages now do the same. `DATA.md` has the rule and the two wrong
  models that preceded it.
- **Collections say how far off they are.** A row used to be noted with the tier's requirement —
  "50,000 collected" — which is what it costs from a standing start and the one number the player
  already has behind them. It now reads `325 more (49,675 of 50,000)`, so two tiers of the same
  size stop looking like the same job. Both the browser and the grind order show it, measured
  from the co-op's shared total where there is one.
- **Pets say where you stand and where you stood.** SkyBlock XP is settled on the highest pet
  score the profile has ever reached, so selling a pet drops the score and keeps the XP — two
  different numbers that the category used to report as one. Only the highest is published;
  what you hold now is worked out from the pets themselves, max-level bonuses included, and the
  panel gives both against the 518 ceiling. `DATA.md` has what the API does and doesn't carry.
- **Pets have a `Top rarity only` toggle.** The rarity ladder is most of what that category is,
  and nobody climbs it a rung at a time — so one row per pet, at the best rarity that pet
  reaches, priced from what you own rather than as an upgrade over a rarity you were never going
  to buy. Mythic where a pet goes mythic, common for the Precursor Drone, which never does: the
  point is to skip the rungs on the way up, not to pick one.
- **The bestiary has a `Fewest kills` toggle.** Its ranking scales a tier against its own
  family's ladder, which is the right answer to "what is the least work" and no answer at all to
  "what am I about to finish" — a short-laddered family reads as a marathon while sitting one
  kill from the next tier. Same rows, ordered on kills left instead.
- **Minions the game will not sell you say so.** The Mycelium and Red Sand lines are gated on
  Crimson Isle reputation, tier by tier, and a row above your standing is tagged `needs 10,000
  mage rep` and sunk below everything you can actually act on — but never cut from the list,
  because a row that vanishes tells you you're finished when you aren't. A gate is not a price:
  the ingredients are affordable, and the merchant still says no. Because the gated tiers sort
  last, the chain splits itself where your reputation runs out: `Mycelium Minion I–IV` to buy
  now, `V–XI` waiting on 10,000.
- **Essence perks say what they cost in essence** — `1.2k wither essence` on the row, off the
  same figure the price is computed from, rather than the wiki rule that used to read "essence
  shop perks" on all four hundred of them.
- The XP floor, coin budget and category toggles re-solve live — see the note on solve cost below.
- **The Minions section has three child tabs**, because a minion is one rate applied to three
  unrelated questions and a single table carrying all three is a table of columns most readers are
  ignoring. *Collections* is the original: what fills a collection fastest, ranked on SkyBlock XP.
  *Raw profits* is what a minion pays an hour in coins. *Pet profits* is what it levels.
- **Raw profits caps every rate by storage, because a full minion earns nothing.** A Tier XII holds
  960 items and makes thousands an hour, so uncompacted it is idle inside the hour and the
  coins-per-hour figure other calculators quote is one you receive for about forty minutes a day.
  The tab asks how often you actually visit and prices what you collect, not what is produced —
  and shows the gross beside it so the gap is visible. Storage is scraped per minion per tier off
  the wiki's own tooltips; the compaction ratio comes from each item's crafting recipe, so 160
  cobblestone to an Enchanted Cobblestone is read rather than assumed.
- **Raw profits refuses to be fooled by a thin book.** This is the specific failure it was built
  against: a bazaar item's top-of-book quote jumps because the orders behind it emptied, and the
  minion attached to it climbs to the top of the table on a price nobody can actually sell into.
  Every drop carries a month of its own daily prices from Coflnet, and the row reports how far
  today sits from that month **in standard deviations** rather than as a percentage — because +15%
  means nothing without knowing whether the item normally moves 1% a day or 40%. Past two sigma the
  guarded basis stops believing the quote and uses the month's median instead, and says so. Caught
  live on the first run: gunpowder quoting 45 against a month median of 11 at +2.5σ, which had put
  the Creeper Minion third on the page at 29k/hr against a real 7k.
- **Raw profits prices three markets, not one.** Instaselling pays the top buy order less the
  bazaar's 2.25%; a sell offer pays the ask and takes time; a shopkeeper pays a fixed price and
  takes nothing — which for cheap bulk output beats both bazaar routes more often than people
  expect. A hopper is priced as what it is rather than as an upgrade: it sells the overflow at 50%
  or 70% of the shop price, which is usually worse than walking over yourself.
- **Pet profits is a real mechanic, not a workaround.** Collecting a minion grants Skill XP — the
  Minions page says so, and then says what people do with it — and a pet that is out levels off it.
  The per-item rates are not a fraction of the XP for doing the thing yourself and cannot be derived
  from it: Wheat is +4 by hand and +0.3 from a minion, Ice is +0.2 by hand and +0.5 from a minion,
  and Nether Wart is +4 by hand and flatly +0 from one.
- **The rates come from two places, and the second one is where most skills live.** The Farming and
  Mining pages carry a **Minion XP** column and no other skill page does — which made Foraging,
  Fishing and Combat look unpublished. They are published, one item page at a time, in a
  `|minion_xp = 0.5 Fishing` infobox field: 42 item pages carry it, between them covering six
  skills, and each states the item id and the skill outright so nothing has to be guessed from a
  display name. That took coverage from 45 rated items across 2 skills to **77 across 6**. What is
  still genuinely unpublished — Enchanting, and 24 of the 61 minions — says **not published**
  rather than claiming a zero, since an unknown and a zero rank at opposite ends of a table.
- **Compaction turns out to be XP-neutral, and that is checked rather than assumed.** An enchanted
  item's minion XP is exactly its recipe quantity times the base item's, across every pair where
  both are published — including Sponge, whose recipe is 40 rather than 160 and whose XP ratio is
  40 to match, which is what makes the rule a rule and not a coincidence of everything being 160.
  So a Super Compactor changes what a minion drops and not what the drop is worth in XP. One pair
  disagrees (Spider Eye, published at 480 where the rule says 48) and is recorded as a suspected
  wiki typo rather than silently corrected.
- **Pet profits takes Wisdom and Taming as inputs and applies them in the right order.** Wisdom is
  additive and goes first, scaling the Skill XP; Taming is multiplicative through Zoologist at +1%
  a level and scales the Pet XP that Skill XP became. Then the divisors, which decide most of the
  ranking: a pet earning XP outside its own skill keeps a third, and a pet earning Alchemy or
  Enchanting XP that is not an Alchemy or Enchanting pet keeps a **twelfth**. Carpentry grants no
  Pet XP at all, which retires the crafting route from this question however much Carpentry XP it
  is worth — and is shown on the page rather than left off it.
- **Pet profits ranks pets on coins per Pet XP, not on the margin.** Ranked on margin the Golden
  Dragon wins every time and is the wrong answer for anyone who has to generate the 210 million Pet
  XP it needs. Prices come from a full auction sweep that keeps the level — which lives inside the
  display name and nowhere else in the payload, and which the accessory index throws away, so a
  level 1 and a level 100 of the same pet are two different purchases. The tab also says the
  unflattering thing out loud: at the best published minion rate a pet takes days to weeks, so
  minion XP is a background trickle rather than a way to level a pet on purpose.

## Solve cost

Every knob on the planner re-solves from the profile already in memory, so none of them touch
the network. What they do cost is arithmetic, and the shape of that is worth knowing.

The expensive part is the greedy fill: it takes the cheapest bundle per XP, applies it, and
recomputes the whole board before picking again — several thousand picks over a catalogue of
~13,000 tasks for a package run. Four things keep that affordable, and all four are caches over
work that provably cannot have changed:

- **Every column on the Pet profits tab sorts too**, across all three of its tables — the plan, the
  routes, and the pet market. Each keeps its own column order, since one shared setting would mean
  sorting the pet market by "actions a day"; the headline cards stay on the best *plan* whatever the
  table is sorted by, because re-sorting to inspect something should not change the recommendation.
- **Every column in Raw profits sorts.** Each carries a sort value separate from its rendered cell,
  because sorting "9.7k" against "48k" as text puts the wrong one on top, and "never fills" is a
  real answer that has to go to one end rather than poisoning the comparison.
- **Corrupt Soil is modelled, and it changes the table.** An upgrade can multiply what a minion
  already makes, change how much of it fits, or add a second item it did not make at all — and the
  third kind was missing. Corrupt Soil adds 1 Sulphur and 1 Corrupted Fragment per harvest to any
  mob minion, and on a cheap one the extras beat the drop: a slimeball fetches 5 at a shopkeeper,
  the Sulphur alone 10. With it counted the Slime Minion moves from 12th to 5th, the Tarantula
  roughly doubles, and the Revenant enters the top three. A one-click **Automated shipping** preset
  sets the whole thing up — Corrupt Soil, a Super Compactor, an Enchanted Hopper and a claim
  interval that says "never" — because it needs three exact slots and looks mediocre if any is
  wrong. (Sulphur is `SULPHUR_ORE`; `SULPHUR` is Gunpowder. There is a test pinning both.)
- **The Pet profits tab opens with a plan**: which minion to put down, which pet to sit on it, and
  what the pair makes in a day. Pairing is the hard part — a pet keeps all of its own skill's XP and
  a third of anything else — so `fetch-pets.mjs` now scrapes each pet's skill from its infobox, and
  the pet is chosen on the pet half of the profit rather than the total, or the item income (which
  is identical across pets) makes the choice a tie broken by nothing.
- **Both halves of the profit are counted**: the pet margin, and everything the minion sold while it
  levelled. For every real setup the items are the larger half by an order of magnitude, and the
  section says so rather than letting one number read as "level pets off minions for 1.3M a day".
- **The Pet profits tab is shaped around its question**: the best money from minion pet-levelling.
  It runs one plan against one generous budget — four collections a day and up to 200 brews — rather
  than the three effort modes it used to offer. Those were three answers to a question the tab does
  not have: each re-planned the whole table, so reading the page meant holding three tables in your
  head, and the ranking on **what pet-levelling adds** already declines to recommend a plan whose
  brewing eats more than the pet is worth. Every row still carries **actions a day** beside its
  profit. The Wisdom boxes and the minion setup stay on screen — they scale every number below them,
  and folding them away is how a plan ends up computed against six zeroes nobody noticed. Only the
  workings fold.
- **The pets live under the minion that feeds them.** Opening a plan row shows the five best pets
  for that minion, with what each adds, what it costs and how long one takes. This replaced a
  forty-row market table further down the page, which ranked every pet on the auction house against
  a rate the reader had to go and find for themselves — so its top row was routinely a pet no minion
  on the page can level this side of a year. Ranked per minion, the question it answers is the one
  being asked.
- **Alchemy drops pay twice, and the plan now says so.** Collecting a minion pays its own skill's
  XP; brewing what you collected pays Alchemy. The tab counted only the Alchemy half, which threw
  away the larger of the two. A brewing row now names **two pets** — the Alchemy pet for the stand
  and the minion's own-skill pet for the collection, swapped, since only one pet is out at a time —
  counts both margins in the profit, and lists five candidates for each skill.
- **One brewing route a minion, chosen on XP a day inside the brew budget.** A drop usually reaches
  several entries in the alchemy table — cactus reaches three — and they are versions of one
  decision, so one belongs in the table. It is not the most compacted one: compacting trades XP
  away, since an Enchanted Cactus is 25,600 cactus and pays 500 where those same cactus brewed raw
  pay 256,000. Nor is it the rawest, which pays best per drop and asks for eleven thousand brews a
  day. The brew ceiling is the real constraint, so the winner is whichever pays the most XP a day
  once both are capped by it — usually a middle rung, and the one that leaves the most drops unspent.
- **Only the top two rarities of each pet are planned.** Every rarity is its own trade with its own
  two ends, so a six-rung pet contributed six rows and the low rungs are not trades anybody makes: a
  Common needs 5.6M Pet XP against a Legendary's 25.4M, so it can price respectably per point of XP
  — the figure the table ranks on — while being worth a fraction of the coins behind a sell side one
  listing deep. Each pet's *own* ladder decides, not a global floor: Mythic and Legendary where a
  pet reaches Mythic, Legendary and Epic where it stops at Legendary, and a pet that only exists at
  one rarity keeps its one. Two rungs rather than one because the top rung is often the thin one.
- **Pets nobody is buying are left out.** The sell side was the cheapest max-level listing, which is
  a real number and often not a price anyone will pay: a levelled Common Rock has **one** listing
  behind it against thirty-two for a Golden Dragon. The sweep already reads `start`, so depth and
  listing age both come free — thresholds measured from a full sweep (median max-level listing is 28
  hours old; liquid pets carry 20–40 listings, illiquid ones carry one). Under three listings is
  dropped from the plan by default and the pet table carries a **Market** column. Nothing is deleted;
  `requireMarket: false` brings them back with the reason attached.
- **It ranks on what pet-levelling adds, not on total profit.** Total is dominated by item income
  the minion earns with no pet on it, so ranking on it recommended a 191M Mosquito for +7.4k a day
  at ten thousand days per pet. Ranked on the advantage, the same data says Ice Minion + Scatha,
  **+72k a day for one collection**.
- **A minion sells what the compactor made.** Raw Ice has no buy orders on the bazaar, so the Ice
  Minion priced out at zero — but a compactor means you hold Enchanted Ice, which trades at 67. The
  hopper already knew this; the ordinary collect-and-sell path did not. Ice goes 0 → 15k a day, and
  it applies to every item whose raw form trades thinly.
- **Brewing costs an opportunity, not money, and is shown that way.** Drops fed to a stand are
  revenue not made rather than money lost, so instead of subtracting them as a cost every row
  carries **vs selling**: what the plan makes over simply running the minion and selling the lot.
  Negative rows are greyed — the plan is worse than having no plan — with a toggle to hide them, and
  the plan is chosen on that figure rather than on a total the item income dominates. Brews a day
  are capped separately, since that constraint is a chore rather than an economic one, and a
  **Collect only** filter re-plans without brewing at all.
- **Wisdom fills itself in from a loaded profile.** Hypixel publishes no Wisdom total, but it does
  publish the parts, and five are recoverable: a **Booster Cookie** (a flat +25 on every skill, and
  the largest single one), the lore of worn armour, equipment and accessories, the **best tool you
  are carrying** per skill — worn things sum, held things do not — attribute shards, and Slayer
  tiers. On a real account that fills **Combat 78.5, Foraging 47.2, Fishing 32, Mining 30, Farming
  27.5, Alchemy 25** where all six had been zero.
- It is still a **floor**, and the note says what is missing, largest first: a mayor's perk while
  elected (Cole is +50 Mining, a Mining Fiesta another +75), Heart of the Mountain and Essence Shop
  perks, potions, and the Ultimate Wisdom enchantment. Anything you type wins and is never
  overwritten — and the tab records which boxes it filled itself, so improving the detection
  upgrades its own past output without touching yours.
- **Wisdom is six fields, one per skill.** A brewed route is Alchemy XP even when a Farming minion
  feeds it, so each route takes its own skill's Wisdom. Skill levels grant none of it — Hypixel's
  own skills resource carries no Wisdom in any level's unlocks — and the sources that do reach
  170–240 on a geared account, which is why the detected figure is presented as a floor rather than
  a total. Each box names where its skill's Wisdom comes from; the old single value migrates across
  all six.
- **The twenty minions with no published XP rate are named rather than omitted.** The Revenant is
  one of them, and a wall of Revenants levelling a Golden Dragon is a well-known setup — so its
  absence would read as a verdict instead of a gap in the wiki.
- **A task's price is cached against the price book it came from.** Nothing a solver does can
  change what a Recombobulator costs; only new prices can, and those arrive as a new book.
- **Prerequisite closures are invalidated per pick, not rebuilt.** Completing a task can only
  change the closures that contained it, so a pick re-resolves a handful of rows rather than all
  of them. `resolve.ts` has the argument for why the dependents index is sufficient on its own.
- **Each view is worked out the first time it is read.** Only one tab is on screen and they are
  not the same size — the packages are one greedy fill per package plus one more for the
  unpackaged baseline, and cost more than the other four views together.
- **The packages' baseline curve is kept between solves.** It drops the XP floor on purpose and
  ignores the target and the budget, so the knob people actually move cannot change it.

On a mid-progress profile against a market that prices most of the catalogue, one re-solve of
five 10M packages costs roughly:

| Tab showing | First solve | Same tab again |
|---|---|---|
| Grind order | 6 ms | 4 ms |
| Cheapest first | 22 ms | 18 ms |
| Category browser | 44 ms | 35 ms |
| Batch plan | 171 ms | 50 ms |
| Packages | 1.1 s | 470 ms |

Packages is the outlier and always will be — six greedy fills for five packages — and the
recompute-after-every-pick is what keeps overlapping bundles honest. Opening that tab is the
only place the page still pauses.

The category chips go through the same debounce the text fields use rather than solving in the
click handler, so turning four categories off is one solve and not four — the chips repaint at
once and the results dim until the answer catches up.

## Modelled categories

All 17, ~48,000 XP. `DATA.md` has the provenance for each number.

| Category | XP available | Source of the task list | Source of completion |
|---|---|---|---|
| Skills | 8,440 | resources API | profile skill XP |
| Bestiary | 4,370 | wiki brackets + family list, and the tasks page for the total | `bestiary.kills` per family, plus `milestone.last_claimed_milestone` |
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
| Abiphone | 840 | harvested ids + wiki contacts table | `completed_tasks` |
| Events | 749 | harvested ids | `completed_tasks` |
| Fairy souls | 570 | formula | `total_collected` |
| Fast travel | 360 | harvested ids | `completed_tasks` |
| Bank | 310 | harvested ids | `completed_tasks` |
| Rift | 295 | harvested ids | `completed_tasks` |

Bestiary is the newest and the only category priced in kills rather than coins. A tier is worth
2 XP — 1 for the tier and the ten-per-ten milestone amortised — and each one is offered with the
kills it actually has left, cheapest first, cut off at 5,000. Two things about it are worth
knowing before trusting a row: the 7,840 is a floor, because Galatea's mobs have no wiki family
entries yet, and the join from the profile's internal mob ids to family names is hand-mapped,
because nothing published carries it. Families the map may be under-counting are held back
rather than shown, and the app prints how many tiers it accounted for against the floor the
profile's own claimed milestones vouch for.

Attribute levels (1,810, priced from bazaar shards), Heart of the Mountain (1,175), Center of
the Forest (250) and the garden's plots, crop upgrades and composter (542) are all modelled — see `DATA.md` for where
each one hides in the API.

Still missing, and named in the UI: the rest of the garden (~1,063), and
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
npm run gen:all    # rebuild every table: API resources, wiki tasks, wiki curves, accessory
                   # upgrade lines, the join
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

- The accessory bag's slot limit is modelled everywhere except where the bag can't be read: an
  unreadable talisman bag reports zero capacity, which looks exactly like a full one, so the
  plan leaves slots out rather than spending 20M a time on room the player may already have.
- The XP floor filters on a bundle's total XP, not per click. A five-tier minion bundle worth
  5 XP passes a floor of 5 while being five actions.
- Accessory family coverage is best-effort; see `DATA.md`. Families now come from the wiki's
  `upgrades_from` graph unioned with the name rules, which closed the fourteen lines that rename
  as they climb (Cropie → Squash → Fermento → Helianthus was being offered as four separate
  purchases). What is left is the reverse risk — a family the wiki doesn't state and no name rule
  spots — and the computed-vs-reported MP readout is the check on it.

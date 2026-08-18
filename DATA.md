# Where every number comes from

The planner's output is only as trustworthy as its inputs, so each table below says what
sourced it and what happens if it's wrong. The rule the code follows: **derive from the API
where possible, curate with a provenance note where not, and refuse to invent.** A task whose
cost we can't source gets `cost: { kind: "unknown" }` — it stays visible in the browser and
stays out of the solver, rather than being dropped or given a made-up price.

## Generated — `data/generated/`, rebuilt with `npm run gen:data`

Written by `scripts/generate-data.mjs` from `api.hypixel.net/v2/resources/skyblock/*`. Nothing
here is hand-typed.

| File | Source | XP values | Cross-check |
|---|---|---|---|
| `skills.json` | `resources/skills` | Parsed out of the `unlocks` strings the API itself ships (`"+5 SkyBlock XP"`) | Totals **8,710** — matches the README table exactly |
| `collections.json` | `resources/collections` | Same `unlocks` parse, per tier | Totals **3,160** — matches exactly |
| `minions.json` | `resources/items` (`generator` / `generator_tier`) | Tier curve from the README table (1×6, 2, 3, 4, 6, 12, 24) | Totals **3,165** vs the README's 3,164. Live data: 48 minions have 12 tiers, 13 stop at 11 |
| `accessories.json` | `resources/items`, `category: ACCESSORY` | — (magical power is curated) | 385 accessories, 277 tradeable |

The skills and collections agreement with the README's independently-written totals is the
strongest signal here that the parse is right.

## Curated — `data/curated/`

Hand-entered because the API doesn't publish it. Each file carries `source`, `verified` and a
statement of what a mistake costs.

### `magical_power.json`
Magical power per rarity (3 / 5 / 8 / 12 / 16 / 22). The items resource gives an accessory's
rarity but never its magical power, so this mapping is the one piece of game knowledge the
accessory model rests on. `verified: false`.

The exclusion list is **deliberately empty**. Party hats and the cake bag are classified
`ACCESSORY` by the API, and nothing in the API says whether they grant magical power —
excluding them on a hunch would hide buyable XP.

### `accessory_families.json`
Only the best member of an accessory family counts, so families have to be detected or the
same magical power gets sold to the user twice. Three patterns are structural and handled in
code (`familyOf`):

- `Bat Person Artifact` → `bat person` (the Talisman/Ring/Artifact/Relic/Orb chain)
- `Relic of Coins` → `of coins`
- `Master Skull - Tier 3`, `Personal Compactor 6000` → tier markers stripped

The rest are named in the file: shark tooth necklaces, Kuudra cores, fish bowls, piggy banks,
voter's badges, rings of love, campfire badges.

**Known imprecision.** Our ceiling for a fresh profile is ~1,872 XP against the README's
~2,121. The gap is family detection in one direction or the other and it is not checkable from
the API. Individual task XP is exact — a specific accessory's magical power is right, and the
"already owned" subtraction is right. It's the category *total* that's approximate.

## Running without a server

The standalone HTML calls Hypixel from the page. Two things make that possible, and both were
checked rather than assumed:

- **Hypixel allows it.** An `OPTIONS` preflight against `/v2/skyblock/profiles` with
  `Origin: null` (what a `file://` page sends) returns `access-control-allow-origin: *` and
  `access-control-allow-headers: API-Key`.
- **Mojang does not.** `api.mojang.com` and `api.minecraftservices.com` return no
  `Access-Control-Allow-Origin` at all, so the browser blocks them. Name lookup goes through
  ashcon.app, falling back to playerdb.co — both send `*`. Hypixel's own `/v2/player?name=`
  works too but rate-limits repeat lookups of the same name, so it isn't used.

The talisman bag is gzipped NBT. Node gunzips with `zlib`, the browser with
`DecompressionStream("gzip")`, and the NBT walk after that is shared code
(`src/lib/nbt.ts`) — first-party since the swap, verified byte-for-byte against
prismarine-nbt on a real 138-item bag and covered by tests.

## Live prices

| Feed | Endpoint | TTL | Notes |
|---|---|---|---|
| Bazaar | `/skyblock/bazaar` | 60s | `quick_status.buyPrice` — what an instant buy costs. The README's 60s call is right; nothing moves fast enough to reorder a ranking |
| Accessory BINs | `/skyblock/auctions` | 10 min | 49 pages, fetched 8 at a time, ~6s cold. Lazy: only swept when the accessory category is on |
| Profile | `/skyblock/profiles` | 5 min | |
| Username → UUID | Mojang | 24h | |

Auction listings don't carry SkyBlock item ids — they're inside gzipped NBT on all 48,000
listings. Accessories are the case where that's avoidable: filter to `category: "accessories"`
(~14% of listings) and suffix-match the display name against the items resource, because a
reforge only ever *prepends* a word. Measured 138/138 matches on a full page.

Lowest BIN is tracked **per rarity**, since a recombobulated copy is a different purchase. When
a task quotes the cheapest listing across rarities, the XP credited is still the base rarity's —
if the cheap copy turns out to be recombobulated the player gains more than promised. The error
direction is deliberate.

## Completion state

All of it comes from the profile; none of it is guessed.

**Co-op profiles need their members unioned.** Minions and collections belong to the island, but
the API records `crafted_generators` and `unlocked_coll_tiers` per *member* — whoever personally
did the crafting. On a seven-person co-op one member's list is full of holes: a real profile
showed Gravel tiers 7-11 for the viewed player and 1-6 for a co-op mate, so reading one member
alone made the planner recommend crafting a tier I minion that had been on the island at tier XI
for months. `coopProgress()` unions the members, which is self-checking: minion tiers are
strictly sequential upgrades, and on that profile the union closed all 278 gaps below a
generator's highest tier, leaving exactly zero. Skills, fairy souls and the museum are genuinely
personal and are *not* unioned.

| Category | Field |
|---|---|
| Skills | `player_data.experience.SKILL_*` against the cumulative table |
| Collections | `player_data.unlocked_coll_tiers` (`"WHEAT_5"`) |
| Minions | `player_data.crafted_generators` (`"LILY_PAD_5"`) |
| Fairy souls | `fairy_soul.total_collected` |
| Accessories | the talisman bag, gzipped NBT, decoded per item with its `rarity_upgrades` |

The bag decode is why the UI shows **computed MP vs reported MP**. `highest_magical_power` is a
high-water mark rather than a current reading, and the game special-cases Hegemony Artifact,
Abicase and Rift Prism, so a gap is expected — but a *large* gap means the model is missing
something, and the number is on screen rather than buried.

## The categories the API doesn't cover

Everything above comes from Hypixel directly. The rest of the game needed two more sources,
because the API publishes no task list at all.

### Discovering the task ids — `scripts/harvest-task-ids.mjs`

`leveling.completed_tasks` contains Hypixel's internal id for every discrete task a player has
finished (`FAST_TRAVEL_CRYSTAL_HOLLOWS`, `BANK_UPGRADE_GOLD`, `DRAGON_ESSENCE_ONE_PUNCH_3`), but
nothing lists the ids that *exist*. Sampling live players and unioning their completions
approximates that set: 140 players across 373 profiles yielded **1,056 distinct ids**, and the
count had flattened by player ~30, so the common set is essentially saturated. Players come from
the auction house, which is just a convenient list of active accounts.

This is the ground truth for *what exists*. It is a lower bound by construction — a task no
sampled player has done cannot appear — so rerunning it with more players can only add.

### Getting the XP — `scripts/fetch-wiki-tasks.mjs`

The wiki's `SkyBlock Levels/Tasks` page, via the MediaWiki API. Its tables lean heavily on
`rowspan` (an essence shop name spans 44 rows), so the parser rebuilds the grid the way a
browser would before reading rows. 778 rows across 9 tabs.

Note the wiki is *behind* the API on everything the API also covers — it says museum 3,522
against the API's 3,644, skills 8,120 against 8,710. So the wiki is used only where Hypixel
publishes nothing, and never to override live data.

### Joining them — `scripts/build-task-table.mjs`

The two halves can't be joined by name: the wiki shows display names ("One Punch"), the API
emits internal ids (`DRAGON_ESSENCE_FLAT_DAMAGE_VS_ENDER_1`), and only 195 of 319 essence rows
line up. So XP comes from **structural rules** read off the wiki, each checked against the
wiki's own totals:

- **Perk shops.** Every essence perk pays along one sequence — `2, 2, 3, 5, 7, 8, 8, 8, 9, 10` —
  truncated at its last tier. Checked against all nine shop totals: eight matched exactly on the
  first pass, and Diamond matched once Rhinestone Infusion (which the wiki spells "Rhinstone")
  got its documented flat curve. Event perk shops use the same curve. This is why no name match
  is needed: the tier suffix alone determines the XP.
- **Flat families.** Abiphone +10, fast travel +15, community shop +10, rock/dolphin milestones
  +20 — each reproducing its wiki total (fast travel: 24 ids × 15 = 360).
- **Lookups.** Bank upgrades 20/25/30/35/40/50 (=200), dojo belts 20/30/50/75/100/150 (=425),
  trophy fish 4/8/16/32 per grade, festival brackets, reputation tiers.

All 1,056 ids now carry an XP value. The Fossil and Safari essence shops are *newer than the
wiki page* and have no wiki rows at all — the harvest found them anyway, which is the argument
for using live ids as the universe.

### Level curves — `scripts/fetch-wiki-curves.mjs`

Catacombs, dungeon classes and slayers are "you are level N because you have X XP", so they need
thresholds Hypixel doesn't publish. The wiki builds those tables with templates, so the wikitext
holds no numbers — asking MediaWiki for *rendered HTML* expands them first. The slayer table
shares cells across bosses via `colspan`, so that parser is span-aware too.

Catacombs comes out at 569,809,640 XP for level 50, and slayer thresholds at
5/15/200/1000/5000/20k/100k/400k/1M for zombie — both matching the known values.

Per-level XP is read from the scraped rows, not typed: an earlier hand-entered guess of
15/25/35/50/70/100/**150/250/500** was wrong at the top end (actually **125/150/150**) and
inflated slayer by 3,400 XP before the totals check caught it.

## Accessory bag slots

An accessory needs somewhere to sit. The bag holds a fixed number of accessories, and more room
is bought from Jacobus — so once the bag is full, the true cost of the next accessory is the
accessory *plus* the slot.

**Capacity is read, not guessed.** The talisman bag decodes to an NBT container, and the length
of its slot list is the bag's real size. The test profile reads 138 accessories in a 271-slot
bag, so 133 free.

**Upgrades are their own priced tasks.** Jacobus sells 99 of them, each +2 slots and +2 XP, at
prices that rise in bands (`data/curated/accessory_bag_upgrades.json`, from his wiki page):

| Upgrades | Cost each |
|---|---|
| 1 | 1.5M |
| 2–5 | 5M |
| 6–10 | 8M |
| 11–20 | 12M |
| 21–99 | 20M |

That is 198 XP for 1,761,500,000 coins all-in — which matches the wiki's own stated cumulative
of ~1.8B, and is why they rank near-last on value at ~750k coins per XP. They are in the plan
because they're real, not because they're efficient.

**The slot surcharge is conditional.** When the bag has room, an accessory costs what it costs.
When it's full, `CostSpec.auction` carries a surcharge of half an upgrade — one upgrade buys two
slots, so one accessory owes half of one — and that lands on every accessory in the category.
Computing it rather than always applying it matters: charging a slot to a player with 133 free
ones would inflate every accessory by 10M for no reason.

## Ordering the grind

Grind tasks carry no coin price, so the solver can't rank them and the browser used to list them
arbitrarily. Ranking them needs a notion of effort, and effort is the one thing nothing
publishes — a skill level, a collection tier, a slayer level and a trophy fish are measured in
four incompatible units.

The one unit they share is **how many people have already done it**.
`scripts/harvest-difficulty.mjs` samples live profiles and records, for every task the catalogue
can generate, whether that player has finished it. The completion rate becomes the difficulty
score: 100% of players have Combat 1, 21% have Combat 60.

This puts every category on one 0-1 scale with no per-category fudge factors, and the ordering
it produces matches intuition (numbers below from the 600-player run):

| Share of players who have it | Task |
|---|---|
| 89% | Combat 20 |
| 80% | Catacombs 10 |
| 74% | Zombie slayer 5 |
| 66% | 100 fairy souls |
| 48% | Combat 40 |
| 39% | Catacombs 30 |
| 31% | Enderman slayer 7 |
| 21% | Healer 30 |
| 15% | Catacombs 40 |

3,543 tasks are rated this way. They are shown as four bands — quick / a session / a long haul /
a marathon — because the signal doesn't justify more precision than that.

### It is a proxy — and the bias is now measured, not just disclosed

Completion rate conflates *difficulty* with *popularity*: an easy task nobody bothers with looks
hard. It also inherits a sample bias, and that bias is worth being precise about rather than
waving at.

There is no Hypixel endpoint that lists "a random cross-section of players" — the only way to
*discover* a UUID through the public HTTP API is to already have one. So every player in the
sample is found through the auction house: current listings, plus `auctions_ended` (which adds
the *buying* side of the economy, not just sellers). That selects for players active in the
economy — online recently, with something to trade — which skews the whole sample toward more
advanced accounts than the playerbase as a whole.

To put a number on that skew rather than just naming it, the script checks its own sample's
SkyBlock level distribution against a published external reference collected by a completely
different method: [tla_, "Data #1: Distribution of SkyBlock Levels"](https://hypixel.net/threads/data-1-distribution-of-skyblock-levels.5579975/)
(Hypixel Forums, 19 Jan 2024) AFK'd in the SkyBlock login lobby for a few hours and logged
**~9,800** UUIDs as they passed through — "basically every skyblock main will pass through the
lobby while logging in," in the author's words. That's close to an unbiased cross-section of
*active* players (still limited to whoever logged in that day), and they published percentiles
for it.

| | mode | Q1 | median | Q3 | P80 |
|---|---|---|---|---|---|
| Our sample (n=600, AH-seeded) | 99 | 86 | **173** | 288 | 329 |
| tla_'s reference (n=9,800, login-lobby) | 47 | 53 | **105** | 178 | 200 |

**Median skew: +68 levels.** Our AH-seeded sample really is meaningfully more advanced than the
general active playerbase — confirmed rather than assumed — but the gap is a few dozen levels,
not the multiple-hundred-level gap a worst-case guess might suggest. That number, its full
citation, and the reasoning are stored in `data/generated/difficulty.json` under `calibration`,
not just asserted in prose.

**What this means in practice:** treat completion rates as relative difficulty within an
economically-active population, not an absolute rate across everyone who has ever played. The
*ordering* between two tasks is more trustworthy than either one's raw percentage — Combat 20
being easier than Combat 40 will hold regardless of sample skew; whether Combat 20 is exactly
"89%" common among all SkyBlock players is not something this method can claim.

**A larger, unbiased sample would need a Minecraft client sitting in a lobby**, which this
project doesn't have — that's what makes tla_'s method work and this script's method not. Given
that constraint, `--players` can be raised for a bigger AH-seeded sample (default 600, up from
an original 150; ceiling is the Hypixel rate limit, not the code), but a bigger sample of the
same biased population narrows the *noise*, not the *skew*.

Anything no sampled player has finished is treated as the hardest thing there is.

## The perk trees, attributes and garden

Four tracks the API half-hides, added by finding where the game actually keeps them.

| Track | XP | Completion source |
|---|---|---|
| Heart of the Mountain | 1,175 | `skill_tree.nodes.mining.core_of_the_mountain` |
| Attribute levels | 1,810 | `attributes.stacks` against a shard threshold table |
| Garden composter | 305 | `/skyblock/garden` → `composter_data.upgrades` |
| Garden plots | 120 | `/skyblock/garden` → `unlocked_plots_ids` |
| Garden crop upgrades | 117 | `/skyblock/garden` → `crop_upgrade_levels` |
| Center of the Forest | 250 | `skill_tree.nodes.foraging.center_of_the_forest` |

Two things made this harder than it looks:

**HOTM is not in `mining_core`.** The obvious home — `mining_core.experience`, `mining_core.nodes` —
is empty on a modern profile; the game moved perk trees to `skill_tree.nodes`, where the HOTM
tier reads as `core_of_the_mountain`. The forest equivalent sits alongside it under `foraging`.

**The garden is not part of the member object.** It belongs to the whole co-op, so it has its own
endpoint keyed by profile id (`/skyblock/garden?profile=`). Composter upgrades pay 1/2/3/4 XP in
bands across 25 tiers, and five upgrades of 25 tiers comes to exactly the wiki's stated 305.

Each per-tier XP table is read from the tasks page at build time rather than transcribed, and
the totals are checked on the way out: HOTM sums to 1,175 and Center of the Forest to 250,
matching the wiki's own maxima.

### Two deliberate omissions

**Peak of the Mountain (~1,000 XP) and Heart of the Forest (~545)** have published XP tables and
are *not* modelled. A recursive search of a maxed profile — every key at every depth — finds no
field carrying either tier. Modelling them from a missing field would report zero progress for
every player, overstating what they have left by ~1,545 XP and filling the grind ordering with
work they may have finished years ago. A wrong number that looks authoritative is worse than an
acknowledged gap, so they're listed in the UI as unmodelled with that reason.

**Attribute levels are complete and priced.** `scripts/fetch-attributes.mjs` scrapes
`Attributes/List/<rarity>` for all five rarities, giving **181 attributes** — matching the
game's ~182 — so the ceiling no longer depends on what the player happens to have touched.

Each attribute is fed by one named shard, and those shards trade on the bazaar, so an attribute
level costs the shards it adds times their live price. The mapping has to be scraped because
shards are named after the *mob*, not the attribute: "Snow Elemental" is fed by "Blizzard Shard"
(`SHARD_BLIZZARD`), and only 1 of 172 attribute names matches its own shard id. **175 of 181**
attributes have a bazaar-traded shard; the remaining six stay unpriced.

That moved attributes off the grind list entirely — on a fresh profile it is now ~1,750 XP of
*priced* work the solver can rank against minions and accessories.

**These costs are an upper bound.** They assume buying every shard outright at bazaar instant-buy.
Fusing shards you already hold is cheaper and isn't modelled, so a real player pays less.

## What is still missing

| Category | XP | Blocker |
|---|---|---|
| Bestiary | ~4,370 | Needs per-mob kill brackets. The wiki has the bracket multipliers, but the mob list has to be assembled from the profile's own bestiary keys |
| Attribute levels | ~1,820 | Per-attribute curves, not published |
| Garden | ~2,000 | Level, plots, visitors and crop milestones — four separate tracks |
| Heart of the Mountain | ~1,175 | Its own perk tree with its own costs |
| Heart of the Forest | ~545 | As above |

Together these are why a maxed player's coverage reads ~57% rather than 100%. The figure is on
screen next to their level, so the gap is visible rather than implied.

## Costs

Six categories now carry live prices. Each join is by name between sources that were never
built to be joined, so every one is counted rather than assumed.

| Category | Priced from | Coverage |
|---|---|---|
| Minions | Wiki crafting recipes → **live** bazaar ingredient prices | **660 of 662 tiers.** The 2 misses need a Crystallized Heart and a Bat Person Helmet, neither of which trades |
| Pets | Auction house, lowest BIN per pet per rarity | ~90% of remaining pet XP |
| Museum | Auction house, lowest BIN per donation item | ~56% of remaining museum XP |
| Essence | Wiki perk tables → live bazaar essence price | **205 of 436 tasks.** Only 33 of 60 wiki perk names match Hypixel's internal ids |
| Bank | Wiki upgrade costs (Gold 5.08M → Palatial 215M) | all 6 |
| Fast travel | Auction house scroll prices | 10 of 24 — the other 14 unlock by walking there |

### Minion recipes: two bugs worth recording

**The scraper read past the end of the table.** It found the header row of the upgrade table and
then walked every remaining row *on the page*. Minion pages carry several tables whose rows also
start with a roman numeral, so those later rows silently overwrote the real recipe — Cobblestone
tier I came out as "3,086x Cobblestone" instead of "1x Wooden Pickaxe, 80x Cobblestone", and
every minion was wrong by a factor of ten or more. Parsing is now scoped to the table the header
belongs to.

**Fixing that exposed a cascade.** Tier I of most minions needs a wooden tool, which doesn't
trade on the bazaar, and one unpriceable ingredient correctly makes the whole prerequisite chain
unpriceable — so the correct recipes initially priced *fewer* tiers than the broken ones. Two
additions fix it properly:

- `data/curated/craftable_ingredients.json` maps the handful of vanilla items minion recipes
  need (wooden pickaxe/sword/axe/shovel/hoe, fishing rod) to the bazaar-traded materials you'd
  craft them from — one `LOG` yields four planks, which covers any of them.
- A minion that needs *another minion* (Revenant needs a Zombie minion, Inferno needs a Blaze
  minion) now becomes a real **prerequisite** rather than an ingredient, so the bundle prices the
  whole dependency chain instead of giving up on it.

Together: 660 of 662 tiers priced, up from 575.

### On the wiki's own price column

The wiki publishes a "Bazaar Upgrade Cost" per tier and **it is not used** — only the recipe
(ingredient and quantity) comes from the wiki, and the price is multiplied in from the live
bazaar at query time. The wiki's figures are stale, which is exactly why: it lists Cobblestone
tier II at 320 coins, where the same 160 cobblestone costs 752 at today's live price of 4.70
each. The recipe is stable; the price is not, so only the stable half is cached.

### The scrapers

`fetch-wiki-costs.mjs` pulls three tables: bank upgrade totals, per-tier minion recipes from all
61 minion pages, and essence perk costs from `Essence Shops/<Type>` (found by wiki search — the
obvious `Dragon Essence Shop` is a stub). `build-cost-table.mjs` then resolves ingredient names
to bazaar product ids and perk names to task ids, reporting what failed.

**Essence is the weak join.** The wiki calls a perk "One Punch" where the game id says
`FLAT_DAMAGE_VS_ENDER`, and no amount of string munging fixes that — it needs a hand-written
alias table. Unmatched perks keep `kind: "unknown"` and stay out of the solver.

**Fast travel is deliberately split.** Ten destinations have a scroll on the auction house and
are priced. The other fourteen unlock by visiting: free in coins, so they are tagged `grind`
rather than priced at zero, which would let them dominate every plan for nothing.

### The auction sweep now covers everything

It used to filter to `category: "accessories"`. It now matches every BIN listing by display
name against accessories, museum items and travel scrolls, and handles pets separately —
they list as `[Lvl 91] Golden Dragon` with the rarity in `tier`, so the level is stripped and
the name keyed as `PET:<NAME>`. That also makes the auction house the pet catalogue: there is
no pet list in the API, and a pet nobody is selling is a pet you can't buy.

## What still lacks a price

XP is now covered for every modelled category; **coin costs are not**. Priced today: accessories
(lowest BIN), minion tier XII (bazaar upgrade stones), and essence perks are priceable in
principle since essence trades on the bazaar — but the perk *costs* (how much essence each tier
takes) aren't published, so they carry `kind: "unknown"` and stay out of the solver. Museum
donations are marked `auction` but need a full-catalogue BIN index rather than the accessory-only
sweep, which is the next thing worth building.

# The Greenhouse

Which mutation is worth growing, priced off the bazaar and ranked on what it pays for being left
alone. `scripts/fetch-greenhouse.mjs` writes `data/generated/greenhouse.json`; `src/lib/greenhouse.ts`
does the arithmetic; `src/browser/greenhouseTab.ts` draws it.

## Where the numbers come from

Hypixel publishes no greenhouse resource. The profile endpoint carries a player's own plots and
upgrades but not the rules, so the rules come off the community wiki — and two of the figures that
matter most are Hypixel staff posting in Discord, quoted on the wiki with citations:

| What | Source |
|---|---|
| 40 mutations: drops, sizes, spreading conditions, growth stages | `Mutations` page, edited the day this was written |
| Mutation weights (all 40) | staff (mrkeith), Discord, quoted on the page |
| Harvest Bounty pool and its odds | staff (mrkeith), Discord, quoted on `Greenhouse` |
| Base crop yields, growth formula, water loss | `Greenhouse` page |
| Ethereal Vine odds by rarity | `Ethereal Vine` page |
| Item ids | Hypixel's own item resource |
| The 13 crop fortunes and what each lifts | `Crop Fortune` page |
| Overdrive Chip (+140, contest only) | `Overdrive Chip` page |
| Prices | the live bazaar (both sides of the book — see the order-type toggle), plus the shop table from `npc-prices.json` |
| A week of price history, for "vs usual" | Coflnet, `sky.coflnet.com/api/bazaar/<id>/history/week` |
| Decay timers | `data/curated/greenhouse_decay.json` — the wiki tabulates none of it; see below |

**Two things have a date on them, and it is the same date.** On **2026-08-20** every base crop's
drop changed — Nether Wart 240 → 108, Carrot 280 → 175, Potato 240 → 150, Sunflower 160 → 232 — and
the same update gave base crops a decay timer. So any figure computed before that date is wrong
twice over: by up to a factor of two on the drops, and by treating the ring as permanent. The scrape records
`generatedAt` and both pages' `editedAt` so the data can be checked against the page's own History.

## What a harvest is worth

### A harvest pays three ways, and the wiki only writes down one of them

The drop table lists crops. It is not the whole income:

| where the coins come from | how much | does fortune lift it? |
|---|---|---|
| **Crops** — the wiki's drop table | thousands per harvest | yes |
| **The mutation itself** — one per harvest | one item, 100 coins to 3.3M | no, it is one item |
| **Ethereal Vine** — a chance on harvest | 15% common to 40% legendary | no |

The middle row is not in the wiki's table and it is often most of the money. The evidence that it
drops is circumstantial and conclusive: **39 of the 40 mutations have a live bazaar book** — the
exception is Jerryflower, which needs a Jerryseed rather than a roll — and there is no craft, no
NPC and no drop table anywhere else that yields one. Harvesting is the only source, so harvesting
gives you one.

Pricing only the crops ranks the page on the smaller half of the income for exactly the mutations
where the item is the point. Measured at Farming Fortune 1,500, the item's share of one harvest:

| | share that is the item |
|---|---|
| Turtlellini, Puffercloud, Chocoberry, Blastberry | 74-85% |
| median mutation | 36% |
| Phantomleaf, Zombud, Fleshtrap | 0-1% |

So it is not a correction of a few percent that leaves the order alone — it is most of the money at
the top of the table and none of it at the bottom, which reorders the page.

The tab shows the three apart in the expanded row, because they answer different questions — a
mutation carried by its own item price is exposed to that item's market, and one carried by crops is
exposed to fortune.

### The setup is not a one-off any more, and that reorders everything

**Plants rot.** The same 2026-08-20 update that changed every drop figure also added decay to base
crops, and Hypixel's designer note says exactly why:

> Currently, there are quite a few "set and forget" setups … effectively only ever needing to
> harvest the mutations without ever having to replant your Greenhouse. … By adding a decay value
> we can expect people having to replant their setups every once in a while.

So the ring is a **running cost**, and the question worth asking of a mutation is not what it makes
in a day but **how many harvests one planting buys**. A ring dies with its shortest-lived plant —
one dead cell breaks the spreading condition and nothing spawns there again — so:

```
harvests per planting = floor(ring life / hours per harvest)
```

That single division reorders the table, because it has nothing to do with how much a harvest is
worth:

| | per harvest | harvests | setup | net per planting |
|---|---|---|---|---|
| **Noctilume** | 13.5 hr | **5** | 6.0M | **+59M** |
| Startlevine | 26.9 hr | 2 | 41M | +28M |
| **Timestalk** | 32.0 hr | 2 | 53M | **−26M** |
| Magic Jellybean | 8.7 days | **0** | 4.9M | −4.9M |

Timestalk reads 9.9M a day gross and **loses 26M on every planting**. Magic Jellybean takes longer
to harvest than its ring survives, so it never completes one at all. Neither is visible in a
coins-per-day figure, which is why `Net/day` — gross less the ring spread over the days it lasts —
is what the table now ranks on.

#### What is known about decay, and what is not

Almost nothing is published. `data/curated/greenhouse_decay.json` holds all of it:

| | | source |
|---|---|---|
| Base crops | **72h** | Changelog 2026-08-20, "Added decay to base crops (72h)" |
| Noctilume | **6 days** | Changelog 2026-02-02, "from 5 to 6 days" |
| All-in Aloe, Magic Jellybean, Fleshtrap | **never** | trivia on each page |
| Dead Plant | **never** | it is what decay produces, so it cannot rot further |
| every other mutation | **≥ 3 days** | `Dead Plant`: "The lowest is 3 days" |

The last row is the honest part. Thirty-six timers exist only in the in-game Plant Diagnostics
Tool, so they are pinned to the published three-day floor and the result is reported as a
**guaranteed minimum** — marked `5+` rather than `5`, because the real figure can only be higher.
A bound presented as a measurement is the kind of wrong nobody can spot afterwards, and a guessed
decay timer would multiply straight into the coins-per-planting figure.

### Gross and net

The ring and the income are not the same kind of number, so they are never added:

- **Net/day** is the ranking: gross less the ring spread across the days that ring survives. It goes
  negative for a setup that costs more to keep replacing than its harvests bring in.
- **Gross/day** is what the harvests sell for with nothing taken off. Read against Net/day beside
  it: where the two are close the ring is nearly free, where they are far apart most of what you
  grow is paying for the plants around it.
- **Profit/harvest** sits next to **Per harvest** on purpose: this much, that often. A test asserts
  the two multiply out to gross/day so the columns cannot disagree with each other.
- **Per setup** is what one planting nets, start to finish — the column that says whether a setup is
  worth buying at all, and the one that does not follow from the daily figure.

Two columns were removed rather than kept, because decay made them *wrong* rather than redundant.
**Net day 1** claimed the ring was bought once and every day after was pure gross; it is bought
again every 72 hours. **Payback** measured how long until the ring repaid itself, which stops
meaning anything once the ring can die before it gets there — `Per setup` going negative says the
same thing and says it in coins. **Each** and **Size** also left the table, for the ordinary reason
that they are true but not what you sort by; both are still in the expanded row.

The bill scales with the number of greenhouses, because three plots is three rings to plant. Quoting
a one-plot setup beside a three-plot income would flatter exactly the mutations with the most
expensive rings — the ones the figure exists for.

### Instant, or leave an order up

A toggle, because the answer differs by more than any other setting on the page. Two ways to trade
a bazaar item: cross the spread and have it now, or post an order at the far side and wait to be
filled. On a deep book that is a rounding error. On mutation books it is most of the value —
**the median mutation's bid sits 54% below its ask, and the widest is 99%.**

| | buying the ring | selling the harvest |
|---|---|---|
| **Instant** | take the cheapest sell offer (the ask) | dump into the best buy order (the bid) |
| **Order** | post a buy order at the bid | post a sell offer at the ask |

It moves the ranking, not just the totals, because a mutation carried by its own item price is
exposed to the spread twice over while one carried by crops is not exposed at all. Crossing the
spread drops **Devourer** and **Startlevine** out of the top six entirely — Devourer's own item is
68% of its income, so the haircut lands squarely on it.

**Crops are always instasold, whichever way the toggle is set.** A harvest is tens of thousands of
them off books deep enough that the spread is noise, and nobody leaves a sell offer up for
pumpkins. The toggle exists for the mutations, which is where the spread is the whole story. The
NPC shop stays in the running in both modes, since it is instant and untaxed and often beats a
thin bid.

A test asserts that patience can never come out behind on either side — if it ever does, a side of
the book has been swapped somewhere, which is a mistake that leaves every figure looking plausible.

### A price now is not the price at harvest

The **vs usual** column compares each mutation's own ask against what it has actually been going
for over the last week. Only the mutations are tracked, and that restriction is the point: a crop
trades in the hundreds of thousands a day and barely moves, while a mutation book is thin enough
that one player clearing it doubles the quoted ask for a morning.

It matters more here than on a flip. A flip is instant, so a spike is a real opportunity. A
greenhouse pays out *hours* later — thirteen for a Noctilume, thirty-five for a Devourer — so a row
that looks enormous on a spike has settled back to normal long before there is anything to sell.
A mutation well above its own usual is almost always a book that emptied, not a mutation that got
better.

**The average is fetched, not waited for.** The first cut folded one live read at a time, which is
honest and useless — it needs the tab left open for a day before it says anything, and nobody
leaves a planner open for a day to decide what to plant. skyblock.bz's history endpoint does refuse
outside callers, which is what the bazaar tab's comment records, but **Coflnet's does not**:

```
https://sky.coflnet.com/api/bazaar/<ID>/history/week
```

It answers cross-origin, and the tab already loads its item icons from that host. A week arrives at
2-hour resolution — 81 real readings — for 39 of the 40 mutations, the exception being Jerryflower,
which has no bazaar book at all. Three requests at a time, cached for six hours, and the browser's
own HTTP cache makes a repeat open free. Six at a time earns a 429, because every row is already
loading an icon from the same host.

Polling is kept underneath as the fallback, marked with a star on the window so the two are never
confused. A figure that degrades to "measured here over 4 min" is better than a column that empties.

The window ("+32% · 6.7 days") is printed beside the figure because it decides whether the number
means anything at all.

What it turns up is not decoration. At the time of writing Chocoberry was **+32%** on its week and
Devourer, Noctilume and Stoplight Petal were all around **−30%** — and Noctilume's ask has run
between 550k and 3.1M inside three months, on a mutation whose own item is two thirds of its
income. Reading that page on the wrong morning and reading it on the right one are different
answers.

## The four things that decide the ranking

### A harvest is two waits, and usually the first one dominates

A mutation rolls against its own chance each time the crops around it advance a growth stage, so
the expected wait for it to *appear* is the reciprocal of that chance — twenty stages for a Godseed
at 5%, three and a third for a Choconut at 30%. Then it grows, which for most commons is nothing at
all and for a Godseed is forty more stages.

A stage is four hours flat and 1h 41m 3s fully upgraded, off the formula the Greenhouse page
publishes:

```
T = 14400 / (1 + 0.025·uniqueCrops + 0.0025·cropGrowth + 0.005·speedAttribute + upgrade)
upgrade = 0.05 per tier for 0-8, and 0.50 at tier 9
```

The tests reproduce the wiki's own 6,063 seconds from the formula, which is what says the terms are
in the right places. Note the step at the top: tier 9 is 0.50 where the pattern would give 0.45, so
the last tier is worth *double a normal one* — not, as it is tempting to write, worth more than the
eight below it, which the reciprocal shape of the formula makes plainly false.

### A condition is a conjunction, not a choice

The wiki writes a spreading condition with slashes — `Soggybud x5 / Noctilume x3` — and it reads
like a list of alternatives. It is a list of **requirements**: all of them, at the same target, at
once. The layouts settle it, because the wiki draws each arrangement as well as writing it:

| mutation | condition | what its layout actually holds |
|---|---|---|
| Scourroot | Potato 1 / Carrot 1 | 1 Potato **and** 1 Carrot |
| Thunderling | Soggybud 5 / Noctilume 3 | 5 Soggybud **and** 3 Noctilume |
| Stoplight Petal | Snoozling 4 / Noctilume 4 | 4 Snoozling **and** 4 Noctilume |
| Snoozling | five crops, 4+3+3+3+3 | all five, sixteen cells |

The counts are the other half of the proof: they fill the ring exactly. A 1x1 mutation has eight
cells around it and Stoplight Petal asks for 4 + 4; a 3x3 Snoozling has sixteen and asks for
4 + 3 + 3 + 3 + 3.

Reading it as a choice — which the first cut did — prices one crop and calls it the cheapest, which
halves every bill on the page and hides whichever half is expensive. On Devourer that is the whole
answer: 50 Puffercloud at 1.1M each is **100% of the bill** and the 25 Zombud beside it are 0.1%.
A test now cross-checks every parsed requirement against the cell counts in the wiki's own drawing,
so the two can never drift apart again.

### A spreading condition counts ring cells, not plants

The wiki's layouts are a 3×3 with the mutation appearing in the middle, and the condition counts
cells of the eight-cell ring. A plant bigger than one cell fills more than one of them:

| plant | ring cells it fills |
|---|---|
| 1×1 crop | 1 |
| 2×2 mutation (Noctilume, PlantBoy Advance, Glasscorn) | 2 |
| 3×3 mutation (Snoozling, Godseed) | 3 |

So **a condition asking for three Noctilumes is met by buying two**, because the first two cover two
cells each. The wiki works this out in footnotes for the six cases where it bites and those are
parsed verbatim; `ceil(cells / cellsPerPlant)` agrees with all six, and a test asserts that it does,
so a wiki edit that contradicts the rule fails the build rather than quietly changing an answer.

### The layout is the whole plot, and the rings are shared

This is what decides the money, and it is the thing a 3×3 diagram hides. **Rings overlap.** Two
empty cells beside each other are fed by one run of support crop, so the plot is a packing problem
rather than a stamp repeated in a grid — `src/lib/greenhouseLayout.ts`:

> maximise the empty cells whose ring holds ≥ N of the support crop,
> subject to the support crop occupying cells of its own

The difference is not marginal. On a 10×10:

| the condition asks for | stamping a 3×3 | packed |
|---|---|---|
| 1 ring cell | 11 | **84** |
| 2 ring cells | 11 | **70** |
| 4 ring cells | 11 | **45** |
| 8 ring cells | 11 | **16** |

The shapes fall out of the arithmetic: a support cell sits in at most eight rings, so a requirement
of N needs at least `N/8` support cells per target. A two-crop condition can afford to be mostly
empty; an eight-crop one needs every neighbour filled and collapses to a scattered lattice. That
bound is computed as `ceiling` and reported beside every answer.

It reorders the table outright. **Timestalk** was 21k/hr as a lone 3×3 and is **1.78M/hr** once 70
of them fit, while Stoplight Petal — which pays far more each — only fits 32.

**Best found, not proven optimal.** The search is exhaustive over *periodic* patterns up to a
twelve-cell tile, evaluated exactly on the real grid with its edges, and it beats every pattern
worked out by hand (checkerboard, row stripes, spaced lattice) on every requirement tried — those
hand figures are in the tests as the floor it must clear. It could still miss an irregular
arrangement worth a few percent, so the ceiling is shown next to the result and the caption says
which of the two it is.

Setup cost is a whole-plot figure for the same reason: the ring is bought once and shared, so it is
the packing's plant count rather than one mutation's condition. And which spreading alternative is
"cheapest" is decided on how well each one *packs*, not on the price of one ring — an option that
fits more mutations wins even if its crop costs more, because the ring is a one-off and the harvest
repeats.

### Fortune is two stats, and only one is harmless to get wrong

**Farming Fortune** lifts every crop, so it multiplies every mutation by the same factor. A wrong
figure scales all the coins and leaves the *order* untouched — there is a test for that invariant.

**Crop Fortune** does not behave that way. There are thirteen of them, one per crop, and Wheat
Fortune lifts wheat and nothing else. So a mutation dropping wheat and one dropping cocoa beans move
apart under the same player's gear, which makes crop fortune **the one input on this page that can
change which mutation wins**. There is a test for that too.

They meet by addition, which the Crop Fortune page states outright:

> their farming fortune is first added to their Crop Fortune stat corresponding to the crop they
> are breaking

Underneath it is a lottery — each point is a 1% chance of 100% more, and every whole hundred is a
guaranteed 100% more. The wiki's worked example is Cactus Fortune 233 giving "300% drops and a 33%
chance for 400%", which averages to `1 + fortune/100`. That is what the model uses, so a single
harvest lands above or below it.

Neither kind touches the mutation item itself: fortune multiplies crop drops, and the item is one
item. So a fortune figure typed in wrongly moves the crop half of a row and leaves the other half
where it was — which on Puffercloud is 78% of the income.

Because it is per-drop, revenue is computed a drop at a time rather than by scaling a mutation's
total, and each row names the crop fortunes that actually lifted it.

**The Overdrive Chip is the figure most likely to be entered wrongly.** It grants up to **+140 Crop
Fortune** to the active crop — but only during a Jacob's Farming Contest. Typed in as a standing
stat it overstates every mutation dropping that crop for the other twenty-three hours of the day, so
the panel says so where it is entered. Other sources are the farming tool being held, Anita's shop
and Carrolyn.

None of this can be read off a profile: the tab takes no API key and asks for no username, so every
fortune is a text box. The general one has a stated placeholder (1,500) and says on screen that it
is a placeholder; the per-crop boxes default to empty, because a guessed crop fortune would move the
ranking rather than just the totals.

Flagged: the wiki's Farming Fortune page carries an `{{Outdated}}` banner saying it has not caught up
with the Greenhouse update, which makes this the piece of the model most likely to be wrong.

## What is flagged rather than guessed

- **Four mutations need a special act rather than a roll** — Lonelily (no adjacent crops), Shellfruit
  (explode a Turtlellini with a Blastberry), Godseed (all positive effects), Jerryflower (grow a
  Jerryseed). They have no spawn chance, so there is no cycle time to divide by. They stay on the
  list with the reason written out, because a mutation nobody can price is still one worth knowing
  about.
- **A blank weight cell is not a zero.** The staff table's own note — "weight of 0 means special
  conditions required" — is what makes a zero meaningful where a blank is not.
- **Fire and Dead Plant are requirements with no price**, not items to look up. Fire matters: it is
  why Ashwreath's published chance is 15% against a weight of 30. Staff explained it — each adjacent
  *crop* supports 25% of the roll, and Fire is not a crop, so two nether warts support half of it.
- **The 12-vs-14 crop count.** The Greenhouse page says "all 12 unique crop types" and its own table
  lists 14 rows. Both are recorded as scraped; nothing here forces them to agree.
- **The plot grid is 10×10**, read off a real profile's `greenhouse_slots` rather than the wiki,
  which does not state it. That profile had 88 of the 100 unlocked.

## What it does not do yet

- **The packing is best-found, not proven optimal.** The search covers repeating patterns up to a
  twelve-cell tile; an irregular arrangement could beat it by a few percent. Every row shows the
  counting ceiling beside its answer so the gap is visible rather than implied.
- **No profile read.** `greenhouse_slots`, `garden_upgrades.GROWTH_SPEED` and `crop_upgrade_levels`
  all exist on the garden endpoint and would fill in the growth boxes from a username. The boxes are
  manual for now, which is why they default to a maxed setup and say so.
- **Watering is described, not scheduled.** Water falls 2-3 a stage and the retain effects slow it,
  but the wiki states no water *capacity*, so "you must water every N hours" cannot be derived. The
  stage timer is on screen instead, which is the half that is knowable.
- **No market depth on the mutation items.** They are priced at one unit off the top of the book,
  the same as every other item here, and that was a fair approximation while the crops were the
  whole income. It is a weaker one now: Devourer harvests 16 a day into a book that is thin at the
  top, and selling them would walk the price down. The crop side is unaffected — the bazaar for
  pumpkins is deep enough not to notice.
- **The Harvest Bounty pool is scraped but not valued.** The staff odds are in
  `greenhouse.json` — Synthesis and Evergreen chips at 3% each, Iridium and Burrowing Spores at
  0.2%, an Overclocker 3000 at 0.05% — and none of it is added to any row, because the pool is not
  documented as a per-mutation-harvest roll and guessing at its trigger would put invented coins in
  the ranking. The Ethereal Vine, which *is* documented per harvest and by rarity, is counted.

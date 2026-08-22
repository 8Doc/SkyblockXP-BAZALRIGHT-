# The bazaar model

How skyblock.bz lays its data out, why the layout is the good part, and what this project does
with it. Everything below was read off the live site and its API and checked against Hypixel's
own `/skyblock/bazaar` for the same item at the same second; where a figure is inferred rather
than confirmed, it says so.

---

## One payload, seven pages

skyblock.bz publishes seven lists — `all`, `flips`, `crafts`, `npc`, `reverse_npc`, `manipulate`,
`crash` — and they look like seven products. They are seven readings of one Hypixel payload.
Every route is the same SvelteKit page with a different column set, a different sort key and a
different one-line explanation, fetched from `https://api.skyblock.bz/api/{route}` and refetched
every twenty seconds. Nothing about a "flip" is structurally different from a "craft".

That is the first thing worth copying. The seven views are not seven features to build; they are
one derivation layer over one snapshot, and they share a single set of primitives.

| Route | Ranks on | Reads |
|---|---|---|
| `all` | page visits | both books' top prices, volumes, weekly transactions |
| `flips` | coins per hour | top of both books, both moving weeks |
| `crafts` | coins per hour | a recipe, the ingredients' books, the output's book |
| `npc` | max profit | the buy book, a shopkeeper's sell price |
| `reverse_npc` | sell-order profit | the sell book, a shopkeeper's buy price and stock |
| `manipulate` | risk, ascending | the whole sell book |
| `crash` | estimated profit | the whole buy book |

---

## The relabelling

Hypixel names its bazaar fields from the order book's point of view, which is the exact opposite
of the player's. `buy_summary` is the list of orders you can buy *from*, so it is made of other
people's sell offers. `quick_status.buyVolume` counts items sitting in those sell offers, which
is supply. Read at speed, every one of those names means its own opposite.

skyblock.bz relabels once, at the edge, and never touches Hypixel's names again. That is the
single highest-value thing in the whole design, and [`src/lib/bazaar.ts`](src/lib/bazaar.ts) does
the same:

| Hypixel | here | means |
|---|---|---|
| `buy_summary` | `sellBook` | sell offers; you instabuy from them |
| `sell_summary` | `buyBook` | buy orders; you instasell into them |
| `quick_status.buyPrice` | `instabuy` | what one costs right now |
| `quick_status.sellPrice` | `instasell` | what one fetches right now |
| `quick_status.buyVolume` | `supply` | items sitting in sell offers |
| `quick_status.sellVolume` | `demand` | items wanted by buy orders |
| `buyMovingWeek` | `weeklyBought` | items instabought in seven days |
| `sellMovingWeek` | `weeklySold` | items instasold in seven days |
| `buyOrders` | `sellOrders` | how many sell offers stand |
| `sellOrders` | `buyOrders` | how many buy orders stand |

One deviation from Hypixel worth keeping: **the quoted price is the best order, not Hypixel's
weighted average.** `quick_status.buyPrice` for Enchanted Cactus reads 103,007.109 while the
cheapest actual sell order is 103,006.9. The average is a fine summary and a bad quote — nobody
is selling at it. skyblock.bz quotes the top of the book and so do we.

---

## The wire format

Three endpoint shapes, and the second one is the interesting one.

**Lists** — `/api/{route}` — a flat array of objects keyed by item id, one per row. No nesting,
no envelope, no pagination. `/api/all` is 2,121 items in 438KB.

**Snapshot** — `/api/product/baseline/{id}` — under a kilobyte, and it is a kilobyte because
everything is positional:

```json
{
  "data": [1787435006965, 103006.9, 100507.9, 53474, 22538, 213174, 176065, 110, 23],
  "info": ["Enchanted Cactus", "81-0.png", []],
  "buy_orders":  [[69, 1, 100507.9], [1396, 2, 100507.8], ...],
  "sell_orders": [[11, 1, 103006.9], [14, 1, 103007],   ...]
}
```

`data` is `[timestamp, instabuy, instasell, supply, demand, weeklyBought, weeklySold, sellOrders,
buyOrders]`. Order levels are `[amount, orders, pricePerUnit]`. The page polls this every ten
seconds and pushes `data` straight onto the end of the live chart series.

**History** — `/api/product/init/{id}` — the same books plus two series, `day_info` and
`historical_info`, both **delta-encoded**:

- the first row is absolute, every row after it is the difference from the one before;
- the timestamp is in units of the sampling interval — 10s for `day_info`, one day for
  `historical_info` — so it stays a small integer instead of a 13-digit one;
- seven columns: `[dt, Δinstabuy, Δinstasell, Δsupply, Δdemand, ΔweeklyBought, ΔweeklySold]`.

That gets 4,320 twenty-second samples (a full day) and 2,332 daily samples (six and a half years,
back through Coflnet's archive to 2020) into 197KB for a single item. Stored as absolutes the day
series alone would be megabytes of near-identical figures, because between two reads twenty
seconds apart most of the six numbers do not move at all. [`bazaarHistory.ts`](src/lib/bazaarHistory.ts)
implements both directions and round-trips them.

Two details that only show up when you build it: the first row's `dt` is *fractional* — it is an
absolute epoch time expressed in ticks — so decoding has to round to whole milliseconds at every
step or the error rides along the entire series. And accumulated decimal deltas drift, so each
sample is rounded back to the precision the bazaar actually quotes.

**Charts** normalise before comparing. Plotting price against supply on one axis is meaningless,
so each series is divided by its own mean and the axis becomes "relative to this item's normal".
The historical price series is additionally despiked — any daily sample above 1.5× what its
neighbours suggest is pulled back — because a six-year history collects reads taken
mid-manipulation, and one such day flattens the whole rest of the chart against the axis.

---

## The two rules underneath every view

**Rate limits the return, not the margin.** A 217M spread on an enchantment that trades four
times a week is not a 217M opportunity. Every view carries a coins-per-hour built from the moving
week and ranks on that rather than on the spread. This is the single thing separating a usable
flip list from a list of illiquid junk with enormous paper margins — and it is why `hourly = weekly / 168`
turns up in every formula below.

**Depth limits the size.** Prices come off the book and quantities are walked through it. A quote
for 5,000 items is a quote for 5,000 items, not the top order repeated 5,000 times — the top
level is very often a single item. `walk()` in `bazaar.ts` is the primitive; every view below is
that function wearing a different hat.

The honesty limit on both: Hypixel publishes only the top 30 levels of each book. A walk that
runs out has reached the end of what is *visible*, which is not the end of the market. We flag
that (`exhausted`) and report unknown rather than guessing at the tail; skyblock.bz uses a
`±1e100` sentinel for the same situation.

---

## The tax

**2.25% on anything sold through the bazaar.** Not looked up — measured. It falls out of three of
skyblock.bz's derived figures independently, and in the crash case it reproduces their published
number to the coin:

```
walk up the sell book for 1,567 Hunks of Ice   = 4,865,248.2
walk down the buy book for 1,567               = 4,057,276.4
4,865,248.2 − 4,057,276.4 × 0.9775             =   899,260.5
skyblock.bz's partialrisk for that book        =   899,260.519
```

NPC sales are **not** taxed, which is most of why NPC flipping beats bazaar flipping on cheap
high-volume items.

---

## The seven derivations

Written out with our field names. `hourlyBought = weeklyBought / 168`, likewise `hourlySold`.

### all
The plain table. Both top prices, supply, demand, both weekly counts. Sorted by page visits,
which is a popularity signal skyblock.bz collects itself via `/api/product/tracking/{id}`.

### flips
```
buyAt   = instasell          place a buy order where buyers are bidding
sellAt  = instabuy           place a sell order where sellers are asking
margin  = instabuy − instasell
netMargin = instabuy × 0.9775 − instasell
marginPercent = margin / instabuy
```
Both legs have to fill, so the round-trip rate is the **slower** side: `min(hourlyBought,
hourlySold)`. Ranking on either alone rewards items that are heavily bought and never sold, where
the buy order simply never fills.

*Deviation:* skyblock.bz's own `marginperhour` does not reproduce as `margin × min(rate)` — the
ratio varies per item between about 0.6 and 0.97, which suggests they use a smoothed margin
rather than the instantaneous one. We use the instantaneous margin, taxed, times the slower rate,
and say so rather than fitting a curve to their output.

### crafts
Ingredients bought via buy orders, output sold via a sell order.
```
craftCost = Σ ingredient.instasell × qty
margin    = output.instabuy × 0.9775 × yield − craftCost
```
Production is a queue question, not a price question, so the rate is a **bottleneck**:
```
outputLimit = output.hourlyBought / yield      what the output's demand absorbs
inputLimit  = min over ingredients of (ingredient.hourlySold / qty)
bottleneck  = min(outputLimit, inputLimit)
coinsPerHour = margin × bottleneck
```
`instaCoinsPerHour` is the same trade done impatiently — instabuy the inputs, instasell the
output — and the gap between the two is how much the patience is worth. It runs from 3.6% to 84%
of the ordered figure across their list, which is a far bigger spread than the margins.

### npc
Buy through a buy order, sell to a shopkeeper.
```
margin       = npcSellPrice − instasell
coinsPerHour = margin × hourlySold
maxProfit    = (500,000,000 / npcSellPrice) × margin
hoursBeforeLimited = maxProfit / coinsPerHour
```
The 500M is the shopkeeper's **daily coin limit**, also measured: their max-profit column is
exactly that formula for Seeds (500M/3 × 2 = 333,333,333.33), Hamster Wheel and Red Mushroom. The
cap is on coins taken, not items bought, which is why cheap items with big proportional margins
top the list.

### reverse_npc
The other direction: buy the shopkeeper's stock, sell it on the bazaar.
```
orderProfit = (instabuy  × 0.9775 − npcBuyPrice) × stock
instaProfit = (instasell × 0.9775 − npcBuyPrice) × stock
```
`stock` is the shop's restock quantity — 640 for most, which is ten stacks.

### manipulate
Items thin enough that one player can own the sell side. skyblock.bz's cut is "fewer than 30 sell
orders", which is the same as saying the whole book fits inside what Hypixel publishes.
```
items = every level of the sell book
cost  = walk up the sell book
risk  = cost − max( walk down the buy book × 0.9775 , items × npcSellPrice )
```
Sorted by risk **ascending**, and negative risk is the point: it means the books are crossed and
buying out the sell side is free money. The shopkeeper term matters — Corrupted Fragment's risk
of −554,913 only works out because 711,994 items recover exactly 711,994 coins at 1 each, and
ignoring the NPC floor overstates the risk on every junk item.

*Deviation:* the `partial` variant stops short of the full book, and their rule for where is not
published. On a thin book the price is usually flat and then jumps — five levels near 48k, one at
100k, one at 200k, then one at a million — and their cut lands in front of the jump. We stop
before a level that more than triples the one below it, which reproduces their cut on the cases
we checked but is our rule, not theirs.

### crash
Sell through the buy book, then catch the people who instasell into the hole.
```
items       = the top buy level (partial) or the whole buy book (full)
cost        = walk up the sell book − walk down the buy book × 0.9775
priceAfter  = the best bid still standing
profit      = hourlySold × 0.5 × (1/3) × (priceBefore − priceAfter) − cost
```
The half hour and the one third are guesses about how much of the instasell flow you catch before
the price recovers. They are skyblock.bz's guesses and we kept them, because a stated guess can
be argued with. Read the number as a shape, not a forecast.

---

## Where coins-per-hour lies

Coins-per-hour is a real improvement on ranking by spread, and it is still wrong in two ways that
put the same rows at the top of every flip list on every site that uses it.

Shadow Warp: a 14M spread, three and a half round trips an hour, 181M a unit. Plain
coins-per-hour makes that 33M an hour and **eighth of 1,521 flips**. Two things are missing.

### It is a mean, and a mean is a poor summary of four trades

Miss one of four trades and you have lost a quarter of the hour. The mean never says so. Trades
arrive independently, so an hour's count is Poisson about the moving-week rate, and the 25th
percentile of that count is a straightforward thing to ask for — a quarter of your hours are
worse than this. Because a round trip needs an instasell to fill the buy order *and* an instabuy
to fill the sell order, it is taken on both legs and the worse one wins.

```
Ultimate Fatal Tempo 3   86.4M/hr mean  →      0    0.4 round trips an hour
Medium Witch Cauldron    32.0M/hr mean  →      0    0.4
Ultimate Bobbin Time 3   39.5M/hr mean  →  19.5M    2.0
Shadow Warp              33.0M/hr mean  →  19.0M    3.5
Enchanted Quartz Block   41.1M/hr mean  →  40.1M    793
```

Everything under about 1.4 round trips an hour goes to **literal zero** — a quarter of the time an
item that thin pays nothing at all — while a busy row barely moves. That is the volume floor a
flip list needs, except the cliff is where the arithmetic puts it rather than where anyone guessed,
and it can tell a thin row with a huge margin from a thin row with a small one.

### It reports the market's ceiling, not yours

The bigger omission. Coins-per-hour asks how fast the *market* turns over and never asks how much
of your money has to sit still for that to happen.

**The bazaar takes the whole order up front.** Place a buy order for a hundred and it holds a
hundred lots of coins from that moment, filled or not, until you cancel. So the coins a flip costs
is the size of the order, which makes order size the real decision — and it has a floor and a
ceiling. Too small and it empties while you are elsewhere and you stop being top of book. Too large
and the tail just sits in a queue that will not reach it for hours, when it could be earning
somewhere else.

**Twenty minutes of flow** is the size that fills in twenty minutes: long enough to leave alone,
short enough that nothing idles. A 10k item taking sixty instasells an hour is twenty items in
twenty minutes, so 200k goes in and no more.

Two details that matter as much as the window does:

- **Size on round trips, not on the buy side.** Buying faster than you can sell is not throughput,
  it is inventory. An item taking 280 instasells an hour and giving back 36 instabuys will hand you
  ninety-four items in twenty minutes and then take three hours to let go of them.
- **Never below one item.** You cannot order a fifth of a Shadow Warp. Three and a half round trips
  an hour is 1.2 items in twenty minutes, so the smallest legal order is already most of an hour's
  flow — and it costs 181M. That the floor is doing the work *is* the warning.

Sized this way, `coinsPerHour / capital` comes out near three times the after-tax margin percentage
on anything that moves — an order filling in twenty minutes turns your coins over three times an
hour whatever the item is. Where it diverges is the thin case above, which is the case worth seeing.

The budget column then reads "buy as many as you can afford, up to the window":

| | allocate | with 50M |
|---|---|---|
| Growth 6 | 18M · 6 items | 163M/hr |
| Enchanted Quartz Block | 35M · 265 items | 39M/hr |
| Perfect Jade Gemstone | 65M · 5 items | 28M/hr — three of the five |
| Shadow Warp | **181M · 1 item** | **nothing** |

That last row is the point, and it is why the count is discrete rather than interpolated. Someone
holding 50M does not earn a quarter of a 181M flip; they cannot place the order at all.

### What we did not use

Competition looked like the obvious culprit and is not. The book publishes `orders`, the count of
separate orders standing at each price, which skyblock.bz reads and then discards — sit behind
eight of them and you are ninth in the queue. **Shadow Warp has exactly one order at the best
bid.** Order stacking turns up on cheap farm goods instead (Seeds 11, Pumpkin 12 — bots), not on
the thin expensive rows. It is a real signal and it is not this one.

### On screen

The Flips table carries **Allocate** and **Bad hour** as columns beside **Coins/hr**, and a
*Coins on hand* field adds a **With 50M** column when it is filled in. The default sort is left on
coins-per-hour: these are a second opinion on the ranking, not a replacement for it, and every
column sorts on click. The Shadow Warp row now reads its own warning across:

```
Shadow Warp   181M  195M  13M  8.7M  6.7%  4  4  4   181M · 1   17M   31M    0
                                             allocate ^  bad ^  mean ^  yours ^
```

---

## Where the data comes from

Three candidate sources were polled every three seconds for three minutes, on the same item, and
compared on the one thing that matters for a flip list: how old the numbers are by the time you
can act on them.

| Source | Latency | Payload | Refresh | Staleness |
|---|---|---|---|---|
| `api.hypixel.net/v2/skyblock/bazaar` | 40ms | 3.5MB (all 2,124 items) | 20.017s | **2s** |
| `api.skyblock.bz/api/product/baseline/{id}` | 106ms | 1KB (one item) | 20.017s | 6s |
| `sky.coflnet.com/api/bazaar/{id}/snapshot` | 34ms | 3KB (one item) | — | 131s |

**Hypixel direct is the fastest source there is, and it cannot be beaten**, because everyone else
is polling it too and can only add to the delay. skyblock.bz's own snapshot is four seconds
behind the origin — the cost of the hop — and Coflnet's is a periodic cache, over two minutes old
and unchanged across the whole probe.

Two things follow:

- **Poll on Hypixel's own cadence, not a blind timer.** The refresh interval measured 20.017s,
  dead regular, and the payload carries `lastUpdated`. Waking at `lastUpdated + 20s` fetches
  just after the flip instead of landing, on average, ten seconds into a stale window. That halves
  the effective staleness for free, and it is the only speed left on the table.
- **The 3.5MB is not the problem it looks like.** It is every product at once — about 1.7KB an
  item against skyblock.bz's 1KB for one — and the app already downloads it.

History is the one thing Hypixel does not serve: its bazaar endpoint is a snapshot with no past.
So the baseline comes from skyblock.bz's `/api/product/init/{id}`, which is the six-and-a-half-year
daily series, decoded by `bazaarHistory.ts`, and the live edge comes from Hypixel.

---

## Recipes

`scripts/fetch-recipes.mjs` writes `data/generated/recipes.json` — 375 recipes for 363 items, 312
of them priceable from the bazaar alone.

Hypixel's own item resource is 5MB of 5,646 items containing exactly one recipe, so they come from
[NotEnoughUpdates' repo](https://github.com/NotEnoughUpdates/NotEnoughUpdates-REPO) instead: the
whole thing as a 9MB tarball, walked in-process, one request. Three shapes have to be handled and
missing any one costs about a third of the list — `recipe` for the single-grid case, `recipes` for
items with alternatives (Enchanted Iron is 160 ingots *or* 160 blocks; both are kept and the price
layer picks), and `overrideOutputId`/`count` for recipes that don't make one of what they're filed
under. Ingredient ids need translating too: NEU writes lapis `INK_SACK-4`, the bazaar sells it as
`INK_SACK:4`.

45 distinct ingredients — Paper, Blaze Powder and other shop goods — have no bazaar price at all.
Their recipes are kept and flagged `offBazaar` rather than dropped, because Hot Potato Books and
Enchanted Eyes of Ender are real crafts that skyblock.bz lists. They need an NPC shop price table,
which is the same table `npc` and `reverse_npc` want.

### Checked against theirs

Running our `craft()` over our recipes against a live Hypixel read, and comparing to
`api.skyblock.bz/api/crafts` fetched in the same second:

```
their list 139, we price 128
craft cost within 2%: 121/128
MAGMA_FISH_GOLD: margin ours 123693 theirs 123693 | bottleneck ours 263.4 theirs 263.4
TARANTULA_SILK:  margin ours  11249 theirs  11249 | bottleneck ours 2127.0 theirs 2127.0
ENCHANTED_CACTUS: margin ours 15553 theirs 15553 | bottleneck ours 1272.8 theirs 1272.8
```

Margin and bottleneck agree exactly, which confirms the 2.25% tax and the bottleneck definition
together. The eleven we don't price are the ones needing shop prices; the seven costs outside 2%
are recipe-choice differences on items with several paths.

### One thing we do that they don't

Wheat is nine out of one Hay Block, and nobody bids on Hay Blocks. Reading a missing bid as a
price of zero quotes the craft as pure profit — skyblock.bz shows Wheat with a craft cost of 0 —
so `flip()` and `craft()` refuse an empty side of the book instead. No price is not a low price.

---

## The tab

The bazaar is a **section** of the page, not another tab inside the report: the planner needs an
API key, a username and a profile, and the bazaar needs none of them, so it sits alongside rather
than inside. `src/browser/bazaarTab.ts` keeps its own state and its own polling, and switching
away unmounts it — a page nobody is looking at should not be making a request a minute.

It ships **Flips** and **Crafts**. Every column is sortable and both default to coins per hour
descending. Flips carries the allocate, bad-hour and budget columns above.

Both carry a **volume floor**, because no amount of cleverness in the ranking removes the reader's
need to say "not that slow". Its slider was a linear 0–200, which was useless: bazaar volumes run
from a couple of trades a week to two hundred thousand an hour, so nine tenths of the travel sat in
a range nobody wants and it could not express "a thousand" at all. It is now the 1-2-3-5-7
preferred numbers, five stops to a decade, from off to 100,000 — resolution where the decisions
are, since three an hour against seven an hour is the difference between a flip that works and one
that does not, while 20,000 against 50,000 is not a difference. The stop reads as a wait rather
than a rate ("20/hr · one every 3 min"), because the wait is the thing being chosen, and the row
count underneath says how many the floor is holding back. It persists, and it applies to round
trips on flips and to items an hour on crafts.

Rows carry the item's art, from `sky.coflnet.com/static/icon/{id}` — the only thing on the page
that comes from anywhere but Hypixel, and worth the exception because two thousand SkyBlock ids
are hard to read without it. Note the **missing `/vanilla` suffix**: that is the variant
skyblock.bz asks for and it is a much poorer set, 43% blank across a 120-product sample with
Enchanted Obsidian and every enchanted book among the gaps. The plain path answered all 150 we
tried, caches for a year, and degrades to an empty square when it cannot — which is what the ten
ids carrying a vanilla damage suffix (`INK_SACK:4`, `LOG:2`) get, since the un-suffixed id
resolves but would put an oak log against Birch Log.

Two things it does that skyblock.bz's does not:

- **Craft figures are per item, not per craft.** Hotspot Bait comes thirty-two to a craft, so a
  per-craft cost of 198k sits beside a sell price of 11k and reads as a disaster when the trade is
  fine. Dividing through by the yield makes every column comparable — to each other, and to the
  flip table beside it. 28 of 375 recipes are affected and they are exactly the misleading ones.
- **A craft says what is holding it up.** When the scarcest ingredient binds before the output's
  demand does, the row names it: "Enchanted Coal · held up by Coal". That is the difference
  between a number you can act on and one you can only rank by.

---

## What this repo has, and what it still needs

Implemented and tested (`tests/bazaar.test.ts` and `tests/recipes.test.ts`, 35 cases):


- [`bazaarTypes.ts`](src/lib/bazaarTypes.ts) — the raw and relabelled shapes, and the history row.
- [`bazaar.ts`](src/lib/bazaar.ts) — `normalise`, the book walk, the tax and rate constants.
- [`bazaarViews.ts`](src/lib/bazaarViews.ts) — all seven derivations, plus the order-sizing,
  bad-hour and budget figures a flip list needs and skyblock.bz's does not carry.
- [`bazaarHistory.ts`](src/lib/bazaarHistory.ts) — delta codec, rolling window, daily rollup,
  proximity-to-average, despike.
- [`scripts/fetch-bazaar-data.mjs`](scripts/fetch-bazaar-data.mjs) — the recipe table and a name
  for every product, both out of one download. `npm run gen:bazaar`.
- [`src/browser/bazaarTab.ts`](src/browser/bazaarTab.ts) — the tab: fetching, polling, sorting, drawing.

All seven derivations exist in the library; two of them are on screen. What is left:

- **`manipulate` and `crash`** are written and tested but have no tab yet. They need nothing new.
- **`npc` and `reverse_npc`** need a shopkeeper price and stock table, which nothing in this repo
  has — `data/generated/npcs.json` is quest NPCs and their coordinates, the wrong table entirely.
  The same table would finish the 63 recipes whose ingredients are shop goods rather than bazaar
  goods, taking crafts from 312 of 375 to all of them.
- **History is decoded but not yet fetched.** `bazaarHistory.ts` reads skyblock.bz's
  `/api/product/init` format, and nothing calls it, so `proximityToAverage` has no baseline to
  work against and there is no per-item page to show a chart on.

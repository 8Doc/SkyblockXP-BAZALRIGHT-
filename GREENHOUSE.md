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
| Prices | the live bazaar, plus the shop table from `npc-prices.json` |

**The drop figures have a date on them.** On **2026-08-20** every base crop's drop changed — Nether
Wart 240 → 108, Carrot 280 → 175, Potato 240 → 150, Sunflower 160 → 232 — so any figure computed
before that date is wrong by up to a factor of two, in both directions. The scrape records
`generatedAt` and both pages' `editedAt` so the data can be checked against the page's own History.

## The three things that decide the ranking

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

### A spreading condition counts ring cells, not plants

Layouts are a 3×3 with the mutation appearing in the middle, and the condition counts cells of the
eight-cell ring. A plant bigger than one cell fills more than one of them:

| plant | ring cells it fills |
|---|---|
| 1×1 crop | 1 |
| 2×2 mutation (Noctilume, PlantBoy Advance, Glasscorn) | 2 |
| 3×3 mutation (Snoozling, Godseed) | 3 |

So **a condition asking for three Noctilumes is met by buying two**, because the first two cover two
cells each. The wiki works this out in footnotes for the six cases where it bites and those are
parsed verbatim; `ceil(cells / cellsPerPlant)` agrees with all six, and a test asserts that it does,
so a wiki edit that contradicts the rule fails the build rather than quietly changing an answer.

### Fortune scales everything and ranks nothing

Farming Fortune multiplies every mutation's drops by the same factor, so it changes what a row pays
and never which row is best. That is worth knowing before agonising over the number: **a wrong
fortune makes every figure wrong by the same proportion and leaves the answer to "which one" exactly
where it was.** There is a test for it.

Which is fortunate, because nothing here can read it. The tab takes no API key and asks for no
username, so the fortune is a text box with a stated placeholder rather than a lookup — and the
placeholder says on screen that it is one. The formula used is the documented `1 + fortune/100`;
flagged because the wiki's own Farming Fortune page currently carries an `{{Outdated}}` banner
saying it has not caught up with the Greenhouse update, which makes it the piece of this model most
likely to be wrong.

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

- **No packing.** Each row prices one mutation and its own ring standing alone. A real greenhouse
  overlaps them — one mutation's ring is its neighbour's — so the layout shown is the pattern to
  copy rather than a plan for a whole plot, and `cellsUsed` is an upper bound rather than a packing.
- **No profile read.** `greenhouse_slots`, `garden_upgrades.GROWTH_SPEED` and `crop_upgrade_levels`
  all exist on the garden endpoint and would fill in the growth boxes from a username. The boxes are
  manual for now, which is why they default to a maxed setup and say so.
- **Watering is described, not scheduled.** Water falls 2-3 a stage and the retain effects slow it,
  but the wiki states no water *capacity*, so "you must water every N hours" cannot be derived. The
  stage timer is on screen instead, which is the half that is knowable.

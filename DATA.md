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
code (`namedFamilyOf`):

- `Bat Person Artifact` → `bat person` (the Talisman/Ring/Artifact/Relic/Orb chain)
- `Relic of Coins` → `of coins`
- `Master Skull - Tier 3`, `Personal Compactor 6000` → tier markers stripped

The rest are named in the file: shark tooth necklaces, Kuudra cores, fish bowls, piggy banks,
voter's badges, rings of love, and the two campfire badge ladders.

Those two are worth a word, because the pattern that caught them used to be unanchored and so
swallowed both: `Campfire .*Badge` matches `Soul Campfire Adept Badge I` just as happily as
`Campfire Adept Badge I`. They are separate ladders in game — 26 badges a side, under separate
ids (`CAMPFIRE_TALISMAN_*` against `SOUL_CAMPFIRE_TALISMAN_*`) — so merging them hid a whole
ladder's magical power. This is the error the *other* way round from the rename lines below: too
eager a merge hides XP the player has, where too shy a one sells XP they already own.

A name is only ever a proxy for the thing that matters, which is whether one accessory is an
upgrade of another, so this is half of family detection. The other half is
`accessory_upgrades.json` below, and `familyOf` unions the two.

**Known imprecision.** The ceiling moves whenever family detection does, and neither it nor the
README's ~2,121 is checkable from the API. Individual task XP is exact — a specific accessory's
magical power is right, and the "already owned" subtraction is right. It's the category *total*
that's approximate.

### `accessory_upgrades.json`

Which accessory is an upgrade of which, from the wiki infobox's `upgrades_from`.

The API was checked first and does not have it. Sweeping all 423 accessories in
`resources/skyblock/items` for a field that links tiers turns up **nothing** — no `recipe`, no
`upgrade_costs`, no `upgrades_from`. The fields those items actually carry are `id`, `name`,
`category`, `material`, `tier`, `stats` and a scatter of flags, and none of them says that a
Fermento Artifact replaces a Cropie Talisman.

Names carry the link whenever a line keeps its stem, which is most of them — Bat Talisman → Bat
Ring → Bat Artifact. **Fourteen lines rename as they climb**, and for those a name rule cannot
work in principle, not just in practice:

| The line | What the name rules saw |
|---|---|
| Cropie → Squash → Fermento → Helianthus | four families |
| Cat → Lynx → Cheetah | three |
| Shady Ring → Crooked Artifact → Seal of the Family | three |
| Kuudra's Kidney → Lung → Heart | three |
| Night Crystal → Moonlight Crystal | two |
| Day Crystal → Sunshine Crystal | two |
| Bait Ring → Spiked Atrocity | two |
| Crux Chronomicon → Celestial Starstone | two |
| Bluetooth Ring → Bluertooth Ring | two |

The symptom was the reported one: the bag listed accessories the player had already upgraded
past, because the tier they owned sat in a family the planner thought was empty. It also
inflated the ceiling — the same magical power counted once per split — by **97 MP**.

The two sources are unioned rather than ranked, because each covers the other's blind spots. The
wiki has no page for the Campfire badge ladders, the Master Skull tiers or the Rings of Love,
all of which the name rules get by construction; the name rules cannot see any of the fourteen
above. Unioning is also the only way to close a chain: the wiki states one edge at a time, and
it takes three of them to learn that Cropie and Helianthus are the same family.

Edges are stored, not finished families, so the union happens in one place next to the name
rules and either source alone still yields a usable answer.

Both wikis are read, and both ends of the link. Fandom is the fuller of the two but the
community wiki carries pages it never got — the Applicant's Statement's is the only one saying
it becomes a Student's Studies, without which a maxed player is offered it as missing XP. And
an editor records the link from whichever end they were editing, so `upgrades_to` states lines
that `upgrades_from` never mentions. 651 pages across the two yield 163 edges; the three that
don't resolve name something outside the modelled set and are recorded rather than guessed at.

### `accessory_rarity.json`

Rarity for the 38 accessories the items resource ships without one, read off the wiki infobox.

Magical power is a function of rarity and nothing else, so an accessory with no rarity has no
defined magical power and gets dropped from the model altogether. That costs twice: the bag
cannot credit one the player is wearing, and the family it anchors reads as empty, so the
planner offers a tier they have already upgraded past. A maxed profile was wearing six of them —
Dante's Ring among them — and being offered Dante's Talisman as missing XP.

This replaces a rule that guessed COMMON for anything named "... Talisman", which was right as
far as it went and reached only the Talisman step. 28 of the 38 now have a stated rarity; the
other 10 (the Campfire Initiate badges, Master Skull tier 2, two joke Wedding Rings) have no
page that states one and stay dropped, listed in `missing` rather than guessed at.

## What the accessory bag is really worth

Magical power is 1 SkyBlock XP each, so the bag's XP is only as good as the magical power model.
Four rules matter, all of them stated on the wiki's Magical Power page and none of them in the
API:

- **Rarity sets it** — 3 / 5 / 8 / 12 / 16 / 22 for common through mythic.
- **Hegemony Artifact counts twice.**
- **An Abicase adds 1 per 2 Abiphone contacts.** Count them from `active_contacts`, not from
  `contact_data`: the latter holds only the contacts with state attached and reads 80 against a
  real 84 on the profile this was checked against.
- **An imbued Rift Prism is worth 11**, and keeps paying after it is gone. Imbuing consumes the
  prism, so nothing in the bag can find it; the profile records the act as
  `rift.access.consumed_prism`. Without reading that, the planner lost the 11 *and* went on
  offering the prism as 8 magical power of XP still to buy.
- **Rift accessories only count if they can leave the rift.** 17 of the 29 cannot, and they
  cannot enter the accessory bag at all, so their magical power is unreachable. They were being
  advertised as buyable XP: the whole Crux line, both Rings of Love, Satelite and the trinkets,
  about 140 magical power nobody can ever collect.

There is a fifth rule the API actively misleads on. **Some accessories climb in rarity through
play** — a Book of Progression and a Pandora's Box are both COMMON in the items resource and
both MYTHIC in a real bag, worth 22 rather than 3. The bag's own NBT carries what the item
actually is, in the last line of its lore, so that is what `bagItemsFrom` now reads and
`scoreBag` prefers. Only about a tenth of bagged items carry lore at all, so this is a
correction where it exists rather than a replacement for the resource.

There is a sixth rule that is not about magical power at all: **some accessories nobody can
have.** The Talisman, Ring and Artifact of Space are uncommon, rare and epic in the items
resource and have only ever sat in a former admin's inventory; the Eternal Crystal stopped being
craftable in 2019. Twelve are in that state, recorded in `accessory_obtainable.json`, and
listing them told a player who owns everything to go and buy a staff curio.

**Hatcessories are one family.** Every Hat of Celebration counts for the same magical power and
only once — the wiki says different editions used to stack and that the stacking was removed —
so a player wearing the Sloth was being offered both Crabs.

Checked against a maxed profile reporting **2,122** magical power in game, the model reads
**2,122**, and offers that player **nothing** as still missing. It read 1,946 against 30 rows
before this work.

The last 31 of that gap were all one bug, and it was in the lore reader. A recombobulated item
writes its rarity line as `§d§l§ka§r §d§lMYTHIC ACCESSORY §d§l§ka`, where `§k` is Minecraft's
obfuscation code and the `a` either side is the shimmer it scrambles. Stripping only the colour
codes leaves `a MYTHIC ACCESSORY a`, which starts with no rarity at all — so **142 of 157**
items on that bag quietly fell back to the items resource, and with them every accessory that
climbs rarity in place. A Pulse Ring reads UNCOMMON in the resource and MYTHIC on the item.

Ruled out along the way, by measuring rather than arguing: dungeon accessories counting double
(that overshoots to 2,216), enrichments (the wiki's Enrichments page never mentions magical
power), and Personal Deletor 6000 against 7000 being separate families (the wiki states 7000
`upgrades_from` 6000, so merging them is right).

### Why the magical power you have and the XP still listed don't add up to 2,122

They are not meant to, and two of the three reasons were bugs.

**Bag slot upgrades are in the category but are not magical power.** They are ordinary SkyBlock
XP for buying room from Jacobus — 146 of the 395 one profile was quoted. Any sum that expects
`magical power + category XP = 2,122` has to drop these first.

**The recombobulator step was only offered on what you already own.** A maxed bag is
recombobulated throughout — one profile had done it to 124 of the 128 families it held, and the
four it hadn't were the four that refuse one — so an accessory you have yet to buy is worth its
rarity *and then the step after it*. Quoting only the first left the rest of the bag priced at
base rarities. The step is now offered for unowned families too, with the accessory as a
prerequisite so the bundle costs what the pair really costs.

**The Hegemony was quoted at half price.** It counts double in the bag and the row offering it
said 22 rather than 44 — the largest single row in the category, ranked as though it were half
its size. `accessoryPower` now applies the doubling in both places, so what it is worth to buy
and what it is worth to hold are the same number.

**Owning a lesser member of a family hid the whole upgrade.** A recombobulated Bat Person Ring
is worth exactly as much as a fresh Bat Person Artifact, so buying the Artifact gained nothing
and was marked done and hidden — and the Recombobulator row only ever covered what was already
in the bag, which was the Ring, and the Ring had already had one. The two steps that actually
pay, buy the better one *and then* recombobulate it, appeared nowhere. That was 73 magical
power across seventeen families on one profile.

**What no purchase can reach is listed too, as grind.** Six accessories climb past their bought
rarity through a mechanic of their own, and imbuing a Rift Prism pays 11 for good. The rarities
they reach are in `magical_power.json` under `climbing`, read off the bag of a profile sitting
at the documented maximum — stated by the item rather than claimed by a table, which is what
makes them maxima rather than guesses. The Abicase's magical power scales with Abiphone
contacts at one per two, which arrives with the contacts rather than being bought, so it is a
grind row here while the contacts stay priced in their own category.

**Count the Abiphone contacts off the task list, not the pricing table.** The two disagree and
only one is complete: `tasks.json` holds all 84 contacts, from the id namespace harvested off
live players, while the wiki's contacts table states 71 and never mentions the drill fuel
mechanic, the forge foreman or eleven others. Reading the short one capped the Abicase seven
magical power below what it reaches — and seven is exactly `floor(84/2) - floor(71/2)`.

**And offer that magical power before the Abicase is bought.** It was gated on already holding
one, which is the wrong way round: not owning the Abicase makes it a prerequisite, not a reason
to hide the 42 magical power behind it.

Checked against **49 profiles sampled at random from the auction house**, plus four named ones.
Before these two changes, 18 of the 49 reconciled to 2,122 and 28 sat exactly 42 short — the
whole Abiphone book, which is what identified the gating as the cause. After, **48 of 49 land
on 2,122 exactly**.

The one that does not is 22 over, and it is also the profile whose computed power runs 17 above
its own reported figure, so the disagreement is upstream of the ceiling. Still open, along with
the accessories a bag can hold that the items resource does not carry at all: the Balloon Hats
of 2024 and 2025 and the Cake Hat of 2026 turned up on 21 of those 49 bags.

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

## The bestiary

The profile reports raw kills and nothing else — `bestiary.kills` is a map of internal mob id
and level (`crypt_lurker_121`) to a count. No tier, no threshold, no family. Three tables have
to come from elsewhere, and only two of them exist.

### The brackets and the families — `scripts/fetch-bestiary.mjs`

The wiki's Bestiary page carries both: a "Cumulative Kill Brackets" table of 7 brackets × 25
tiers, and a per-island family list giving each family's bracket, tier cap and max kills.

**They check each other.** Max kills *is* the bracket's value at the tier cap, so the bracket
is derived from the other two columns rather than trusted, and all **249 families** across 18
islands are independent assertions about one 7×25 table. Four rows disagreed with themselves,
and in each the two numbers outvoted the label:

| Family | Page says | Its own numbers say |
|---|---|---|
| Ghost (Dwarven Mines) | bracket 2 | 40,000 kills at tier 15 is bracket 1 |
| Grunt (Crystal Hollows) | bracket 5 | 4,000 at tier 15 is bracket 3 — and its two siblings on the same row values are labelled 3 |
| King Minos, Manticore | — | the page says "[More Info Needed]" for all three columns |

The corrections are printed on every run and stored in the output, not swallowed. The two
undocumented families are excluded rather than guessed at.

**3,920 tiers, 3,920 SkyBlock XP, and 450 more from the milestones — 4,370 in all.**

This used to read 7,840, on the reading that "every tenth tier pays a milestone worth 10, so a
tier is worth 2 XP amortised". The tasks page says something else, in two lines: **"Each Tier:
+1"** and **"Every 10 _Milestones_: +10"**. A milestone is a thing the bestiary counts in its own
right, not every tenth tier, so the second line was being spent on the first.

The tasks page also states the category total outright — **4,370** — and that figure was
dismissed here as the wiki being behind itself. It is not: 3,920 tiers at 1 XP plus 450 of
milestones is exactly 4,370, and the two halves reconcile against a number this file had already
written down. Doubling every tier put the category at 7,840, and crediting a maxed profile by
its milestone count alone put it at **10,260 — more than twice everything the bestiary holds**,
which is the shape of error a stated total exists to catch.

What the milestones pay is credited from the profile's own `last_claimed_milestone` at 10 per
ten, and the tiers from the kills. They are kept apart because only one of them is knowable:
the milestone count is exact but lags, since a milestone is claimed rather than granted, while
the tier count is short wherever a mob id can't be placed. Neither is inflated to cover the
other, and the pair is capped at the total so it can't exceed the category again.

How many tiers a milestone actually takes is still not established. On live profiles the ratio
runs between one milestone per 6.5 and one per 7.5 tiers and is not consistent between them, so
no per-tier share of the milestone half would be honest.

### The table that doesn't exist — `data/curated/bestiary_mobs.json`

Neither wiki nor the API joins internal mob ids to family names. The Crypt Ghoul family is fed by
`unburried_zombie`; the ids appear in no wiki page, in no items resource, and
`/resources/skyblock/bestiary` returns "Unknown resource provided". Three rules are structural
and live in code — a trailing `_<level>` is the mob's level, a `master_` prefix is the master
mode copy of a dungeon mob, a `pest_` prefix is how the garden names a bestiary pest — and the
rest cannot be derived from the names at all: `bezal` is a Blaze, `scatha` is a Worm,
`team_treasurite_wendy` is a Grunt, and six separate goblin ids are one Goblin Raiders family.
Grouping is information, not spelling, which is also why the ids cannot simply stand in for the
families: one family routinely covers many ids, and an id says nothing about a tier threshold or
a cap.

**One third party does publish it — `scripts/fetch-bestiary-mobs.mjs`.** SkyCrypt has to know the
grouping to draw its bestiary page, and its constants carry a `mobs[]` array per family. Only
that array is taken. Its `cap` and `bracket` are dropped: they disagree with the wiki's on 92 of
the families both describe, and the wiki is the one that matches the game — Creeper caps at 50
kills in game, which is the wiki's figure against SkyCrypt's 200, checked in game rather than
read off a page. Its family list stopping at 208 against the wikis' 319 says the same thing. A
rebalance moves a cap; it does not stop a Bezal being a Blaze, so the durable half is kept and
joined onto our own family list by name (199 of 208 match outright, four are renames named in the
script, five have no family of ours to attach to and are recorded in the output).

Precedence is curated first, then the scrape, so a stale third-party entry can always be
overridden by hand without editing generated data. Last of all, a family id is matched with its
underscores removed — the game writes `lotus_fish` where the wiki writes `Lotusfish` — but only
where exactly one family compacts to it, since the merged list carries both `endstone_protector`
and `end_stone_protector` and picking one would credit a coin flip.

The map distinguishes three answers, which is the point: a family, `null` for a mob positively
established to have none (dungeon bosses and their summons never enter the bestiary), and
`undefined` for an id we cannot place. Collapsing the last two would let a family be credited a
fraction of its kills without anything noticing.

**Two guards on top of that.** An unplaced id whose every word appears in a family's name looks
like a variant of that family, so that family is held back rather than offered — otherwise its
missing kills would read as a lower tier, and since the list is ordered by how close the next
tier is, a wrong row would land at the very top. And the profile's own claimed milestone count
is a floor on the tiers it has earned (ten tiers to a milestone; milestones are claimed rather
than granted, so the count can lag but can never run ahead). The catalog states both numbers.

On an 847-id maxed profile the scrape took unplaced ids from 94 stems / 174,628 kills to 58 /
74,986, and families reading as never touched from 41 to 27 — worth +151 XP credited and 110
fewer rows offered that the player had in fact already done. Every profile measured improved.

What is left is mostly the **family list**, not the join, and it is bounded and measurable: the
in-game menu states the category at 5,660 XP against the 5,060 our table now sums to (see
`data/curated/bestiary_known_max.json`). The Sea Emperor, Pigman and Watcher are families
SkyCrypt knows and ours has no entry for; 123 id stems are unknown to both sources, most of them
the Hunting shard creatures — our table holds 37 of those and no Galatea families at all.

**Moogma and Pyroclastic Worm were not missing families — they were a parser bug.** Fandom's row
for each reads a flavour-text sentence before the real numbers: "Produces **100%** fresh magma
daily", "Travels up to **10** miles downhill". The old extraction stripped every non-digit
character out of *every* cell and read whichever numbers came out first, so those sentences
donated a phantom 100 and 10 that landed ahead of the real tier and kill count. Moogma's phantom
tier (100) failed the `<= 25` sanity check and vanished with no trace at all — not even into
`undocumented`, so a maxed profile's 32,949 real kills had nowhere to go. A cell now counts as a
number only if a digit *leads* it (`/^[\d,]/`), which excludes both sentences without breaking
Dragonfly's tier cell, which carries a caption glued onto the digits ("15earth").

Recovering Moogma exposed a second problem: the wiki's own number for it is wrong. Fandom states
4,000 on bracket 3; a real profile's in-game Bestiary screen showed it maxed at exactly 1,000
kills on bracket 4 ("Moogma XV", 1,672 kills, "100% (MAX!)", 1,000/1k). Both 4,000 and 1,000 land
on a real ladder value, so nothing structural catches the wrong one — only a screenshot did. That
is `data/curated/bestiary_corrections.json`: individual wiki figures overridden against a
verified in-game reading, applied before a family is placed on a ladder rather than after, so the
correction actually changes which bracket it lands on rather than leaving the wrong one in place
with a patched kill count. Pyroclastic Worm needed no such entry — once read correctly, the
wiki's own numbers (15, 1,000, bracket 4) were right all along.

**The level is sometimes the family.** Almost always a family owns every level a mob spawns at,
and the level is noise — `crypt_lurker_121` and `crypt_lurker_111` are one family. But sixteen ids
are split by it: `unburried_zombie_30` is a Crypt Ghoul and `unburried_zombie_60` a Golden Ghoul,
`pond_squid_1` a Squid and `pond_squid_300` a Plhlegblast, `goblin_50` a Golden Goblin and
`goblin_500` a Diamond one. Stripping the level poured both families' kills into whichever one the
map named and left the other reading as untouched — a maxed profile holding 58,277 Golden Ghoul
kills was being offered its tier 1, which is the symptom this whole line of work started from.
Those are keyed by the whole id in `levelAliases`, checked before the stem because they are the
more specific fact.

**Where the hand-mapped file disagreed with the scrape, the hand-mapping lost.** The curated file
was written from names before SkyCrypt's grouping was available, and every disagreement that could
be checked came out against the name-guess: `tentaclees` reads like a Tentacle but is a Fels,
`crypt_witherskeleton` reads like a Wither Husk but is a Withermancer, `random_slime` is a Rain
Slime rather than the Private Island Slime. Seven more had been positively excluded as boss
summons or secret mobs — Sadan's golems and statues, the invisible creepers, the dungeon
`diamond_guy` — and all of them do have families; a profile records thousands of kills for each
under `bestiary.kills`, which is not where a mob outside the bestiary would appear. Those entries
were deleted rather than left as overrides, because curated wins by design and a wrong override is
invisible.

Together those took families reading as never-touched across six profiles from **22 to 10**, and
kills credited to a family from 94.4% to **98.4%**. Two more of the ten resolved from a real
profile's kill counts: `guardian_emperor` and `skeleton_emperor` sum to 29 against The Loch
Emperor's 29, and both wikis' redirects confirm The Sea Emperor and Watcher are renames of it and
of Seer — worth 8,268 and 11,785 kills on two profiles that a curated exclusion had been hiding as
"dungeon boss".

**Critter Safari had no row on either wiki's summary table at all.** Not misnamed, not
mis-bracketed — entirely absent from `Bestiary/List` and from Fandom's rendered `Bestiary` page,
which is why nothing in the scrape above ever touched it. But every one of its mobs states its own
bracket and tier cap on its own page (`bestiary_bracket`, `bestiary_max_tier` — the same infobox
field 244 pages across the wiki carry), so `fetch-bestiary.mjs` now reads those 37 pages directly,
identified by `spawn_location = [[Critter Safari]]` so an ordinary farm critter sharing the same
template (Sheep, Cow) is not swept in by accident. A profile checked in game confirmed the count
exactly — 37 — before this ran; Gemzie's bracket is commented out on the wiki itself
(`<!--9-->`, and bracket 9 does not exist), so it is left out rather than guessed at, landing 36.

That surfaced a second bug in `placeOnLadder` itself: brackets 7 and 8 both read 20 kills at tier
10, and its identity search returns whichever comes first rather than checking what a source
actually stated. A dozen critters the wiki states as bracket 8 were silently relabelled 7. It cost
no XP — none of these families has a tier past 10 to be wrong about — but the recorded bracket was
a number nobody had stated. Critter Safari families now carry their own page's bracket directly
(`knownBracket`), verified against the ladder rather than re-derived from it.

354 families, tier total 4,960, category total **5,450** against the 5,660 the menu states —
99.2% of kills across six profiles now land on a family, up from 94.4% before any of this section's
fixes.

**Duplicates across the two wikis.** The wikis spell some families differently — Fandom writes
"Endstone Protector", "Angry Archeologist" and "Gravel Skeleton" where the community wiki writes
"End Stone Protector", "Angry Archaeologist" and "Flint Skeleton" — and slugging both gave six ids
for three families. The extra three read as families nobody had ever killed, and a maxed profile
was offered 60 tiers of mobs that do not separately exist.

Both wikis carry redirects between the spellings, so the merge folds a Fandom name when the
redirect resolves the same way **on both wikis**. The agreement is the whole guard: the community
wiki alone points "Worm" at "Stoneworm", because its Stoneworm article covers the shard creature
and it has no page for the Crystal Hollows worms — while Fandom keeps a real Worm family, the one
Scatha feeds. Folding on one wiki's say-so merged two different families and stranded every Scatha
kill. Fandom has no such redirect, and that disagreement is what catches it.

What the merge folded is published in `bestiary.json` as `renames`, so anything joining on a
family name can follow it. `fetch-bestiary-mobs.mjs` needs exactly that: SkyCrypt predates the
renames and still says Gravel Skeleton, so without the bridge three families' mob ids would go
unmapped again.

### What is offered

One task per tier still to climb, worth 2 XP, priced in kills rather than coins: **how many more
kills from where the player stands now**, ordered lowest first, and cut off at 5,000. Past that
a tier is a week of one mob, and there is no honest way to rank it against a purchase. Bestiary
tiers are the one grind category that does not use the sampled difficulty proxy — the kills
remaining are a measurement, not an estimate, so they rank on that instead.

## Abiphone contacts

84 contacts at 10 XP each is 840 XP, and until now every one of them was priced at nothing.
`discreteCost` had no rule for them, so they fell through to `{ kind: "none" }` and were filed
as grind — which meant the cheapest purchases in the game could never appear in any ranking.
They are not grind. Most contacts are added by handing one item to an NPC.

### `scripts/fetch-abiphone.mjs`

The wiki's `Abiphones/ContactsTable` states the requirement for all 80 documented contacts, and
writes it to a pattern rather than freely, which is what makes it parseable:

| Requirement | Becomes | Count |
|---|---|---|
| `No requirement.` | `npc`, 0 coins — you only have to talk to them | 11 |
| `Paying 32,000,000 coins.` | `npc` | 1 |
| `Giving 64x Silent Pearl.` | `bazaar` | 34 |
| `Giving 5,000x Undead Essence.` | `essence` | 1 |
| `Slaying a runic Enderman.` | `none` — a quest, correctly grind | 18 |
| `Giving three of the following Pets…` | `unknown`, naming what it couldn't reduce | 7 |

Item names join to item ids through the items resource, with two mechanical fallbacks: the wiki
pluralises a quantity where the item is singular ("2x Ultimate Carrot Candies"), and attribute
shards are absent from the items resource entirely but trade on the bazaar as `SHARD_<MOB>`,
which is checked against live products rather than assumed.

**The ids are named by role, not by person.** The profile calls Maddox the Slayer `slayer`, Tia
the Fairy `fairy`, Trevor `trevor_the_trapper`. Most of that is structural — one name's words
are a subset of the other's — and the pairing is required to be *unique*, so an ambiguous match
throws instead of being picked (Queen Nyx and Queen Mismyla both compete for `queen`, and only
resolve because Mismyla matches by name first). Five roles share no word with the person at all
and are named in the script with the reason: Kat is the pet sitter, Maxwell the thaumaturgist,
Elizabeth the community shop, Geo the gemstone trader, the Fear Mongerer the spooky shop.

Nine wiki rows join to no harvested id and are recorded in `unmatched` rather than dropped, so
the gap is countable. The result: **71 contacts joined, 46 of them priced.**

This is checkable against an independent implementation. SkyHelper's bot prices the same column,
and the two agree to the coin: Roddy 6,892 against their 6.9K, Walter 254,987 against 254.7K.

## The XP floor was hiding the cheapest XP in the game

The browser defaulted `minXp` to 5, on the reasoning that 1-XP tasks are death by a thousand
clicks. That reasoning is right about *bulk* and wrong about *value*, and the default inverted
the app's whole purpose: Red Sand Minion I costs 655 coins for 1 XP, which is the best rate on
the board by a factor of twenty, and a floor of 5 removed it along with every 2-XP essence perk
and 3-XP museum donation. What survived was a list starting at 27,000 coins per XP against a
real floor of 655.

The floor is now **0 by default**. It is still there for anyone who wants it — the tail is real
— but hiding the best rows is opt-in rather than the shipped behaviour.

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

**A slot is charged to no accessory.** Two earlier models are worth recording because both are
wrong in instructive ways. Half an upgrade added to every accessory's price quoted a Large Fish
Bowl listing at 9.8M as 19.8M, and billed the slot twice over — once in the markup and once in
the upgrade task that was already in the category. Making the upgrade a *prerequisite* of an
accessory was worse: one upgrade houses two accessories, so whichever one happened to sort
first carried 20M of a cost the rest of them shared, and every accessory below it looked cheap
by comparison.

So the slot stays what it is — its own purchase, at its own price, needed once per two
accessories that go into a bag with no room. Three views place it, all by the same rule, and
none of them touches an accessory's price:

- **The category browser** walks its ranking in the order shown, spends a slot on each
  accessory that needs one, and drops the next upgrade in at the point the count hits zero
  (`bagSlotsWhereNeeded` in `report.ts`).
- **The batch plan and the packages** buy the room as the fill goes, out of the same budget
  (`slotsWanted` / `slotsFor` in `solver.ts`). A package that can't afford the upgrade can't
  afford the accessory either, so it buys neither — which is the honest answer, and the reason
  the slots are checked against the budget rather than added on top of it. They lead their
  group, because nothing else in it can be bought until they are.

Only a **new family** takes a slot. Upgrading one already in the bag puts the artifact where the
ring was, and recombobulating takes no room at all — so the count is per family, not per row.

**A bag we can't read buys nothing.** An unreadable talisman bag reports a capacity of zero,
which is indistinguishable from a bag with no room in it. The plan would then spend 20M a time
on room the player may already have — the test profile has 133 free slots — so the solvers are
handed the bag only when `readable` and a non-zero capacity agree that we know its size.

## Collections say the distance, not the threshold

A collection row used to be noted with the tier's own requirement — "50,000 collected" — which
is what the tier costs from a standing start, and the one figure the player already knows is
behind them. It made every tier of a given size look like the same job. Spider Eye IX and a
Cobblestone tier both reading "50,000 collected" says nothing about the fact that one of them is
325 items away and the other is forty thousand.

So the note is the distance, in the shape the bestiary already used for kills:

```
Spider Eye 9      325 more (49,675 of 50,000)
```

The total is read once per collection rather than once per tier, because that is how the game
counts it: one cumulative figure per item, measured against every tier at once. It is taken from
the co-op union where there is one — the island collected it, not the member — so a co-op player
isn't told they are 25,000 short of something their profile finished last month.

**A collection with no data falls back to the threshold.** The profile only lists items the
player has collected something of, so a *missing key* is a real zero and "1,500 more (0 of
1,500)" is true. An *empty* `collection` object is a profile that publishes none of it, and
there the distance is unknowable rather than the whole of it — quoting one would invent a
number, so the old threshold note stands in.

**A span of tiers is still one distance.** Where the browser trims a row to the tiers it adds —
"Seeds 4–5" after Seeds 3 was listed above it — the note is the top tier's distance rather than
a count of the tiers in the span. Collections and the bestiary are running counts, so the seeds
that reach tier V are the same seeds that passed tier IV; ten attribute levels really are ten
purchases and their note goes on counting them. `CUMULATIVE` in `grouping.ts` is the list of
categories that work the first way.

## Ordering the grind

Grind tasks carry no coin price, so the solver can't rank them and the browser used to list them
arbitrarily. Ranking them needs a notion of effort, and effort is the one thing nothing
publishes — a skill level, a collection tier, a slayer level and a trophy fish are measured in
four incompatible units.

The one unit they share is **how many people have already done it**.
`scripts/harvest-difficulty.ts` samples live profiles and records, for every task the catalogue
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

Accessories are rated the same way, and were the last grind that was not. A completion there is
not a flag on the profile but an item inside a gzipped blob, so the harvester decodes each
player's accessory bag and records what is in it — which is why that script is TypeScript rather
than plain JavaScript, so it can share the NBT reader with the app instead of keeping a second
copy of it in step.

That matters because the accessories nobody can buy — soulbound ones, and the ones the game only
ever drops — are a grind and nothing else. They used to be priced "unknown", the kind that means
a price exists and we could not find it, which kept them out of the grind order altogether. They
are priced `grind` now: obtainable, never for coins, ranked by how many players have one.

3,937 tasks are rated this way, 393 of them accessories. They are shown as four bands — quick / a session / a long haul /
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

### What a milestone counts, and why the published numbers disagree

A milestone is ten family level-ups across the bestiary as a whole — the wiki says "Milestone
rewards are obtained after reaching 10 family milestones", and every ten milestones pay 10 XP.

That reading does not close, and the notes say so rather than picking a side. A maxed profile
claims **513** milestones, which at ten level-ups each is about **5,130 tiers** — more than the
**3,920** our family table holds at full, and more than the **4,370** the tasks page gives the
whole category, which the tiers alone would already exceed. One of those published figures is
stale and nothing available says which: there is no bestiary resource on the API, and the wiki's
own family list is missing islands the game has shipped since.

So the two halves are still credited from what each can support — tiers from the kills, the
milestone half from the profile's own count — and capped at the stated total. The cap is doing
real work: without it the old reading credited 10,260 against a category of 4,370.

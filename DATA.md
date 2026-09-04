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
| `skill-xp.json` | Hypixel Wiki: the Farming/Mining XP tables, every item page with a `minion_xp` infobox field, and Potions/Alchemy Experience — `npm run gen:skillxp` | Skill XP per item, by hand and from a minion | 83 item rows, 77 with a published minion rate across 6 skills; 20 compaction pairs cross-checked, 1 non-linear |
| `pets.json` | `Category:Pets`, `Infobox/Pet` — `node scripts/fetch-pets.mjs` | — | 85 pets; 82 carry the skill they level off, which is what the pet/minion pairing turns on |

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

## Crimson Isle reputation, and the two minions behind it

Every minion merchant in the game sells to whoever turns up, with two exceptions. The Mycelium
and Red Sand lines are sold against faction standing, and they check it **tier by tier** rather
than once at the door — so this is not a lock on the minion, it is a ceiling on how far up it
you can climb.

| What | Where |
|---|---|
| Mage standing | `nether_island_player_data.mages_reputation` |
| Barbarian standing | `nether_island_player_data.barbarians_reputation` |

Both are read whichever faction the player is standing in. The two have been tracked
independently since November 2024 — earning one no longer costs you the other — so a profile can
hold reputation with a faction it left, and that reputation still buys the minion.

`faction_reputation.json` carries the ladder. Both minions want the same numbers, and tier XII
sits exactly on the 12,000 cap:

| Tier | I | II | III | IV | V | VI | VII | VIII | IX | X | XI | XII |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Reputation | 500 | 1,000 | 1,500 | 2,000 | 3,000 | 4,000 | 5,500 | 6,500 | 7,500 | 9,000 | 10,000 | 12,000 |

Source is the wiki's own upgrade tables for each minion, cross-read against the Factions page
for the cap and the named bands (Neutral 0, Friendly 1,000, Trusted 3,000, Honored 7,000, Hero
12,000). Worth noting for anything scraped in future: **the official `wiki.hypixel.net` shut
down in July 2026** and now redirects to a forum thread. `hypixelskyblock.minecraft.wiki` is the
maintained successor; the Fandom copy is stale and disagrees.

### A gate is not a price

A blocked row keeps its real cost — the ingredients are on the bazaar and they are affordable.
What it gains is `blocked`, a short reason the merchant will still say no, and that sinks it
below every row you *can* act on in both the category browser and the value ranking. It reads
`needs 10,000 barbarian rep` rather than borrowing the "no price" wording, because the two are
different problems: one has no number, the other has a number you cannot spend yet.

**Sunk, but never cut.** Sinking a row below seven hundred minion tiers and then showing forty
is the same as deleting it, and deleting it is the one outcome that must not happen: a player
finishing the category would be told they were done, and then watch a row appear from nowhere
the day their reputation landed. So the sink sets the order and the truncation spares gated
rows — they are appended after the cut in both lists, and the "+N more" counts only what was
really dropped. On a fresh profile the minions panel shows 40 rows plus 4 gated ones, and
cheapest-first shows 300 plus the same 4.

**The sink splits the chain for free.** Because every craftable tier now ranks above every gated
one, `progressive` walks the craftable prefix first and the gated row picks up where it stopped:
a profile on 2,000 mage reputation is offered "Mycelium Minion I–IV" as an ordinary purchase and
"Mycelium Minion V–XI · needs 10,000 mage rep" as the part it cannot reach yet. That split falls
out of the ordering rather than being coded for, so it holds at any reputation.

One thing this deliberately does **not** do: **the solver still picks gated tiers**, so a plan
can include a Mycelium tier the profile cannot craft. Sinking it in the lists was the ask;
leaving it out of the plan changes every total, and reputation is grindable rather than
impossible — a prerequisite this model has no task for rather than a thing that can never
happen.

## Pet score: two numbers, and only one of them is published

Pet score is the one category where what you hold and what you were paid for come apart.
SkyBlock XP is settled on the **highest score the profile has ever reached**, so selling a pet
drops the score and leaves the XP behind. The API reflects that split exactly:

| What | Where | Notes |
|---|---|---|
| Highest ever reached | `leveling.highest_pet_score` | A single integer. This is what the XP was paid on, and it is the only score the API publishes |
| What you hold now | **not published** | Computed from `pets_data.pets[]`, which carries `type`, `tier` and `exp` per pet |

There is no current-score field anywhere on the profile. The strongest evidence isn't its
absence from the docs — it is that SkyCrypt computes it from `pets_data` too, and it would not
bother if Hypixel published one.

### Working the current score out

Three rules, and the third is the one that needed new data:

1. **Only the best rarity of a pet counts.** Owning the epic as well as the legendary is worth
   the legendary alone, which is why pets carry `exclusiveGroup` and behave like accessory
   families.
2. **The profile's ids are not the catalogue's names.** A T-Rex is a `TYRANNOSAURUS`, and the
   Wisp has four ids across its rarities — `accessory_families.json`'s pet equivalent,
   `pet_api_keys.json`, bridges those, and without it one family scored four times over.
3. **A pet at its maximum level is worth +1 on top of its rarity**, and this is the part the app
   could not see: it needs a level, and a level needs the pet XP curve.

### `pet_levels.json`

The curve is public and static, but it is **not** in the Hypixel resources API — `/resources/
skyblock/items` carries no pet table. It is a fixed `PET_LEVELS` array with a per-rarity offset
into it, so a pet of rarity R reaches level L once its `exp` covers `PET_LEVELS[offset[R] ..
offset[R] + L - 2]`.

Only the *thresholds* are carried, not the whole 219-entry curve: whether a pet is maxed is the
only thing here that needs a level at all, so the file holds the sum for L = 100 per rarity.
They cross-check against the figures the community publishes — common 5,624,785 and legendary
25,353,230 both agree.

Two pets break the pattern, and both are in the file:

- **Golden Dragon** climbs to 200 rather than 100, on the legendary stretch of the same curve —
  210,255,385 XP. Reading it against the ordinary legendary threshold would call every hatched
  dragon maxed at level 100, which is halfway.
- **Bingo pets** level on the common stretch whatever rarity they are. Not in this catalogue,
  but a profile can hold one.

One pet is excluded outright: the game does not count `FRACTURED_MONTEZUMA_SOUL` towards pet
score, so neither does this. It is not in the catalogue either, but a profile can carry one and
it would otherwise be counted from that profile.

### The ceiling is counted, not quoted

The panel says "of 518", and that figure is summed off the catalogue itself — best rarity of
each of the 84 pets plus one apiece for maxing it — rather than read from the `maxScore: 521`
in `pet_score.json`. Counting it keeps the headline honest against the rows underneath it: if a
pet is added or a rarity is wrong, the ceiling moves with it instead of drifting from a number
nobody rechecks. The three-point gap against 521 is unexplained and worth chasing; the wiki's
"444 as of July 2024" is a third figure again, and stale.

All 84 pets are counted, including the four the auction house never carries. A rift-bound pet
you own scores whether or not anyone will ever sell you one — the buyable filter is about what a
*plan* can shop for, not about what your score is.

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

**A perk row says what it asks for.** The note on these used to be the wiki rule that generated
the row — "essence shop perks", identically, on all four hundred of them: provenance where
information should be. It now reads `1.2k wither essence`, taken from the same cost the price is
computed off, so the row cannot say one thing and be priced as another. The amount is the only
thing that differs between two tiers of one perk, and it is what decides whether the next tier
is this evening or next month. Perks with no matched cost table still say nothing rather than
inventing a figure. One gap left: a *bundled* row — two tiers folded into one because the XP
floor hid the lower — still reads "2 levels" without a total, because the bundle summing only
recognises the `30× Shard` form the attributes use.

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

## Minion production

Hypixel's item resource carries `generator` and `generator_tier` and nothing else, so it knows
every minion's tiers and the XP each is worth but not what any of them produce. That comes off the
community wiki, a page per minion — `scripts/fetch-minion-production.mjs` writes
`data/generated/minion-production.json`. Two requests each, because the halves live apart: the
infobox is wikitext (`collects`, `collection`) and the per-tier cooldowns only exist once the stats
template has been expanded, which needs the rendered HTML.

**A cooldown is not a drop interval.** The stats table quotes the time between *actions*, and a
minion generates on one action and harvests on the next. The Minions page states it and works the
example:

> if a Tier I Cobblestone Minion does an action every 14 seconds, the minion will generate 1
> Cobblestone every 28 seconds and not 14 seconds

Reading the cooldown as the drop interval doubles every rate, and nothing about the result looks
wrong. `actionsPerHarvest: 2` is in the file so the assumption is stated rather than buried in an
expression.

The scrape is checked against two independent worked examples the wiki happens to publish, which
is the reason to trust it: Cobblestone I at **14s** on the Minions page, and Clay XI at **16s** on
the Minion Fuel page. Both are in the table at exactly those values. A test asserts both, plus that
every minion has one cooldown per tier, all positive and never rising with tier.

`collects` appears in four shapes and the first parser only handled one, which silently dropped
some of the better collection minions:

| written as | means |
|---|---|
| `4 Acacia Log` | a plain count |
| `1x Flower` | an "x" suffix |
| `* 2-5 String` | a bullet and a range — averaged, both ends kept |
| `*0.4 Nether Quartz` | already an expectation per harvest |

Three minions produce something no collection tracks — Flower, Inferno and Snow — and are kept
with a null rather than dropped, since a missing row reads as an oversight.

### Fuels and upgrades

`data/curated/minion_modifiers.json`, curated rather than scraped: both wiki tables are one page
each and mix prose, ranges and per-minion exceptions, so a parser would be more fragile than the
twenty rows it replaced.

Two things there must never be added together. **Percentage fuels** shorten the action timer, and
the wiki gives the shape — `time = base / (1 + boost)`, not `base × (1 − boost)`. **Multiplier
fuels** (×2/×3/×4) leave the timer alone and duplicate the drop. A Hyper Catalyst is four times the
items at the same speed; Foul Flesh is +90% speed, which is not 1.9× the items.

Boosts from the fuel and both upgrade slots **add before dividing**: two Minion Expanders are +10%
together rather than 1.05², and a Flycatcher beside a fuel is one division rather than two. Tests
pin the divide-not-subtract shape against the wiki's own Clay XI calculation, and the add-not-
compound shape against a case where the two differ by 8%.

Only the effects that change how fast a collection fills are modelled. A Super Compactor changes
the shape of a drop and not the count — 160 cobblestone compacted still counts as 160 collected —
so it is offered and modelled as no change, which is the honest answer rather than an omission.

### Storage, and the label the wiki changed

The scrape now also reads **max storage per tier**, off the minetip tooltip the wiki renders beside
each tier (`Max Storage: &e64`). A rate on its own says how much an hour and cannot say how long a
minion runs before it fills and stops, which is the figure that decides whether a setup wants
visiting hourly or weekly. Every minion in the game shares one ladder today — 64, 192, 192, 384,
384, 576, 576, 768, 768, 960, 960, 960 — and it is scraped per minion anyway, because that is the
sort of thing an update changes for one family and nothing else.

Reading it turned up that the wiki had **relabelled `Cooldown:` to `Time Between Action:`**, the
game's own wording. The old parser matched nothing against the live page and would have written a
table with no rates in it at all — a silent failure, since an empty match list is not an error.
Both spellings are now read. The re-scrape reproduced all 61 minions' cooldowns identically to the
committed table, which is the cross-check that the relabelled parser reads the same numbers.

Both parsers match far more tooltips than there are tiers, because the crafting tables further down
each page show lower-tier minions as ingredients and every one of those carries its own tooltip.
The tier ladder is the leading run, so the caller trims to the tier count Hypixel already publishes
rather than trusting the match count.

## What a minion pays

`src/lib/minionProfit.ts`, behind the Minions section's **Raw profits** tab. Three things decide a
coins-per-hour figure and two of them are usually left out.

**Storage caps the rate.** A Tier XII holds 960 items and makes thousands an hour, so uncompacted it
is full and idle inside the hour: the uncapped figure describes a minion nobody owns. Compaction is
what changes that, and by a lot — 160 cobblestone become one Enchanted Cobblestone, so the same 960
slots hold 153,600. The ratio is read from the compacted item's own single-ingredient recipe in
`recipes.json` rather than assumed to be 160, because it genuinely differs per item and a wrong one
is wrong by a factor of hundreds in a fill time. A plain Compactor only reaches block forms, so
anything above 64:1 is out of its reach.

`minion_storage.json` carries the chests (Small 3 slots, Medium 9, Large 15, X-Large 21, XX-Large
27) and the hoppers. Chests are **not** Minion Upgrades — the wiki is explicit that they are placed
*beside* a minion — so they are free of the two-slot budget; compactors are upgrades and do take a
slot, which is why the tab spends the second slot on one rather than letting the same decision be
expressed in two controls that can disagree. A hopper is priced as what it is: Budget sells the
overflow at 50% of the shopkeeper's price and Enchanted at 70%, and with a chest placed it only
starts once both the minion and the chest are full.

**Which market.** Instaselling pays the top buy order less the bazaar's 2.25%; a sell offer pays the
ask and takes time; a shopkeeper pays a fixed price and takes nothing — better than both bazaar
routes for a lot of cheap bulk. All three are offered rather than one being picked and called
"profit".

**Which drop.** A collection id and a drop id look alike and are not the same thing. The Cow Minion's
collection resolves to Leather and the thing it drops is Raw Beef, so pricing the collection prices
the wrong item. `minion_drops.json` pins the six that resolve wrongly or not at all, each with its
reason; the Flower Minion drops one of eleven flowers at random and carries no price rather than a
guessed one, staying in the table with the reason on the row.

## The bazaar price that is having a bad day

`src/lib/priceVariance.ts`. The failure this exists for: a thin book empties, the top-of-book quote
jumps fortyfold, and the minion attached to it climbs to the top of the table. The number is real —
you genuinely could sell *one* item at it — and the ranking is worthless, because you cannot sell
nine thousand an hour at it.

A mean does not fix this. An item that usually sits at 400 and is at 460 today is unremarkable; an
item that usually sits at 400 with a standard deviation of 4 and is at 460 today is a different
claim. So the figure on the row is the **z-score** — the distance from the month's mean in units of
how much this item normally moves — and not a percentage, because +15% means nothing without
knowing whether the item moves 1% a day or 40%.

The window is thirty days and it is **fetched, not measured**. Coflnet's bare
`/api/bazaar/{id}/history` returns a daily series going back to 2021; the last thirty entries are
the month. (`/history/week` is two-hourly and too short; there is no `/history/month`.) That means a
real month on arrival, where averaging our own polls — which is what the greenhouse tab falls back
to — needs the tab left open for a month before it says anything.

Past two sigma the guarded basis stops believing the quote and uses the month's **median** instead.
A median rather than a clamp to two sigma: a clamp still lets a manipulated item outrank an honest
one, just by less, and the complaint is about the ordering. Anything thinner than seven daily points
comes back as no month at all, because a made-up baseline makes every anomaly look explicable. An
item whose price never moved has no z-score rather than an infinite one — a perfectly flat price is
the least suspicious thing on the bazaar, and dividing by a zero deviation would sort it to the top
of the suspicious list.

Caught on the first live run: gunpowder quoting 45 against a month median of 11 at +2.5σ, which had
the Creeper Minion third on the page at 29k/hr against a real 7k.

## Minions level pets, and the rate is published

`scripts/fetch-skill-xp.mjs` writes `data/generated/skill-xp.json`; the model is in
`src/lib/minionXp.ts`, behind the **Pet profits** tab.

This is a documented mechanic rather than a workaround. The Minions page notes that a co-op member
away at collection time "will receive the Skill XP from them once they go to Private Island", and
then spells out what people do with it — levelling the same pet several times off one collection. A
pet that is out levels off that Skill XP like any other.

**Minion XP is its own column and cannot be derived from the one beside it.** The Farming and Mining
pages carry both, and the ratio wanders in both directions:

| item | by hand | from a minion |
|---|---|---|
| Wheat | +4 | +0.3 |
| Ice | +0.2 | **+0.5** |
| Nether Wart | +4 | +0 |

Anything scaling one column from the other gets all three wrong. Only those two skills carry the
column — but that is *not* the end of the coverage, and an earlier version of this section wrongly
said it was. The rest is published in the item infoboxes; see "Where the minion rates actually come
from" below. What remains genuinely unpublished comes back `minionXp: null` and the tab says **not
published** rather than quoting a zero — an unknown and a zero rank at opposite ends of a table and
only one is a claim the sources make. The scraper keeps them apart deliberately: the wiki's
`{{bc}}` blank cell is read as null, and a written `+0` as zero.

The Farming table's Red and Brown Mushroom share one `rowspan="2"` XP cell, so the second row's
markup is a single item cell. Read without carrying rowspans down, Brown Mushroom silently inherits
whatever follows it — a wrong number that looks entirely plausible.

### Skill XP into Pet XP

`data/curated/pet_xp.json`, from the Pets page's own list and table. Order matters and the page
states it: **additive factors first**.

1. Wisdom scales the *Skill XP*: `skillXp × (1 + wisdom/100)`. There is one Wisdom stat per skill.
2. Taming scales the *Pet XP* that became, through Zoologist at +1% a level to a max of 60 — so
   `×1.01` to `×1.60`.
3. Then the divisors. A pet earning XP outside its own skill keeps **a third**. A pet earning
   Alchemy or Enchanting XP that is not an Alchemy or Enchanting pet keeps **a twelfth** — and the
   two are alternatives rather than a stack, so a non-Alchemy pet takes the /12 and not the /3 as
   well. Fishing is the one skill that pays a bonus instead, ×1.5, which no minion can reach.
4. **Carpentry, Taming, Dungeoneering, Runecrafting and Social grant no Pet XP whatsoever.**

That last line retires an otherwise attractive route. Carpentry XP is 3% of the combined NPC sell
price of a craft's ingredients — a formula, not a table, and both halves are already in this repo —
so a minion feeds it generously and it is worth exactly nothing to a pet. The constant is carried in
`skill-xp.json` with its citation; the tab shows Carpentry on the page at zero rather than leaving
it off, because being able to see that it is zero is the useful part.

The brewing table is the second route and a different shape: Alchemy XP is per *brew*, so a minion
reaches it only once its drops are compacted into the enchanted form the table pays for. The chain
has to be followed rather than assumed — Enchanted Sugar Cane is 160 Enchanted Sugar and Enchanted
Sugar is 160 Sugar Cane, so one ingredient is **25,600** drops for its 15,000 XP. Assuming a single
step values it 160× too high and puts sugar cane at the top of every list in the app.

The unflattering result, stated on the tab: at the best published rate a pet takes days to weeks.
Minion XP is a trickle that costs nothing to run, not a way to level a pet on purpose.

### Where the minion rates actually come from

Two sources on the same wiki, and the second one is where most of the coverage is.

**The skill tables.** Farming and Mining each carry a `Minion XP` column beside the by-hand one.
No other skill page does — which is why an earlier pass reported Foraging, Fishing and Combat as
unpublished. 45 rated items across 2 skills.

**The item infoboxes.** Individual item pages carry a `|minion_xp = 0.5 Fishing` field. Forty-two
items have it, found by asking the wiki (`insource:/minion_xp/`) rather than from a hand-kept list,
because the list would go stale exactly when somebody fills the field in on the Oak Log page — the
absence this scrape most wants to notice. Between them they cover **six** skills, and they give
three things the tables cannot:

- **The item id, stated.** `|id = INK_SACK:4` is the real id, so nothing is resolved from a display
  name and the whole class of "Lapis Lazuli is not `LAPIS_LAZULI`" mistakes disappears.
- **The skill, per item.** A table's skill is whichever page it sat on; here it is written down,
  which is how a Cave Spider Minion files under Combat with no Combat table existing anywhere.
- **The enchanted forms**, which is what a minion with a compactor actually produces.

Together: **77 rated items across Alchemy, Combat, Farming, Fishing, Foraging and Mining**, and 37
of the 61 minions with a rate. The three the infoboxes newly reached are the Jungle Minion (0.1
Foraging), the Fishing Minion (0.5 Fishing) and the Cave Spider Minion (0.3 Combat) — one each for
the three skills that previously had no answer at all.

The five other log minions are the obvious remaining gap: Oak, Birch, Spruce, Acacia and Dark Oak
are all +6 Foraging by hand and all behave identically, so 0.1 is the overwhelmingly likely rate for
each. None of them carries the field, so none of them gets it. Guessing would be the one thing this
file is written to avoid.

### Compaction is XP-neutral, and it is checked

The enchanted forms make a cross-check possible that neither source states outright. An Enchanted
Cobblestone is 160 cobblestone and grants 16 Mining XP against cobblestone's 0.1 — exactly 160
times, exactly the recipe quantity. That holds for **16 of the 17** pairs where both ends are
published, and the load-bearing case is Sponge: its recipe is 40 rather than 160, and its XP ratio
is 40 to match. A rule that survives the one item with a different ratio is a rule; sixteen
agreements that were all 160 would only have been a coincidence.

So a Super Compactor changes what a minion drops and not what the drop is worth in XP — the
opposite of what people assume, and it means the XP half of the app can ignore the compactor
entirely while the profit half cares about it enormously.

The seventeenth pair is Spider Eye: published at 0.3, with an Enchanted Spider Eye at 480 where the
rule says 48. Sixteen exact agreements make a dropped decimal the likeliest reading by a distance,
but the scrape records the disagreement in `nonLinear` rather than correcting the wiki from here.
Nothing downstream is affected — a Cave Spider Minion drops the base item, so the base rate is what
gets used either way.

### Pure Coal is not an item

Caught by the cross-check above, and worth writing down because it was a real error in the first
pass. The Mining table has rows for Pure Coal, Pure Gold and Pure Diamond — blocks in the Dwarven
Mines — and the wiki links them to Enchanted Coal Block and friends. Aliasing them onto those ids
filed a block's 2.7 under an item whose own page says 7,680: two different things wearing one id.
There is no `PURE_COAL` in the bazaar's names or at any shopkeeper, because there is no such item.

They are left unresolved now, listed in `unresolved` rather than silently dropped. Nothing is lost:
no minion drops a Pure anything, so no ranking ever read those rows — they simply stop claiming to
be an item they are not.

### The Fandom wiki, and why it is not the source

Worth recording since it is the obvious other place to look. `hypixel-skyblock.fandom.com` carries
the same two skill tables from the same lineage, and is strictly worse for this:

| | Fandom | `hypixelskyblock.minecraft.wiki` |
|---|---|---|
| Farming / Mining last edited | 2026-06-07 | 2026-08-11 / 08-12 |
| Minions page last edited | 2026-04-05 | 2026-08-12 |
| Pure Coal row | absent | 20 / 2.7 |
| Dwarven Gold minion XP | blank | 3.6 |
| Block of Diamond player XP | 15 | 20 |
| `minion_xp` infoboxes | none | 42 pages |
| Foraging / Fishing / Combat rates | none | via infoboxes |

Two months staler, missing two of the highest minion XP rates, and with none of the item-page
infoboxes that are the only published source for four of the six skills. Its per-minion pages are
1.4KB stubs against the other wiki's fully rendered tier tables. It does independently carry the
same co-op Skill XP note, which is a useful corroboration of the mechanic and nothing more.

The official `wiki.hypixel.net` is not an option either: it now redirects to a forum thread
announcing the end of the official Hypixel Wiki, July 2026.

## Pets as a trade

`src/lib/petLevelling.ts`. Buy cheap, level, sell dear — ranked on **coins per Pet XP**, not on the
margin. Ranked on margin the Golden Dragon wins every time and is the wrong answer for anyone who
has to generate the 210 million Pet XP it needs; coins per XP is what makes a Rabbit comparable to
it, and it is the figure the minion half multiplies into coins an hour.

A pet's **level lives inside its display name** — `[Lvl 91] Golden Dragon` — and nowhere else in the
auction payload. The existing BIN index throws it away, reasonably, because the museum and accessory
questions it was built for have no levels; but a level 1 and a level 100 of the same pet are two
completely different purchases, so the pet sweep is its own pass. Only the two ends of each ladder
are kept, which is why a hundred-megabyte sweep caches as a few kilobytes.

The level table is keyed bare (`GOLDEN_DRAGON`) and the index keys pets `PET:GOLDEN_DRAGON`. The
prefix is stripped in one place rather than at every call site: a missed strip falls through to the
default max level of 100, which treats a Golden Dragon as finished at the level it *hatches* at and
prices the whole trade against the wrong end of its ladder. A test caught exactly that.

Both ends are lowest BIN and only one of them is a promise. The buy side is a listing that exists;
the sell side is *someone else's* listing, which is what you would have to undercut rather than what
you would receive — and listing a hundred of them is not the same market as the one listed now. The
1% auction cut is taken off, being the one deduction that is certain. A pet listed at only one end
is not a trade and is dropped rather than priced from a reference.

## The upgrades that add items, and the setup that was invisible without them

`data/curated/minion_extras.json`, modelled in `minionProfit.ts` as *streams*.

An upgrade can change three different things and this app previously modelled two. A Flycatcher
multiplies a number the minion already had; a compactor changes how much of it fits; and Corrupt
Soil adds a **second item the minion did not produce at all**. Folding that third kind into the
`output` multiplier would be arithmetically wrong — the extra item is not the drop and is not worth
the same — so each output is now a stream of its own, and storage, compaction, the hopper and the
claim interval treat a sulphur exactly as they treat a slimeball.

The consequence is not marginal. Corrupt Soil adds **1 Sulphur and 1 Corrupted Fragment per
harvest** to any mob-spawning minion, and on a cheap mob minion the extras are worth more than the
drop: a slimeball sells to a shopkeeper for 5, the Sulphur alone for 10. With it modelled, the Slime
Minion moves from 12th to 5th on the table, the Tarantula Minion roughly doubles, and the Revenant
Minion appears in the top three — which is what people actually build.

**Sulphur is `SULPHUR_ORE`. `SULPHUR` is Gunpowder.** The two names are swapped relative to any
reasonable guess, and the Creeper Minion drops the latter. Pricing Corrupt Soil against `SULPHUR`
values its sulphur at 4 instead of 10 and quietly halves the strategy. There is a test pinning both
names for exactly this reason.

### The hopper sells what the compactor made

A second bug the streams rewrite fixed. `compactionRatio` returned only a number, so the overflow a
hopper sells was priced as the *raw* drop — but the minion's inventory holds Enchanted Cobblestone,
not cobblestone, and the shop pays for what is in the inventory. `compactionOf` now returns the
item id as well, and the hopper is priced at the compacted item's shop price divided back down.

For most items this is a small correction, because the shop price of an enchanted item is usually
exactly its recipe quantity times the raw one. It is not always: Enchanted String is 576 against
480 for the 160 strings in it.

### Presets

Three of them, and the automated shipping one is why they exist. A mob minion with Corrupt Soil and
a Super Compactor selling into an Enchanted Hopper needs three specific slots filled and a claim
interval that effectively says "never", and getting any one wrong makes it look mediocre. The table
could always model it; the preset is what makes it findable.

## Sorting

Every column in Raw profits sorts, and each carries a `value` separate from its `render`. The
rendered cell is a string with a suffix on it and sorting that lexically puts "9.7k" above "48k".
Infinity is a real answer in the fill column — "never fills" — and is pushed to one end rather than
being allowed to poison the comparison. Ties break on the minion's name so the table does not
reshuffle under the cursor every time the bazaar ticks.

## Which pet, on which minion

`src/lib/petPlan.ts`, and the first section of the Pet profits tab.

The two lists that were already there — best minion per skill, best pet to level — required the
reader to multiply them in their head, and the multiplication is not the hard part. **The pairing
is.** A pet keeps the full Skill XP of its own skill and a third of anything else, so the best
minion under the wrong pet loses to a worse minion under the right one. Pairing needs to know each
pet's skill, which nothing in this repo had: `fetch-pets.mjs` now scrapes it from the pet infobox's
`type` line, written three different ways across the pages, and 82 of 85 pets resolve. A pet with no
skill — the Wisp is fed Gabagool rather than levelled — stays null and is not planned for, because
guessing is a factor of three either way.

**Profit has two halves and both are counted.** A minion levelling a pet is still a minion: it goes
on producing items to sell the whole time, and for every real setup that is the larger half by an
order of magnitude. The section says so out loud whenever the pet half is under a quarter of the
total, which is almost always — printing one number without that would read as "level pets off
minions for 1.3M a day", which is not what the number means.

Two design decisions worth recording, both found by looking at the output:

- **The pet is chosen on the pet half, not the total.** Item income is identical across every pet on
  a given minion, so including it makes the comparison a tie broken by nothing — and the table
  cheerfully recommended a mismatched Enderman on every single row.
- **There is a completion horizon**, default 365 days. Without one the plan recommends a pet that
  finishes in twenty-three thousand days. When nothing fits, the empty state re-runs the plan
  unbounded and reports what the quickest pairing *would* have been, so the reader knows which
  control to move rather than facing a blank table.

### Brewing costs an opportunity, not money

Every other route here is a by-product of collecting a minion you were collecting anyway. Brewing is
not: the drops go into a brewing stand instead of onto the market.

That is **money not made, not money lost**, and the distinction changed how it is presented. An
earlier version subtracted the drops' value and displayed it as a cost, which reads as a penalty on
an otherwise good plan. It is not a penalty — it is the entire question. The only thing worth asking
about a brewing route is whether the pet XP is worth more than the sale would have been, so every
row now carries **`advantagePerDay`**: what this plan makes over simply running the minion and
selling everything. For a direct route that is just the pet profit, since the XP arrived free with a
collection you were making anyway. For a brewing route it is the pet profit less what the stand ate.

Negative means the plan is worse than having no plan. Those rows are **greyed rather than removed**,
because "this minion has no worthwhile pet plan" is an answer, and a toggle hides them for anyone
who disagrees. The plan is also *chosen* on the advantage rather than on the total or on the pet
half alone — choosing on the total makes the comparison a tie broken by nothing, and choosing on the
pet half picks brewing routes that eat more in drops than the pet is worth.

The labour is capped separately and bluntly, because it is not economic: a hard cap on brews per
day, default 100. Capping the brews caps the XP with them, which is the point — "22,500 pet XP an
hour" is not an offer anyone takes if it means thousands of brews. A route that hits the cap says
so, and says what the minion could have supplied.

A route filter sits above the table for the same reason. Brewing wins on raw Pet XP by a wide
margin — an Alchemy pet on a brewed route dodges the `/12` that makes Alchemy XP nearly worthless to
anything else — so **Collect only** is a genuinely different plan rather than the same table with
rows struck out, and it is re-planned from scratch.

### What the plan cannot answer, said out loud

Twenty minions cannot be planned at all, because no minion XP rate has ever been published for what
they drop. The Revenant Minion is one of them, and a wall of Revenants levelling a Golden Dragon is
a well-known setup — so its absence from the table would read as a verdict rather than as a gap.
The section lists them and points at Raw profits, which prices exactly what those minions sell, and
which is where most of that strategy's money comes from anyway.

Enchanting, Taming and Carpentry are gone from the skill grid. No minion produces Enchanting XP by
any route, and Taming and Carpentry grant no Pet XP at all, so the three were permanent zeroes
taking up a third of the tiles. The facts are still in `pet_xp.json` and still enforced — a
Carpentry route still comes back worth nothing — they simply no longer have a card that never
changes.


## Wisdom is per skill, and cannot be read from a profile

There is a separate Wisdom stat for every skill and they are nothing like each other — an account
deep in Slayers can sit at 30 Combat Wisdom and 0 Alchemy. Wisdom multiplies the Skill XP *before*
anything else touches it, so a single figure applied to all six silently scaled the wrong skills;
`Player.wisdom` is now a map keyed by skill and each route takes its own. A brewed route is Alchemy
XP even when the minion feeding it is a Farming minion, and it takes Alchemy Wisdom accordingly.

**The tab asks for the six figures rather than detecting them, and that is deliberate.** The obvious
thing to do is read them off the profile, and it cannot be done honestly:

- Skill levels do not grant Wisdom. Hypixel's own `resources/skills` carries no Wisdom in any level's
  unlocks — the only mention in the whole resource is an unrelated enchantment.
- What does grant it, per the six `<Skill> Wisdom` pages: equipped weapons, armour and equipment,
  enchantments, attributes, pets, accessories, consumables, and permanent bases from Slayer tiers
  and Essence Shop perks. The totals reach **170–240** on a geared account, and the largest single
  sources are gear-dependent.
- Some of it is not additive at all. Fishing's Expertise enchantment multiplies with the rest rather
  than adding to it.

Computing that means reproducing SkyCrypt's whole stat engine over equipped items, and a partial
answer would be worse than none: reading only the accessory bag would find perhaps 2 of a real 170
while looking authoritative, and every XP figure downstream would be quietly wrong by a factor of
two. So the six boxes are typed once and remembered, each with a tooltip naming where that skill's
Wisdom actually comes from, and the note says plainly that the profile cannot supply them. The old
single value is migrated across all six on first load rather than dropped — wrong in detail, much
closer than zero, and one edit puts it right.

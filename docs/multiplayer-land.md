# Multiplayer land: cash, neighbours, planning, services and roads (design)

Rich, 2026-11-11: "Let's consider the minimal requirements for multiplayer. Let's see if we can really minimize their
starting cash so that maybe they can build anywhere / everywhere and possibly sell land to other players later. This way
they need to balance themselves the area types but other players can build unpopular units (garbage collection etc)
near other players high price residences etc ... come up with some options for the multiplayer experience that allows
for tactical play but not just blatant griefing." Then, over the same conversation: kinds of nuisance and amenity that
combine into a value, cleaner grades of nuisance buildings, alternatives to "the polluter pays the neighbour", planning
notices with a residents' vote, selling services to neighbours, fewer roads, marketing in planning fights, and a
prevailing wind (which grew into `docs/weather.md`).

This is a design. It changes no game code. Every question in section 10 has been decided (2026-11-11); the decisions are
written into the sections.

## 1. Today

- **Money.** A new player starts with `START_MONEY` ($20,000); a frontier start with `FRONTIER_MONEY` ($18,000) and a
  free 32×32 charter (`shared/src/constants.ts`).
- **Land.** `LAND_PRICE_PER_TILE` is a flat $10, bought as rectangles up to 48 tiles a side. After the first parcel, new
  land must share an edge with land you own, and a purchase may not wall anyone in (`shared/src/landrules.ts`). There
  is no market: selling and transferring parcels is a follow-up in `docs/world-map.md`.
- **Building.** Only on your own parcels. Anyone may lay a road on unclaimed land for `PUBLIC_ROAD_COST` ($20), and
  anyone may bulldoze one (README roadmap, "Griefing controls").
- **Road upkeep.** `ROAD_UPKEEP` ($0.50 a tile a day) is charged to the parcel owner for roads inside the parcel
  (`World.roadUpkeepOf`). Public roads on unclaimed land are in no parcel, so nobody pays for them.
- **Neighbours.** Nothing measures what is built next door. A home's appeal (`homeScore` in
  `server/src/sim/motivation.ts`) reads the parcel's tax rate, service coverage, parks, room, building level, distance
  and commute; how tall a neighbourhood grows is a hash of its 7×7 cell (`Simulation.ambition`) plus the learning lift.
  A refuse depot beside a rival's homes does nothing to them today.
- **Services between players.** Utilities bill per owner at a tariff (`docs/utilities.md` 3.5, $0.06 a unit by default,
  the same as grid import) and a network reaches only its owner's roads and public roads, never another player's
  streets. Refuse depots are a hashed share of industrial buildings (`server/src/sim/refuse.ts`).
- **Opinion.** Campaigns plant beliefs about parcels, estates, buildings and study (`docs/adverts.md`,
  `docs/motivation.md`): posters, TV, big screens, word of mouth, regret and cynicism, contrarians, fly-posting, focus
  groups.
- **Accounts.** Sign-in (`docs/accounts.md`) gives one mayor per account on the live world.

## 2. Principles

Griefing is when an action costs the victim far more than the actor and the victim has no answer. Every mechanic here
is held to five tests:

1. **It costs the actor in proportion.** No cheap action does lasting harm.
2. **The harm has a ceiling.** Nobody can wipe a neighbour out.
3. **The victim has an answer.** Buy the land between, screen, object, campaign, re-route.
4. **It is visible in advance.** Plumes, impact zones and notices are shown before anything is built.
5. **There is a positive-sum alternative.** Trading services, land and agreements pays better than fighting.

## 3. Land and money (decisions 1-4)

- **A free homestead and little cash** (decided). A new player on a shared world gets a free 16×16 homestead and about
  $3,000 instead of $20,000. Numbers to be tuned with player bots (section 9, M1). Frontier and local starts keep their
  own tuning.
- **Land priced by what is near it.** Wilderness costs $1-2 a tile; land near valuable land costs more: the price is the
  base times the land value of section 4 averaged over the rectangle. Being early somewhere pays when newcomers buy from
  you (section 7).
- **Separate outposts allowed** (decided). The "must share an edge" rule goes; "no walling in" stays, and each outpost
  must be at least 8×8 so nobody buys one-tile spite strips.
- **An empty-land tax** (decided). Land with nothing built on it (no road, zone or building) pays a small daily charge,
  a share of its price. It pauses after the owner has been away 3 days, so a holiday does not ruin anyone. Built-on
  land pays nothing extra: it already pays upkeep.
- **Self-assessed prices that anyone may buy at** (Harberger-style, on empty land only): **held back** (decided). Revisit
  only if the empty-land tax does not stop hoarding.
- **Abandoned land.** After a long absence (30 days for empty land, longer for built-on land) land goes back on the
  market and the proceeds go to the owner's treasury.

## 4. Neighbourhood value: nuisance and amenity (decisions 5-7)

### Kinds

| Kind | Comes from | Spread |
| --- | --- | --- |
| Noise | industry, busy roads, rail, runways, late venues | short; falls off fast; blocked by buildings and tree belts; leans downwind |
| Air and smell | landfill, smoking industry, incinerators | long; a downwind plume (`docs/weather.md` section 3) |
| Heavy traffic | measured lorry counts per road tile | along the roads it uses |
| Hazard | fuel depots, chemical works, fire risk | medium |
| Disorder | late venues, empty and derelict buildings | short; police coverage lowers it |
| Eyesore | derelict lots, scrapyards, pylons | very short; screening removes it |
| Green | parks, trees, water, open country | medium |
| Quiet | the absence of noise and heavy traffic | derived, nothing stored |
| Access | shops, jobs and stops in walking distance | along the street network |
| Services | the existing service coverage | exists |
| Culture and prestige | landmarks, theatres, high-level neighbours | medium |

### Nuisance follows use (decided)

A nuisance building gives off nuisance in proportion to what it actually handles: tonnes through a refuse site, lorries
through a yard, flights off a runway, staff on shift in a works. Its customers must be real (the builder's own homes, or
a neighbour's under a contract, section 6). A decoy tip with nothing coming in costs upkeep and gives off nothing.
Mothballed buildings give off nothing. A building left unused runs down and is cleared.

Nuisance also spreads evenly over the builder's own land: a tip on your border spoils your own border too.

### Combining (decided)

Amenities add, with less each time; nuisances multiply, each taking a share off:

```
value = base × (1 + Σ saturate(wᵢ × amenityᵢ)) × Π (1 − wⱼ × nuisanceⱼ)
```

One severe nuisance cannot be bought off with a park. The weights are the household's own: the six motivation values
(`docs/motivation.md` section 3) map onto the kinds (Family weights hazard and disorder heavily; Adventure barely minds
noise; Money cares most about price). A noisy area is not worthless: it is cheaper housing for people who mind noise
less. A tile's published value uses the average household's weights.

### What value drives (decided: two steps)

- **Step 1.** Value steers who chooses to move in (a new term in `homeScore`, per household weights) and how tall a
  neighbourhood grows (it raises or lowers `ambition`). Land prices (section 3) follow it. No money changes hands.
- **Step 2, later.** House prices and rents: households get budgets, value sets what a home costs, and parcel tax may
  become a share of value. This changes every tuned number in `docs/early-game-audit.md`, so it waits for step 1 to
  settle.

### Storage and cost

Kinds are kept per 4×4-tile cell as bytes in a per-chunk field (8×8 cells a chunk), recomputed for a chunk when a
source in reach changes and smoothed once a game hour, in the way `UtilityField` caches per chunk. Smell plumes read the
weather's long-run wind (`docs/weather.md`) for planning and the day's wind for complaints. The client gets the field
for an overlay (a "Neighbourhood" map layer with one tab per kind) as chunk bytes, sent like the congestion bytes.

## 5. Cleaner grades and boundary limits

### Grades

Each nuisance building comes in grades: cleaner grades cost more to build and give off less, and some earn money back.
Refuse is the first family:

| Grade | Build | Running | Gives off |
| --- | --- | --- | --- |
| Open tip | very low | low, plus the landfill levy on every tonne | heavy smell, heavy traffic, eyesore |
| Lined landfill | medium | medium, plus the levy | medium smell and traffic |
| Recycling centre | medium | partly paid back by selling materials | noise and traffic, little smell |
| Green composting or digester | high | sells gas or compost | light smell, some traffic |
| Incinerator that makes power | high | paid back by power sales | smoke, unless fitted with scrubbers |

Add-ons for any nuisance building: an enclosed building, screening with trees or earth banks (less noise and eyesore),
restricted hours (no night noise, less throughput) and a lorry route. Neighbours already have an answer to lorries: a
lorry ban on their own streets (`docs/roads.md`, street rules), whose detour the tool already works out.

### Instead of "the polluter pays the neighbour"

Rich found paying the neighbour unrealistic. Three mechanisms replace it (decided):

1. **A landfill-style levy into a regional fund.** Every tonne landfilled, and every unit of smoke, pays a levy into a
   world fund, not to anyone. This is how real landfill tax works, and it is what makes green recycling cheaper to run
   than a tip. The fund pays the upkeep of adopted roads (section 8).
2. **Limits at the boundary.** A permit sets the most of each kind any building may push onto someone else's land (the
   long-run average at their boundary). To build near a boundary you buy a cleaner grade, add screening or move back.
   The rule is objective and needs no vote; it is also the ceiling of principle 2: neighbours together can lower a
   parcel's growth by at most one level.
3. **A community offer during planning** (section 6): the applicant may offer a park, a one-off payment, cheaper service
   or shorter hours to win the vote. Paying the neighbour becomes the applicant's choice, not a rule.

Residents also react on their own: unhappy ones complain, leave, and lower the builder's credibility (section 6).

## 6. Planning and opinion (decisions 8-13)

### Notices

- **What needs planning.** A building of a nuisance kind whose expected impact zone (the area where it changes value by
  more than a threshold) reaches someone else's land. The ghost shows the zone before placing. A nuisance build that
  stays inside the builder's own land needs no vote (decided): its residents can still complain, leave and lower the
  builder's credibility.
- **The notice.** One game day (8 minutes real time) (decided). A site sign goes up, the affected mayors get a toast,
  and the local news carries it. Citizens vote, so the neighbour need not be online.
- **The voter list** is frozen when the notice is filed: residents of the impact zone, of every owner. Homes built
  during the notice do not vote.
- **Results:** approved; approved with conditions (hours, screening, a lorry route); or refused. A refused plan may be
  filed again after a cooling-off period, and only with a changed design: a cleaner grade, more distance or a better
  offer.

### The vote

```
lean    = the resident's own expected impact (the game's true estimate, weighted by what they care about)
        + their belief about the plan (campaigns, word of mouth)
        + the community offer, and jobs for them or their household
turnout = how strongly they feel × a loss-aversion factor (opponents vote more readily) + turnout campaigns
```

Loss aversion is the not-in-my-backyard effect: a plan mildly good for many and bad for a few loses unless the
applicant makes its case.

### Campaigning on a plan

A plan is a fifth campaign target, `plan` (`docs/adverts.md` section 3), with its own claim table. Each claim names a
value and a nuisance or amenity kind, so the game can check it against the truth:

| Value | For | Against |
| --- | --- | --- |
| Money | "Lower bin charges for {parcel}" | "House prices will fall" |
| Family | "A new park for {parcel}" (the offer) | "Fumes by the school" |
| Getting on | "{n} skilled jobs" | "Who'd want to live next to a tip?" |
| Staying put | "Local jobs for local people" | "Keep {parcel} green" |
| Free time | "Recycling on your doorstep" | "Lorries on our streets all day" |
| Something new | "The cleanest plant in the region" | |

A turnout claim ("Have your say: vote by {day}") raises turnout among those who already lean your way, without moving
anyone.

Channels:

| Channel | Reach | Cost | Notes |
| --- | --- | --- | --- |
| Posters (exist) | commutes past the slot | rent a day | good when the zone sits on busy routes |
| Leaflets and doorsteps (new) | households on the voter list | per household | precise and dear; only inside the zone |
| Public meeting (new) | attendees of an event at a nearby venue | venue hire | a strong nudge; both sides speak, so the truer case gains more |
| TV (exists) | everyone | high | mostly wasted outside the zone |
| Local news (new rows in `sim/news.ts`) | everyone | free | written by the game: the application, the meeting, the result |
| Word of mouth (exists) | friends | free | well-connected residents carry it |

Focus groups (`cul2`) show a live poll with a margin of error. Without them a player campaigns blind.

### Credibility (decided)

One number per player per map sector. Regret attributed to a player's claims in a sector lowers it; claims borne out
raise it. It multiplies the strength of that player's campaigns there. A plan's claims are the fastest-checked in the
game: everyone in the zone lives with the result. If "odour-free composting" smells, the applicant's next plan there
starts weaker; if "house prices will fall" proves false, the objector pays instead. An applicant may change the plan
during the notice (cleaner grade, screening, a better offer), which changes the true impact and unlocks a "We listened"
claim.

### Guards (decided)

- **Only people with a stake campaign on a plan:** the applicant and owners of land in the impact zone.
- **A spending cap per side**, scaled to the plan's size.
- **Diminishing returns** from the existing freshness rule.
- **Fly-posting** keeps its limits (`docs/adverts.md` section 7); during a notice, a discovered fly-post over a planning
  poster also costs credibility.
- **Claims about someone else's land must be true when posted.** False claims about your own land are allowed and
  backfire through regret, as now. A claim about a rival's land is checked against the truth when posted and refused if
  false; if it becomes false while running, it is taken down and the poster fined.
- **No new planning campaigns in the last game hour** before the vote (optional; tune in play).

### Opinion about areas

Beliefs may also target an area's kinds ("Docklands is up-and-coming", "Eastfield is noisy"). In the short run, who
moves in follows belief; in the long run, the truth. That allows a land play with real risk: buy cheap land by a tip,
win planning to replace the tip with composting, market the area, sell to newcomers. Overhype it and regret drags it
back and costs credibility.

## 7. Trading land and services (decision 14)

### Land

- **Sell or lease a parcel** on the map: a listing with an asking price, offers, and a transfer when accepted (the
  `docs/world-map.md` follow-up). Split and merge already exist to cut the piece to sell.
- **Covenants**, set by the seller and binding every later owner, enforced by the build rules: "no heavy industry",
  "stays a park", "no building over {n} levels". Land with a covenant sells for less.
- **Leases** pay rent each day for a fixed term; buildings on leased land revert at the end, or are bought at book
  value.
- **Neighbour pacts:** two owners agree a buffer strip and share its cost; either can end it with notice.

### Services (decided)

- **A fixed public tariff.** The provider sets a price per unit (power, water, gas) or per home per day (refuse). A
  neighbour signs up a parcel or an estate. The contract runs for a fixed term at a fixed price; either side may leave
  with 3 game days' notice; nobody can cut a service off mid-contract.
- **A regional fallback caps the price.** A regional supplier always exists at a reference price (like today's grid
  import). No provider may charge more, so nobody is held hostage; a provider wins by being cheaper or cleaner.
- **Access to the buyer's roads.** Signing up lets the provider's network and vehicles use the buyer's streets, for that
  service only: the exception to "a network never reaches another player's streets".
- **Billing** runs hourly through the existing utility bills, with a line per contract in both ledgers.
- **Tenders, later:** "refuse collection for 400 homes for 10 days", and providers bid.

## 8. Roads (decisions 15-17)

- **The builder pays the upkeep** of every road they lay, on their own land or public (decided). This closes the spam
  loophole: today a public road costs nobody anything after it is built.
- **Unused roads fade** (decided). A road tile with no traffic and nothing built beside it for 5 game days starts to
  revert to countryside, with no refund.
- **Shared roads are adopted.** A public road that other players' traffic uses regularly is adopted by the regional
  fund (paid by the levy, section 5): its builder stops paying upkeep and can no longer remove it freely.
- **Buildings help pay for their roads.** Each building facing a road covers part of that tile's upkeep, so dense,
  efficient streets pay for themselves and long empty ones lose money.
- **Cheap tracks first.** A slow, cheap track that fades when unused, upgraded in place (the existing road-class
  upgrade) once traffic justifies it.
- **Removing roads: decided by use, not by every neighbour agreeing** (decided; a unanimous rule hands a permanent veto
  to the most hostile neighbour or an abandoned account). A road no other player's traffic depends on is free to
  remove. A road is protected when removing it would cut another player's land off from the gateways, or lengthen their
  trips by more than a threshold (the detour sum the lorry-ban tool already computes). A protected road can be closed
  when the closer first builds a replacement route (approved automatically), or after a closure notice to which no
  affected mayor objects in time (silence is consent).

## 9. Where it applies (decision 21) and phased plan

Nuisance, value, grades, the levy and road upkeep apply in every world, private frontiers and local mode included: your
own residents care. Planning votes, campaigns on plans, service contracts and land sales between players matter only in
shared worlds. Spectate (showcase) worlds refuse every new intent, as today.

| # | Subtask | Depends on | Main files |
| --- | --- | --- | --- |
| M1 | **The value field.** Kinds per 4×4 cell, per-chunk cache, sources from buildings and measured traffic (nuisance follows use); the Neighbourhood overlay; `homeScore` and `ambition` read it (step 1). A loadtest probe. | W1 of `docs/weather.md` for plumes (until then, round plumes) | new `sim/value.ts`, `sim/motivation.ts`, `sim/simulation.ts` (hot), `client` overlay |
| M2 | **Land and money.** Homestead and start cash, value-priced land, outposts, the empty-land tax and its pause, abandoned land. Tune with player bots. | M1 | `shared/src/{constants,landrules,tuning}.ts`, `server/src/net.ts`, `sim/finance.ts` |
| M3 | **Roads.** Builder-pays upkeep, fading roads, adoption, frontage share, protected roads and closure notices. Closes the README griefing item. | none | `world.ts` (`recountRoads`, upkeep), `net.ts` bulldoze, `shared/src/roadtool.ts` |
| M4 | **Grades and limits.** Refuse grades and add-ons, the levy and the regional fund, boundary limits in the build check. | M1 | `shared/src/buildings/`, `sim/refuse.ts`, `sim/finance.ts` |
| M5 | **Planning.** Impact zones, notices, the frozen list, the vote, conditions and cooling-off; the news rows; the planning panel. | M1, M4 | new `sim/planning.ts`, `sim/news.ts`, `protocol.ts`, client panel |
| M6 | **Campaigns on plans.** The `plan` target and claims, leaflets, public meetings, turnout claims, spending caps, stake rule, truth check on claims about others' land, credibility per sector. | M5, adverts A4 | `shared/src/adverts.ts`, `sim/adverts.ts`, `sim/motivation.ts` |
| M7 | **Land market.** Listings, offers, transfers, covenants, leases, pacts. | M2 | `shared/src/parcelops.ts`, `net.ts`, `client/src/mapmode.ts` |
| M8 | **Service contracts.** Tariffs, terms, notice, the fallback cap, road access, ledger lines; refuse first, then power and water. Tenders later. | M4 | `sim/utilities.ts`, `sim/refuse.ts`, `sim/finance.ts` |
| M9 | **Step 2: house prices and rents.** Household budgets, rents from value, tax on value; re-run the early-game audit. | M1-M2 in play | `sim/simulation.ts`, `sim/motivation.ts`, `sim/finance.ts`, `shared/src/tuning.ts` |

M1 first: nothing else matters until a neighbour's choices reach you. M3 can run beside M1. A caution for every phase:
growth demand and vacant jobs are world totals today (`docs/start-from-zero.md` section B), so neighbours already share
demand; test with two or three player bots before tuning numbers.

## 10. Decisions (Rich, 2026-11-11)

| # | Question | Decision |
| --- | --- | --- |
| 1 | Free 16×16 homestead and about $3,000 start cash | yes |
| 2 | Separate outposts (drop "must share an edge", keep "no walling in") | yes |
| 3 | Empty-land tax, paused after 3 days away | yes |
| 4 | Self-assessed prices anyone may buy at, on empty land | held back |
| 5 | Value as real house prices | in two steps: steering first, prices later |
| 6 | Prevailing wind | yes (`docs/weather.md`) |
| 7 | Multiplied nuisances, household weights | yes |
| 8 | A vote on nuisance builds inside the builder's own land | no |
| 9 | Notice of one game day | yes |
| 10 | Only people with a stake campaign on a plan | yes |
| 11 | Spending cap per side | yes |
| 12 | Claims about others' land must be true | yes |
| 13 | Credibility per player per sector | yes |
| 14 | Service contracts: fixed tariff, regional cap, 3 days' notice, no cut-off | yes |
| 15 | The builder pays upkeep on public roads | yes |
| 16 | Unused roads fade after about 5 days | yes |
| 17 | Road removal decided by use, not unanimity | yes |
| 18-20 | Weather questions | see `docs/weather.md` section 7 |
| 21 | Nuisance everywhere; planning, campaigns and contracts in shared worlds | yes |

Still open, for the phases that need them: the empty-land tax rate, the boundary limit per kind, the plan-size scale of
the spending cap, the adoption threshold for shared roads, and the abandoned-land periods. All are tuning, set in M2-M5.

## Built: M3 roads (2026-11-11)

Section 8's first, second, third and sixth bullets, for road on unclaimed land ("public road"). Code:
`server/src/sim/publicroads.ts` (one `PublicRoads` per game, owned by the Simulation), `World.publicRoads`, the road and
bulldoze intents in `server/src/net.ts`, the tunables in `shared/src/tuning.ts` (`PUBLIC_ROAD_TUNING`). Check:
`npm run roadrules:check` (`server/src/roadrules-check.ts`, a frontier world driven over fake clients).

**The record.** `World.publicRoads` maps each public road tile (tkey) to `{ b?, old?, ad?, used, om, od, u?, warned? }`:
the builder, whether it is from before M3, whether it was adopted, the last day it was used, the days other owners'
traffic was seen (a bitmask), and the owners seen on it lately. Saved as the optional snapshot field `publicRoads` (no
format bump). When the game starts, every road tile on unclaimed land without a record becomes `old`: a save from before
M3, and the seeded country road of a frontier, load with their public roads nobody's. A tile taken into a parcel leaves
the map (`World.setParcelId`), and midnight drops records whose tile is no longer road.

**Builder pays.** The road tool records the player as builder of every tile it lays on unclaimed land, bridge decks
included, and of every public tile it upgrades to another class (the upgrader becomes the builder, an adopted or old
tile included). At midnight each builder pays the day's upkeep of their tiles at the class's rate (`classDef(...).upkeep`,
the same as `recountRoads` charges a parcel), as one ledger line, `roads`, "Public roads" (a running cost). Old and
adopted tiles cost nobody.

**Use.** Every `sampleTicks` (20) ticks the sampler looks at each moving citizen and each vehicle on the road: one standing
on a public road tile marks it used today, under its owner (a citizen's home parcel's owner, a vehicle's `owner`); a
public tile with any congestion is used too, and at midnight so is one with anything built, being built or zoned beside
it. Walkers count (citizens on foot have a leg like drivers).

**Fading.** A non-old tile unused for `fadeDays` (5) whole days goes back to plain ground at midnight (`setTile`, ordinary
tile deltas; its class byte goes with it; no refund). The builder is told the midnight before (a toast through the
simulation's notices) and when it goes. Fading tiles are taken a 4-connected cluster at a time, and a cluster whose
removal would cut anyone's land (the builder's included) off from every gateway stays; it is looked at again after
another `fadeDays`. Junction, bridge-deck and level-crossing tiles never fade (their builder can bulldoze them).

**Adoption.** A non-old tile on which other owners' traffic (anyone but the builder) was sampled on `adoptDays` (3) of the
last `adoptWindow` (5) days is adopted at midnight: the builder record is cleared, the builder is told, and nobody pays
its upkeep. The day's adopted upkeep is handed to `PublicRoads.regionalFund`, a hook that is null for now: M4's
regional fund (section 5, the levy) fills it. An adopted tile is protected like any other (below) and still fades if
all traffic leaves it.

**Protected removal.** Before a bulldoze, `net.ts publicRoadRefusal` gathers the tiles of the drag that would take up
public road (a bridge deck brings its whole span; junction and crossing tiles, which only lose their junction, are left
out) and asks `PublicRoads.removalRefusal`, all tiles together. It refuses, as an error toast naming who depends on it:

- **Cut off.** Any other player's land that reaches a gateway along roads now and would not without the tiles. A bounded
  breadth-first search (`reachMax` 20,000 road tiles; past that the land counts as linked) runs from each road beside
  the removed tiles; a side that runs out without meeting a gateway's road gives its neighbouring owners as candidates,
  with the owners beside the tiles themselves, and each candidate is confirmed by the same search from every road in and
  round their parcels, before and after. "This public road is the only road link between Bob's land and the gateways:
  build another way round before taking it up".
- **Detour.** When other players' traffic was sampled on the tiles within the adoption window: the route cost between
  the road tiles at the removed tiles' ends, through them and round them (`findRoute` with the tiles as walls, as the
  street-rules HGV probe does; both searches take HGV bans as walls), and a way round more than `protectDetour` (16)
  dearer, or none, is refused. "Ada's traffic uses this public road and the way round is 31 tiles longer: build a
  replacement route before taking it up".

A replacement route already there passes both naturally. A builder (or anyone) may still take up public road nobody else
depends on, at today's cost. **Road on a player's own parcel stays the owner's call**: it is not protected, even when
others drive on it. A sandbox has no protection (anyone may change anything there). **Closure notices** (a protected road
closed after a notice no affected mayor objects to) are left to M5, planning: the notice, the toast and the objection
belong with its notices.

**Buying the land under a public road** takes the road into the parcel as before: its record goes, and `buy` now
recounts the parcel's roads at once, so the buyer pays its upkeep from the next midnight (before, a bought road was
counted only when the server next started or the parcel was edited).

**Client.** The road tool's chip and status line say "3 on unclaimed land: public road, you pay its $1.50/day upkeep (it
fades after 5 days unused)"; the class picker's note says the same with adoption; the ledger shows the new line through
`LEDGER_LABELS`; the bulldozer's refusal is an error toast like every other refusal.

**Cost.** Nothing runs per tick per tile. In a 6-district test city (43,000 citizens) with all 8,900 of its road tiles
made public as a worst case, a sample took 1.6 ms (every 20 ticks) and midnight 3 ms. The protection's searches run only
on a bulldoze of public road and for fading clusters at midnight.

**Differences from the design.**

- The builder pays for public road only; road on a parcel is still its owner's to pay for, whoever laid it (only the
  owner may lay road there anyway).
- Fading is all at once after 5 days, not a gradual "starts to revert", and applies only to public road laid since M3:
  old public road (a frontier's country road, roads of saves from before M3) never fades and costs nobody.
- Adoption is measured by the sampler (other owners' citizens or vehicles seen on 3 of the last 5 days), the threshold
  section 10 left open. A sample every 20 ticks catches a light stream of traffic, not a single car; a road others rely
  on is protected through the cut-off rule whether or not it was sampled.
- "The only link to a gateway" is judged from the land's side: a road is kept when some land would be left with no road
  to any gateway. A road whose removal leaves every piece of land still linked to some gateway may go, even if one
  gateway loses its road.
- The detour is between the removed tiles' own ends, with a car's route costs, not the lorry-ban tool's sample lorry;
  the threshold is a route cost (about a tile of street each), not a share.
- Street-rule upkeep on public road (an HGV ban on unclaimed land) is still nobody's; undoing an upgrade of a public tile
  leaves the upgrader its builder.
- Cheap tracks, frontage contributions and the regional fund are not built (out of scope for M3).

## Built: M1 value field (2026-11-11)

Step 1 only: value steers who moves where and how tall a neighbourhood grows. No money changes hands.

**What landed.**
- `shared/src/value.ts`: the eleven kinds (`ValueKind`, `VALUE_KINDS` with labels and legends), the `VALUE` tuning object
  (spreads, emissions, weights, home and ambition terms), `VALUE_BY_MOTIVE` (the six motivation values to kind weights:
  Family x2.2 hazard, x2.0 disorder; Adventure x0.3 noise; Status x1.8 eyesore, x2.2 culture; Time x1.8 access, x1.5 quiet;
  Money a little less of everything), `valueWeights`, `AVERAGE_VALUE_WEIGHTS`, `combineValue` (the section 4 formula,
  saturate x/(1+x), each nuisance cut capped at 0.9), the spread kernels per seed (`valueKernels`: round, or a plume from
  `climateOf(seed).rose`, long downwind and short upwind, a strong-wind bin reaching further; noise is 30% plume), and the
  industrial models' noise, pollution and hazard (chemicals, fuel) from the catalogue.
- `server/src/sim/value.ts` (`ValueField`, owned by `Simulation` as `sim.value`): bytes per 4×4 cell (12 a cell: the
  eleven kinds and the published value), per-chunk cache. Once a game hour it measures use, builds an emission grid
  quantised on a log scale (about 13% a step), and recomputes only the chunks within reach of an emission that changed
  (plus new chunks and every chunk when services move). Targets are modified chunks and the ring round them. Nothing runs
  per tick per tile; traffic is sampled every 10 ticks (vehicles and lorries/buses per cell).
- Nuisance follows use: works by workers on shift (smoothed hourly), times the model's noise and pollution; refuse depots
  by homes emptied (`Refuse.handledAt`); power plants by staff share times `UTIL_POLLUTION_OF`; roads by measured vehicles
  and heavy vehicles; rail by running lines' track tiles and trains (`Timetabled.eachRunning`); airports by flights an hour
  at three points on the runway; late venues by guests at 22:00-04:00; buildings empty 12 hours give disorder and eyesore.
  Mothballed buildings give nothing. Police cover takes up to 60% of disorder off. Amenities: open land and parks (green),
  jobs, shops and stops (`Transit.eachStop`) (access), staffed coverage (services), landmarks, theatres, cinemas,
  libraries and buildings above level 4 (culture). Quiet = 255 - max(noise, heavy traffic). Owner-blind: own land is hit
  as hard as a neighbour's.
- Effects: `Motivation.hoodTerm` in `homeScore`, `VALUE.homeTerm` (0.45) x clamp(1.2 x ln(value there / value here)) with
  the household's own weights; `Simulation.ambition` + `ValueField.ambitionDelta`: -1 where the average household's
  nuisances leave under 0.62 of value, +1 where value is over 1.75, never more than one level either way.
  `VALUE=0` keeps the field but turns both effects off (A/B).
- Client: the overlays menu has a Neighbourhood row (channel `Overlay.Neighbourhood`, combined value on the diverging
  ramp) and, while it is on, a tab per kind (channels `NEIGHBOURHOOD_KIND0 + k`). It goes through the existing data-overlay
  path (`server/src/overlays.ts`, per-tile bytes for subscribed chunks, re-sent only when a chunk's hash changes), so no
  new message. A home's tooltip has a Neighbourhood row: value, worst nuisance, best amenity.
- Snapshot: nothing new; a loaded world rebuilds the field at its first hourly pass (checked).
- `npm run value:check` (`server/src/value-check.ts`), `server/src/loadtest/value-probe.ts` (A/B probe).

**Measured.**
- value:check: idle depot 0, busy depot (60 homes a day) 0.77 smell at its cell; works with 40 on shift noise 0.92, none 0;
  mothballed 0. Seed 4242: smell reaches 48 tiles downwind and 6 upwind; kernel weight downwind/upwind 2.61/1.79 (noise),
  22.1/1.22 (smell), equal (eyesore). Own and neighbour cells either side of a depot 0.49/0.49. A Family household's home
  term prefers the quiet home more than an adventurous one's. Deterministic; a settled field recomputes nothing.
- Cost: 6x6 test city (6,937 buildings, 14,400 citizens): 7-8 ms a pass once settled (63 of 64 chunks still changing
  in the first hours), 21-23 ms for the first pass (all chunks new); a full rebuild 10-20 ms. That is once a game hour,
  so about 0.1 ms a tick amortised, but one tick an hour carries it.
- Motivation loadtest (2x2, 5 days, VALUE=0 against on): all 29 checks pass both ways; moves of their own accord 0.043% to
  0.071% of households a day (6 to 10 moves), job changes 0.043% to 0.049%; wage and commute effects unchanged.
- value-probe (3x3, 4 days, first tuning, roadNoise 0.12): population 4,949 off / 4,867 on, all levels 2,223 / 2,212, merged
  28 / 28, moves 15 / 20. Ambition was cut a level at 168 of 665 homes and noise was over 50% at 576 homes. The dense test
  grid saturated noise, so road noise was lowered (roadNoise 0.12 to 0.04, heavyNoise 0.2 to 0.1, heavyTraffic 0.6 to 0.4).
  With the new tuning: population 4,949 off / 4,971 on, all levels 2,223 / 2,190, merged 28 / 30, moves 15 / 17;
  ambition -1 at 97 homes and +1 at 39 of 656; noise over 50% at 243 homes; 6.1 ms a pass on the 3x3 city.
- perf:check ran while two probes loaded the machine (load 3.9 on 4 cores), so its timing failures are not meaningful.
  The plan phase (which now includes the hourly pass) was 5.1% of the tick against 3.4%. Re-run on a quiet machine, then
  `--update` once accepted (the game hash changes, since moves and growth now read the field).

**Deviations.**
- Quiet is stored as a byte like the others, though it is derived each pass. Access counts jobs, shops and stops by
  distance, not along the street network. Heavy traffic is per cell from sampled vehicles, spread 6 tiles round, not
  along the roads. Noise is not yet blocked by buildings or tree belts.
- "Spreads evenly over the builder's own land" is read as owner-blind spread (your land suffers as a neighbour's does),
  not an extra share smeared over the whole parcel.
- Overlay chunks go as per-tile bytes on the existing overlay message (4x4 cells expanded), not a new cell-byte message.
- Depot use is today and yesterday averaged, so a depot's smell fades over a weekend without collections.

## Built: M2 land and money (2026-11-11)

Section 3's decisions 1-3 and abandoned land, on a **shared world** only. Code: `shared/src/land.ts` (prices, browser-safe),
`shared/src/landrules.ts` (outposts), `LAND_TUNING` in `shared/src/tuning.ts`, `server/src/sim/land.ts` (`LandMarket`,
one per game: the price cache, the tax, abandoned land), `server/src/net.ts` (start, homestead, buy, the `landPrice`
message, presence), the client's buy preview (`client/src/main.ts` `buyCost`, `world.ts` `landPrices`). Check:
`npm run land:check` (`server/src/land-check.ts`). Bot: `server/src/loadtest/landbot.ts` (bot F's moves on a shared world,
`loadtest/botf.ts` `playMarket`).

**Where it applies.** `GameConfig.market`, set by `index.ts` on the live server (not a test city, demo or showcase;
`LAND=classic` turns it off); `createGame` also refuses it on a frontier, a sandbox or a showcase. Frontier starts keep
`FRONTIER_MONEY` and the charter, local mode (no `market`) keeps `START_MONEY`, the flat `LAND_PRICE_PER_TILE` and
"must share an edge"; their tuning is untouched. The welcome carries `land: 'market'` so the client plays the same rules.
Existing players keep what they have; only players made after the switch get the homestead and the small start.

**Start and homestead.** A new player on a shared world gets `LAND_TUNING.startMoney` ($3,000) and `Player.homestead`
(16, saved, in the player DTO). The homestead is the **first purchase**, anywhere legal: free when it fits in 16×16; a
bigger first purchase pays for the tiles beyond 256 (its price × (area − 256) / area). The first plot, like an outpost,
must be at least 8×8 (otherwise a fresh account could drop free one-tile spite strips). The parcel is named "<name>'s
homestead".

**Prices.** A tile's price is `base` × exp(`gain` × (land value − 1)), clamped to [$1, $40] (base $1.50, gain 4). The land
value is the published value's formula (`combineValue`, the average household) **without the green and quiet terms**:
with them, open country (green and quiet at full) scored 1.61 against 1.41 at the median home of a test city, so the wilds
would have been the dearest land. Without them open country and anywhere with nothing near is 1 (the base price), a
test city's homes are 0.77 / 1.09 / 1.27 (p10 / median / p90; at most 1.44), and nuisances take it down. The exponential
curve turns that narrow spread into $1.50 in the wild, about $2.20 at the median home and $7.40 at 1.4; in land:check's
Commons world the dearest 8×8 is 3.9× the wild price. Each cell's price travels as one byte on a log scale between $1 and
$40 (about 1.5% a step): `landPriceBytes` makes a chunk's 64 bytes from its value-field bytes, and `landPriceOf` sums a
rectangle's tiles from those bytes alone, so the server's charge and the client's preview come from identical numbers
(water tiles are priced like land, as before). Chunks with no field are the wild price.

**On the wire.** `{ t: 'landPrice', cx, cy, d }` (base64 of the 64 bytes, '' for the wild price) goes to a client for each
chunk it subscribes to and again after an hourly value pass when a subscribed chunk's bytes changed (Net keeps what each
client last got; `LandMarket` caches the bytes per value-field version). A buy carries the price the client showed
(`q`); a server price above it is refused ("The price of that land has just changed to $…"), so a pass landing between
the preview and the click never charges more than was shown. The buy tool's chip reads "by value"; the status line
shows the cost, about a tile, "your homestead, free (worth $…)", and the empty-land tax.

**Outposts.** With `rules.outposts` `checkPurchase` drops "must share an edge"; a purchase that shares no edge with your
land must be at least `outpostMin` (8) a side. The walling-in check stays as it was, but its search box is the bounding
box of the holdings joined to the new rectangle (sharing an edge or a corner, through each other), since only those can
close a wall: a far outpost does not stretch the search over the country between.

**The empty-land tax.** At midnight (`LandMarket.midnight`, after the day rolls) each owner pays `emptyTax` (2%) of the
current price of every owned dry tile with nothing on it (no road, zone, building, track, structure or tunnel), ledger
line `landtax` "Empty-land tax", a running cost. An empty 16×16 homestead in the wild pays about $7.70 a day; a road and
a zoned row on it take that down tile for tile. The Commons and dev-funded players pay nothing.

**Presence.** `Player.seen` (saved): the tick the player was last connected, set on joining and once a game hour for
every connected player. A save from before M2 starts its clock at the first midnight. The tax pauses once a player has
been away `awayPauseDays` (3).

**Abandoned land.** At midnight, an owner away `abandonEmptyDays` (30) loses every parcel with no building on it (roads
and empty zoned lots at most; nothing being built, no structure, track or tunnel): its zoning is cleared, its roads stay
as public road, adopted (nobody pays, they fade if unused, M3), the tiles are unclaimed again and the owner's treasury is
paid the parcel's current price (`land` line). After `abandonBuiltDays` (60) every other parcel goes to the Commons
(`sys`, when the world has one) at its current land price, buildings and all, unpaid for. 0 turns that off. The owner
is told by a toast if connected (they normally are not).

**Selling back.** The recovery plan's "sell land back" (`sim/finance.ts`) now pays `landBuyback` of the market price on
a shared world (`Finance.landPrice`, set by game.ts), not of $10 a tile: otherwise land bought at $1.50 sold back at $8.

**Measured: the homesteader bot** (`landbot.ts`: bot F's opening, rows and technology choices; homestead against the
Commons' east edge road, later blocks bought row by row; 10 ticks a loop as at SIM_STEPS=10; 120 minutes =
15 game days):

| start | seed | treasury low | Hamlet | Village | residents at 2 h | land bought | empty-land tax |
| --- | --- | --- | --- | --- | --- | --- | --- |
| $3,000 + homestead | 1 | −$399 (min 120) | 67 min | | 478 | $555 | $28 |
| $3,000 + homestead | 2 | −$78 (min 1) | 59 min | | 396 | $196 | $31 |
| $4,000 + homestead | 1 | −$51 (min 77) | 21.5 min | | 532 | $210 | $33 |
| $4,000 + homestead | 2 | −$372 (min 85) | 28 min | 86 min | 520 | $670 | $66 |
| $5,000 + homestead | 1 | −$274 (min 107) | 21.5 min | | 639 | $501 | $37 |
| $5,000 + homestead | 2 | −$191 (min 101) | 28 min | 89 min | 700 | $539 | $44 |
| classic $20,000, $10 a tile | 1 | $574 (min 92) | 27 min | 94 min | 704 | $7,200 | |
| classic $20,000, $10 a tile | 2 | $458 (min 70) | 28 min | 77 min | 797 | $7,200 | |

With $3,000 the bot spends its start in the first minute (the homestead's street and three rows of homes, about $2,500)
and then sits at $250-$900 for about eight game days until taxes and the Hamlet grant let it buy technology: it never
goes into administration (its low points are the overdraft for a block's road, paid back within the hour), but it reaches
Hamlet 30-40 minutes later than a classic start and has about 40% fewer residents at two hours. At $4,000 it keeps
classic's Hamlet time; at $5,000 also its residents. Land itself is cheap (a few hundred dollars against $7,200), and
the empty-land tax on a builder's land is small ($30-70 over 15 days); it bites only on held empty land. `startMoney`
stays at the decided $3,000; $4,000 is the number to try if new players should keep the classic pace.

**Differences from the design.**

- The land value leaves out green and quiet (above); "base × the land value averaged over the rectangle" is a sum of
  per-tile prices on an exponential curve, not a linear multiple, so the spread is wide enough to matter.
- The homestead is the first purchase (up to 16×16, at least 8×8), not a plot handed out at a fixed site: a shared world
  has no single road end to put it at.
- Abandoned built land goes to the Commons rather than to a market: there is no land market until M7. It is a tunable
  hook (`abandonBuiltDays`, 0 = off); buildings, lines and vehicles of the old owner are not otherwise touched, and
  nothing yet tells a returning owner beyond the ledger.
- A free homestead per new account makes new accounts worth something; sign-in (docs/accounts.md) is the guard, and
  abandonment returns unused homesteads after 30 days.
- Self-assessed prices stay held back (decision 4).

## Built: M4 grades, levy and limits (2026-11-11)

Section 5 for the refuse family: five grades as placeable buildings, three add-ons, the landfill levy into a world
regional fund that pays adopted public roads, and boundary limits checked when a site is placed or an add-on taken off.
Code: `shared/src/buildings/refuse.ts` (the kinds), `shared/src/refuse.ts` (grades, add-ons, levy, limits; browser-safe),
`server/src/sim/refuse.ts` (routing, the levy, add-on upkeep, the panel), `server/src/sim/value.ts` (emissions),
`server/src/net.ts` (`boundaryRefusal`, the `refuseAddon` intent), `World.regional` and `World.refuseAddons`. Check:
`npm run refuse:check` (`server/src/refuse-check.ts`).

**Grades.** Placed buildings, not upgrades of a depot: the catalogue already places plants this way (civic sub-kinds
of the transport-hub family, like the power stations), and a grade changes what the building is. Kind ids 217-221, all
2×2, the `refuse` ladder (Services), on the Utilities track: Waste management (`ut4`, tier 1, 30 housed: open tip,
lined landfill), Recycling (`ut5`, tier 2, 150 housed: recycling centre, composting and digester site), Energy from
waste (`ut6`, tier 3, needs Power stations: the plant). Per grade (`REFUSE_GRADES`; money a day at 100 homes, 25 t):

| Grade | Build, upkeep | Takes (homes a day) | Landfilled | Sells | Levy | Net cost a day (with half the staff wages) |
| --- | --- | --- | --- | --- | --- | --- |
| Open tip | $1,500, $12 | 160 | all | nothing | $75 | $164 |
| Lined landfill | $4,500, $30 | 160 | all | landfill gas $0.30/t | $75 | $188 |
| Recycling centre | $6,000, $40 | 140 | 30% residue | materials $1.60/t | $22.50 | $131 |
| Composting and digester | $8,000, $45 | 100 | 20% | gas and compost $2.20/t | $15 | $95 |
| Energy from waste | $14,000, $80 | 200 | 10% ash | power $3.20/t | $57.50 (smoke $50) | $205 |

Emissions per home emptied a day, in M1's value units: the tip smell 0.03, heavy traffic 0.013, noise 0.006, eyesore up
to 0.8 once busy (20 homes); the lined landfill about half the smell and eyesore; the recycling centre little smell but
the most noise; composting the gentlest; energy from waste smoke (0.5 units a tonne, each 0.1 smell and 0.016 hazard)
carried downwind. Nuisance still follows use: `ValueField` feeds a site's smoothed homes a day through
`refuseEmission`, so an idle site gives off nothing. At equal use the tip leaves the least value at its cell (0.38 at 100
homes against 0.44-0.66). Most of a site's staff are bin crews (`MOBILE.siteCrewShare` 0.66) and sweeper drivers.

**Routing.** The rounds (unchanged otherwise) pick, for each district due today, the nearest refuse site in reach with
crews and room for the district's homes today (its capacity, less with restricted hours) before any old depot; a site
with some room left takes what fits and the rest wait a week (counted unserved); only when no site has room does an old
depot take the district. The old hashed depots (a share of industry) still collect where no site reaches, unchanged
and unlevied: they are other players' factories, not a choice their owners made.

**Levy and fund.** Each home a site's lorry empties (`Refuse.tip`) pays `LANDFILL_LEVY`: $3 a tonne landfilled and $4 a
unit of smoke (a home is 0.25 t), from the site's owner (ledger line `levy`, "Landfill levy", running) into
`World.regional.fund`; the grade's sales come back at the same moment (line `recycling`, "Recycling, gas and power
sales", running). At midnight `PublicRoads.regionalFund` (M3's hook) is handed the adopted tiles' upkeep and the fund
pays it as far as it goes; what it cannot cover is nobody's, as before (`World.regional.short`). The fund is saved as
the optional snapshot field `refuse` (with the levied, paid and short totals and the add-ons), and shown in the world
stats line ("regional fund $N", from the `stats` message's `fund`). With the levy, a recycling centre at 100 homes a day
costs $131 a day against the tip's $164; on a trickle (5 homes) the tip is cheaper, $92 against $147.

**Add-ons.** Settings per site, bits in `World.refuseAddons` (by door), set by the `refuseAddon` intent from the building
panel (owner only; anyone's in a sandbox; refused in administration when it costs money): an enclosure ($3,000, $15 a
day: smell x0.4, noise x0.5, eyesore x0.6, smoke x0.4, its scrubbers also cutting the smoke levy), screening ($700, $3 a
day: noise x0.65, eyesore x0.3, smell x0.9) and restricted hours (free: no night working, noise x0.6, lorry traffic
x0.85, and 30% less a day). Upkeep is charged at midnight (`Refuse.newDay`, ledger `upkeep`); taking one off refunds
nothing. A lorry route is not built: the neighbours' own answer, an HGV ban on their streets, already exists.

**Boundary limits.** `boundaryImpact` spreads a site's expected emission at full use (its capacity with its add-ons)
with this world's M1 kernels (round, or the wind rose's plume) over 4×4 cells, and takes the worst of each nuisance
kind over every tile whose owner is not the builder; the builder's own land and unclaimed land are not limited. Limits
(`BOUNDARY_LIMITS`, intensity 0-1, the value byte / 255): noise 40%, smell and smoke 35%, heavy traffic 45%, hazard 20%,
disorder 40%, eyesore 40%. `net.ts placeStructure` refuses a site over a limit with the reason ("The open tip would push
97% smell and smoke (and heavy traffic) onto Bob's land at full use; the limit at a boundary is 35%. Choose a cleaner
grade, add screening or an enclosure, or build further back"); an add-on change that raises any kind and leaves it over
a limit is refused the same way (so land a neighbour bought since cannot be made worse, but a site built first is not
closed). The client's ghost runs the same function on the loaded parcels: red with the reason, or the worst kind
against its limit on the status line; a site's panel lists its impact per kind and whose land. Sandboxes have no limits.
In the check's world (seed 4242), with a neighbour on every side, a tip needs 35-40 tiles between its door and the
neighbour's land (the plume's direction; less upwind), a lined landfill and an energy-from-waste plant about 30 (an
enclosed plant about 20), while a recycling centre or a composting site may stand beside the boundary.

**Measured.** refuse:check: all pass (grades' order, add-ons lower every grade, the money, the placements, add-on
costs and refusals, the levy into the fund, the fund paying roads, routing, the value field (smell 0.20 at a tip against
0.08 at a composting site after 40 homes each), the save round trip). `loadtest/mobile.ts --grade recycling` (2×2
districts; every old depot made a recycling centre): 67 and 59 homes emptied on two weekdays, 16.75 and 14.75 t handled,
levy $15.07 and $13.28 into the fund, $26.80 and $23.60 of materials sold; the sim's ms per tick as without
(5.2/4.6 against 5.0/4.7).

**Differences from the design.**

- Only refuse has grades; other nuisance buildings (works, plants, venues) are not limited yet, and industry grows
  rather than being placed. The limit is the builder's own contribution at full use, not the long-run total at the
  boundary with everyone else's.
- Restricted hours cut noise and throughput as a factor: the rounds already run in the day, so "no night activity" is
  modelled, not simulated hour by hour.
- Energy from waste sells power as a ledger line; it does not feed the utilities network.
- Scrubbers are the enclosure add-on on the energy-from-waste plant, not a separate fitting.
- The client checks limits against the parcels it has loaded; the server's check is the one that counts.

## Built: M7 land market (2026-11-11)

Section 7 "Land": listings and offers, covenants, leases and neighbour pacts, in **every world** (classic and market
worlds alike; a sandbox drops the purchase rules on transfer; a showcase refuses the intents as it refuses every other).
Code: `shared/src/landdeals.ts` (types, `LAND_DEALS` tuning, the covenant and strip rules; browser-safe),
`server/src/sim/landdeals.ts` (`LandDeals`, one per game: the state, the intents, transfers, rent and the midnight),
`server/src/net.ts` (the `land` intent, the `deals` message, the build and placement hooks), `World.landLocked` and
`Parcel.cov` in `world.ts`, the snapshot field `landDeals`, the client's `client/src/landmarket.ts` (in `mapmode.ts`).
Check: `npm run market:check` (`server/src/market-check.ts`).

**Wire.**

```
client  { t: 'land', op: 'list', id, price, estate?, cov? }    list a parcel (or its whole estate) with covenants
        { t: 'land', op: 'unlist', listing }
        { t: 'land', op: 'offer', listing, amount }            at or above the asking price it is a purchase
        { t: 'land', op: 'buy', listing }                       at the asking price, at once
        { t: 'land', op: 'accept' | 'reject' | 'withdraw', offer }
        { t: 'land', op: 'lease', id, rent, days, tenant? }     tenant: a player's name; absent: anyone may take it
        { t: 'land', op: 'leaseAccept' | 'leaseCancel', lease }
        { t: 'land', op: 'pact', pa, pb, strip }                pa yours, pb the neighbour's, strip a rectangle on the two
        { t: 'land', op: 'pactAccept' | 'pactEnd', pact }        pactEnd: withdraw or decline a proposal, or give notice
server  { t: 'deals', listings, offers, leaseOffers, leases, pacts }
```

The `deals` message goes to each client on joining and whenever anything changed; listings, lease offers, leases and
pacts are public, offers go only to their buyer and the seller. `ParcelDTO.cov` carries a parcel's covenants. Results
are toasts; the other party hears by toast (`LandDeals.notices`).

**Listings and offers.** The holder of a parcel (its owner, or its landlord while it is leased) lists it, or its whole
estate, at an asking price, for `LAND_DEALS.listingDays` (7). Anyone else may buy at the asking price at once, or offer
less (one offer per buyer per listing, the latest standing); the seller accepts or rejects; the buyer may withdraw.
**Money is checked, not held**: an offer must be within the buyer's spendable money (treasury plus the overdraft line)
when it is made and again when it is accepted; an offer the buyer can no longer pay is dropped with the reason to both.
Escrow would freeze money across days for offers most of which are refused, and would need its own ledger state; the
check at acceptance is the same guarantee for the seller. Buyers in administration cannot buy or offer. A listing whose
land changed (split, merged, its holder changed: checked every 25 ticks and at each use) is withdrawn and its bidders told;
to sell a piece the seller splits first and lists the piece (the panel says so).

**A transfer** sets `Parcel.owner` to the buyer (or, for leased land, the lease's landlord: the tenant stays), recounts
the roads, and calls `onTransfer` (game.ts: `utilities.invalidate()`, so the reach field is rebuilt with the new
owner). Everything else follows because every system reads the owner from the parcel: building rights, taxes, road and
building upkeep, utility networks and bills, refuse routing, the empty-land tax; residents, jobs, sites and buildings stay
as they are. A parcel sold out of an estate leaves it; a whole estate keeps its group. The buyer pays `land` ("Land"),
the seller is paid `landsale` ("Land sales", a new one-off ledger line); both are toasted. Other offers lapse, and open
lease offers on the land are dropped.

**The rules a sale keeps for the buyer.** *No walling in*: each parcel goes through `checkPurchase` as if the buyer were
buying it (earlier parcels of the same sale count as theirs), so a sale that closes a ring round someone's land, or a
pocket of more than four unclaimed tiles, is refused ("That sale would cut off Eve's parcel"). *Outposts* on a market
world: a sale touching none of the buyer's land must be at least 8×8, as an outpost purchase (a first plot too). *Must
share an edge* (classic worlds) does **not** apply: it paces buying unclaimed land, and a sale is an agreement between
two players. Leased parcels skip the walling check (their occupier does not change). `LandDeals.canTransfer(q)` is the
hook for planning (M5): a parcel under an open application cannot be listed, leased or transferred while it says why.

**Covenants** (`Parcel.cov`): set by the seller at listing, put on the land at the sale, binding every later owner;
never lifted. A resale without one keeps it; a split copies it to both parts; a merge keeps the strictest of each
(`joinCovenants`). A listing whose land already breaks its covenant is refused, naming what breaks it.

| Covenant | Refused |
| --- | --- |
| no heavy industry (`noHeavy`) | industrial zoning, refuse sites, polluting power stations, the airport (`isHeavyNuisanceKind`) |
| stays a park (`park`) | every zone and building that is not a park (`isParkKind`), parking lots and bus stops; roads are allowed |
| no building over N levels (`maxLevel`) | growth past level N (`LandDeals.mayGrow`, chained before the power gate in game.ts) |

Zoning and one-tile buildings are checked per tile in `net.ts build` (`buildRefusal`); structures over their whole
footprint in `placeStructure` (`placeRefusal`, before the M4 boundary limit). The parcel panel lists the covenants and
the hover line names them. Price impact is left to the market, as decided.

**Leases.** The holder offers a lease (rent a day, a term of 1-60 days, to a named player or anyone); a tenant takes
it (not in administration, with a day's rent spendable). For the term **the tenant is `Parcel.owner`**: they build,
zone and collect taxes as owner and pay its upkeep and empty-land tax; the landlord is kept on the lease. Each midnight
the tenant pays the rent to the landlord (`rent`, "Land rent", a running line on both ledgers). At the end of the term
the land goes back to the landlord **with whatever is on it** (the simpler of the design's two rules: no book-value
buy-out; a tenant builds knowing the term). A tenant in administration at midnight has missed the rent: the lease ends
there and then, the land back to the landlord. While a lease runs the parcel is locked (`World.landLocked`): no split,
combine, recovery-plan sell-back or abandonment; a leased member leaves its estate when the lease starts. The landlord
may sell the freehold: the lease goes with it (the buyer becomes the landlord on the same terms, the tenant is told);
the tenant cannot sell.

**Neighbour pacts.** Two holders of edge-adjacent parcels agree a buffer strip, a rectangle lying on the two parcels
(the client offers a band along the shared edge, 1-8 tiles each side). The proposer's neighbour accepts or declines;
proposals lapse after 7 days. While it is in force nobody may zone industry or place a heavy nuisance building with
any tile in the strip (`stripRefusal`, the same kinds as the covenant). **No money** changes hands (the design's "share
its cost" is kept to nothing: a split of the strip's empty-land tax would only matter on a market world and the strip
is usually built on). Either side may give notice; the pact ends `pactNoticeDays` (3) midnights later. A pact binds the
land: it survives a sale (its parties are whoever holds the two parcels), and goes if either parcel is merged away.

**Client.** The world map's parcel panel (`mapmode.ts` with `landmarket.ts`) gains a Land market block: covenants, the
lease, pacts with Accept, Decline and Give notice; for sale with Buy, an offer field and Withdraw offer; for the seller
its offers with Accept and Reject and Withdraw listing; a **Sell…** section (asking price, defaulting to the book value,
the whole estate, the three covenants) and a **Lease out…** section (rent, term, tenant). Picking one of your parcels
and a neighbour's shows a Neighbour pact block. The market box at the bottom left has a **For sale (N)** toggle for the
layer (listed land tinted by price a tile: under $2, $2-5, $5-15, over $15, with a legend), the listings cheapest a tile
first (a click selects the land), and **Your deals**: offers received and made, leases offered to you, pacts proposed
to you, each with its buttons. The panel's open sections and typed values survive its redraws.

**Persistence.** `Snapshot.landDeals` (optional; `LandDealsSave`: the next id, listings with their land signature,
offers, lease offers, leases, pacts), absent while there are none; covenants ride on the saved parcels. Saves from
before M7 load with an empty market.

**Measured.** market:check, all pass: list → offer → accept moves the parcel, its house and street (Bob pays their
upkeep) and the money on both ledgers; an offer past spendable money is refused; buy-now; a listing is up after 6 days
and lapses after 7 with its offers, both sides told; splitting listed land withdraws the listing; a "no heavy industry"
covenant refuses industrial zoning and a tip for the buyer and still binds after a resale without it; a park covenant
on zoned land is refused at listing, and on park land homes are refused while a park and roads are fine; a level cap
holds growth at the growth gate; a lease (tenant zones, landlord cannot, split refused, rent $50 a day both sides, the
freehold sold with the lease, the land back with the tenant's zoning at the end); missed rent in administration ends a
lease; a pact refuses industry and a tip in the strip on the proposer's own side, allows them outside, holds through the
notice and ends after it; walling in refused on transfer; on a market world a 4×4 far sale is refused as an outpost; the
snapshot round trip (market, covenants, tenant, the lock) and an older save; a showcase refuses. typecheck, build,
parcels:check, land:check, finance:check, roadrules:check and refuse:check pass.

**Differences from the design.**

- Covenants can only be set when listing (the design's "set by the seller"); there is no way to put one on your own
  land without selling it, and none is ever lifted. The level cap applies to growth; placed buildings have no levels
  to cap.
- Leases return the land with its buildings, never the book-value buy-out; there is no early surrender.
- Pacts share no cost; the strip is a rectangle on the two parcels, offered by the client as a band along the edge.
- Transfers are between players only: no auction, no regional buyer, no self-assessed prices (decision 4 stays held back).

## Built: M5 planning (2026-11-11)

Section 6's notices, the frozen roll, the vote, conditions, the community offer, refusal and cooling-off, and M3's
closure notices. Code: `shared/src/planning.ts` (`PLANNING` tuning, the source list, `planImpact`, `withPlan`, the DTO;
browser-safe), `server/src/sim/planning.ts` (`Planning`, one per game, made by `game.ts` and ticked with the systems),
the hooks in `server/src/net.ts` (`placeStructure`, `refuseAddon`, the bulldozer, `planningAct`, `closureNotice`),
`News.planning` (`sim/news.ts`, story kind `planning`), `PublicRoads.dependents`, the client's `planning.ts` (panel and
chip) and `render/planningSigns.ts` (site markers). Check: `npm run planning:check` (`server/src/planning-check.ts`).

**Where it applies.** Votes on nuisance builds run on a shared world: `GameConfig.planning`, which defaults to `market`
(M2) and is never on in a sandbox or a showcase. Closure notices work wherever M3's road protection does (any world but a
sandbox), since that is where a protected road can block someone.

**What needs planning.** `PLANNING_SOURCES` lists the nuisance buildings with their emission at full use, their jobs and
the add-ons they may take as conditions: the five refuse grades for now; industry kinds, plants and late venues join the
list once they are placed buildings with a full-use emission. `planImpact` spreads that emission with the world's M1
kernels (as M4's `boundaryImpact`) and keeps (a) the impact zone, every 4×4 cell where some nuisance reaches `zoneMin`
(4%) whoever owns it, and (b) the worst of each kind on land of owners other than the builder. A build is filed for
planning when some kind on others' land is over `threshold` (0.4) × its boundary limit while none is over the limit (over
a limit it is still refused outright, M4). Impact only on the builder's own or unclaimed land needs no vote. On the
check's world (seed 4242) a tip is over the limit within about 30 tiles of a neighbour downwind, goes to planning at 36-42
tiles and is free beyond about 45; a composting site needs planning within about 16 tiles; a recycling centre with
screening only right at the boundary. Taking a refuse site's add-on off (`refuseAddon`) that raises an over-threshold
kind on others' land is filed the same way (kind `addon`); on approval the add-on comes off.

**The application.** The click files instead of placing: the building's cost and its conditions' cost (as `build`) and
the community offer (as the new ledger line `planning`, "Planning offers") are taken at filing and held, so a player
cannot file more than they can pay for. The site's footprint is reserved (nothing else may be built or zoned on it until
the vote); the client draws a notice board at the door and pegs out the footprint. Each affected mayor gets a toast
("Planning notice: Ada plans an open tip near your land (smell and smoke up to 27%). 38 residents vote at the end of a
game day"), the applicant is told what is held, and the news runs a `planFiled` story. The notice is `noticeTicks`, one
game day. The roll is frozen at filing as an id array: every resident who is not a child and not migrating whose home is
in the impact zone, of every owner (the applicant's own residents included). A build may carry conditions and an offer
from the start (`build` message `plan: { conditions, offer }`); conditions also count for the boundary-limit check, so a
landfill over the limit bare may be filed with an enclosure.

**During the notice.** The applicant may amend (`planningAct` `amend`): add conditions or raise the offer; the extra is
taken and held, the true impact is recomputed, the roll stays as it was. They may withdraw (everything back, no
cooling-off). Nothing else changes the vote; campaigns on plans are M6.

**The vote** (`Planning.vote`, at the end of the notice), for each voter still in town:

- own impact: `impactGain` (4) × ln(value after / value before) at their home's cell, with their household's weights
  (`Motivation.weightsOf` → `valueWeights` → `combineValue`, M1); "after" adds the plan's intensities at full use to the
  cell's bytes the way the field combines nuisances (1 − (1 − a)(1 − b)), quiet falling with the new noise and traffic;
- belief: `beliefGain` × a belief in −1..1 kept per application per voter (`Planning.believe`, the `plan` belief target,
  `BeliefTarget.Plan` in shared; plumbing for M6, nothing sets it yet), plus word of mouth: `wordOfMouth` (0.3) × the mean
  own impact of the voter's friends on the roll;
- the offer: `offerGain` (0.8) × sat(offer per household on the roll / $150), bent by the household's Money weight as
  happiness bends (0.6-1.6);
- jobs: `jobsGain` (0.25) × min(1, the building's staff / households on the roll), in full for a household with someone
  out of work, 40% otherwise;
- a hashed ±0.03 so a vote is not a cliff.

Turnout is `turnoutBase` (0.15) + `turnoutGain` (1.2) × |lean|, × `lossAversion` (1.8) for opponents, at most 95%; whether
a voter votes is a hash of their id and the application's id, so the same world gives the same result. More yes than no
among those voting approves; nobody voting (an empty roll) approves.

**Outcomes.**

- *Approved:* placed as a build would be (re-planned on the same door and facing; a site no longer clear lapses with a
  full refund), its conditions fitted as refuse add-ons and kept in `Planning.locks`: `refuseAddon` refuses to take a
  condition off ("a condition of the planning approval"). The offer is paid to the affected owners, split by their
  residents on the roll (evenly when none). The news runs `planApproved`.
- *Refused:* everything held comes back; the applicant may not file anything that needs planning within `nearTiles` (8)
  of the door for `coolTicks` (2 game days), and until `rememberTicks` (10 days) only a design whose impact score (the sum
  over kinds of worst / limit on others' land) is under `changedBy` (90%) of the refused one: a cleaner grade, add-ons or
  more distance. Screening on a tip is not enough; a lined landfill with an enclosure (0.16 against the tip's 0.78) is. A
  build under the threshold (a composting site at the same door) needs no vote at all. The news runs `planRefused`.
- Everyone involved gets a toast with the count ("Refused: 0 for, 21 against, 21 of 38 voting"). Decided applications
  stay in the list and on the panel for `showDecidedTicks` (6 game hours).

**Road closure notices.** A bulldoze refused by M3's protection now also sends the client a `closureOffer` with the
public road tiles; the client asks "Give a closure notice instead?" and sends `closureNotice`. The mayors who depend on
the road (`PublicRoads.dependents`: whom it would cut off, and whose traffic used it in the adoption window) get a toast
and may `object` in the panel within the notice. An objection stops it at once, and the closer may not give notice on
those tiles again for `coolTicks`; silence lets it through: at the end of the notice the tiles still public road are taken
up (a bridge deck takes its span).

**Client.** A "Planning · n" chip shows while an open application is the player's or reaches their land (or their road)
and opens the panel: each application's site (a link), who filed it, the voters on the roll, its impact on others' land
per kind against the limit, time left, conditions, offer and, once decided, the result; the applicant's buttons add a
condition (with its cost), raise the offer or withdraw; an affected mayor's button objects to a closure. Placing a refuse
site whose ghost passes the limits says "goes to planning: residents near Bob vote over a game day" on the status line.
The welcome is unchanged: the `planning` message says whether votes are on (`votes`).

**Persistence.** The optional snapshot field `planning`: applications (with their rolls, conditions, offers, held money,
beliefs and results), refused designs and conditions of approved sites. Impact zones are recomputed on load. A save
without it loads with none, and a world with nothing to keep saves without the field.

**Measured.** planning:check, all pass: a tip 36 tiles from Bob's land (smell 27% against a limit of 35%) is filed, not
placed, $1,500 held, 38 residents of Bob and Cy on the roll; 21 of them vote, all against; refunded in full; refiling at
once is refused (cooling-off), unchanged after it too; a composting site at the same door is placed at once. A lined
landfill 24 tiles off is over the limit bare (score 1.03), filed with an enclosure (0.47) and amended with screening
(0.42): approved, placed with both fitted, and the screening cannot come off. A recycling centre 10 tiles off: without an
offer 0 for, 22 against; with $1,000 (raised during the notice) 9 for, 3 against: approved, Bob paid $818 and Cy $182. A
tip in the middle of a 100×100 outpost is placed with no vote. A home built during a notice is not on its roll. The same
scene votes identically voter by voter. A save round trip keeps an open application's roll, end and offer, the
conditions and the refused design. Closure: Bob objects and the road stays (and Ada cannot give notice again at once);
after the cooling-off nobody objects and a game day later the two tiles are gone. Cost: filing walks the citizens once
(the roll) and spreads one kernel; the vote walks the roll; per tick only the open applications' end ticks are looked at.
refuse:check, value:check, roadrules:check, land:check and finance:check still pass; the motivation loadtest passes 29 of
29.

**Differences from the design.**

- Only the refuse grades need planning; industry still grows from zoning, so it has no full-use emission to judge.
- The community offer is cash only (no park commitment, cheaper service or shorter hours as a promise); shorter hours
  and screening are conditions instead. The offer is paid on approval and refunded with the rest on refusal.
- Money is held at filing rather than charged on approval: a refused or withdrawn plan costs nothing but time.
- Beliefs about a plan are a per-application map on the server, not motivation's general belief store (which is not
  built yet); word of mouth is computed at the vote from friends on the roll, not spread day by day.
- An empty roll approves: a nuisance near a neighbour's land with nobody living in the zone needs no residents' consent
  (the boundary limits still apply). Owners have no vote of their own on building plans; they object only to closures.
- Conditions are only ever added during a notice; the impact may fall below the threshold meanwhile, and the plan still
  goes to its vote.
- A closure objection decides the notice at once rather than at its end; the closure marker tints only its first tile.
- The site is reserved against building and zoning; a road laid over it meanwhile makes the approved plan lapse (refunded).

## Built: M8 service contracts (2026-11-11)

Section 7 "Services" for **refuse and power**, in every world (as M7; a showcase refuses the intents). Water waits for
the water network (docs/utilities.md U3): `ServiceId` and `regionalPrice` take it then. Code: `shared/src/contracts.ts`
(types, `CONTRACTS` tuning, `regionalPrice`; browser-safe), `server/src/sim/contracts.ts` (`Contracts`, one per game:
tariffs, contracts, reach, billing, the midnight, the cut-off rule, the save), hooks in `server/src/sim/utilities.ts`
(`Utilities.contracts`, `PowerContracts`; `UtilEnv.access` in `shared/src/utilities.ts`), `server/src/sim/refuse.ts`
(`Refuse.contracts`, `RefuseContracts`), `server/src/net.ts` (the `svc` intent, the `services` and `svcQuotes` messages,
the bulldozer), the ledger lines `contracts` and `services` (`protocol.ts`), the snapshot field `contracts`, and the
client's `client/src/services.ts` (in `mapmode.ts`; `client/src/utilities.ts` follows power contracts in its reach).
Check: `npm run contracts:check` (`server/src/contracts-check.ts`).

**Wire.**

```
client  { t: 'svc', op: 'tariff', service, price }            post or change a tariff; price null withdraws it
        { t: 'svc', op: 'sign', id, service, provider, days, estate? }
        { t: 'svc', op: 'notice', contract }                   either party
        { t: 'svc', op: 'quote', id }                          the providers that could serve parcel id
server  { t: 'services', tariffs, contracts, regional }        tariffs public, contracts to their two parties
        { t: 'svcQuotes', id, quotes: [{ provider, service, price, reach, why? }] }
```

**Tariffs and the regional cap.** A provider posts one price per service: refuse **a home a day**, power **a unit**. It
needs something to serve from (a refuse site of its own; a substation or grid supply point). No tariff may be above the
regional reference price; a higher one is refused with the cap in the reason:

| Service | Regional supplier | Reference price |
| --- | --- | --- |
| refuse | the old waste depots (a hashed share of industry), at their fee of `REFUSE.feePerHome` ($0.60) a weekly collection | $0.60 / 7 ≈ $0.086 a home a day |
| power | grid import through the buyer's own substation | `UTIL.importPrice`, $0.06 a unit |

Tariffs are public (every client has them; a neighbour's parcel panel shows its owner's). Changing or withdrawing one
leaves running contracts at the price they were signed at.

**Contracts.** The owner of a parcel (a tenant counts: they are `Parcel.owner`) signs it, or its whole estate, up with a
provider that has a tariff posted and **reaches** the land, for `CONTRACTS.minDays`-`maxDays` (3-60) days, at the posted
price fixed for the term. Reach: refuse, one of the provider's sites within the rounds' reach (`REFUSE.reach`, 40) of
the land; power, one of the provider's substations whose reach, allowed onto these parcels' roads, takes in a road on
them (the same `utilityReach`). One contract per service per parcel; not in administration; at most 40 running per
buyer. No acceptance step: a posted tariff is an offer to anyone in reach. Either side gives **3 days' notice**
(`CONTRACTS.noticeDays`): the contract ends at the third midnight (or at its term, if sooner), both are told, and the
service falls back to the regional supplier. A contract **binds the land** (as M7's pacts): sold, it carries on with the
new owner (told by toast); parcels gone or now the provider's leave it; with none left it ends.

**Access to the buyer's roads, that service only.**

- *Power.* `UtilEnv.access(owner, x, y)` is the one exception to section 3.1 of docs/utilities.md: the provider's reach
  may walk roads on parcels under a power contract with it (and on to public roads beyond, never onto a third player's).
  `Utilities.serve` gives a building on such a parcel the provider's nearest node where it reaches, else its owner's own;
  the growth gate (`supplied`) follows. The field is rebuilt when a power contract starts or ends.
- *Refuse.* A player's refuse site now collects only its owner's homes and the Commons' or unowned homes, **unless** a
  refuse contract sends a neighbour's homes to it; the old depots (the regional service) and sites on public or Commons
  land collect anyone's, as before. The rounds plan each district's due homes by who may collect them (`collectorAt`:
  the contract's provider, else the owner) and pick each group's depot (`depotsNear(..., who)`); a contracted group
  takes the provider's site with room before anything else and falls back to the regional depots. The lorry already
  drove any street; what changes is whose site's round the buyer's homes are on. Sweepers are unchanged (by district).

**Billing, hourly.** Refuse at tick `CONTRACTS.billAt` (47) of each game hour: the contract's price / 24 for every built
home on its parcels. Power at the utilities' solve (tick 41): the units the provider's network supplied to the buyer's
buildings that hour, at the contract's price; units not supplied are not billed. The buyer pays `services` ("Services
bought from neighbours"), the provider is paid `contracts` ("Service contracts sold"), both running lines. For power the
buyer still collects its residents' bills (`bills`) as before, so at the default tariff it keeps the margin between
$0.06 and the contract price; the provider pays the fuel or import for what it supplies. A home its provider's lorry
empties pays no per-collection fee (the contract covers it).

**Nobody cuts a service mid-contract** (two enforcements):

1. *Refused:* while refuse contracts run, the provider may not bulldoze its **last** refuse site; while a power contract
   runs, it may not bulldoze a substation that served contracted buildings at the last solve (`Contracts.cutRefusal`,
   in `net.ts`'s bulldozer, with the reason and "give notice first"). Refuse sites and substations cannot be mothballed
   (the recovery plan mothballs only staffed services and yards), so the bulldozer is the only switch.
2. *The provider pays the fallback:* when service lapses anyway (its sites full or unstaffed, a fault), the buyer does
   not pay for it: power is billed only for units supplied, and a contracted home the regional depots had to empty has
   its $0.60 fee paid by the provider, not the buyer (`Refuse.arrive`).

**Client.** The world map's parcel panel gains a **Services** block (`services.ts`): contracts on the parcel (provider or
buyer, price, until when, paid so far, **Give notice**); on your own parcel, for each service without a contract, the
regional price and each provider's quote (asked for on selecting the parcel, `svcQuotes`) with how far under the
regional price it is and **Sign** (or why it does not reach), a term field and "the whole estate"; and **Your tariffs…**
(a price per service, at most the regional one; Post, Change, Withdraw). The market box lists your running contracts
with Give notice. The power overlay follows the power contracts its player is a party to.

**Persistence.** `Snapshot.contracts` (optional; `ContractsSave`: the next id, tariffs, contracts with their price, term,
notice and paid total), absent while there are none. Saves from before M8 load with none. `UtilitiesSave.contracts`, the
U9 hook, stays empty.

**Measured.** contracts:check, all 47 pass: a refuse tariff with no site, and both services above the regional price,
refused; tariffs seen by every neighbour; before a contract Bob's homes go to Cy's old depot, not Ada's composting site
next door; quotes in reach; short terms and other people's land refused; signed, the round is Ada's site's with all four
kerb stops on Bob's street, the lift costs Bob no fee, and the regional depot emptying them charges Ada $0.60; an hour's
bill 4 × $0.07 / 24 = $0.0117 on both ledgers, and the game bills it hourly by itself; the price held at $0.07 when Ada
drops her tariff to $0.02 and raises it to $0.085; her only site cannot be bulldozed; a refuse contract leaves Bob's
homes without power, a power contract puts Ada's reach on his street (to (58, 10)) but never on Cy's beyond, his homes
supplied and billed 0.34 units × $0.05, he still collects his residents' bills, refuse still goes by the refuse
contract; the substation serving him cannot be bulldozed; notice from either side holds two midnights and ends at the
third, the power reach off his street and his bins back at the regional depot, the substation free to go; a snapshot
round trip and a save without the field. typecheck (with local:check), build, refuse:check, finance:check,
market:check, planning:check and value:check pass; the utilities probe (`loadtest/utilities.ts`) 59/59;
`loadtest/mobile.ts --grade recycling` (2×2, seed 1) empties 67 and 59 homes on its two weekdays, as before M8 (the test
city is the Commons', so no player's site is restricted), at 4.7 and 4.3 ms a tick.

**Differences from the design.**

- Water has no network yet, so no water contracts; gas likewise. Tenders ("refuse collection for 400 homes for 10
  days", providers bid) are later: a contract is signed at a posted price, with no acceptance step and no capacity cap
  (a provider with too many signed homes fills its sites and pays the regional fee for the overflow).
- The refuse reference price is the old depots' fee spread over a week ($0.086 a home a day). It is honest about what a
  buyer's fallback costs, but low against a site's running cost (M4: about $1-2 a home a day), so refuse contracts are
  about neighbourliness and nuisance more than profit until that fee is retuned.
- For power the regional fallback is grid import through the buyer's own substation: a buyer with none has no power
  after a contract ends (its buildings stay at level 1, as before power).
- "Access to the buyer's roads" for refuse vehicles changes whose round the homes are on; lorries already drove every
  street. Trunk links still may not cross another player's land.
- The cut-off rule covers bulldozing; selling the land under a site, or letting its staff go, is covered by the provider
  paying the fallback instead.

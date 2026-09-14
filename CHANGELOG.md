# Changelog

## 6.0.1

No code change. `repository.url` names the `pulseindex` organisation, which is
where this repository now lives.

It matters for two reasons that pull in opposite directions and are both
satisfied for the first time here. npm provenance refuses a publish whose
`package.json` does not name the repository the workflow ran in. And the
engine's disclosure guard refuses a published archive containing the old
owner's personal account name, which that field was the only place it appeared
in — so the guard had failed every run since 2026-09-07, including the one that
published 6.0.0.

Versions up to 6.0.0 keep naming the old account in their signed attestations.
Those are immutable, in a public transparency log. This is the first release
where the shipped package and the attestation both name the organisation.

## 6.0.0

Engine unchanged: this still needs v2.0.0 or later, and nothing on the wire
moved. The major is for two signatures, below.

### A position given as `points` is indexed with no geo tag — fixed

`points` is the shape this README leads with, and the shape that makes a radius
exact. Only a top-level `lat` / `lng` pair emitted the `geo:5` / `geo:6` covering
tags, and `withinRadius` is a SHOULD over exactly those tags — so a record
indexed the documented way matched **nothing**. Verified against a live engine
with 216 positioned records: `within('where', ...)` found the 108 inside the
circle and `withinRadius({ ..., field: 'where' })` found **0**, neither with an
error. An empty page, silently, which is the family this SDK has now produced
four times.

Every position in `points` is tagged now, each one of several, and a position
sent in both shapes is tagged once rather than twice. You do not send a position
twice in two shapes any more; the READMEs stop telling you to.

### `indexEntity()` takes `points` — **breaking**

It is documented as the PHP client's signature in the PHP client's order, and it
was not: PHP takes `(id, categories, numbers, points, tenantId)` and this took
`(id, categories, numbers, tenantId)`. A fourth positional argument that was a
tenant is now a points map. `index()` is unaffected and is the call to prefer.

### A fractional range bound is refused rather than moved — **breaking**

`range()` floored both bounds. Flooring is wrong in opposite directions — a
minimum of `4.3` became `4.0` and widened the range, a maximum of `4.9` became
`4.0` and narrowed it — and neither said so, so the page came back looking
complete. It throws now, the same way a fraction in `numbers` is refused at index
time. Scale the number yourself: a price in cents, a rating out of 100.

### The README was still describing 4.x in four places

Verified against the source rather than re-read:

- `indexEntity()` was documented as `(id, categories, price, locationPrefix,
  tenant)`. Three releases out of date, and the signature above fixes the rest.
- The QueryBuilder table listed `location(prefix)`, a method that no longer
  exists, and described `range()` as "currently `price`".
- The geohash precision table said **precision 4 above 8 km**. That is the bug
  5.0.0 fixed: nothing is indexed at precision 4, so every radius above 8 km
  matched nothing at all. The table now states the real rule, with measured
  cell counts, and says a circle too large to cover is refused rather than
  half-covered.
- `SearchResponse` was missing `totalIsExact`, and the RPC table was missing
  `BatchDeleteEntities`.

`within()`, `nearest()`, `exactTotal()` and the sort methods are in the table
now. They shipped in 5.0.0 and were never listed.

## 5.0.1

### The README was documenting 4.x

Every indexing example showed a bare `price: 250000`, which 5.0.0 turns into
the tag `price:250000` rather than a number, so a range on it would find
nothing. Corrected, along with the claim that `price` and `locationPrefix` are
reserved keys — they are not, and the engine has no field of its own for
either.

Added what 5.0.0 shipped and the README never mentioned: passing `field` to
`withinRadius` so the circle is measured rather than approximated, `nearest()`,
`searchWithTotal()`, and that a fraction in `numbers` is refused rather than
rounded.

No code changed.

## 5.0.0

Needs a PulseIndex engine at v2.0.0 or later. The wire contract is a
breaking change: an SDK at 4.x cannot talk to a v2 engine, and this cannot
talk to a v1 one.

### A radius that means what it says, and "the nearest K"

A circle used to be a union of geohash cells, and a union of cells is a superset
of the circle. Measured against a million entities, a 1 km search returned
**2,479** rows where **1,241** were really inside — and nothing in the answer
said which. You hydrated all 2,479 from your own store and measured them again.

Send a position with the record and the engine settles the edge itself:

    points: { where: { lat: 41.0369, lon: 28.9850 } }

Then `withinRadius({ ..., field: 'where' })` narrows on the cells and measures
the true distance, or `within('where', lat, lon, km)` measures without them.
Degrees go on the wire and the engine packs them: a representation split between
this package and the engine, with nothing comparing the two, is how the geo
defects in 4.0.0 happened.

`nearest('where', lat, lon)` orders by distance, nearest first. That was not a
question you could ask before at any price. It needs no radius guessed to make
it quick, and combines with every other filter, so "the closest ten available
drivers with room" is one request.

Ordering is to the centimetre, which is the precision a stored position has.


### The result count now says whether it is the whole count

A paged search stops as soon as the page is full, so the `totalMatches` it
carried was only what the engine had reached by then. Nothing said so, and it
does not look partial: measured on 500,000 records that all matched, a page of
20 reported **65,536**; a harder query reported **48,105** against a true total
of **333,895**. Any interface printing "N results" from that was wrong by
several times over and looked fine.

`totalIsExact` now comes from the engine instead of being guessed from
`limit === 0`, and `searchWithTotal()` is **one request instead of two** — the
wire can ask for a page and a true count together. A page whose matches all fit
inside it is reported exact, which the old guess got wrong.


### A record carries whatever numbers you name, and no field the engine chose

An entity used to be forced through one `uint32` called `price` and one `uint64`
bitfield called `locationPrefix`. That is a schema this SDK had no business
imposing: one number per record, under a name we picked, with no negatives, and
nothing above 4,294,967,295. A rating, a capacity, a timestamp, an elevation and
a balance were all the same field or no field at all.

Both are gone. A record now carries `numbers`, under your own names:

    client.index('1001', {
      categories: ['feature:pool'],
      numbers: { price_cents: 45000, bedrooms: 3, built_at: 1712000000 },
    })

Any name, any 64-bit integer, any number of them, and every one is filterable
through `range()` and orderable through `sortBy()`. A name means nothing to the
engine beyond its hash.

### Three things this fixes that were losing data quietly

**A fraction was floored without a word.** `4.3` was sent as `4`, `0.5` as `0`,
`199.99` as `199` — measured, not inferred. The engine's column is a 64-bit
integer, so a fraction is refused now, with the scaling it needs named. Keep the
scale on your side: a price in cents, a rating out of 100.

**A field of your own called `price` disappeared.** Sixteen key names were
reserved out of your attributes, and anything under one was dropped: measured,
`{price: 250, rating: 4.3, lat: 41, kind: 'villa'}` came out as
`["rating:4.3", "kind:villa"]` — `price` and `lat` gone, no error. Numbers go
through `numbers` now, so nothing in your own object is swallowed.

**A range or an order on a field nothing carries was answered, not refused.**
It excluded every entity, or left the page in insertion order and reported it as
sorted. At ten million records `bedrooms 3..6` returned 0 while the tag
`bedrooms:3` returned 1,666,667. The engine refuses it by name now — but only
when the tenant holds entities and none of them carries that field, because an
empty tenant has nothing to be wrong about.

### Migrating

- `index(id, {price: N})` → `index(id, {numbers: {price: N}})`. A top-level
  `price` is no longer special; it becomes the tag `price:N` like any other
  scalar attribute.
- `indexEntity(id, categories, price, locationPrefix, tenantId)` →
  `indexEntity(id, categories, numbers, tenantId)`.
- `.location(prefix)` on the query builder is gone. Nothing ever sent it: both
  SDKs passed 0 on every request.
- A range bound may now be negative or past 4,294,967,295.

This needs an engine built from the same commit. The proto is a breaking change:
field numbers 2 and 3 on `IndexEntityRequest`, and 1 on `SearchQueryRequest`, are
reserved rather than reused.

## 4.0.1

### The covering threshold, corrected against a real app

`withinRadius` is a pre-filter the caller narrows exactly afterwards, so excess
area is cheaper than predicates. 4.0.0's threshold was too strict: it rejected
the coarse cell at 5 km, turning a 10-cell covering into 167. Measured through
the sibling PHP SDK against a real application with 100,000 properties, a 5 km
radius went from 3,082 µs to 926 µs on wall time — the cost is the request, not
the search.

The coarse cell is now taken up to 3.0× the circle, which still rejects it at
2 km where it wastes 4.73× to 6.91×. Both SDKs are regenerated against one
shared vector fixture, so they still agree cell for cell.

## 4.0.0

**A major, not a minor.** The previous draft of these notes said 3.2.0. Checking
what actually breaks says otherwise, so the number says otherwise too.

### Breaking

1. **`withinRadius` returns different results.** It has to: above 8 km it was
   returning **nothing at all**, and below that it over-matched by up to 5.4x.
   Measured against a real engine with 20,000 points:

   | radius | true | before | after |
   |--------|-----:|-------:|------:|
   | 2 km   | 7    | 38     | 9     |
   | 5 km   | 36   | 109    | 42    |
   | 15 km  | 386  | **0**  | 518   |
   | 50 km  | 4,282| **0**  | 4,800 |

2. **`getCoveringHashes()` refuses a precision nothing is indexed at.** Passing
   4 used to return cells that matched no entity; it now throws.

3. **A radius too large for the indexed precisions is refused**, naming the
   latitude. Cells narrow toward the poles, so 50 km is available to about 82
   degrees and 15 km to about 89. Previously such a request came back
   silently covering a fraction of its own circle.

4. **`SearchResponse` gained a required `totalIsExact`.** Code that *builds* the
   type — a test double, a cache, a mapper — fails to compile until it sets it
   (`TS2741`). Code that only reads search results is unaffected.

### Migrating

Nothing to change for the common case: index the same way, call `withinRadius`
the same way, and get results that are actually inside the radius you asked for.

If you pinned expectations to the old counts, they will move. If you passed an
explicit precision, pass one of the indexed precisions or drop the argument. If
you search above 80 degrees latitude at a large radius, catch the refusal.

### Everything else in this release

### The total on a paged search is not the number of matches

A paged search stops as soon as the page is full — that is what makes it cost
microseconds — so the total it reports is whatever it had counted when it
stopped. On a million entities, a query with 166,325 matches reported 10,866
when asked for a page of 100. Anything printing "page 1 of N" from that number
is wrong by an order of magnitude and looks entirely fine.

The result now says which it is, and there is a call that gets you the real one:

```ts
const page = await client.search(query.limit(20));
page.totalIsExact;   // false — the search early-exited

const both = await client.searchWithTotal(query.limit(20));
both.totalIsExact;   // true, at the cost of a second round trip
both.totalMatches;   // the real total
```

`limit(0)` still asks for the count alone and is exact by itself; nothing about
that changed, and `searchWithTotal` skips its second call when you already
passed it.


### `withinRadius` was returning nothing above 8 km

`optimalPrecisionForRadius` chose geohash precision 4 for any radius over 8 km,
and entities are only ever tagged at precisions 5 and 6. A covering at
precision 4 therefore matched **nothing at all**. Measured against a real
engine with 20,000 points around Riyadh:

| radius | true matches | returned, before | returned, after |
|--------|-------------:|-----------------:|----------------:|
| 2 km   | 7            | 38               | 9               |
| 5 km   | 36           | 109              | 42              |
| 15 km  | 386          | **0**            | 518             |
| 50 km  | 4,282        | **0**            | 4,800           |

The precision is now always one the index carries, and of those the finest
whose complete covering fits a cell budget. Small radii also tightened: 2 km
went from 5.4x the true count to 1.3x.

### A covering is no longer truncated in silence

The 64-cell limit stopped the search mid-covering and returned what it had, so
a 50 km circle came back covered 18% and a 1 km circle at fine precision came
back covered 30% — with no error either time. The limit is now a budget the
precision is chosen to fit, so the covering always completes. A radius too
large for any indexed precision is refused by name.

### `withinRadius` is a pre-filter, not an exact radius

Cells are rectangles and the query is a circle, so the result still contains
some points outside it — now about 1.1x to 1.8x the circle's area rather than
up to 6x. The engine stores no coordinates, so only you can filter the
remainder, from your own data after hydration. This was always true and was
never written down.


### Delete many entities in one call

`delete()` takes a single id, so clearing a catalogue meant one round trip per
row. There was no other way to do it through the API at all.

```ts
for (const page of pages(idsToRemove, 10_000)) {
  const { deletedCount } = await client.batchDelete(page);
}
```

Up to 10,000 ids per call. A larger page is refused by name rather than
truncated, so a page that is too big fails loudly instead of deleting part of
itself and reporting success.

Ids that are unknown or already deleted are skipped rather than refused, so
retrying a page that half-applied is safe. `deletedCount` is the number of rows
that actually changed, which is lower than the number of ids you sent whenever
some were already gone.

## 3.1.0

### A radius no longer merges with your own OR

`withinRadius` turns a circle into one SHOULD filter per covering geohash cell.
Every SHOULD went into the same disjunction, so a radius sat in the same OR as
anything else you had asked for:

```ts
PulseIndex.query().should(['color:red', 'color:blue']).withinRadius(lat, lon, 5)
```

asked for "within 5 km **or** red **or** blue". It returned a plausible page of
results and said nothing about it. The cells now form a disjunction of their
own, and each further radius gets another, so that query means what it reads
like. Nothing changes for a query that used one or the other but not both.

### Groups: (red or blue) and (small or medium)

`should()` takes a group number. Members of a group are OR'd together and the
groups are AND'd with each other:

```ts
PulseIndex.query()
  .should(['color:red', 'color:blue'], 1)
  .should(['size:s', 'size:m'], 2);
```

Left unset it is 0, which is one disjunction — exactly what every existing
query already does.

### Ordering

`sortAsc(field)`, `sortDesc(field)` and `sortBy(field, descending)`, plus
`sortBy` on the plain options form:

```ts
await client.search(PulseIndex.query().must('status:active').sortAsc('price'));
```

Rows carrying no value for the field sort last in both directions; they still
count towards `totalMatches`, they simply have nothing to be ordered by.

An ordered search cannot stop as soon as the page is full — the cheapest
remaining row may be anywhere in the tenant — so it costs more than the same
filter unordered. `offset + limit` is capped at 100,000 and a request past it
is refused with the ceiling named.

## 3.0.0

### Breaking: a query returns a page instead of everything

`QueryBuilder` defaulted to a limit of 0, which the engine read as "no
ceiling" and answered with every matching id the tenant held. Nobody calling
`search()` without a limit meant to ask for that, and the cost of it landed on
the service rather than on the caller who never mentioned one.

The default is now `DEFAULT_LIMIT`, a hundred, on the builder and on the plain
options object alike. If you relied on getting every match back, say so:

```ts
await client.search(PulseIndex.query().tenant('acme').must('status:active').limit(5000));
```

A limit above the engine's maximum is refused with the maximum named, rather
than quietly trimmed — a short page that looks complete is worse than an error.

### Zero now means the count

`limit(0)` no longer means "no ceiling". It asks the engine for the number of
matches and no ids at all, which is the cheap way to count:

```ts
const { totalMatches } = await client.search(
  PulseIndex.query().tenant('acme').must('status:active').limit(0),
);
```

Requires an engine that speaks this contract. Against an older engine, a limit
of 0 still returns every id.

## 2.0.0

### Breaking: the operator-only methods are gone

Three methods that no API key could ever call have been removed, along with
their types. Every attempt returned a permission error, so nothing that worked
before stops working. If you were calling them and handling the failure, that
is the code to delete.

**Checking readiness:** use `health()`, or `servingStatus()` when you need to
tell "not answering" apart from "not reachable". Both work with any key.

### `health()` no longer reports false for every key

`health()` returned `false` no matter how the service was actually doing. It
now uses the standard `grpc.health.v1.Health` protocol. The signature is
unchanged — if you were working around this by ignoring `health()`, you can
stop.

### Added

- `client.servingStatus(service?)` — the raw serving status, for telling
  "reachable but not serving" apart from "no answer at all". Defaults to `''`,
  the overall-server name from the health spec.
- `SERVING_STATUS` — the status constants, exported from the package root.
- `healthProtoPath` on the client config, for the rare case of overriding the
  bundled `health.proto`.

`proto/health.proto` ships with the package. It is the standard health
protocol, vendored rather than pulled in as a dependency.

### Compatibility

Against a service deployed before this release, the health protocol answers but
always reports `SERVING`. `health()` is then equivalent to a reachability check.

## Earlier versions

1.x was withdrawn and is not installable. 2.0.0 is the first supported release.

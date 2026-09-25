# PulseIndex JavaScript / TypeScript SDK

Official Node.js & TypeScript client for **PulseIndex**: hosted search and filtering for large entity sets.

You send attributes to index and queries to run; PulseIndex returns matching entity IDs, which you hydrate from your own database. Your records stay in your primary store. The service holds only what it needs to answer queries.

[![npm version](https://img.shields.io/npm/v/@pulseindex/sdk.svg)](https://www.npmjs.com/package/@pulseindex/sdk)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](#installation)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

## Key features

- Dual ESM / CommonJS build for Node.js 18+
- Typed fluent `QueryBuilder` matching `pulseindex-php`
- Zero-dependency GeoHash radius coverage (`geo:{precision}:{hash}`)
- Connection pooling, deadlines, and `x-api-key` / `Authorization: Bearer` metadata
- Attribute flattening so plain objects index without a schema (categories, flags, geo tags), with numbers and positions under names you choose
- Exact radius and nearest-first ordering, measured by the engine rather than approximated by geohash rectangles
- A count that says whether it is a count (`totalIsExact`), so a page total is never mistaken for the whole set
- Typeahead on names and titles, from the first three letters of any word, with no text stored

## Installation

```bash
npm install @pulseindex/sdk
```

```bash
pnpm add @pulseindex/sdk
```

ESM:

```ts
import PulseIndex, { GeoHash } from '@pulseindex/sdk';
```

CommonJS:

```js
const { PulseIndex, GeoHash } = require('@pulseindex/sdk');
```

Requires Node.js 18 or later. The engine gRPC endpoint defaults to `localhost:50051`.

## Quickstart

```ts
import PulseIndex, { GeoHash } from '@pulseindex/sdk';

const client = new PulseIndex({
  endpoint: 'localhost:50051',
  apiKey: process.env.PULSEINDEX_API_KEY,
  tenantId: 'acme_corp',
});

await client.index('1001', {
  categories: ['features:swimming_pool'],
  category: 'villa',
  status: 'listed',

  // Numbers under your own names. Any name, any whole number, any number of
  // them, and each one takes a range or an order. There is no field the
  // engine calls `price`.
  numbers: { price: 250000, bedrooms: 3 },

  // A position, in degrees, under a name you pick. The engine packs it, so a
  // radius is measured rather than approximated, and the SDK adds the
  // geo:5 / geo:6 tags that narrow which part of the index a radius search
  // opens. You send the position once.
  points: { where: { lat: 41.0082, lon: 28.9784 } },
});

const result = await client.search(
  PulseIndex.query()
    .tenant('acme_corp')
    .must('features:swimming_pool')
    .should(['category:villa', 'category:apartment'])
    .mustNot('status:sold')
    .range('price', 100000, 500000)
    .withinRadius({ lat: 41.0082, lng: 28.9784, radiusKm: 5, field: 'where' })
    .limit(50),
);

const ids = result.matchedEntityIds;
await client.close();
```

### The radius is exact when you name the position field

`withinRadius` expands the circle into geohash cells, which are rectangles, so
the cells alone cover more than the circle does. Measured against a million
records with PostgreSQL computing the same circle, a 5 km search returned **44
rows where 22 were really inside**.

Pass `field`, the name you indexed the position under, and the engine narrows
on those cells and then measures the true distance. Same query, **22 rows**, and
it agreed with both PostgreSQL and Typesense on the id set. Leave `field` out and
the cells are the whole answer, which is the 4.x behaviour.

### The nearest K

```ts
const result = await client.search(
  PulseIndex.query()
    .must('status:available')
    .nearest('where', 41.0082, 28.9784)
    .limit(10),
);
```

Ordered by distance, nearest first, drawn from whatever the other filters left.
No radius has to be guessed to keep it quick. Ordering is to the centimetre,
which is the precision a stored position has.

### A count that says whether it is a count

A page stops as soon as it is full, so the `totalMatches` it carries is only
what the scan had reached by then. Read `totalIsExact` before showing the
number, or ask for both in one request:

```ts
const { matchedEntityIds, totalMatches } = await client.searchWithTotal(
  PulseIndex.query().must('status:available').limit(20),
);
```

### You send a position once

Every position in `points` is tagged at precisions 5 and 6 as it is indexed, and
a radius query covers at one of those two. Both come from `GeoHash`, so the two
sides cannot drift apart.

A top-level `lat` / `lng` pair is still read, for records that carry a position
that way, and a position given in both shapes is tagged once rather than twice.
Before 6.0.0 only that pair emitted tags, so a record carrying its position in
`points`, the shape that makes a radius exact, was indexed with no geo tag at
all, and `withinRadius` matched nothing.

```ts
const tags = GeoHash.encodeMultiTags(41.0082, 28.9784);
// ['geo:5:sxk97', 'geo:6:sxk973']
```

## gRPC configuration

Create a client against any PulseIndex Engine endpoint. Production customer gRPC should set `ssl: true` (or `PULSEINDEX_SSL=true`). The default is plaintext for local development.

```ts
const client = PulseIndex.create(
  'api.usepulseindex.com:50051',
  process.env.PULSEINDEX_API_KEY,
  true,
);
```

| Option | Env var | Default | Description |
| --- | --- | --- | --- |
| `endpoint` / `host` | `PULSEINDEX_ENDPOINT`, `PULSEINDEX_HOST` | `localhost:50051` | Engine `host:port` |
| `apiKey` | `PULSEINDEX_API_KEY` | - | Sent as `x-api-key` and `Authorization: Bearer` |
| `authorization` | `PULSEINDEX_AUTHORIZATION` | - | Overrides the Bearer token when set |
| `tenantId` | `PULSEINDEX_TENANT_ID` | `''` (engine uses `default`) | Default tenant for index / search / delete |
| `timeoutMs` | - | `5000` | Per-RPC deadline |
| `ssl` | `PULSEINDEX_SSL` | `false` | Enable TLS |
| `rootCerts` / `privateKey` / `certChain` | - | - | Optional custom TLS materials |
| `poolSize` | - | `1` | Number of multiplexed gRPC clients |
| `protoPath` | - | packaged `proto/engine.proto` | Override the proto file |
| `channelOptions` | - | keepalive defaults | Extra `@grpc/grpc-js` channel options |

The client sends your key as `x-api-key`, and also as `Authorization: Bearer`. Either is accepted. Every indexing and query call carries `tenant_id`; an empty value means `"default"`.

```ts
const client = new PulseIndex({
  endpoint: process.env.PULSEINDEX_HOST,
  apiKey: process.env.PULSEINDEX_API_KEY,
  tenantId: 'acme_corp',
  timeoutMs: 5000,
  ssl: true,
  poolSize: 2,
});
```

## Indexing

`index()` accepts a string/number entity id plus a flat attribute object. `numbers` and `points` carry the fields you want ranges, orders and circles on, under names you pick. These keys are consumed rather than turned into tags: `id`, `entityId`, `entity_id`, `attributes`, `numbers`, `points`, `tenantId`, `tenant_id`, `categories`, `tags`, `latitude`, `longitude`, `lat`, `lng`, `lon`. Every other key becomes a namespaced term (`status:listed`, `amenities:parking`) you can filter on. Every position, whether in `points` or as a top-level `lat` / `lng` pair, automatically adds its `geo:5:…` and `geo:6:…` tags.

`price` and `locationPrefix` used to be reserved this way and are not any more: the engine has no field of its own for either. A bare `price: 250000` is now the tag `price:250000`, so a range on it would find nothing. Put it in `numbers`.

A fraction in `numbers` is refused rather than rounded. The engine's column is a 64-bit integer, and `4.3` used to be sent as `4` without a word. Scale it yourself: a price in cents, a rating out of 100.

```ts
await client.index('1001', {
  categories: ['feature:pool'],
  amenities: ['parking', 'gym'],
  furnished: true,
  numbers: { price: 1500 },
  points: { where: { lat: 24.7136, lon: 46.6753 } },
});

await client.batchIndex([
  { id: '1002', attributes: { categories: ['feature:garden'], numbers: { price: 900 } } },
  { entityId: 1003, categories: ['feature:pool'], numbers: { price: 2000 } },
]);

await client.delete('1001');

// Clearing many rows: send ids in pages of up to 10,000. A larger page is
// refused by name rather than truncated.
await client.batchDelete([1002, 1003, 1004]);
```

Low-level PHP-compatible helper:

```ts
await client.indexEntity(
  1001,
  ['feature:pool', 'amenity:parking'],
  { price: 1500 },
  { where: { lat: 24.7136, lon: 46.6753 } },
  'acme',
);
```

It took a single `price` and a `locationPrefix` before 5.0. Both are gone: the
third argument is the whole `numbers` map and the fourth is `points`, under
names you pick. The parameters are `pulseindex-php`'s, in its order, which is
the only reason this helper exists. `index()` is the ergonomic call here.

`entity_id` is a proto `uint64`. Pass a string when the id may exceed `Number.MAX_SAFE_INTEGER`.

## QueryBuilder

The engine evaluates MUST (AND), SHOULD (OR group, then AND), MUST_NOT, numeric ranges on any field you named, an optional circle, and an optional order, and returns ids only. `QueryBuilder` is immutable: each chained call returns a new builder.

```ts
const query = client
  .query()
  .tenant('acme_corp')
  .must('feature:pool')
  .should(['category:villa', 'category:apartment'])
  .mustNot('status:sold')
  .range('price', 1000, 5000)
  .withinRadius({ lat: 24.7136, lng: 46.6753, radiusKm: 5 })
  .limit(50)
  .offset(0);

const page = await query.execute();
```

Equivalent object form:

```ts
await client.search({
  tenantId: 'acme_corp',
  must: 'feature:pool',
  should: ['category:villa', 'category:apartment'],
  mustNot: 'status:sold',
  ranges: [{ field: 'price', min: 100000, max: 500000 }],
  withinRadius: { lat: 41.0082, lng: 28.9784, radiusKm: 5, field: 'where' },
  limit: 50,
});
```

| Method | Effect |
| --- | --- |
| `tenant(id)` | Set `tenant_id` |
| `must(attr \| attr[])` | MUST filters |
| `should(attr \| attr[])` | SHOULD filters (OR group) |
| `mustNot(attr \| attr[])` | MUST_NOT filters |
| `range(field, min, max)` | Inclusive range on a number you named. Whole numbers; a fraction is refused, not rounded |
| `sortAsc(field)` / `sortDesc(field)` / `sortBy(field, desc)` | Order the page by a number you named |
| `withinRadius({ lat, lng, radiusKm, field? })` | Geohash covering, and an exact circle when `field` is given |
| `within(field, lat, lon, km)` | The circle alone, measured, with no covering to narrow it |
| `nearest(field, lat, lon)` | Order by distance, nearest first |
| `whereGeoHash(hash)` / `inGeoHash(hash)` | MUST exact geo cell |
| `exactTotal()` | Count every match instead of stopping when the page fills |
| `typeahead(typed)` | Records whose text starts with what was typed, every word, any order. See [Typeahead](#typeahead) |
| `limit(n)` / `offset(n)` | Pagination (`0` = the count with no ids) |
| `toRequest()` | Compile the proto-shaped payload |
| `execute()` | Search via the bound client |

`location(prefix)` is gone. It set `location_prefix`, a `uint64` bitfield the
engine no longer has, and both SDKs had been sending `0` for it on every request.

## Typeahead

Find a record by the first letters of any word in a name or a title, while
someone is still typing. At write time `Text` turns each value into tags such as
`t:andreas` and `p:and`, and at query time it turns what was typed into the tags
to look for. The tags reach PulseIndex like any other filter value, and it keeps
them only as hashes: no name or title is stored as text.

**Writing.** Add the tags beside the record's own:

```ts
import { PulseIndex, Text, verifyTextIndex } from '@pulseindex/sdk';

await client.batchIndex(doctors.map((d) => ({
  entityId: String(d.id),
  categories: [
    ...Text.indexTokensFor([d.name, d.specialty]),
    `city:${d.city}`,
  ],
  numbers: { popularity: d.popularity },
})));
```

**Searching.** Pass what was typed, and combine it with any other filter:

```ts
const page = await client.search(
  client.query()
    .typeahead('andreas mue')      // Dr. Andreas Müller
    .must('city:berlin')
    .sortDesc('popularity')
    .limit(10),
);
// or: client.search({ typeahead: 'andreas mue', must: 'city:berlin', limit: 10 })
```

**Once at boot**, check that the records were written by the tokenizer this
version of the SDK speaks. A different one would match nothing, silently, so
this throws `PULSEINDEX_TOKENIZER_VERSION_MISMATCH` instead. The answer is
cached per client and tenant:

```ts
await verifyTextIndex(client);
```

What it matches:

| Typed | Finds | Why |
| --- | --- | --- |
| `mue`, `mul`, `mül` | Müller | German umlauts are indexed both ways, `ü` as `ue` and as `u` |
| `andreas mue`, `mue andreas` | Dr. Andreas Müller | Every word is required, in any order |
| `dr mue` | Dr. Andreas Müller, Dr. Thomas Mueller | A finished word under three letters is matched whole |
| `m` | whatever the rest of the query finds | A last word under three letters adds nothing yet. Skip the search while `Text.typeaheadGroups(typed).length === 0` |
| `gastroenterologe` | Gastroenterologe | Past twelve letters a word is matched whole, which is what was typed |
| `محم`, `моск`, `οδο` | محمد, Москва, ΟΔΟΣ | Every script with spaces between words, accents and tashkeel folded |

Chinese, Japanese and Korean have no spaces to split words on, so they are
matched from the start of each unbroken run of characters.

There is no relevance score. The order is whatever number you supply, as
above, which is usually what a directory wants anyway: the most booked doctor
first. For one typo per word, add `Text.spellingTags(word)` as a SHOULD group.

**What it costs.** Text adds tags to every record, and a plan counts records by
weight (150 bytes is one). How much depends mostly on how many different
surnames or words your records carry, not on how many records there are.
Measured on a doctor directory of a million records, name plus specialty:

| Different surnames in the index | Bytes per record | Counts against the plan as |
| --- | --- | --- |
| none (no text) | 41 | 1 record |
| 1,170 | 114 | 1 record |
| 10,000 | 158 | 1.03 records |
| 47,000 | 213 | 1.4 records |
| 121,000 | 271 | 1.8 records |
| 182,000 | 382 | 2.5 records |

A smaller index with as many different names weighs more per record: at
400,000 records with 74,000 to 135,000 different surnames, each record counted
as 1.9 to 2.9. Writing slows too, from about 1.2 million records a second to
between 80,000 and 220,000, which matters for a first load and not after.

Changing the tokenizer is a breaking change: `Text.TOKENIZER_VERSION` moves,
and an index written under the old one has to be written again.

## GeoHash usage

Precision is chosen from the radius **and the latitude**, then the covering cells are emitted as SHOULD `geo:{precision}:{hash}` tags. Only precisions 5 and 6 are ever chosen, because those are the only two `encodeMultiTags` writes at index time:

| Radius | Precision | Cells in the covering |
| --- | --- | --- |
| up to ~2 km | 6 (~1.2 km × 0.6 km) | 2 – 45 |
| ~5 km and above | 5 (~4.9 km × 4.9 km) | 9 at 5 km, 184 at 30 km, 487 at 50 km |
| too large for 2,048 cells | - | **refused by name**, not half-covered |

Measured at Istanbul; the same radius costs more cells the further from the equator it is asked, because a cell keeps its width in degrees and so narrows in kilometres toward the poles. A 100 km circle is answered at Riyadh and refused at Oslo.

It used to return **precision 4 for anything above 8 km**, and nothing is indexed at precision 4, so every radius above 8 km matched nothing at all: measured against a real engine, 15 km returned 0 of 386 and 50 km returned 0 of 4,282. An empty page, silently. The covering was also truncated at 64 cells, so a 50 km circle came back covered 18% with no error.

`GeoHash.neighborhood3x3()` returns the centre cell plus eight neighbors. `withinRadius()` uses intersecting covering cells (same algorithm as `pulseindex-php`, checked against one shared vector fixture) so oversized neighbors are not OR'd in.

```ts
import { GeoHash } from '@pulseindex/sdk';

GeoHash.encode(42.6, -5.6, 5); // 'ezs42'
GeoHash.tag('ezs42'); // 'geo:5:ezs42'
GeoHash.encodeMultiTags(41.0082, 28.9784);
GeoHash.neighborhood3x3('ezs42'); // centre + 8 neighbors
query.whereGeoHash('ezs42'); // MUST geo:5:ezs42
```

Also available: `decode`, `decodeBounds`, `neighbor`, `neighbors`, `neighborhoodTags`, `optimalPrecisionForRadius`, `getCoveringHashes`, `encodeTag`, `haversineKm`.

## Error handling

All RPC failures wrap gRPC status codes. Catch the typed subclass that matches the failure mode:

```ts
import {
  PulseIndexAuthError,
  PulseIndexConnectionError,
  PulseIndexQueryError,
} from '@pulseindex/sdk';

try {
  await client.search(PulseIndex.query().must('feature:pool').limit(20));
} catch (error) {
  if (error instanceof PulseIndexAuthError) {
    // UNAUTHENTICATED / PERMISSION_DENIED: check x-api-key
  } else if (error instanceof PulseIndexConnectionError) {
    // UNAVAILABLE / DEADLINE_EXCEEDED: engine down or timeout
  } else if (error instanceof PulseIndexQueryError) {
    // INVALID_ARGUMENT / RESOURCE_EXHAUSTED: bad query or capacity
  } else {
    throw error;
  }
}
```

| Class | Typical gRPC statuses |
| --- | --- |
| `PulseIndexError` | Base class (`code`, `grpcStatusCode`, `grpcDetails`) |
| `PulseIndexConnectionError` | `UNAVAILABLE`, `DEADLINE_EXCEEDED`, `CANCELLED`, `ABORTED` |
| `PulseIndexAuthError` | `UNAUTHENTICATED`, `PERMISSION_DENIED` |
| `PulseIndexQueryError` | `INVALID_ARGUMENT`, `FAILED_PRECONDITION`, `RESOURCE_EXHAUSTED`, … |

`client.health()` returns `false` instead of throwing when the channel is not ready.

### Health

`client.health()` is `true` only when the service can **serve reads**: the channel
is ready and the standard health protocol reports `SERVING`. A reachable service
that cannot currently answer queries reports `false`, so reachability alone is not
treated as health.

It returns `false` rather than throwing, which means unreachable and unavailable
look the same. Use `servingStatus()` when you need to tell them apart:

```ts
import { SERVING_STATUS } from '@pulseindex/sdk';

const status = await client.servingStatus();
status === SERVING_STATUS.SERVING;       // ready for queries
status === SERVING_STATUS.NOT_SERVING;   // reachable, not currently serving
```

`health()` needs no particular scope on your API key. It does not send one.

If `health()` stays `false` for more than a few minutes, retry with backoff rather
than failing your own requests immediately; if it persists, contact support.

## API reference

### `PulseIndex` / `PulseIndexClient`

| Method | Returns | Description |
| --- | --- | --- |
| `new PulseIndex(config)` | client | Create a pooled gRPC client |
| `PulseIndex.create(host, apiKey?, ssl?)` | client | Convenience constructor |
| `PulseIndex.query()` | `QueryBuilder` | Unbound fluent query |
| `client.query()` | `QueryBuilder` | Bound builder (`execute()` calls `search`) |
| `client.search(query \| options)` | `SearchResponse` | Run `Search` |
| `client.index(id, attributes)` | `{ success }` | Upsert one entity |
| `client.batchIndex(entities)` | `{ indexedCount }` | Batch upsert |
| `client.delete(id)` | `{ success }` | Soft-delete an entity |
| `client.batchDelete(ids)` | `{ deletedCount }` | Soft-delete up to 10,000 entities in one call |
| `client.health()` | `boolean` | Whether the service is ready to answer queries |
| `client.servingStatus()` | `number` | Readiness as a status code, when you need more than a boolean |
| `client.close()` | `void` | Shut down the channel pool |

`SearchResponse`:

```ts
{
  matchedEntityIds: string[];
  totalMatches: number;
  totalIsExact: boolean;   // read this before showing totalMatches
  executionTimeUs: number;
}
```

`totalIsExact` is computed from what the scan actually did, not from what you
asked for: a page whose matches all fitted inside it was never cut short, so its
count is exact either way.

## gRPC contract

Service: `pulseindex.engine.v1.SearchEngineService`

| RPC | Request | Response |
| --- | --- | --- |
| `IndexEntity` | `IndexEntityRequest` | `IndexEntityResponse` |
| `BatchIndexEntities` | `BatchIndexEntitiesRequest` | `BatchIndexEntitiesResponse` |
| `DeleteEntity` | `DeleteEntityRequest` | `DeleteEntityResponse` |
| `BatchDeleteEntities` | `BatchDeleteEntitiesRequest` | `BatchDeleteEntitiesResponse` |
| `Search` | `SearchQueryRequest` | `SearchQueryResponse` |

`health()` reports whether the service is ready to answer queries. It needs no
particular scope, so it works with any key.

## License

MIT

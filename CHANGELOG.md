# Changelog

## 8.0.0

The first release from this repository's new history. Earlier versions are
deprecated on npm and their notes are not carried over.

The API is the same as 7.0.2: code written against 7.x runs unchanged, and
upgrading is a version bump. What 8.0.0 contains:

- Indexing with categories, tags, numbers and positions under names you choose.
- MUST, SHOULD and MUST_NOT filters, groups of alternatives, ranges and orders
  on any number you indexed.
- An exact radius, and an order by distance for the nearest K.
- `searchWithTotal`, and `totalIsExact` on every page.
- Typeahead on names and titles in every script with spaces between words,
  with `verifyTextIndex` to check the index was written by the same tokenizer.
- Batch index and batch delete, up to 10,000 entities a call.
- `health()` and `servingStatus()` on the standard gRPC health protocol.
- An unknown search option is refused by name rather than ignored.

Requires Node.js 18 or later.

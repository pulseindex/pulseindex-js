import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { GeoHash } from '../src';

describe('GeoHash', () => {
  it('encodes well-known coordinates', () => {
    expect(GeoHash.encode(42.6, -5.6, 5)).toBe('ezs42');
    expect(GeoHash.encode(57.64911, 10.40744, 11)).toBe('u4pruydqqvj');
    expect(GeoHash.encode(37.7749, -122.4194, 6)).toBe('9q8yyk');
  });

  it('decodes a cell centre within precision', () => {
    const decoded = GeoHash.decode('ezs42');
    expect(decoded.lat).toBeCloseTo(42.6, 1);
    expect(decoded.lon).toBeCloseTo(-5.6, 1);
  });

  it('round-trips encode and decode', () => {
    const lat = 41.0082;
    const lon = 28.9784;
    const decoded = GeoHash.decode(GeoHash.encode(lat, lon, 8));
    expect(decoded.lat).toBeCloseTo(lat, 2);
    expect(decoded.lon).toBeCloseTo(lon, 2);
  });

  it('returns the eight neighbors of ezs42', () => {
    expect(GeoHash.neighbors('ezs42')).toEqual([
      'ezs48',
      'ezs49',
      'ezs43',
      'ezs41',
      'ezs40',
      'ezefp',
      'ezefr',
      'ezefx',
    ]);
  });

  it('resolves cardinal neighbors', () => {
    expect(GeoHash.neighbor('ezs42', 'n')).toBe('ezs48');
    expect(GeoHash.neighbor('ezs42', 'e')).toBe('ezs43');
    expect(GeoHash.neighbor('ezs42', 's')).toBe('ezs40');
    expect(GeoHash.neighbor('ezs42', 'w')).toBe('ezefr');
  });

  it('builds a 3x3 neighborhood of center plus eight neighbors', () => {
    const grid = GeoHash.neighborhood3x3('ezs42');
    expect(grid).toHaveLength(9);
    expect(grid[0]).toBe('ezs42');
    expect(grid.slice(1)).toEqual(GeoHash.neighbors('ezs42'));
    expect(GeoHash.neighborhoodTags(42.6, -5.6, 5)[0]).toBe('geo:5:ezs42');
  });

  // A precision nothing is tagged at would match nothing, silently.
  it('only ever picks a precision the index carries', () => {
    for (const radius of [0, 0.5, 1, 1.5, 2, 5, 8, 8.01, 10, 15, 25, 40, 50]) {
      expect(GeoHash.INDEX_PRECISIONS as readonly number[]).toContain(
        GeoHash.optimalPrecisionForRadius(radius, 41.0082, 28.9784),
      );
    }
  });

  it('uses the coarser cell whenever it is accurate enough', () => {
    const [lat, lon] = [41.0082, 28.9784];
    // Small circles need the fine cell.
    expect(GeoHash.optimalPrecisionForRadius(0.5, lat, lon)).toBe(6);
    expect(GeoHash.optimalPrecisionForRadius(5.0, lat, lon)).toBe(5);
    // Larger ones take the coarse cell.
    expect(GeoHash.optimalPrecisionForRadius(15.0, lat, lon)).toBe(5);
    expect(GeoHash.optimalPrecisionForRadius(50.0, lat, lon)).toBe(5);
    expect(GeoHash.getCoveringHashes(lat, lon, 15).length).toBeLessThan(200);
    expect(GeoHash.precisionForRadius(4.9, lat, lon)).toBe(
      GeoHash.optimalPrecisionForRadius(4.9, lat, lon),
    );
  });

  // -180 and +180 are the same meridian.
  it('does not drop a cell across the antimeridian', () => {
    const cells = GeoHash.getCoveringHashes(0.0, 179.99, 2.0);
    expect(cells.some((h) => GeoHash.decodeBounds(h).lonMin < 0)).toBe(true);
    expect(cells).toContain('800000');
  });

  it('finds the same covering from either side of the line', () => {
    // 179.999 and -179.999 are 222 metres apart.
    const east = GeoHash.getCoveringHashes(0.0, 179.999, 5.0);
    const west = new Set(GeoHash.getCoveringHashes(0.0, -179.999, 5.0));
    const shared = east.filter((h) => west.has(h)).length;
    expect(shared).toBeGreaterThan(east.length * 0.8);
  });

  // Cells narrow toward the poles, so the same radius costs more of them the
  // further north it is asked. The refusal has to say so.
  it('names the latitude when it refuses', () => {
    expect(() => GeoHash.getCoveringHashes(89.9, 0, 50)).toThrow(/latitude 89\.9/);
  });

  // Oslo, Stockholm, Helsinki and Saint Petersburg are above 60 degrees.
  it('covers 50 km where Europeans live', () => {
    for (const [lat, lon] of [[59.9139, 10.7522], [59.3293, 18.0686], [60.1699, 24.9384], [69.6492, 18.9553]]) {
      const cells = GeoHash.getCoveringHashes(lat, lon, 50);
      expect(cells.length).toBeGreaterThan(0);
      expect(cells.length).toBeLessThanOrEqual(GeoHash.COVERING_CELL_BUDGET);
    }
  });

  // A partial covering would look like a complete answer.
  it('refuses a radius too large to cover rather than half-covering it', () => {
    expect(() => GeoHash.optimalPrecisionForRadius(400, 41.0082, 28.9784)).toThrow(
      /needs more than \d+ geohash cells/,
    );
  });

  it('refuses a precision nothing is indexed at', () => {
    expect(() => GeoHash.getCoveringHashes(41.0082, 28.9784, 15, 4)).toThrow(/is not indexed/);
  });

  // Sixteen bearings around the rim, every one inside a returned cell. This is
  // the assertion a truncated covering fails.
  it('returns a covering that contains the whole circle', () => {
    const destination = (lat: number, lon: number, km: number, bearing: number) => {
      const R = 6371, d = km / R, b = (bearing * Math.PI) / 180;
      const la = (lat * Math.PI) / 180, lo = (lon * Math.PI) / 180;
      const la2 = Math.asin(Math.sin(la) * Math.cos(d) + Math.cos(la) * Math.sin(d) * Math.cos(b));
      const lo2 = lo + Math.atan2(
        Math.sin(b) * Math.sin(d) * Math.cos(la),
        Math.cos(d) - Math.sin(la) * Math.sin(la2),
      );
      return [(la2 * 180) / Math.PI, (lo2 * 180) / Math.PI] as const;
    };

    const places: Array<[number, number]> = [
      [41.0082, 28.9784],     // Istanbul
      [51.5074, -0.1278],     // London, across the prime meridian
      [-33.8688, 151.2093],   // Sydney
      [0.0, 179.99],          // hard against the antimeridian, east side
      [0.0, -179.99],         // and the west side
      [-16.5, 179.9],         // Fiji, a real place that sits on it
      [71.0, 25.8],           // North Cape, where cells are narrow
    ];
    for (const [lat, lon] of places) {
      for (const radius of [0.5, 2, 5, 15, 40]) {
        const bounds = GeoHash.getCoveringHashes(lat, lon, radius).map((h) =>
          GeoHash.decodeBounds(h),
        );
        for (let bearing = 0; bearing < 360; bearing += 22.5) {
          const [plat, plon] = destination(lat, lon, radius * 0.999, bearing);
          // Longitude compared in a frame anchored at the cell's west edge, so
          // the +/-180 seam is not a discontinuity.
          const inside = bounds.some((b) => {
            if (plat < b.latMin || plat > b.latMax) return false;
            const span = b.lonMax - b.lonMin;
            const off = ((((plon - b.lonMin) + 180) % 360) + 360) % 360 - 180;
            return off >= -1e-9 && off <= span + 1e-9;
          });
          expect(inside, `${radius}km rim at ${bearing}deg from ${lat},${lon}`).toBe(true);
        }
      }
    }
  });

  // The same vectors the PHP SDK asserts against, so both SDKs give the same
  // result for the same call.
  it('matches the shared covering vectors', async () => {
    const vectors = JSON.parse(
      readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'geo-covering-vectors.json'), 'utf8'),
    ) as Array<{
      name: string; lat: number; lon: number; radiusKm: number;
      precision: number; count: number; first: string; last: string;
    }>;
    expect(vectors.length).toBeGreaterThan(0);

    for (const v of vectors) {
      const cells = GeoHash.getCoveringHashes(v.lat, v.lon, v.radiusKm);
      const label = `${v.name} at ${v.radiusKm} km`;
      expect(cells, label).toHaveLength(v.count);
      expect(cells[0].length, label).toBe(v.precision);
      expect(cells[0], label).toBe(v.first);
      expect(cells[cells.length - 1], label).toBe(v.last);
    }
  });

  it('keeps the covered area close to the circle', () => {
    const [lat, lon] = [41.0082, 28.9784];
    for (const radius of [0.5, 2, 5, 10, 15, 25, 50]) {
      const covered = GeoHash.getCoveringHashes(lat, lon, radius).reduce((sum, h) => {
        const b = GeoHash.decodeBounds(h);
        const rad = (d: number) => (d * Math.PI) / 180;
        return sum + 6371 * rad(b.latMax - b.latMin)
          * 6371 * Math.cos(rad((b.latMax + b.latMin) / 2)) * rad(b.lonMax - b.lonMin);
      }, 0);
      // Cells are rectangles and the query is a circle, so some excess is
      // unavoidable, more so for a circle smaller than one cell.
      const bound = radius < 1 ? 5.0 : GeoHash.ACCEPTABLE_COVER_RATIO + 0.01;
      expect(covered / (Math.PI * radius ** 2), `${radius}km`).toBeLessThan(bound);
    }
  });

  it('covers a radius with the centre cell first', () => {
    const hashes = GeoHash.getCoveringHashes(42.6, -5.6, 4.9);
    expect(hashes[0]).toBe('ezs42');
    expect(hashes.length).toBeGreaterThanOrEqual(1);
    expect(hashes).toEqual([...new Set(hashes)]);
    for (const hash of hashes) {
      expect(hash).toHaveLength(5);
    }
  });

  it('uses precision 6 for a 1.2km radius', () => {
    const hashes = GeoHash.getCoveringHashes(37.7749, -122.4194, 1.2);
    expect(hashes[0]).toBe('9q8yyk');
    for (const hash of hashes) {
      expect(hash).toHaveLength(6);
    }
  });

  it('drops neighbors that miss a tiny circle', () => {
    const bounds = GeoHash.decodeBounds('ezs42');
    const lat = (bounds.latMin + bounds.latMax) / 2.0;
    const lon = (bounds.lonMin + bounds.lonMax) / 2.0;
    const hashes = GeoHash.getCoveringHashes(lat, lon, 0.05, 5);

    expect(hashes).toEqual(['ezs42']);
    expect(hashes).not.toContain('ezs48');
  });

  it('honors explicit covering precision', () => {
    const hashes = GeoHash.getCoveringHashes(42.6, -5.6, 1.0, 5);
    expect(hashes[0]).toBe('ezs42');
    for (const hash of hashes) {
      expect(hash).toHaveLength(5);
    }
  });

  it('namespaces tags by precision and is idempotent', () => {
    expect(GeoHash.tag('ezs42')).toBe('geo:5:ezs42');
    expect(GeoHash.tag('geo:ezs42')).toBe('geo:5:ezs42');
    expect(GeoHash.tag('geo:5:ezs42')).toBe('geo:5:ezs42');
    expect(GeoHash.encodeTag(42.6, -5.6, 5)).toBe('geo:5:ezs42');
    expect(GeoHash.encodeTag(42.6, -5.6, 6)).toBe(`geo:6:${GeoHash.encode(42.6, -5.6, 6)}`);
  });

  it('indexes dual-granularity geo tags', () => {
    const lat = 42.6;
    const lon = -5.6;
    const tags = GeoHash.encodeMultiTags(lat, lon);
    expect(tags).toEqual([
      `geo:5:${GeoHash.encode(lat, lon, 5)}`,
      `geo:6:${GeoHash.encode(lat, lon, 6)}`,
    ]);
    expect(tags[0]).toBe('geo:5:ezs42');
    expect(tags[1]?.startsWith('geo:6:')).toBe(true);
    expect(tags[1]?.slice('geo:6:'.length)).toHaveLength(6);
  });

  it('computes bounding-box radius math via haversine', () => {
    const km = GeoHash.haversineKm(41.0082, 28.9784, 41.0082, 28.9784);
    expect(km).toBeCloseTo(0, 6);
    expect(GeoHash.haversineKm(41.0082, 28.9784, 41.0532, 28.9784)).toBeGreaterThan(4);
    expect(GeoHash.haversineKm(41.0082, 28.9784, 41.0532, 28.9784)).toBeLessThan(6);
  });

  it('rejects invalid inputs', () => {
    expect(() => GeoHash.encode(91.0, 0.0, 5)).toThrow(/Latitude/);
    expect(() => GeoHash.encode(0.0, 200.0, 5)).toThrow(/Longitude/);
    expect(() => GeoHash.optimalPrecisionForRadius(-1)).toThrow(/Radius/);
    expect(() => GeoHash.neighbor('ezs42', 'up')).toThrow(/Direction/);
  });
});

export class GeoHash {
  static readonly TAG_PREFIX = 'geo:';
  static readonly MIN_PRECISION = 1;
  static readonly MAX_PRECISION = 12;
  static readonly INDEX_PRECISIONS = [5, 6] as const;

  private static readonly BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';
  private static readonly EARTH_RADIUS_KM = 6371.0;
  /**
   * Most cells one radius query may expand into, and therefore the most SHOULD
   * predicates it sends.
   *
   * This used to be 64 and it was a truncation limit: the walk stopped mid
   * covering and returned what it had, so a 50 km search covered 18% of its own
   * circle and said nothing. It is now a budget the precision is chosen to fit,
   * so a covering is always complete or the request is refused.
   *
   * The number is set by latitude, not by radius. Cells needed at the coarsest
   * indexed precision, measured: 50 km costs 376 at the equator, 592 at London,
   * 720 at Oslo, 1,044 at Tromso, 2,028 at 80N. A first attempt used 512,
   * chosen at one latitude, and it refused a 50 km search anywhere above 60
   * degrees — Oslo, Stockholm, Helsinki, Saint Petersburg.
   *
   * The cost is bounded: measured against a live engine, a covering costs about
   * 0.57 us per cell, so a query at the full budget spends roughly 1.2 ms in
   * the engine, and stays half of its 4,096-filter ceiling.
   */
  static readonly COVERING_CELL_BUDGET = 2048;

  /**
   * How much area outside the circle a covering may carry before a finer
   * precision is worth its cell count.
   *
   * `withinRadius` is a pre-filter the caller narrows exactly afterwards, so
   * excess area is cheaper than predicates.
   *
   * 2.0 was the first attempt and it was too strict. It rejected the coarse
   * cell at 5 km, so a covering that had cost 10 cells cost 167, and the demo
   * benchmark went from beating PostgreSQL to losing to it by 2.76x on wall
   * time — the cost is the request, not the search. 3.0 keeps the cheap
   * covering at 5 km (2.76x) and still rejects the coarse cell at 2 km, where
   * it wastes 4.73x to 6.91x depending on latitude.
   */
  static readonly ACCEPTABLE_COVER_RATIO = 3.0;

  private static readonly NEIGHBORS: Record<'n' | 's' | 'e' | 'w', [string, string]> = {
    n: ['p0r21436x8zb9dcf5h7kjnmqesgutwvy', 'bc01fg45238967deuvhjyznpkmstqrwx'],
    s: ['14365h7k9dcfesgujnmqp0r2twvyx8zb', '238967debc01fg45kmstqrwxuvhjyznp'],
    e: ['bc01fg45238967deuvhjyznpkmstqrwx', 'p0r21436x8zb9dcf5h7kjnmqesgutwvy'],
    w: ['238967debc01fg45kmstqrwxuvhjyznp', '14365h7k9dcfesgujnmqp0r2twvyx8zb'],
  };

  private static readonly BORDERS: Record<'n' | 's' | 'e' | 'w', [string, string]> = {
    n: ['prxz', 'bcfguvyz'],
    s: ['028b', '0145hjnp'],
    e: ['bcfguvyz', 'prxz'],
    w: ['0145hjnp', '028b'],
  };

  static encode(lat: number, lon: number, precision = 6): string {
    this.assertLatitude(lat);
    this.assertLongitude(lon);
    this.assertPrecision(precision);

    let latMin = -90.0;
    let latMax = 90.0;
    let lonMin = -180.0;
    let lonMax = 180.0;
    let hash = '';
    let bit = 0;
    let ch = 0;
    let even = true;

    while (hash.length < precision) {
      if (even) {
        const mid = (lonMin + lonMax) / 2.0;
        if (lon >= mid) {
          ch |= 1 << (4 - bit);
          lonMin = mid;
        } else {
          lonMax = mid;
        }
      } else {
        const mid = (latMin + latMax) / 2.0;
        if (lat >= mid) {
          ch |= 1 << (4 - bit);
          latMin = mid;
        } else {
          latMax = mid;
        }
      }

      even = !even;

      if (bit < 4) {
        bit += 1;
      } else {
        hash += this.BASE32[ch];
        bit = 0;
        ch = 0;
      }
    }

    return hash;
  }

  static decode(hash: string): { lat: number; lon: number } {
    const bounds = this.decodeBounds(hash);
    return {
      lat: (bounds.latMin + bounds.latMax) / 2.0,
      lon: (bounds.lonMin + bounds.lonMax) / 2.0,
    };
  }

  static decodeBounds(hash: string): {
    latMin: number;
    latMax: number;
    lonMin: number;
    lonMax: number;
  } {
    const normalized = this.normalizeHash(hash);

    let latMin = -90.0;
    let latMax = 90.0;
    let lonMin = -180.0;
    let lonMax = 180.0;
    let even = true;

    for (const character of normalized) {
      const cd = this.BASE32.indexOf(character);
      if (cd < 0) {
        throw new Error(`Invalid GeoHash character "${character}".`);
      }

      for (let mask = 16; mask > 0; mask >>= 1) {
        if (even) {
          const mid = (lonMin + lonMax) / 2.0;
          if ((cd & mask) !== 0) {
            lonMin = mid;
          } else {
            lonMax = mid;
          }
        } else {
          const mid = (latMin + latMax) / 2.0;
          if ((cd & mask) !== 0) {
            latMin = mid;
          } else {
            latMax = mid;
          }
        }
        even = !even;
      }
    }

    return { latMin, latMax, lonMin, lonMax };
  }

  static neighbor(hash: string, direction: string): string {
    const normalizedDirection = direction.toLowerCase();
    if (!this.isCardinal(normalizedDirection)) {
      throw new Error('Direction must be one of: n, s, e, w.');
    }
    return this.adjacent(this.normalizeHash(hash), normalizedDirection);
  }

  static neighbors(hash: string): string[] {
    const normalized = this.normalizeHash(hash);
    const north = this.adjacent(normalized, 'n');
    const south = this.adjacent(normalized, 's');
    const east = this.adjacent(normalized, 'e');
    const west = this.adjacent(normalized, 'w');

    return [
      north,
      this.adjacent(north, 'e'),
      east,
      this.adjacent(south, 'e'),
      south,
      this.adjacent(south, 'w'),
      west,
      this.adjacent(north, 'w'),
    ];
  }

  static neighborhood3x3(hash: string): string[] {
    const center = this.normalizeHash(hash);
    return [center, ...this.neighbors(center)];
  }

  static neighborhoodTags(lat: number, lon: number, precision = 6): string[] {
    return this.neighborhood3x3(this.encode(lat, lon, precision)).map((cell) => this.tag(cell));
  }

  /**
   * The precision a radius query should cover at, at this point on the globe.
   *
   * Only ever one of {@link INDEX_PRECISIONS}. That is the correction: this
   * used to return 4 for anything over 8 km, and nothing is indexed at
   * precision 4, so **every radius above 8 km matched nothing at all**.
   * Measured against a real engine with entities tagged by `encodeMultiTags`:
   * 15 km returned 0 of 386, 50 km returned 0 of 4,282 — an empty page, with
   * no error to explain it.
   *
   * Of the indexed precisions it returns the **coarsest** whose complete
   * covering both fits {@link COVERING_CELL_BUDGET} and is tight enough
   * ({@link ACCEPTABLE_COVER_RATIO}), falling back to the finest that fits at
   * all. Measured at Riyadh: 15 km needs 1,120 cells at precision 6 to cover
   * 1.07x the circle where precision 5 costs 47 for 1.44x, so the finer cell
   * buys a quarter off an already-small excess for 24 times the predicates.
   *
   * Latitude is a parameter because it changes the answer: a cell keeps its
   * width in degrees, so it narrows in kilometres toward the poles and the same
   * radius needs more of them.
   *
   * @throws when no indexed precision can cover the radius within the budget —
   *         refused rather than half-covered.
   */
  static optimalPrecisionForRadius(radiusKm: number, lat = 0, lon = 0): number {
    if (radiusKm < 0) {
      throw new Error('Radius must be non-negative.');
    }

    const budget = this.COVERING_CELL_BUDGET;
    let fallback: number | null = null;

    // Coarsest first, stopping at the first precision that is accurate enough.
    // Taking the finest that merely fits was the earlier rule and it was wrong:
    // at 15 km that is 1,120 cells for 1.07x the circle where the coarser cell
    // costs 47 for 1.44x — 24 times the predicates to shave a quarter off an
    // excess that is already small.
    for (const precision of [...this.INDEX_PRECISIONS].sort((a, b) => a - b)) {
      // One past the budget is enough to know it does not fit, and stops a
      // 100 km radius walking six thousand cells to find out.
      const cells = this.walkCovering(lat, lon, radiusKm, precision, budget + 1);
      if (cells.length > budget) {
        continue;
      }
      if (radiusKm > 0 && this.coveredRatio(cells, radiusKm) <= this.ACCEPTABLE_COVER_RATIO) {
        return precision;
      }
      fallback = precision;
    }

    // Nothing hit the target; the finest that fits is the tightest on offer.
    if (fallback !== null) {
      return fallback;
    }

    throw new Error(
      `A ${radiusKm} km radius at latitude ${lat.toFixed(1)} needs more than ${budget} geohash ` +
        `cells at every indexed precision (${this.INDEX_PRECISIONS.join(', ')}). Geohash cells ` +
        'narrow toward the poles, so the same radius costs more cells the further from the ' +
        'equator it is asked. Use a smaller radius, move the search nearer the equator, or ' +
        'index a coarser precision.',
    );
  }

  static precisionForRadius(radiusKm: number, lat = 0, lon = 0): number {
    return this.optimalPrecisionForRadius(radiusKm, lat, lon);
  }

  /**
   * GeoHashes whose cells cover the search circle.
   *
   * The covering is always complete. It used to stop at 64 cells and return
   * what it had, so a caller asking for 50 km got cells covering 18% of that
   * circle — with no error. Now the precision is chosen to fit the budget and
   * the walk always finishes, so the result either covers the circle or the
   * call refuses.
   *
   * Passing `precision` explicitly overrides the choice, and is checked against
   * {@link INDEX_PRECISIONS}: entities carry tags only at those, so any other
   * precision matches nothing at all rather than matching loosely.
   */
  static getCoveringHashes(
    lat: number,
    lon: number,
    radiusKm: number,
    precision?: number,
  ): string[] {
    if (radiusKm < 0) {
      throw new Error('Radius must be non-negative.');
    }

    let resolved: number;
    if (precision === undefined) {
      resolved = this.optimalPrecisionForRadius(radiusKm, lat, lon);
    } else {
      this.assertPrecision(precision);
      if (!(this.INDEX_PRECISIONS as readonly number[]).includes(precision)) {
        throw new Error(
          `Precision ${precision} is not indexed, so a covering at it matches nothing. ` +
            `Indexed precisions: ${this.INDEX_PRECISIONS.join(', ')}.`,
        );
      }
      resolved = precision;
    }

    return this.walkCovering(lat, lon, radiusKm, resolved, null);
  }

  /**
   * Every cell at `precision` that intersects the circle, breadth-first from
   * the centre and expanding only through cells that intersect.
   *
   * `limit` exists only so the precision chooser can stop early once a
   * precision is known not to fit; a null limit walks to completion, which is
   * what every caller that wants an answer passes.
   */
  private static walkCovering(
    lat: number,
    lon: number,
    radiusKm: number,
    precision: number,
    limit: number | null,
  ): string[] {
    const covering: string[] = [];
    const visited = new Set<string>();
    const queue: string[] = [this.encode(lat, lon, precision)];

    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined || visited.has(current)) {
        continue;
      }
      visited.add(current);

      if (!this.cellIntersectsCircle(current, lat, lon, radiusKm)) {
        continue;
      }

      covering.push(current);
      if (limit !== null && covering.length >= limit) {
        return covering;
      }

      for (const neighbor of this.neighbors(current)) {
        if (!visited.has(neighbor)) {
          queue.push(neighbor);
        }
      }
    }

    return covering;
  }

  static tag(geohash: string): string {
    const hash = this.normalizeHash(geohash);
    return `${this.TAG_PREFIX}${hash.length}:${hash}`;
  }

  static encodeTag(lat: number, lon: number, precision = 6): string {
    return this.tag(this.encode(lat, lon, precision));
  }

  static encodeMultiTags(lat: number, lon: number): string[] {
    return this.INDEX_PRECISIONS.map((precision) => this.encodeTag(lat, lon, precision));
  }

  static haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const dLat = this.toRadians(lat2 - lat1);
    const dLon = this.toRadians(lon2 - lon1);
    const a =
      Math.sin(dLat / 2.0) ** 2 +
      Math.cos(this.toRadians(lat1)) * Math.cos(this.toRadians(lat2)) * Math.sin(dLon / 2.0) ** 2;
    return 2.0 * this.EARTH_RADIUS_KM * Math.asin(Math.min(1.0, Math.sqrt(a)));
  }

  private static cellIntersectsCircle(
    hash: string,
    lat: number,
    lon: number,
    radiusKm: number,
  ): boolean {
    const bounds = this.decodeBounds(hash);
    const closestLat = Math.min(Math.max(lat, bounds.latMin), bounds.latMax);
    const closestLon = this.closestLongitude(lon, bounds.lonMin, bounds.lonMax);
    return this.haversineKm(lat, lon, closestLat, closestLon) <= radiusKm;
  }

  /**
   * The longitude in [lonMin, lonMax] nearest to `lon`, going the short way
   * round the globe.
   *
   * A plain clamp is wrong at the antimeridian, because -180 and +180 are the
   * same meridian and a numeric comparison does not know it. Measured before
   * this: a query at lon 179.99 against the cell spanning -180 to -179.989
   * clamped to -179.989 and measured 2.334 km, when the true nearest point is
   * -180.0 at 1.112 km. The cell was rejected from a 2 km radius it is well
   * inside, and five of sixteen points on that circle's rim fell outside the
   * covering — silently.
   *
   * Working in deltas normalised to +/-180 removes the discontinuity: the cell
   * either straddles the query meridian, or lies wholly to one side of it and
   * the nearer edge is the answer.
   */
  private static closestLongitude(lon: number, lonMin: number, lonMax: number): number {
    const toMin = this.normalizeLonDelta(lonMin - lon);
    const toMax = this.normalizeLonDelta(lonMax - lon);

    // Straddles the query's own meridian, so that is the closest point. A
    // geohash cell never spans more than 180 degrees, so this reads correctly
    // on either side of the line.
    if (toMin <= 0 && toMax >= 0) {
      return lon;
    }

    return Math.abs(toMin) <= Math.abs(toMax) ? lonMin : lonMax;
  }

  /** A longitude difference folded into [-180, 180]. */
  private static normalizeLonDelta(delta: number): number {
    return ((((delta + 180) % 360) + 360) % 360) - 180;
  }

  /**
   * Covered area divided by the circle's, so a precision can be judged on what
   * it wastes rather than only on what it costs.
   */
  private static coveredRatio(cells: string[], radiusKm: number): number {
    const rad = (d: number) => (d * Math.PI) / 180;
    const covered = cells.reduce((sum, hash) => {
      const b = this.decodeBounds(hash);
      return sum
        + this.EARTH_RADIUS_KM * rad(b.latMax - b.latMin)
        * this.EARTH_RADIUS_KM * Math.cos(rad((b.latMax + b.latMin) / 2)) * rad(b.lonMax - b.lonMin);
    }, 0);
    return covered / (Math.PI * radiusKm ** 2);
  }

  private static adjacent(hash: string, direction: 'n' | 's' | 'e' | 'w'): string {
    if (hash.length === 0) {
      throw new Error('GeoHash must not be empty.');
    }

    const lastChar = hash[hash.length - 1] ?? '';
    const type = hash.length % 2;
    let parent = hash.slice(0, -1);
    const borders = this.BORDERS[direction][type] ?? '';

    if (parent.length > 0 && borders.includes(lastChar)) {
      parent = this.adjacent(parent, direction);
    }

    const neighborCharset = this.NEIGHBORS[direction][type] ?? '';
    const index = neighborCharset.indexOf(lastChar);
    if (index < 0) {
      throw new Error(`Invalid GeoHash character "${lastChar}".`);
    }

    return parent + (this.BASE32[index] ?? '');
  }

  private static normalizeHash(hash: string): string {
    let normalized = hash.trim().toLowerCase();
    if (normalized.startsWith(this.TAG_PREFIX)) {
      normalized = normalized.slice(this.TAG_PREFIX.length);
    }

    const tagged = normalized.match(/^([1-9]|1[0-2]):([0-9bcdefghjkmnpqrstuvwxyz]+)$/);
    if (tagged) {
      normalized = tagged[2] ?? '';
    }

    if (normalized.length === 0) {
      throw new Error('GeoHash must not be empty.');
    }

    for (const character of normalized) {
      if (!this.BASE32.includes(character)) {
        throw new Error(`Invalid GeoHash "${normalized}".`);
      }
    }

    return normalized;
  }

  private static assertLatitude(lat: number): void {
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
      throw new Error('Latitude must be between -90 and 90.');
    }
  }

  private static assertLongitude(lon: number): void {
    if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
      throw new Error('Longitude must be between -180 and 180.');
    }
  }

  private static assertPrecision(precision: number): void {
    if (
      !Number.isInteger(precision) ||
      precision < this.MIN_PRECISION ||
      precision > this.MAX_PRECISION
    ) {
      throw new Error(
        `GeoHash precision must be between ${this.MIN_PRECISION} and ${this.MAX_PRECISION}.`,
      );
    }
  }

  private static isCardinal(direction: string): direction is 'n' | 's' | 'e' | 'w' {
    return direction === 'n' || direction === 's' || direction === 'e' || direction === 'w';
  }

  private static toRadians(degrees: number): number {
    return (degrees * Math.PI) / 180;
  }
}

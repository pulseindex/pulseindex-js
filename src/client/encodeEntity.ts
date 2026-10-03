import { GeoHash } from '../geo/GeoHash';
import { PulseIndexQueryError } from '../errors/PulseIndexError';
import {
  type EncodedEntity,
  type GeoPoint,
  type EntityAttributes,
  type EntityId,
  type EntityInput,
} from '../types';

/** Keys this encoder consumes itself, so they are not also emitted as tags. */
const SKIP_ATTRIBUTE_KEYS = new Set([
  'id',
  'entityId',
  'entity_id',
  'attributes',
  'numbers',
  'points',
  'tenantId',
  'tenant_id',
  'latitude',
  'longitude',
  'lat',
  'lng',
  'lon',
  'categories',
  'tags',
]);

export function toUint64String(value: EntityId, field = 'entityId'): string {
  if (typeof value === 'bigint') {
    if (value < 0n) {
      throw new PulseIndexQueryError(`${field} must be a non-negative integer.`);
    }
    return value.toString(10);
  }

  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 0 || !Number.isSafeInteger(value)) {
      throw new PulseIndexQueryError(
        `${field} must be a non-negative safe integer, bigint, or digit string.`,
      );
    }
    return String(value);
  }

  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new PulseIndexQueryError(`${field} must be a non-negative integer string.`);
  }
  return trimmed.replace(/^0+(?=\d)/, '');
}

/**
 * One numeric field's value: a 64-bit integer. A fraction is refused, with
 * the scaling it needs named, rather than rounded.
 */
export function toFieldValue(value: unknown, field: string): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) {
    throw new PulseIndexQueryError(`${field} must be a finite number.`);
  }
  if (!Number.isInteger(numeric)) {
    throw new PulseIndexQueryError(
      `${field} is ${numeric}, and numeric fields are whole numbers. Scale it to an ` +
        `integer and keep the scale on your side, a price in cents, a rating out of 100.`,
    );
  }
  if (!Number.isSafeInteger(numeric)) {
    throw new PulseIndexQueryError(`${field} is past the range JavaScript can hold exactly.`);
  }
  return numeric;
}

/**
 * The numeric fields of one record, from `numbers` on the input.
 *
 * Names are yours. Nothing here knows what any of them mean.
 */
function collectNumbers(merged: Record<string, unknown>): Record<string, number> {
  const source = merged.numbers;
  if (source === undefined || source === null) {
    return {};
  }
  if (typeof source !== 'object' || Array.isArray(source)) {
    throw new PulseIndexQueryError('numbers must be an object of field name to number.');
  }

  const out: Record<string, number> = {};
  for (const [name, value] of Object.entries(source as Record<string, unknown>)) {
    if (!name.trim()) {
      throw new PulseIndexQueryError('A numeric field name must not be empty.');
    }
    if (value === undefined || value === null || value === '') {
      continue;
    }
    out[name] = toFieldValue(value, name);
  }
  return out;
}

/** The positions of one record, from `points` on the input, in degrees. */
function collectPoints(merged: Record<string, unknown>): Record<string, GeoPoint> {
  const source = merged.points;
  if (source === undefined || source === null) {
    return {};
  }
  if (typeof source !== 'object' || Array.isArray(source)) {
    throw new PulseIndexQueryError('points must be an object of field name to {lat, lon}.');
  }

  const out: Record<string, GeoPoint> = {};
  for (const [name, value] of Object.entries(source as Record<string, unknown>)) {
    if (!name.trim()) {
      throw new PulseIndexQueryError('A position field name must not be empty.');
    }
    const point = asRecord(value);
    const lat = Number(point.lat ?? point.latitude);
    const lon = Number(point.lon ?? point.lng ?? point.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      throw new PulseIndexQueryError(`${name} must be {lat, lon} with finite numbers.`);
    }
    if (lat < -90 || lat > 90) {
      throw new PulseIndexQueryError(`${name}.lat is ${lat}, outside -90..90.`);
    }
    if (lon < -180 || lon > 180) {
      throw new PulseIndexQueryError(`${name}.lon is ${lon}, outside -180..180.`);
    }
    out[name] = { lat, lon };
  }
  return out;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function pushScalarTag(target: string[], value: unknown): void {
  if (typeof value === 'boolean') {
    return;
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') {
    const text = String(value).trim();
    if (text.length > 0) {
      target.push(text);
    }
  }
}

function flattenAttributes(
  attributes: Record<string, unknown>,
  points: Record<string, GeoPoint>,
): string[] {
  const categories: string[] = [];

  for (const listKey of ['categories', 'tags'] as const) {
    const list = attributes[listKey];
    if (!Array.isArray(list)) {
      continue;
    }
    for (const item of list) {
      pushScalarTag(categories, item);
    }
  }

  for (const [key, value] of Object.entries(attributes)) {
    if (SKIP_ATTRIBUTE_KEYS.has(key)) {
      continue;
    }

    if (typeof value === 'boolean') {
      if (value) {
        categories.push(key);
      }
      continue;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'boolean') {
          if (item) {
            categories.push(`${key}:true`);
          }
          continue;
        }
        if (item !== undefined && item !== null && item !== '') {
          categories.push(`${key}:${String(item)}`);
        }
      }
      continue;
    }

    if (value !== undefined && value !== null && value !== '') {
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') {
        categories.push(`${key}:${String(value)}`);
      }
    }
  }

  // Every position gets its geo tags, whichever way it arrived.
  for (const point of Object.values(points)) {
    categories.push(...GeoHash.encodeMultiTags(point.lat, point.lon));
  }

  const lat = firstNumber(attributes, ['latitude', 'lat']);
  const lon = firstNumber(attributes, ['longitude', 'lng', 'lon']);
  if (lat !== undefined && lon !== undefined) {
    categories.push(...GeoHash.encodeMultiTags(lat, lon));
  }

  // A position given in both shapes is tagged once.
  return [...new Set(categories)];
}

function firstNumber(source: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = source[key];
    if (value === undefined || value === null || value === '') {
      continue;
    }
    const numeric = typeof value === 'number' ? value : Number(value);
    if (Number.isFinite(numeric)) {
      return numeric;
    }
  }
  return undefined;
}

function firstString(source: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

export function encodeEntity(
  entityIdOrInput: EntityId | EntityInput,
  attributes: EntityAttributes = {},
  defaults: { tenantId?: string } = {},
): EncodedEntity {
  const isObjectInput =
    typeof entityIdOrInput === 'object' && entityIdOrInput !== null && !Array.isArray(entityIdOrInput);

  const input = isObjectInput ? (entityIdOrInput as EntityInput) : {};
  const nested = asRecord(input.attributes);
  const merged: Record<string, unknown> = {
    ...input,
    ...nested,
    ...attributes,
  };

  const rawId =
    (!isObjectInput ? entityIdOrInput : undefined) ??
    input.id ??
    input.entityId ??
    input.entity_id ??
    nested.id ??
    nested.entityId ??
    nested.entity_id;

  if (rawId === undefined || rawId === null || rawId === '') {
    throw new PulseIndexQueryError('entityId is required.');
  }

  const tenantId =
    firstString(merged, ['tenantId', 'tenant_id']) ?? defaults.tenantId ?? '';

  const points = collectPoints(merged);

  return {
    entityId: toUint64String(rawId as EntityId, 'entityId'),
    categories: flattenAttributes(merged, points),
    numbers: collectNumbers(merged),
    points,
    tenantId,
  };
}

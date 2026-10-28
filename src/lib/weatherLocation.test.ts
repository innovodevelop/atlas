import { describe, expect, test } from 'bun:test';
import { cityOfZone, locationKey, parsePlace, parsePlaces, placeLabel, resolveLocation, validPlace } from './weatherLocation';

const AARHUS = { name: 'Aarhus', country: 'DK', state: 'Central Denmark Region', lat: 56.15, lon: 10.21 };

describe('weather location', () => {
  test('a place needs a name and real coordinates', () => {
    expect(validPlace(AARHUS)).toEqual(AARHUS);
    expect(validPlace({ ...AARHUS, lat: 91 })).toBeNull();
    expect(validPlace({ ...AARHUS, name: '  ' })).toBeNull();
    expect(validPlace({ name: 'X', lat: '1', lon: 2 })).toBeNull();
    expect(validPlace(null)).toBeNull();
  });

  test('the stored pick parses, and garbage is no pick', () => {
    expect(parsePlace(JSON.stringify(AARHUS))?.name).toBe('Aarhus');
    expect(parsePlace('{not json')).toBeNull();
    expect(parsePlace(null)).toBeNull();
  });

  test('the geocoder’s list keeps only well-formed matches', () => {
    expect(parsePlaces({ places: [AARHUS, { name: 'Bad' }] })).toHaveLength(1);
    expect(parsePlaces({})).toEqual([]);
    expect(parsePlaces(null)).toEqual([]);
  });

  test('labels skip the empty parts', () => {
    expect(placeLabel(AARHUS)).toBe('Aarhus, Central Denmark Region, DK');
    expect(placeLabel({ name: 'Paris', country: 'FR', state: null })).toBe('Paris, FR');
  });

  test('a time zone names a city, except the ones that name none', () => {
    expect(cityOfZone('Europe/Copenhagen')).toBe('Copenhagen');
    expect(cityOfZone('America/Argentina/Buenos_Aires')).toBe('Buenos Aires');
    expect(cityOfZone('Etc/UTC')).toBeNull();
    expect(cityOfZone('UTC')).toBeNull();
    expect(cityOfZone(null)).toBeNull();
  });

  test('the pick wins, then the time zone, then the old default', () => {
    expect(resolveLocation(AARHUS, 'Europe/Copenhagen')).toMatchObject({ city: 'Aarhus', lat: 56.15, source: 'picked' });
    expect(resolveLocation(null, 'Europe/Copenhagen')).toMatchObject({ city: 'Copenhagen', lat: null, source: 'timezone' });
    expect(resolveLocation(null, 'Etc/UTC')).toMatchObject({ city: 'San Francisco', source: 'default' });
  });

  test('the poll key names everything the request carries', () => {
    expect(locationKey({ city: 'Aarhus', lat: 56.15, lon: 10.21 })).toBe('Aarhus@56.1500,10.2100');
    expect(locationKey({ city: 'Copenhagen', lat: null, lon: null })).toBe('Copenhagen');
  });
});

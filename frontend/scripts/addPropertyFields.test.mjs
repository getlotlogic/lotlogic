// Unit tests for AddPropertyForm's pure helpers (src/lib/addPropertyFields.js).
import test from 'node:test';
import assert from 'node:assert/strict';

import { manualAddressValid, placeToFields } from '../src/lib/addPropertyFields.js';

test('manualAddressValid accepts a complete, well-formed address', () => {
  assert.equal(manualAddressValid({ line1: '123 Main St', city: 'Charlotte', state: 'NC', zip: '28205' }), true);
});

test('manualAddressValid accepts a ZIP+4', () => {
  assert.equal(manualAddressValid({ line1: '123 Main St', city: 'Charlotte', state: 'NC', zip: '28205-1234' }), true);
});

test('manualAddressValid rejects a state that is not two letters', () => {
  assert.equal(manualAddressValid({ line1: '123 Main St', city: 'Charlotte', state: 'North Carolina', zip: '28205' }), false);
  assert.equal(manualAddressValid({ line1: '123 Main St', city: 'Charlotte', state: 'N', zip: '28205' }), false);
});

test('manualAddressValid rejects a malformed ZIP', () => {
  assert.equal(manualAddressValid({ line1: '123 Main St', city: 'Charlotte', state: 'NC', zip: '2820' }), false);
  assert.equal(manualAddressValid({ line1: '123 Main St', city: 'Charlotte', state: 'NC', zip: 'ABCDE' }), false);
});

test('manualAddressValid rejects a blank line1 or city', () => {
  assert.equal(manualAddressValid({ line1: '', city: 'Charlotte', state: 'NC', zip: '28205' }), false);
  assert.equal(manualAddressValid({ line1: '123 Main St', city: '  ', state: 'NC', zip: '28205' }), false);
});

test('manualAddressValid tolerates undefined/missing fields', () => {
  assert.equal(manualAddressValid(), false);
  assert.equal(manualAddressValid({}), false);
});

test('placeToFields maps a Place with LatLng-method location', () => {
  const place = {
    formattedAddress: '123 Main St, Charlotte, NC 28205',
    id: 'ChIJ_fake_place_id',
    location: { lat: () => 35.2271, lng: () => -80.8431 },
  };
  assert.deepEqual(placeToFields(place), {
    address: '123 Main St, Charlotte, NC 28205',
    place_id: 'ChIJ_fake_place_id',
    lat: 35.2271,
    lng: -80.8431,
  });
});

test('placeToFields maps a Place with a plain {lat,lng} location', () => {
  const place = {
    formattedAddress: '123 Main St, Charlotte, NC 28205',
    id: 'ChIJ_fake_place_id',
    location: { lat: 35.2271, lng: -80.8431 },
  };
  assert.deepEqual(placeToFields(place), {
    address: '123 Main St, Charlotte, NC 28205',
    place_id: 'ChIJ_fake_place_id',
    lat: 35.2271,
    lng: -80.8431,
  });
});

test('placeToFields returns null for a null/undefined place', () => {
  assert.equal(placeToFields(null), null);
  assert.equal(placeToFields(undefined), null);
});

test('placeToFields tolerates a place with no location', () => {
  assert.deepEqual(placeToFields({ formattedAddress: '123 Main St', id: 'x' }), {
    address: '123 Main St', place_id: 'x', lat: null, lng: null,
  });
});

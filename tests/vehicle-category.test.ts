import { expect, it } from 'vitest';
import { vehicleTags } from '../shared/vehicle-category';
it('classifies pickup and SUV variants independently', () => {
  expect(vehicleTags('Patrol Pickup 1997.zip', ['SUV'])).toEqual(['pickup']);
  expect(vehicleTags('Patrol 2025.zip', ['SUV'])).toEqual(['suv']);
  expect(vehicleTags('Tesla_Cybertruck_PACK.zip', [])).toEqual(['pickup']);
});
it('does not classify a coupe as a sedan based on copied donor metadata', () => {
  expect(vehicleTags('280ZX 1979.zip', ['Sedan'])).toEqual(['coupe']);
  expect(vehicleTags('A8 2023.zip', ['Luxury Sedan'])).toEqual(['sedan']);
});

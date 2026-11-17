import { expect, it, vi } from 'vitest';
import { loadCatalog } from '../src/catalog';
it('loads all 193 cars without a user pagination action', async () => {
  const cars = Array.from({ length: 193 }, (_, index) => ({ id: String(index) }));
  const fetchPage = vi.fn(async (page: number, limit: number) => ({ items: cars.slice((page - 1) * limit, page * limit), total: cars.length }));
  const result = await loadCatalog(fetchPage);
  expect(result?.items).toEqual(cars); expect(result?.total).toBe(193); expect(fetchPage).toHaveBeenCalledTimes(4);
});
it('discards a response after changing the section or search', async () => {
  let active = true;
  const result = await loadCatalog(async () => { active = false; return { items: [{ id: 'old-car' }], total: 1 }; }, () => active);
  expect(result).toBe(null);
});
it('deduplicates overlapping listings when the catalog changes during loading', async () => {
  const result = await loadCatalog(async page => ({ items: Array.from({ length: 60 }, (_, index) => ({ id: String((page - 1) * 59 + index) })), total: 120 }));
  expect(result?.items).toHaveLength(119);
});

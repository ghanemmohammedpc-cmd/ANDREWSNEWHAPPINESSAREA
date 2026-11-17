export async function loadCatalog<T extends { id: string }>(fetchPage: (page: number, limit: number) => Promise<{ items: T[]; total: number }>, active = () => true) {
  const items = new Map<string, T>();
  const limit = 60;
  for (let page = 1; active(); page++) {
    const result = await fetchPage(page, limit);
    if (!active()) return null;
    for (const item of result.items) items.set(item.id, item);
    if (result.items.length < limit || page * limit >= result.total) return { items: [...items.values()], total: result.total };
  }
  return null;
}

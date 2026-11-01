import pg from 'pg';

export type GanjineEvent = { id: string; kind: string; address: string | null; tags: string[] };

/** Anyone with database access can NOTIFY, so only known fields pass. An event is a hint: read through the verified path. */
export function parseEvent(text: string): GanjineEvent | null {
  try {
    const e = JSON.parse(text);
    if (typeof e.id !== 'string' || typeof e.kind !== 'string') return null;
    return { id: e.id, kind: e.kind, address: typeof e.address === 'string' ? e.address : null, tags: Array.isArray(e.tags) ? e.tags.filter((t: unknown) => typeof t === 'string') : [] };
  } catch {
    return null;
  }
}

export async function subscribe(url: string, on: (e: GanjineEvent) => void) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  client.on('notification', (n) => {
    const e = parseEvent(n.payload ?? '');
    if (e) on(e);
  });
  await client.query('LISTEN ganjine_events');
  return client;
}

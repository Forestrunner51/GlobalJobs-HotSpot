import { beforeEach, describe, expect, it, vi } from 'vitest';
import { markApplied, recordJob } from '../src/core/applications';
import { changeApps, loadApps } from '../src/core/storage';

// An in-memory chrome.storage.local, with getKeys like Chrome 130+.
let store: Record<string, unknown>;
const sets: string[][] = [];
beforeEach(() => {
  store = {};
  sets.length = 0;
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: async (keys: string[] | string | null) => (keys === null ? { ...store }
          : Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter((k) => k in store).map((k) => [k, store[k]]))),
        getKeys: async () => Object.keys(store),
        set: async (items: Record<string, unknown>) => { sets.push(Object.keys(items)); Object.assign(store, items); },
        remove: async (keys: string[] | string) => { for (const k of [keys].flat()) delete store[k]; },
      },
    },
  });
});

const a = { url: 'https://job-boards.greenhouse.io/acme/jobs/1', title: 'A' };
const b = { url: 'https://job-boards.greenhouse.io/acme/jobs/2', title: 'B' };

describe('application history storage', () => {
  it('moves a 0.3.0 history (one key) to one key per job', async () => {
    store.applications = recordJob({}, a);
    store.resume = { data: 'big' };
    expect(Object.keys(await loadApps())).toEqual(['greenhouse:1']);
    expect(Object.keys(store).sort()).toEqual(['app:greenhouse:1', 'resume']);
  });

  it('writes only the jobs that changed, so tabs saving at the same moment don\'t undo each other', async () => {
    await changeApps((apps) => recordJob(recordJob(apps, a), b));
    sets.length = 0;
    // Both read the history before either writes, as two queued tabs can.
    await Promise.all([
      changeApps((apps) => markApplied(apps, a)),
      changeApps((apps) => recordJob(apps, { ...b, location: 'Austin, TX' })),
    ]);
    expect(sets.sort()).toEqual([['app:greenhouse:1'], ['app:greenhouse:2']]);
    const apps = await loadApps();
    expect(apps['greenhouse:1'].status).toBe('applied');
    expect(apps['greenhouse:2'].location).toBe('Austin, TX');
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { emptyState, loadState, saveState } from "./store";

import type { Item } from "./simkl";

/** A fresh folder per test, so nothing is read from a previous run. */
let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "salvage-simkl-"));
  process.env.SALVAGE_PLUGIN_DATA = root;
});

afterEach(async () => {
  delete process.env.SALVAGE_PLUGIN_DATA;
  await rm(root, { recursive: true, force: true });
});

const item: Item = {
  id: "297",
  title: "Charmed",
  year: 1998,
  poster: "https://simkl.in/posters/24/24273cee77f9d9f_m.jpg",
  rating: 8,
  status: "watching",
  url: "https://simkl.com/tv/297/charmed",
  activityAt: 1_768_000_000_000,
};

describe("the sync store", () => {
  test("answers a first sync when nothing has been written", async () => {
    expect(await loadState()).toEqual(emptyState());
  });

  test("keeps the snapshot each library's next delta is measured from", async () => {
    await saveState({
      snapshots: {
        shows: {
          all: "2026-05-16T00:00:00Z",
          domain: {
            all: "2026-05-16T00:00:00Z",
            removed_from_list: null,
          },
        },
      },
      checkedAt: 1_768_000_000_000,
      items: { shows: [item] },
    });

    const loaded = await loadState();
    expect(loaded.snapshots.shows?.all).toBe("2026-05-16T00:00:00Z");
    expect(loaded.snapshots.shows?.domain.all).toBe("2026-05-16T00:00:00Z");
    expect(loaded.snapshots.movies).toBeUndefined();
    expect(loaded.checkedAt).toBe(1_768_000_000_000);
    expect(loaded.items.shows).toEqual([item]);
    expect(loaded.items.movies).toBeUndefined();
  });

  test("a store it cannot read is a first sync, not a crash", async () => {
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "sync.json"), "{not json", "utf8");
    expect(await loadState()).toEqual(emptyState());
  });

  test("drops rows that no longer look like an item", async () => {
    await writeFile(
      join(root, "sync.json"),
      JSON.stringify({
        snapshots: {},
        checkedAt: null,
        items: { shows: [item, { id: "9" }, null] },
      }),
      "utf8",
    );

    const loaded = await loadState();
    expect(loaded.items.shows).toEqual([item]);
  });
});

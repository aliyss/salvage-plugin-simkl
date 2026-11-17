import { describe, expect, test } from "bun:test";

import {
  changedAnywhere,
  dropMissing,
  idOf,
  mergeItems,
  syncPlan,
  toItem,
  typeSnapshot,
} from "./simkl";

import type { Activities, Item, TypeSnapshot } from "./simkl";

const show = {
  added_to_watchlist_at: "2018-02-24T23:55:13Z",
  last_watched_at: "2026-05-15T00:35:15Z",
  user_rated_at: null,
  user_rating: 8,
  status: "watching",
  last_watched: "S01E02",
  next_to_watch: "S01E03",
  watched_episodes_count: 2,
  total_episodes_count: 12,
  show: {
    title: "Charmed",
    poster: "24/24273cee77f9d9f",
    year: 1998,
    ids: { simkl: 297, slug: "charmed" },
  },
};

const movie = {
  added_to_watchlist_at: "2026-05-15T00:35:15Z",
  status: "completed",
  movie: {
    title: "The Godfather",
    poster: "16/16913426086fc13",
    year: 1972,
    ids: { simkl: 35426, slug: "the-godfather" },
  },
};

describe("a SIMKL entry", () => {
  test("becomes a card with its poster, year and the account's score", () => {
    expect(toItem(show, "shows")).toEqual({
      id: "297",
      title: "Charmed",
      year: 1998,
      poster: "https://simkl.in/posters/24/24273cee77f9d9f_m.jpg",
      rating: 8,
      status: "watching",
      url: "https://simkl.com/tv/297/charmed",
      activityAt: Date.parse("2026-05-15T00:35:15Z"),
    });
  });

  test("points a film at its own page, not at a show's", () => {
    const item = toItem(movie, "movies");
    expect(item?.url).toBe("https://simkl.com/movies/35426/the-godfather");
    expect(item?.rating).toBeNull();
    expect(item?.activityAt).toBe(Date.parse("2026-05-15T00:35:15Z"));
  });

  test("reads the bucket a client id registered before the rename sees", () => {
    expect(toItem({ ...show, status: "notinteresting" }, "shows")?.status).toBe(
      "dropped",
    );
  });

  test("keeps an unreadable bucket as no bucket, so nothing fades", () => {
    expect(toItem({ ...show, status: "somewhere" }, "shows")?.status).toBeNull();
  });

  test("drops a poster that is not a path on SIMKL's image host", () => {
    const item = toItem(
      { ...show, show: { ...show.show, poster: "https://evil.example/x.jpg" } },
      "shows",
    );
    expect(item?.poster).toBeNull();
  });

  test("is skipped when it has no title to draw", () => {
    expect(
      toItem({ ...show, show: { ...show.show, title: "  " } }, "shows"),
    ).toBeNull();
  });

  test("takes the latest of its own times as when it was last touched", () => {
    const item = toItem(
      { ...movie, user_rated_at: "2026-06-01T10:00:00Z" },
      "movies",
    );
    expect(item?.activityAt).toBe(Date.parse("2026-06-01T10:00:00Z"));
  });

  test("is dated at the epoch when SIMKL reports no time at all", () => {
    const item = toItem({ show: movie.movie, status: "completed" }, "movies");
    expect(item?.activityAt).toBe(0);
  });

  test("reads an id from an ids-only row, where there is no title", () => {
    expect(idOf({ show: { ids: { simkl: 297 } } })).toBe("297");
    expect(idOf({ ids: { simkl: 12 } })).toBe("12");
    expect(idOf({ movie: { ids: { simkl_id: 7 } } })).toBe("7");
    expect(idOf({ title: "no id" })).toBeNull();
  });
});

const card = (over: Partial<Item>): Item => ({
  id: "1",
  title: "One",
  year: null,
  poster: null,
  rating: null,
  status: "watching",
  url: null,
  activityAt: 0,
  ...over,
});

describe("a delta", () => {
  test("replaces an item it names and keeps the rest", () => {
    const stored = [card({ id: "1" }), card({ id: "2", status: "completed" })];
    const merged = mergeItems(stored, [
      card({ id: "2", status: "watching", activityAt: 5 }),
      card({ id: "3", title: "Three" }),
    ]);

    expect(merged.map((item) => item.id)).toEqual(["1", "2", "3"]);
    expect(merged[1]?.status).toBe("watching");
    expect(merged[1]?.activityAt).toBe(5);
  });

  test("brings an item back when the account adds it again", () => {
    const stored = [card({ id: "1", removed: true })];
    const merged = mergeItems(stored, [card({ id: "1" })]);
    expect(merged[0]?.removed).toBe(false);
  });
});

describe("reconciling deletions", () => {
  test("marks what SIMKL no longer holds and keeps it for its note", () => {
    const stored = [card({ id: "1" }), card({ id: "2" })];
    const next = dropMissing(stored, new Set(["1"]));

    expect(next).toHaveLength(2);
    expect(next[0]?.removed ?? false).toBe(false);
    expect(next[1]?.removed).toBe(true);
  });

  test("leaves an item alone when nothing changed about it", () => {
    const stored = [card({ id: "1", activityAt: 9 })];
    expect(dropMissing(stored, new Set(["1"]))[0]).toBe(stored[0]);
  });
});

describe("the sync plan", () => {
  const before: Activities = {
    all: "2026-05-14T07:12:20Z",
    tv_shows: {
      all: "2026-05-14T06:49:56Z",
      removed_from_list: "2026-04-10T05:34:55Z",
    },
    anime: {
      all: "2026-05-14T06:50:38Z",
      removed_from_list: "2026-04-10T05:34:55Z",
    },
    movies: {
      all: "2026-05-14T06:50:38Z",
      removed_from_list: "2026-04-10T05:34:55Z",
    },
  };

  test("reads the whole library when there is no snapshot yet", () => {
    expect(syncPlan(null, typeSnapshot(before, "shows"))).toEqual({
      first: true,
      delta: false,
      reconcile: false,
    });
  });

  test("asks for nothing when the library did not move", () => {
    const snapshot = typeSnapshot(before, "shows");
    expect(syncPlan(snapshot, snapshot)).toEqual({
      first: false,
      delta: false,
      reconcile: false,
    });
  });

  test("asks for a delta of the library that moved, and only that one", () => {
    const after: Activities = {
      ...before,
      all: "2026-05-16T00:00:00Z",
      anime: {
        all: "2026-05-16T00:00:00Z",
        removed_from_list: "2026-04-10T05:34:55Z",
      },
    };
    expect(
      syncPlan(typeSnapshot(before, "anime"), typeSnapshot(after, "anime")).delta,
    ).toBe(true);
    expect(
      syncPlan(typeSnapshot(before, "shows"), typeSnapshot(after, "shows")).delta,
    ).toBe(false);
    expect(
      syncPlan(
        typeSnapshot(before, "movies"),
        typeSnapshot(after, "movies"),
      ).delta,
    ).toBe(false);
  });

  test("reconciles ids when the account deleted something", () => {
    const after: Activities = {
      ...before,
      all: "2026-05-16T00:00:00Z",
      movies: {
        all: "2026-05-14T06:50:38Z",
        removed_from_list: "2026-05-16T00:00:00Z",
      },
    };
    expect(
      syncPlan(typeSnapshot(before, "movies"), typeSnapshot(after, "movies")),
    ).toEqual({ first: false, delta: false, reconcile: true });
  });

  test("hands back the top-level timestamp for date_from, not the library's", () => {
    const snapshot: TypeSnapshot = typeSnapshot(before, "shows");
    expect(snapshot.all).toBe("2026-05-14T07:12:20Z");
    expect(snapshot.domain.all).toBe("2026-05-14T06:49:56Z");
  });

  test("treats a library that never had activity as never having moved", () => {
    const empty: Activities = { all: null };
    const snapshot = typeSnapshot(empty, "shows");
    expect(snapshot).toEqual({
      all: null,
      domain: { all: null, removed_from_list: null },
    });
    expect(syncPlan(snapshot, snapshot).delta).toBe(false);
    expect(changedAnywhere(empty, empty)).toBe(false);
  });

  test("stops at the gate when the whole account is unchanged", () => {
    expect(changedAnywhere(before, { ...before })).toBe(false);
    expect(changedAnywhere(before, { ...before, all: "2026-05-17T00:00:00Z" })).toBe(
      true,
    );
    expect(changedAnywhere(null, before)).toBe(true);
  });
});

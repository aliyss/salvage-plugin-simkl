import { createHash } from "node:crypto";

import { keepCovers, keptCovers } from "./covers";
import { episodePage, fetchEpisodes, linkFromUrl } from "./episodes";
import { PluginError, serve } from "./sdk";
import {
  dropMissing,
  fetchActivities,
  fetchIds,
  fetchItems,
  fetchViewer,
  LIST_STATUSES,
  MEDIA_TYPES,
  mergeItems,
  refreshAccessToken,
  syncPlan,
  TokenRefused,
  typeSnapshot,
} from "./simkl";
import {
  loadState,
  loadToken,
  saveState,
  saveToken,
  type SyncState,
} from "./store";
import type { CoverColours } from "./covers";
import type { Credentials, Item, MediaType } from "./simkl";
import type { Data, Paging, Subject } from "./sdk";

const DEFAULT_PER_PAGE = 30;
const MIN_PER_PAGE = 5;
const MAX_PER_PAGE = 50;
/**
 * How long an answer from the gate is trusted. A canvas asks once per page and
 * once per view it opens; the checks in between would all be answered "nothing
 * changed", and SIMKL asks apps to sync on what the user did, not on a timer.
 */
const CHECK_MS = 2 * 60 * 1000;
/** The metadata of the notes a canvas names is asked for in one lookup. */
const MAX_KNOWN = 40;
/** Only a SIMKL id can name an item, so nothing else is looked up. */
const ITEM_ID = /^\d{1,10}$/;

function credentialsOf(
  secrets: Record<string, string> | undefined,
): Credentials {
  const clientId = secrets?.clientId?.trim() ?? "";
  const token = secrets?.token?.trim() ?? "";
  if (!clientId || !token) {
    throw new PluginError(
      "bad_subject",
      "Sign in to SIMKL in this plugin's settings first.",
    );
  }
  const refreshToken = secrets?.refreshToken?.trim();
  return refreshToken ? { clientId, token, refreshToken } : { clientId, token };
}

/**
 * Which sign-in a kept token belongs to. A new sign-in writes a new token to
 * the helper, and a copy refilled from that one has to stop answering for the
 * old token rather than outlive it.
 */
function tokenFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 12);
}

/**
 * Runs one visit with a token that works.
 *
 * The helper holds the token a sign-in produced, and SIMKL expires an access
 * token after a week. When that happens the refresh token the sign-in also left
 * behind buys a new one, and the copy is kept here so every later visit starts
 * with it instead of spending a request to be refused first.
 */
async function withToken<T>(
  credentials: Credentials,
  run: (credentials: Credentials) => Promise<T>,
): Promise<T> {
  const from = tokenFingerprint(credentials.token);
  const kept = await loadToken(from);
  const current = kept ? { ...credentials, token: kept } : credentials;
  try {
    return await run(current);
  } catch (error) {
    if (!(error instanceof TokenRefused)) {
      throw error;
    }
    const fresh = await refreshAccessToken(current);
    if (!fresh) {
      throw error;
    }
    await saveToken(from, fresh);
    return await run({ ...credentials, token: fresh });
  }
}

function typeOf(value: unknown): MediaType {
  return value === "movies" || value === "anime" ? value : "shows";
}

/**
 * The lists a canvas shows. The canvas saves them as one string of the buckets
 * ticked in its settings; nothing ticked means all of them.
 */
function listsOf(value: unknown): Set<string> {
  const picked = (typeof value === "string" ? value.split(",") : [])
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry): entry is string =>
      (LIST_STATUSES as readonly string[]).includes(entry),
    );
  return new Set(picked.length > 0 ? picked : LIST_STATUSES);
}

function perPageOf(value: unknown): number {
  const wanted =
    typeof value === "number" ? Math.round(value) : DEFAULT_PER_PAGE;
  return Math.min(MAX_PER_PAGE, Math.max(MIN_PER_PAGE, wanted));
}

/** The page a canvas asked for: where it starts, and how much it holds. */
function pageOf(
  paging: Paging | undefined,
  perPage: number,
): { offset: number; limit: number } {
  const limit = Math.min(
    MAX_PER_PAGE,
    Math.max(MIN_PER_PAGE, Math.round(paging?.limit ?? perPage)),
  );
  const offset = Math.max(0, Math.round(paging?.offset ?? 0));
  // The whole library is already on this computer, so a page is a slice of it
  // rather than a number SIMKL has to be asked about.
  return { offset, limit };
}

/**
 * An item with the cover filed here for it, and the colour that cover leads
 * with — the two things a card draws that a sync never reports.
 */
type CardItem = Item & { cover: string | null; color: string | null };

/** One item as a card, with the colour its filed cover was read for. */
function withColour(
  item: Item,
  cover: string | null,
  colours: CoverColours,
): CardItem {
  return { ...item, cover, color: cover ? (colours[cover] ?? null) : null };
}

/**
 * The pictures of one page. A card never asks SIMKL for its cover: the plugin
 * files the copy on this computer first, and the app draws what the helper
 * serves back. A cover still missing when the page is answered leaves the card
 * as the colour block it already paints, and is filed on a later visit.
 *
 * The colour of a cover is read out of the picture here too, once in the life
 * of that picture; `colours` grows as it is read, so the caller can keep it.
 */
async function withCovers(
  items: Item[],
  colours: CoverColours,
): Promise<CardItem[]> {
  const covers = await keepCovers(
    items.map((item) => item.poster),
    colours,
  );
  return items.map((item, index) =>
    withColour(item, covers[index] ?? null, colours),
  );
}

/** The covers already held for the items a note of this canvas still points at. */
async function withHeldCovers(
  items: Item[],
  colours: CoverColours,
): Promise<CardItem[]> {
  const covers = await keptCovers(
    items.map((item) => item.poster),
    colours,
  );
  return items.map((item, index) =>
    withColour(item, covers[index] ?? null, colours),
  );
}

/**
 * What one visit costs.
 *
 * The gate first: if this library's timestamps are the ones the last sync was
 * taken at, the copy on this computer is current and nothing else is asked.
 * When it did move, the delta — the items that changed, not the library — is
 * read and merged, and a library whose deletions moved is compared by id,
 * because a deleted item never appears in a delta. Only the library this canvas
 * shows is ever pulled: SIMKL asks single-type apps to call one type.
 */
async function refresh(
  state: SyncState,
  credentials: Credentials,
  type: MediaType,
): Promise<{ state: SyncState; dirty: boolean }> {
  const now = Date.now();
  if (state.checkedAt !== null && now - state.checkedAt < CHECK_MS) {
    return { state, dirty: false };
  }

  // Read before the pull, never after: a change made while the pull runs would
  // otherwise be stamped at or below the value saved, and no later `date_from`
  // would return it.
  const activities = await fetchActivities(credentials);
  const snapshot = typeSnapshot(activities, type);
  const plan = syncPlan(state.snapshots[type] ?? null, snapshot);
  if (!plan.first && !plan.delta && !plan.reconcile) {
    return {
      state: { ...state, checkedAt: now },
      dirty: true,
    };
  }

  let items = state.items[type] ?? [];
  if (plan.first) {
    items = await fetchItems(credentials, type);
  } else if (plan.delta) {
    items = mergeItems(
      items,
      await fetchItems(credentials, type, {
        // The top-level timestamp of the answer this library was last pulled
        // at, handed back exactly as SIMKL gave it.
        dateFrom: state.snapshots[type]?.all ?? null,
      }),
    );
  }
  if (plan.reconcile) {
    items = dropMissing(items, await fetchIds(credentials, type));
  }

  return {
    state: {
      snapshots: { ...state.snapshots, [type]: snapshot },
      checkedAt: now,
      items: { ...state.items, [type]: items },
      colours: state.colours,
    },
    dirty: true,
  };
}

/** The metadata this computer still holds for the ids a canvas named. */
function knownFor(subject: Subject | undefined, state: SyncState): Item[] {
  const ids = [...new Set((subject?.data?.ids ?? "").split(","))]
    .map((id) => id.trim())
    .filter((id) => ITEM_ID.test(id))
    .slice(0, MAX_KNOWN);
  if (ids.length === 0) {
    return [];
  }

  const byId = new Map<string, Item>();
  for (const type of MEDIA_TYPES) {
    for (const item of state.items[type] ?? []) {
      byId.set(item.id, item);
    }
  }
  return ids.flatMap((id) => {
    const item = byId.get(id);
    return item ? [item] : [];
  });
}

/**
 * The library the canvas shows: one page of it, the notes it knows, and whether
 * more follow. The order is the account's own history — what it touched most
 * recently first — because watch state is what a sync reports; a cover's colour
 * is read off the picture, and is what the colour view sorts a page by.
 */
async function catalogue(
  settings: Record<string, unknown>,
  subject: Subject | undefined,
  secrets: Record<string, string> | undefined,
  paging: Paging | undefined,
): Promise<Data> {
  const credentials = credentialsOf(secrets);
  const type = typeOf(settings.type);
  const perPage = perPageOf(settings.perPage);
  const { offset, limit } = pageOf(paging, perPage);
  const wanted = listsOf(settings.lists);

  const loaded = await loadState();
  let state = loaded;
  try {
    state = await withToken(credentials, async (live) => {
      const refreshed = await refresh(loaded, live, type);
      if (refreshed.dirty) {
        await saveState(refreshed.state);
      }
      return refreshed.state;
    });
  } catch (error) {
    // A canvas holding the library as it was last read is worth more than a
    // blank one, so a failed sync answers from what is here and tries again on
    // the next visit. Nothing is saved, so the next attempt sends the same
    // `date_from` and picks up what this one did not get. The token itself is
    // checked by the settings page's own `whoami`, which does report a token
    // SIMKL refused.
    if ((loaded.items[type] ?? []).length === 0) {
      throw error;
    }
  }

  const library = state.items[type] ?? [];
  const shown = library.filter(
    (item) => !item.removed && (item.status === null || wanted.has(item.status)),
  );
  const ordered = [...shown].sort(
    (left, right) =>
      right.activityAt - left.activityAt || right.id.localeCompare(left.id),
  );
  const page = ordered.slice(offset, offset + limit);

  const colours: CoverColours = { ...state.colours };
  const items = await withCovers(page, colours);
  const known = await withHeldCovers(knownFor(subject, state), colours);
  // A colour read now is a picture never decoded again, so it is kept even when
  // the sync itself had nothing to save.
  if (Object.keys(colours).length !== Object.keys(state.colours).length) {
    await saveState({ ...state, colours });
  }

  return {
    kind: "watch-catalogue",
    text: JSON.stringify({
      items,
      known,
      hasMore: offset + page.length < ordered.length,
    }),
  };
}

/**
 * Whose token this computer holds. The app asks this before it offers the
 * account's own lists, and stops offering them when SIMKL refuses the token.
 */
async function whoami(
  secrets: Record<string, string> | undefined,
): Promise<Data> {
  const credentials = credentialsOf(secrets);
  return {
    kind: "auth",
    text: await withToken(credentials, (live) => fetchViewer(live)),
  };
}

/**
 * The episodes of one show, for the button the app draws on a SIMKL entry. One
 * request per open, and never part of a sync: SIMKL answers a title's whole
 * episode list at once and caches it, and this is the one per-item lookup the
 * plugin's API rules allow.
 */
async function episodes(
  subject: Subject | undefined,
  secrets: Record<string, string> | undefined,
  paging: Paging | undefined,
): Promise<Data> {
  const link = linkFromUrl(subject?.link?.url);
  if (!link) {
    throw new PluginError(
      "bad_subject",
      "This entry does not link to a SIMKL show.",
    );
  }

  const credentials = credentialsOf(secrets);
  const list = await withToken(credentials, (live) =>
    fetchEpisodes(live, link),
  );
  return { kind: "episodes", text: episodePage(list, paging) };
}

export default () =>
  serve(async ({ command, params }) => {
    if (command === "catalogue") {
      return await catalogue(
        params.settings ?? {},
        params.subject,
        params.secrets,
        params.paging,
      );
    }
    if (command === "whoami") {
      return await whoami(params.secrets);
    }
    if (command === "episodes") {
      return await episodes(params.subject, params.secrets, params.paging);
    }

    throw new PluginError("unsupported", `Unknown command ${command}.`);
  });

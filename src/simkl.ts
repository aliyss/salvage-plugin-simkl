/**
 * Reads an account's library from SIMKL, and only the part of it that moved.
 *
 * Two endpoints, in the order SIMKL asks for them: `/sync/activities` says
 * whether anything changed at all, and `/sync/all-items` with `date_from`
 * answers just the delta. A library is read whole once, on its first sync;
 * after that a visit costs one tiny request and, when something moved, a small
 * one. Calling `/sync/all-items` without a `date_from` on every visit is the
 * traffic pattern SIMKL suspends a client id for.
 */

import { PluginError } from "./sdk";

const API = "https://api.simkl.com";
const TOKEN_URL = `${API}/oauth2/token`;
const SITE = "https://simkl.com";
const POSTERS = "https://simkl.in/posters";
const APP_NAME = "salvage";
const APP_VERSION = "0.1.0";
const USER_AGENT = `salvage-plugin-simkl/${APP_VERSION}`;
const TIMEOUT_MS = 12_000;
/** A first sync of a large library is one big answer, and still one answer. */
const MAX_BYTES = 8_000_000;
const MAX_ITEMS = 5_000;
const MAX_TITLE = 200;
const MAX_NAME = 100;
/** A poster path is `74/74415673dcdc9cdd`, and nothing longer can be one. */
const POSTER_PATH = /^\d{1,6}\/[a-z0-9]{6,40}$/i;
const MIN_YEAR = 1800;
const MAX_YEAR = 2100;
const MIN_RATING = 1;
const MAX_RATING = 10;
const RATING_STEP = 10;

export type MediaType = "shows" | "movies" | "anime";

/** The three libraries SIMKL keeps, each with its own timestamps. */
export const MEDIA_TYPES: readonly MediaType[] = ["shows", "movies", "anime"];

/** The watchlist buckets an item can sit in. */
export type ListStatus =
  | "watching"
  | "plantowatch"
  | "hold"
  | "completed"
  | "dropped";

export const LIST_STATUSES: readonly ListStatus[] = [
  "watching",
  "plantowatch",
  "completed",
  "hold",
  "dropped",
];

/** One item of the account's library, as a card needs it. */
export type Item = {
  id: string;
  title: string;
  year: number | null;
  /** The poster on SIMKL's image host, which the plugin files here. */
  poster: string | null;
  /** The account's own score, one to ten. */
  rating: number | null;
  /** The bucket it sits in, which is what a canvas dims by. */
  status: ListStatus | null;
  url: string | null;
  /**
   * When the account last touched it, in milliseconds: the latest of watching
   * an episode, rating it, and adding it to a list. The date view places the
   * card there, so the canvas reads as the account's history rather than as
   * the moment it was opened.
   */
  activityAt: number;
  /**
   * True once the account has deleted the item from its library. It stays in
   * the store so a note written about it keeps its poster, and is left out of
   * the canvas.
   */
  removed?: boolean;
};

/** The timestamps of one library: `tv_shows`, `anime` or `movies`. */
export type DomainActivities = {
  all: string | null;
  removed_from_list: string | null;
};

/** The answer of `/sync/activities`, of which two fields of each block matter. */
export type Activities = {
  all: string | null;
  tv_shows?: DomainActivities;
  anime?: DomainActivities;
  movies?: DomainActivities;
};

/**
 * Where one library was left, so the next visit can ask what changed since.
 *
 * `all` is the *top-level* timestamp of the response the library was pulled at,
 * which is what SIMKL wants handed back as `date_from`; `domain` is that
 * library's own block, which is what decides whether this library moved and
 * whether anything was deleted from it. Two libraries cannot share a snapshot:
 * a canvas only ever pulls its own type, so a shared one would move past a
 * change another library never read.
 */
export type TypeSnapshot = {
  all: string | null;
  domain: DomainActivities;
};

export type Credentials = {
  clientId: string;
  token: string;
  /** The token that can replace the one above, when the sign-in left one. */
  refreshToken?: string;
};

/**
 * The token this computer holds is no longer accepted. It carries the same code
 * the app reads, so a sign-in failure still reads as one; what is different is
 * that a refresh token can replace it without asking anybody anything.
 */
export class TokenRefused extends PluginError {
  constructor(message: string) {
    super("refused", message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shortText(value: unknown, max: number): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const text = value.trim();
  return text ? text.slice(0, max) : null;
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function simklId(value: unknown): string | null {
  const id =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : Number.NaN;
  return Number.isInteger(id) && id > 0 ? String(id) : null;
}

function idIn(value: unknown): string | null {
  if (!isRecord(value) || !isRecord(value.ids)) {
    return null;
  }
  return simklId(value.ids.simkl ?? value.ids.simkl_id);
}

/**
 * The SIMKL id of an entry. A full entry nests it under `show` or `movie`;
 * `extended=simkl_ids_only` may answer it on the entry itself, so both are read.
 */
export function idOf(row: unknown): string | null {
  if (!isRecord(row)) {
    return null;
  }
  return (
    idIn(row.show) ??
    idIn(row.movie) ??
    idIn(row) ??
    simklId(row.simkl) ??
    simklId(row.simkl_id)
  );
}

/** The catalogue item an entry describes, whichever key it arrived under. */
function mediaOf(row: Record<string, unknown>): Record<string, unknown> | null {
  if (isRecord(row.show)) {
    return row.show;
  }
  return isRecord(row.movie) ? row.movie : null;
}

function yearOf(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= MIN_YEAR &&
    value <= MAX_YEAR
    ? value
    : null;
}

/** SIMKL answers a poster path; the picture itself is one suffix and a host. */
function posterOf(value: unknown): string | null {
  const path = shortText(value, 128);
  if (!path || !POSTER_PATH.test(path)) {
    return null;
  }
  return `${POSTERS}/${path}_m.jpg`;
}

function ratingOf(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  if (value < MIN_RATING || value > MAX_RATING) {
    return null;
  }
  return Math.round(value * RATING_STEP) / RATING_STEP;
}

/**
 * The bucket an item sits in. A client id registered before SIMKL renamed the
 * bucket still reads `notinteresting` where `dropped` would appear.
 */
function statusOf(value: unknown): ListStatus | null {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  const status = raw === "notinteresting" ? "dropped" : raw;
  return (LIST_STATUSES as readonly string[]).includes(status)
    ? (status as ListStatus)
    : null;
}

function pageUrl(type: MediaType, id: string, slug: string | null): string {
  const segment = type === "shows" ? "tv" : type;
  return `${SITE}/${segment}/${id}${slug ? `/${slug}` : ""}`;
}

function latestTime(...values: unknown[]): number {
  let latest = 0;
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }
    const at = Date.parse(value);
    if (Number.isFinite(at) && at > latest) {
      latest = at;
    }
  }
  return latest;
}

/** One entry of `/sync/all-items`, or null when it cannot be drawn as a card. */
export function toItem(row: unknown, type: MediaType): Item | null {
  if (!isRecord(row)) {
    return null;
  }
  const media = mediaOf(row);
  const id = idOf(row);
  const title = media ? shortText(media.title, MAX_TITLE) : null;
  if (!id || !title || !media) {
    return null;
  }

  const slug = isRecord(media.ids) ? shortText(media.ids.slug, MAX_TITLE) : null;

  return {
    id,
    title,
    year: yearOf(media.year),
    poster: posterOf(media.poster),
    rating: ratingOf(row.user_rating),
    status: statusOf(row.status),
    url: pageUrl(type, id, slug),
    activityAt: latestTime(
      row.last_watched_at,
      row.added_to_watchlist_at,
      row.user_rated_at,
    ),
  };
}

/**
 * Merges a delta into the library already held. A delta is only the items that
 * changed, so anything it does not name stays as it was; an item it does name
 * is replaced whole, because SIMKL sends its current state, not a patch.
 */
export function mergeItems(
  stored: readonly Item[],
  delta: readonly Item[],
): Item[] {
  const byId = new Map(stored.map((item) => [item.id, item]));
  for (const item of delta) {
    byId.set(item.id, { ...item, removed: false });
  }
  // The currency of the store is "everything ever seen", in insertion order, so
  // the oldest entries are the ones that fall off a cap.
  return [...byId.values()].slice(-MAX_ITEMS);
}

/**
 * Marks the items the account has deleted. `date_from` never reports removals,
 * so the only way to find them is to compare the ids SIMKL still has against
 * the ids held here — after which the item is kept, because a note about it may
 * still be on a canvas, but no longer drawn.
 */
export function dropMissing(
  stored: readonly Item[],
  present: ReadonlySet<string>,
): Item[] {
  return stored.map((item) => {
    const gone = !present.has(item.id);
    return (item.removed ?? false) === gone ? item : { ...item, removed: gone };
  });
}

/** The activity block of one library. Shows and anime share SIMKL's `tv_shows`. */
export function domainOf(
  activities: Activities,
  type: MediaType,
): DomainActivities {
  const raw =
    type === "movies"
      ? activities.movies
      : type === "anime"
        ? activities.anime
        : activities.tv_shows;
  return {
    all: raw?.all ?? null,
    removed_from_list: raw?.removed_from_list ?? null,
  };
}

/** The snapshot to keep for one library, taken from one activities answer. */
export function typeSnapshot(
  activities: Activities,
  type: MediaType,
): TypeSnapshot {
  return { all: activities.all, domain: domainOf(activities, type) };
}

function parseDomain(value: unknown): DomainActivities | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return {
    all: textOrNull(value.all),
    removed_from_list: textOrNull(value.removed_from_list),
  };
}

/** Read from either a response or the snapshot this computer saved. */
export function parseActivities(value: unknown): Activities | null {
  if (!isRecord(value)) {
    return null;
  }
  return {
    all: textOrNull(value.all),
    tv_shows: parseDomain(value.tv_shows),
    anime: parseDomain(value.anime),
    movies: parseDomain(value.movies),
  };
}

/** A saved snapshot, or null when the file no longer holds one. */
export function parseSnapshot(value: unknown): TypeSnapshot | null {
  if (!isRecord(value) || !isRecord(value.domain)) {
    return null;
  }
  return {
    all: textOrNull(value.all),
    domain: {
      all: textOrNull(value.domain.all),
      removed_from_list: textOrNull(value.domain.removed_from_list),
    },
  };
}

/** Whether anything at all moved since the snapshot. */
export function changedAnywhere(
  previous: Activities | null,
  next: Activities,
): boolean {
  if (!previous) {
    return true;
  }
  return (previous.all ?? "") !== (next.all ?? "");
}

/** What has to be fetched for one library to be current. */
export type SyncPlan = {
  /** Nothing is held yet, so the whole library is read. */
  first: boolean;
  /** The library moved, so `date_from` answers the items that did. */
  delta: boolean;
  /** Items may have been deleted, which only an id comparison can find. */
  reconcile: boolean;
};

export function syncPlan(
  previous: TypeSnapshot | null,
  next: TypeSnapshot,
): SyncPlan {
  if (!previous) {
    return { first: true, delta: false, reconcile: false };
  }
  return {
    first: false,
    delta: (previous.domain.all ?? "") !== (next.domain.all ?? ""),
    reconcile:
      (previous.domain.removed_from_list ?? "") !==
      (next.domain.removed_from_list ?? ""),
  };
}

async function failureMessage(response: Response): Promise<string | null> {
  const raw = await new Response(response.body).text().catch(() => "");
  try {
    const body: unknown = JSON.parse(raw);
    return isRecord(body) ? shortText(body.message, 200) : null;
  } catch {
    return null;
  }
}

/**
 * One request to SIMKL. Every call names the app's own client id, because SIMKL
 * rate-limits an app rather than a person, and a plugin that hammers an
 * endpoint gets that client id suspended.
 */
export async function readJson(
  credentials: Credentials,
  path: string,
  params: Record<string, string> = {},
): Promise<unknown> {
  const url = new URL(`${API}${path}`);
  url.searchParams.set("client_id", credentials.clientId);
  url.searchParams.set("app-name", APP_NAME);
  url.searchParams.set("app-version", APP_VERSION);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": USER_AGENT,
      authorization: `Bearer ${credentials.token}`,
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch(() => null);

  if (!response) {
    throw new PluginError("refused", "SIMKL could not be reached.");
  }
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel().catch(() => undefined);
    throw new TokenRefused(
      "SIMKL did not accept that token. Approve this computer again.",
    );
  }
  if (response.status === 429) {
    await response.body?.cancel().catch(() => undefined);
    throw new PluginError(
      "refused",
      "SIMKL is rate limiting this computer. Try again in a minute.",
    );
  }
  if (!response.ok) {
    const message = await failureMessage(response);
    throw new PluginError(
      "refused",
      message ?? `SIMKL answered ${String(response.status)}.`,
    );
  }

  const raw = await new Response(response.body).text();
  if (raw.length > MAX_BYTES) {
    throw new PluginError("refused", "SIMKL answered with too much data.");
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new PluginError(
      "refused",
      "SIMKL answered with something unreadable.",
    );
  }
}

/**
 * A new access token, from the refresh token the sign-in left behind. SIMKL's
 * access tokens last a week, so this is what keeps a canvas working without
 * sending the user back through a consent page every time.
 */
export async function refreshAccessToken(
  credentials: Credentials,
): Promise<string | null> {
  if (!credentials.refreshToken) {
    return null;
  }

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": USER_AGENT,
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: credentials.clientId,
      refresh_token: credentials.refreshToken,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch(() => null);
  if (!response?.ok) {
    await response?.body?.cancel().catch(() => undefined);
    return null;
  }

  const raw = await new Response(response.body).text();
  try {
    const body: unknown = JSON.parse(raw);
    const token = isRecord(body) ? body.access_token : null;
    return typeof token === "string" && token.trim() ? token.trim() : null;
  } catch {
    return null;
  }
}

/** The timestamps every later sync is measured from. The cheapest call there is. */
export async function fetchActivities(
  credentials: Credentials,
): Promise<Activities> {
  const activities = parseActivities(
    await readJson(credentials, "/sync/activities"),
  );
  if (!activities) {
    throw new PluginError(
      "no_data",
      "SIMKL answered without any activity times.",
    );
  }
  return activities;
}

/**
 * The items of one library: all of them when `dateFrom` is absent, and only
 * those that changed strictly after it when it is not. The value is the
 * top-level `all` of the activities answer the library was last pulled at,
 * passed as it came.
 */
export async function fetchItems(
  credentials: Credentials,
  type: MediaType,
  options: { dateFrom?: string | null } = {},
): Promise<Item[]> {
  const params: Record<string, string> = {};
  if (options.dateFrom) {
    params.date_from = options.dateFrom;
  }

  const body = await readJson(credentials, `/sync/all-items/${type}`, params);
  const rows = isRecord(body) ? body[type] : null;
  // An empty library answers `{}`, which is not a failure.
  if (!Array.isArray(rows)) {
    return [];
  }

  return rows.slice(0, MAX_ITEMS).flatMap((row) => {
    const item = toItem(row, type);
    return item ? [item] : [];
  });
}

/**
 * The ids SIMKL still holds in one library, with no other field of them. This
 * is the cheapest answer the API can give, and the only way to see a deletion:
 * a removed item is never part of a `date_from` delta.
 */
export async function fetchIds(
  credentials: Credentials,
  type: MediaType,
): Promise<Set<string>> {
  const body = await readJson(credentials, `/sync/all-items/${type}`, {
    extended: "simkl_ids_only",
  });
  const rows = isRecord(body) ? body[type] : null;
  if (!Array.isArray(rows)) {
    return new Set();
  }

  const ids = new Set<string>();
  for (const row of rows) {
    const id = idOf(row);
    if (id) {
      ids.add(id);
    }
  }
  return ids;
}

/**
 * Whose token this is. The plugin's settings page asks this before it offers
 * the account's own lists, so a token SIMKL no longer accepts is not shown as
 * one that works. The name is a nicety: the request succeeding is the answer.
 */
export async function fetchViewer(credentials: Credentials): Promise<string> {
  const body = await readJson(credentials, "/users/settings");
  const user = isRecord(body) ? body.user : null;
  const name = isRecord(user)
    ? shortText(user.name ?? user.username ?? user.login, MAX_NAME)
    : null;
  return name ?? "your SIMKL account";
}

/**
 * The library this computer knows, kept in the folder the helper hands the
 * plugin. It is a sync store rather than a cache: the snapshot in it is what
 * the next visit asks SIMKL "what changed since…" with, so losing it costs a
 * full read of the library, and writing half of it would cost a wrong one. A
 * new snapshot is therefore only saved once every pull succeeded.
 *
 * Beside it sits what the sync cannot report and the pictures can: the colour
 * each filed cover leads with, so a poster is read once in its life rather than
 * once per visit.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { isColor } from "./color";
import { MEDIA_TYPES, parseSnapshot } from "./simkl";

import type { CoverColours } from "./covers";
import type { Item, MediaType, TypeSnapshot } from "./simkl";

const FILE = "sync.json";
const TOKEN_FILE = "token.json";
/** Enough for a large library, and small enough to read in a moment. */
const MAX_ITEMS = 5_000;
/** Covers outlive the items they were drawn for, so this is the generous cap. */
const MAX_COLOURS = 4_000;
const ITEM_STATUSES = [
  "watching",
  "plantowatch",
  "completed",
  "hold",
  "dropped",
];

export type SyncState = {
  /** Where each library was left, so only what moved is fetched again. */
  snapshots: Partial<Record<MediaType, TypeSnapshot>>;
  /** When the gate was last asked, so a page turn does not ask again. */
  checkedAt: number | null;
  items: Partial<Record<MediaType, Item[]>>;
  /** The colour each filed cover leads with, by the name it is filed under. */
  colours: CoverColours;
};

function stateFile(): string {
  return join(process.env.SALVAGE_PLUGIN_DATA ?? ".", FILE);
}

function tokenFile(): string {
  return join(process.env.SALVAGE_PLUGIN_DATA ?? ".", TOKEN_FILE);
}

export function emptyState(): SyncState {
  return { snapshots: {}, checkedAt: null, items: {}, colours: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isItem(value: unknown): value is Item {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.title === "string" &&
    typeof value.activityAt === "number" &&
    (value.poster === null || typeof value.poster === "string") &&
    (value.rating === null || typeof value.rating === "number") &&
    (value.status === null ||
      (typeof value.status === "string" &&
        ITEM_STATUSES.includes(value.status)))
  );
}

/** The colours a store holds, newest kept when there are more than the cap. */
function parseColours(value: unknown): CoverColours {
  if (!isRecord(value)) {
    return {};
  }
  const colours: CoverColours = {};
  for (const [name, hex] of Object.entries(value).slice(-MAX_COLOURS)) {
    if (isColor(hex)) {
      colours[name] = hex;
    }
  }
  return colours;
}

export async function loadState(): Promise<SyncState> {
  try {
    const raw = JSON.parse(await readFile(stateFile(), "utf8")) as unknown;
    if (!isRecord(raw)) {
      return emptyState();
    }

    const storedSnapshots = isRecord(raw.snapshots) ? raw.snapshots : {};
    const snapshots: Partial<Record<MediaType, TypeSnapshot>> = {};
    const storedItems = isRecord(raw.items) ? raw.items : {};
    const items: Partial<Record<MediaType, Item[]>> = {};
    for (const type of MEDIA_TYPES) {
      const snapshot = parseSnapshot(storedSnapshots[type]);
      if (snapshot) {
        snapshots[type] = snapshot;
      }
      const list = storedItems[type];
      if (Array.isArray(list)) {
        items[type] = list.filter(isItem).slice(-MAX_ITEMS);
      }
    }

    return {
      snapshots,
      checkedAt:
        typeof raw.checkedAt === "number" && Number.isFinite(raw.checkedAt)
          ? raw.checkedAt
          : null,
      items,
      colours: parseColours(raw.colours),
    };
  } catch {
    // A missing or unreadable store is simply a first sync.
    return emptyState();
  }
}

/**
 * The access token a refresh produced in an earlier visit, kept for the sign-in
 * it came from. `from` is a digest of the token the helper holds, so a new
 * sign-in — which writes a new token there — stops this copy answering for it.
 */
export async function loadToken(from: string): Promise<string | null> {
  try {
    const raw = JSON.parse(await readFile(tokenFile(), "utf8")) as unknown;
    if (
      !isRecord(raw) ||
      raw.from !== from ||
      typeof raw.value !== "string" ||
      !raw.value
    ) {
      return null;
    }
    return raw.value;
  } catch {
    return null;
  }
}

export async function saveToken(from: string, value: string): Promise<void> {
  const file = tokenFile();
  await mkdir(join(file, ".."), { recursive: true }).catch(() => undefined);
  const part = `${file}.part`;
  await writeFile(part, JSON.stringify({ from, value }), "utf8").catch(
    () => undefined,
  );
  await rename(part, file).catch(() => undefined);
}

export async function saveState(state: SyncState): Promise<void> {
  const file = stateFile();
  await mkdir(join(file, ".."), { recursive: true }).catch(() => undefined);
  // Written beside its name and moved into place: the helper answers a plugin
  // and exits, so a process killed mid-write must not leave a store that reads
  // as one it can trust.
  const part = `${file}.part`;
  await writeFile(part, JSON.stringify(state), "utf8").catch(() => undefined);
  await rename(part, file).catch(() => undefined);
}

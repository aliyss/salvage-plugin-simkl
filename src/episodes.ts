/**
 * The episodes of one show, for the button the app draws on a SIMKL entry.
 *
 * SIMKL answers a title's whole episode list in one request and caches it, and
 * its API rules allow asking for it — unlike a per-item detail fan-out across a
 * library. Nothing is stored: a list is read when it is opened, which is also
 * when it is most worth being current.
 */

import { PluginError, type Paging } from "./sdk";
import { readJson } from "./simkl";
import { keepStills } from "./still";

import type { Credentials } from "./simkl";

const MAX_EPISODES = 60;
const MAX_TITLE = 160;
const MAX_DESCRIPTION = 400;
const ISO_DATE = 10;
/** How many episodes one answer carries, so a long list grows as it is read. */
const EPISODE_PAGE = 20;
/** The site's pages: `/tv/297/charmed`, `/anime/1234/…`, `/movies/56/…`. */
const SITE_PAGE =
  /^https?:\/\/(?:www\.)?simkl\.com\/(tv|anime|movies)\/(\d{1,10})(?:[/?#]|$)/i;

/** The library a SIMKL page belongs to, and the id the API keys it by. */
export type SimklLink = { kind: "tv" | "anime" | "movies"; id: string };

/** One episode of a title, as the app's list draws it. */
export type Episode = {
  number: number;
  title: string;
  date: string | null;
  image: string | null;
  description: string | null;
  url: string | null;
  /** The name of the still kept on this computer, once it has been filed. */
  still?: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The title and id a SIMKL page names, or null for any other link. */
export function linkFromUrl(url: string | null | undefined): SimklLink | null {
  if (!url) {
    return null;
  }
  const match = SITE_PAGE.exec(url.trim());
  if (!match) {
    return null;
  }
  const id = Number(match[2]);
  if (!Number.isInteger(id) || id <= 0) {
    return null;
  }
  const kind = match[1]?.toLowerCase();
  return {
    kind: kind === "anime" ? "anime" : kind === "movies" ? "movies" : "tv",
    id: String(id),
  };
}

function wholeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function dateOf(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return /^\d{4}-\d{2}-\d{2}/.test(trimmed) ? trimmed.slice(0, ISO_DATE) : null;
}

/** A picture is only used when it is an https address. */
function httpsUrl(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.startsWith("https://") && trimmed.length <= 2_048
    ? trimmed
    : null;
}

function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const text = value
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text ? text.slice(0, max) : null;
}

type ShowNumbered = {
  row: Record<string, unknown>;
  season: number;
  episode: number;
};

/**
 * The episodes an answer holds, in the order they are watched.
 *
 * SIMKL numbers an episode inside its season, and the app's list numbers them
 * through the show — an absolute count, as AniList does — so season and episode
 * only order the rows here and the count is what is reported. Specials sit in
 * season zero and are left out: they are extras, not the run of the show.
 */
export function listFrom(rows: unknown): Episode[] {
  if (!Array.isArray(rows)) {
    return [];
  }

  const numbered: ShowNumbered[] = [];
  for (const row of rows) {
    if (!isRecord(row) || row.type === "special") {
      continue;
    }
    const season = wholeNumber(row.season) ?? 1;
    const episode = wholeNumber(row.episode);
    if (!episode || episode <= 0 || season <= 0) {
      continue;
    }
    numbered.push({ row, season, episode });
  }

  numbered.sort(
    (left, right) =>
      left.season - right.season || left.episode - right.episode,
  );

  return numbered.slice(0, MAX_EPISODES).map((entry, index) => ({
    number: index + 1,
    title:
      cleanText(entry.row.title, MAX_TITLE) ?? `Episode ${String(entry.episode)}`,
    date: dateOf(entry.row.date),
    image: httpsUrl(entry.row.img),
    description: cleanText(entry.row.description, MAX_DESCRIPTION),
    // SIMKL's episode pages are not addressable by id, so no link is offered.
    url: null,
  }));
}

/**
 * One title's episodes, with the stills filed here as the list is read: the
 * next open draws them from this computer instead of asking simkl.in.
 */
export async function fetchEpisodes(
  credentials: Credentials,
  link: SimklLink,
): Promise<Episode[]> {
  if (link.kind === "movies") {
    throw new PluginError("bad_subject", "A film has no episodes to list.");
  }

  const body = await readJson(credentials, `/${link.kind}/episodes/${link.id}`);
  const rows = Array.isArray(body)
    ? body
    : isRecord(body) && Array.isArray(body.episodes)
      ? body.episodes
      : null;
  const episodes = listFrom(rows);
  if (episodes.length === 0) {
    throw new PluginError(
      "no_data",
      "SIMKL has no episodes for that title yet.",
    );
  }

  const stills = await keepStills(episodes.map((episode) => episode.image));
  return episodes.map((episode, index) => ({
    ...episode,
    still: stills[index] ?? null,
  }));
}

/** One page of the list, as the answer text the app reads. */
export function episodePage(episodes: Episode[], paging?: Paging): string {
  // Without a page asked for, the whole list is the answer: a helper too old to
  // pass `paging` on must not be handed a first page that claims there is more.
  if (!paging) {
    return JSON.stringify({ episodes, hasMore: false });
  }

  const offset = Math.max(0, Math.round(paging.offset ?? 0));
  const limit = Math.min(
    MAX_EPISODES,
    Math.max(1, Math.round(paging.limit ?? EPISODE_PAGE)),
  );
  const page = episodes.slice(offset, offset + limit);

  // `hasMore` is what lets the app ask for the rest by scrolling, instead of
  // fetching a whole season before drawing its first line.
  return JSON.stringify({
    episodes: page,
    hasMore: offset + page.length < episodes.length,
  });
}

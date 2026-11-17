/**
 * The covers of one page of the canvas, filed on this computer before the page
 * is answered. A card never points at SIMKL for its picture: the plugin keeps
 * the cover here, the helper serves it back from disk, and the browser only
 * ever asks this machine. A page is mostly covers it already has, which costs
 * one stat each and no request at all.
 */

import { keptStill, keepStill } from "./still";

/** A page holds at most this many cards, so this is every cover on one. */
const MAX_COVERS = 50;

/** Covers are fetched a few at a time, so a page does not arrive in a burst. */
const CONCURRENCY = 4;

/**
 * How long the page waits for pictures it has never seen. SIMKL's image host
 * answers a cover in a fraction of a second, so this is time for a bad
 * connection, not a normal one; whatever is still missing by then keeps the
 * colour block the card already paints and is filed on the next visit.
 */
const BUDGET_MS = 6_000;

/** Files the covers that are missing, stopping once the budget is spent. */
async function fileMissing(
  urls: (string | null)[],
  names: (string | null)[],
  budgetMs: number,
): Promise<void> {
  const deadline = Date.now() + budgetMs;
  let next = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= urls.length) {
        return;
      }
      const url = urls[index];
      // A picture already filed needs no fetch; skipping it must not end the
      // worker, or the ones behind it on this page never get their turn.
      if (!url || names[index]) {
        continue;
      }
      // The budget is checked before each picture rather than once per page, so
      // one slow cover cannot spend it for the ones behind it.
      if (Date.now() >= deadline) {
        return;
      }
      names[index] = await keepStill(url);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, urls.length) }, worker),
  );
}

/**
 * The filed name of each poster, in the same order. A poster that could not be
 * filed is null, and its card is drawn as the colour block it always has.
 */
export async function keepCovers(
  posters: (string | null)[],
): Promise<(string | null)[]> {
  const urls = posters.slice(0, MAX_COVERS);
  const names = await Promise.all(urls.map((url) => keptStill(url)));
  if (names.some((name, index) => !name && urls[index])) {
    await fileMissing(urls, names, BUDGET_MS);
  }
  return [...names, ...posters.slice(MAX_COVERS).map(() => null)];
}

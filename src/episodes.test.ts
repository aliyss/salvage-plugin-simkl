import { describe, expect, test } from "bun:test";

import { episodePage, fetchEpisodes, linkFromUrl, listFrom } from "./episodes";

type Page = {
  episodes: { number: number; title: string; date: string | null }[];
  hasMore: boolean;
};

function read(text: string): Page {
  return JSON.parse(text) as Page;
}

describe("the SIMKL page an entry links to", () => {
  test("names the library and the id of a show", () => {
    expect(linkFromUrl("https://simkl.com/tv/297/charmed")).toEqual({
      kind: "tv",
      id: "297",
    });
    expect(linkFromUrl("https://www.simkl.com/anime/1234/one-piece")).toEqual({
      kind: "anime",
      id: "1234",
    });
    expect(linkFromUrl("http://simkl.com/movies/56")).toEqual({
      kind: "movies",
      id: "56",
    });
  });

  test("is null for a link that is not a SIMKL page", () => {
    expect(linkFromUrl("https://anilist.co/anime/1")).toBeNull();
    expect(linkFromUrl("https://simkl.com/tv/not-an-id")).toBeNull();
    expect(linkFromUrl(null)).toBeNull();
  });
});

describe("the episodes SIMKL reports", () => {
  test("are ordered through the show, however the seasons are numbered", () => {
    const episodes = listFrom([
      { season: 2, episode: 1, title: "Second season" },
      { season: 1, episode: 2, title: "One two" },
      { season: 1, episode: 1, title: "One one" },
    ]);

    expect(episodes.map((episode) => episode.number)).toEqual([1, 2, 3]);
    expect(episodes.map((episode) => episode.title)).toEqual([
      "One one",
      "One two",
      "Second season",
    ]);
  });

  test("leave the specials out, and keep the shape the app reads", () => {
    const episodes = listFrom([
      { season: 0, episode: 1, type: "special", title: "A special" },
      {
        season: 1,
        episode: 1,
        date: "1998-10-07T00:00:00Z",
        img: "https://simkl.in/episodes/1/11a_m.jpg",
        description: "<b>Pilot</b> &amp; more",
      },
      { season: 1, episode: 2, img: "http://simkl.in/episodes/2/22a_m.jpg" },
    ]);

    expect(episodes).toHaveLength(2);
    expect(episodes[0]).toEqual({
      number: 1,
      title: "Episode 1",
      date: "1998-10-07",
      image: "https://simkl.in/episodes/1/11a_m.jpg",
      description: "Pilot &amp; more",
      url: null,
    });
    // A picture that is not https is not offered, and a nameless episode still
    // has a title a card can draw.
    expect(episodes[1]?.image).toBeNull();
    expect(episodes[1]?.title).toBe("Episode 2");
  });

  test("are none at all when SIMKL answers nothing", () => {
    expect(listFrom(null)).toEqual([]);
    expect(listFrom({})).toEqual([]);
  });
});

describe("one page of episodes", () => {
  const episodes = listFrom(
    Array.from({ length: 5 }, (_, index) => ({
      season: 1,
      episode: index + 1,
      title: `Episode ${String(index + 1)}`,
    })),
  );

  test("is the whole list when no page was asked for", () => {
    expect(read(episodePage(episodes))).toEqual({
      episodes,
      hasMore: false,
    });
  });

  test("is as much as was asked for, and says whether more follow", () => {
    expect(read(episodePage(episodes, { offset: 2, limit: 2 }))).toEqual({
      episodes: episodes.slice(2, 4),
      hasMore: true,
    });
    expect(read(episodePage(episodes, { offset: 4, limit: 2 }))).toEqual({
      episodes: episodes.slice(4),
      hasMore: false,
    });
  });
});

describe("reading one title's episodes", () => {
  test("asks SIMKL for the library the link names", async () => {
    const asked: string[] = [];
    const original = globalThis.fetch.bind(globalThis);
    globalThis.fetch = (async (input: string | URL | Request) => {
      asked.push(String(input));
      return new Response(
        JSON.stringify([{ season: 1, episode: 1, title: "Pilot" }]),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    try {
      const episodes = await fetchEpisodes(
        { clientId: "client", token: "token" },
        { kind: "anime", id: "1234" },
      );
      expect(episodes[0]?.title).toBe("Pilot");
    } finally {
      globalThis.fetch = original;
    }

    expect(asked[0]).toContain("/anime/episodes/1234");
    expect(asked[0]).toContain("client_id=client");
  });

  test("refuses a film, which has no list", async () => {
    await expect(
      fetchEpisodes(
        { clientId: "client", token: "token" },
        { kind: "movies", id: "56" },
      ),
    ).rejects.toThrow("A film has no episodes to list.");
  });
});

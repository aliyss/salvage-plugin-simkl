/**
 * The colour a poster leads with, read from the copy filed on this computer.
 *
 * SIMKL's sync reports watch state and nothing about a picture, so a card has
 * no colour to be drawn or sorted by unless one is worked out here. The rule is
 * the app's own for an uploaded picture — the most common coarse colour of the
 * image — applied once, when the poster is first filed, and then kept beside
 * the store's snapshot so no later visit reads a picture it already knows.
 *
 * Only JPEG is decoded. Every poster SIMKL serves is one, so a picture in any
 * other container leaves its card as the colour block it already paints rather
 * than guessing at a colour nobody chose.
 */

import { decode } from "jpeg-js";

import { readStill } from "./still";

/** A decoded pixel is four channels, and the alpha is the last of them. */
const RGBA_CHANNELS = 4;
const ALPHA_INDEX = 3;
/** The alpha of a pixel that carries none. */
const OPAQUE_ALPHA = 255;
/** A pixel below this alpha is see-through, so it votes for no colour. */
const TRANSPARENT_ALPHA = 128;
/**
 * A poster is sampled on a grid this wide, so a cover the size of a wall costs
 * no more to read than a small one.
 */
const SAMPLE_SIZE = 64;
/** A bucket keeps the top four bits of each channel, so one bucket is 16 wide. */
const BUCKET_SHIFT = 4;
const CHANNEL_MAX = 255;
const HEX = /^#[0-9A-F]{6}$/;
/** Decoding one poster stops here, so a broken file cannot exhaust the process. */
const MAX_DECODE_MB = 96;

type Bucket = { count: number; r: number; g: number; b: number };

function isJpeg(bytes: Uint8Array): boolean {
  return (
    bytes.length > 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  );
}

function channelOf(value: number): string {
  return Math.min(CHANNEL_MAX, Math.max(0, Math.round(value)))
    .toString(16)
    .padStart(2, "0")
    .toUpperCase();
}

function hexOf(r: number, g: number, b: number): string {
  return `#${channelOf(r)}${channelOf(g)}${channelOf(b)}`;
}

/** True for a colour in the form the canvas stores one, `#RRGGBB`. */
export function isColor(value: unknown): value is string {
  return typeof value === "string" && HEX.test(value);
}

/** The most common coarse colour of a JPEG, or null when it cannot be read. */
export function leadingColorOf(bytes: Uint8Array): string | null {
  if (!isJpeg(bytes)) {
    return null;
  }

  let image: { width: number; height: number; data: Uint8Array };
  try {
    image = decode(bytes, {
      useTArray: true,
      maxMemoryUsageInMB: MAX_DECODE_MB,
    });
  } catch {
    return null;
  }
  if (image.width <= 0 || image.height <= 0) {
    return null;
  }

  const step = Math.max(
    1,
    Math.ceil(Math.max(image.width, image.height) / SAMPLE_SIZE),
  );
  const buckets = new Map<string, Bucket>();
  for (let y = 0; y < image.height; y += step) {
    for (let x = 0; x < image.width; x += step) {
      const index = (y * image.width + x) * RGBA_CHANNELS;
      if (
        (image.data[index + ALPHA_INDEX] ?? OPAQUE_ALPHA) < TRANSPARENT_ALPHA
      ) {
        continue;
      }
      const r = image.data[index] ?? 0;
      const g = image.data[index + 1] ?? 0;
      const b = image.data[index + 2] ?? 0;
      const key = `${String(r >> BUCKET_SHIFT)}-${String(g >> BUCKET_SHIFT)}-${String(
        b >> BUCKET_SHIFT,
      )}`;
      const bucket = buckets.get(key) ?? { count: 0, r: 0, g: 0, b: 0 };
      bucket.count += 1;
      bucket.r += r;
      bucket.g += g;
      bucket.b += b;
      buckets.set(key, bucket);
    }
  }

  // The bucket with the most pixels, as the average of the pixels in it: a
  // quantised bucket is a colour and a half, its average is the colour.
  let best: Bucket | null = null;
  for (const bucket of buckets.values()) {
    if (!best || bucket.count > best.count) {
      best = bucket;
    }
  }
  return best
    ? hexOf(best.r / best.count, best.g / best.count, best.b / best.count)
    : null;
}

/** The colour the filed cover of one card leads with, once it has been read. */
export async function coverColor(name: string | null): Promise<string | null> {
  const bytes = name ? await readStill(name) : null;
  return bytes ? leadingColorOf(bytes) : null;
}

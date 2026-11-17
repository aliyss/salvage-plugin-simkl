import { describe, expect, test } from "bun:test";

import { encode } from "jpeg-js";

import { isColor, leadingColorOf } from "./color";

/** A JPEG of one flat colour, which is the easiest picture to read a colour out of. */
function solid(
  width: number,
  height: number,
  [r, g, b]: [number, number, number],
): Uint8Array {
  const data = new Uint8Array(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    data[index * 4] = r;
    data[index * 4 + 1] = g;
    data[index * 4 + 2] = b;
    data[index * 4 + 3] = 255;
  }
  return new Uint8Array(encode({ width, height, data }, 90).data);
}

function channels(hex: string): [number, number, number] {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

describe("the colour a cover leads with", () => {
  test("is the colour the poster mostly is", () => {
    const hex = leadingColorOf(solid(16, 16, [200, 40, 40]));

    expect(hex).not.toBeNull();
    expect(isColor(hex)).toBe(true);
    // JPEG is lossy, so the colour is the picture's, not the one it was made
    // from, to the byte.
    const [r, g, b] = channels(hex as string);
    expect(Math.abs(r - 200)).toBeLessThan(16);
    expect(Math.abs(g - 40)).toBeLessThan(16);
    expect(Math.abs(b - 40)).toBeLessThan(16);
  });

  test("is null for a picture that is not a JPEG", () => {
    expect(leadingColorOf(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
  });

  test("is null for a JPEG that cannot be decoded", () => {
    const broken = new Uint8Array([0xff, 0xd8, 0xff, 0x00, 0x11, 0x22]);
    expect(leadingColorOf(broken)).toBeNull();
  });
});

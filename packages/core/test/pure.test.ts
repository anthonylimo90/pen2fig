import { describe, expect, it } from "vitest";
import {
  counterAlign, expandPadding, gradientTransform, layoutModeFor, normalizeWeight, parseHex, parseSize,
  pickFontStyle, primaryAlign, sizingFor,
} from "../src/pure";
import { checkBundle } from "../src/bundle";

describe("parseSize", () => {
  it("reads numbers, numeric strings and variables", () => {
    expect(parseSize(120)).toEqual({ kind: "fixed", v: 120 });
    expect(parseSize("48")).toEqual({ kind: "fixed", v: 48 });
    expect(parseSize("$space", (n) => (n === "space" ? 16 : undefined))).toEqual({ kind: "fixed", v: 16 });
    expect(parseSize("$missing")).toEqual({ kind: "unset" });
  });
  it("reads fill and fit with optional fallbacks", () => {
    expect(parseSize("fill_container")).toEqual({ kind: "fill", fb: undefined });
    expect(parseSize("fill_container(320)")).toEqual({ kind: "fill", fb: 320 });
    expect(parseSize("fit_content(48)")).toEqual({ kind: "fit", fb: 48 });
  });
  it("treats absent as unset", () => expect(parseSize(undefined)).toEqual({ kind: "unset" }));
});

describe("sizingFor", () => {
  const base = { inAutoLayout: true, hasAutoLayout: true, isFrame: true };
  it("fills only inside auto layout", () => {
    expect(sizingFor({ kind: "fill" }, base)).toBe("FILL");
    expect(sizingFor({ kind: "fill" }, { ...base, inAutoLayout: false })).toBe("FIXED");
  });
  it("hugs an unset auto-layout frame (Pencil default), not a fixed 100", () => {
    expect(sizingFor({ kind: "unset" }, base)).toBe("HUG");
    expect(sizingFor({ kind: "unset" }, { ...base, hasAutoLayout: false })).toBe("FIXED");
  });
  it("keeps fixed sizes fixed", () => expect(sizingFor({ kind: "fixed", v: 10 }, base)).toBe("FIXED"));
});

describe("layout", () => {
  it("defaults a new frame to a horizontal row", () => {
    expect(layoutModeFor(undefined, true)).toBe("HORIZONTAL");
    expect(layoutModeFor(undefined, false)).toBeUndefined();
    expect(layoutModeFor("vertical", true)).toBe("VERTICAL");
    expect(layoutModeFor("none", true)).toBe("NONE");
  });
  it("expands padding shorthands", () => {
    expect(expandPadding(8)).toEqual([8, 8, 8, 8]);
    expect(expandPadding([4, 12] as [number, number])).toEqual([4, 12, 4, 12]);
    expect(expandPadding([1, 2, 3, 4] as [number, number, number, number])).toEqual([1, 2, 3, 4]);
  });
  it("maps alignment, folding space_around into SPACE_BETWEEN", () => {
    expect(primaryAlign("space_around")).toBe("SPACE_BETWEEN");
    expect(primaryAlign("end")).toBe("MAX");
    expect(counterAlign("center")).toBe("CENTER");
    expect(counterAlign("stretch")).toBe("MIN");
  });
});

describe("colour", () => {
  it("parses short and alpha hex", () => {
    expect(parseHex("#fff")).toEqual({ r: 1, g: 1, b: 1, a: 1 });
    expect(parseHex("#00000080").a).toBeCloseTo(0.502, 2);
  });
  // Figma's gradientTransform maps node space (0..1) into gradient space, where the gradient runs
  // along x from 0 to 1. Pencil's 0° points up, so the bottom edge is the start and the top the end.
  const apply = (m: number[][], x: number, y: number) => [m[0][0] * x + m[0][1] * y + m[0][2], m[1][0] * x + m[1][1] * y + m[1][2]];
  it("runs a 0° linear gradient from bottom to top", () => {
    const m = gradientTransform({ gradientType: "linear", rotation: 0 });
    expect(apply(m, 0.5, 1)[0]).toBeCloseTo(0);
    expect(apply(m, 0.5, 0)[0]).toBeCloseTo(1);
  });
  it("runs a 90° linear gradient along the horizontal axis", () => {
    const m = gradientTransform({ gradientType: "linear", rotation: 90 });
    const a = apply(m, 0, 0.5)[0], b = apply(m, 1, 0.5)[0];
    expect(Math.abs(a - b)).toBeCloseTo(1);
  });
});

describe("fonts", () => {
  const avail = new Set(["Inter|Regular", "Inter|Semi Bold", "Inter|Bold", "Inter|Italic", "Geist|SemiBold", "Geist|Medium"]);
  it("normalises CSS weights", () => {
    expect(normalizeWeight("normal")).toBe(400);
    expect(normalizeWeight("bold")).toBe(700);
    expect(normalizeWeight("650")).toBe(700);
    expect(normalizeWeight(undefined)).toBe(400);
  });
  it("finds the foundry's spelling of a weight", () => {
    expect(pickFontStyle("Inter", 600, false, avail)).toEqual({ style: "Semi Bold", exact: true });
    expect(pickFontStyle("Geist", 600, false, avail)).toEqual({ style: "SemiBold", exact: true });
  });
  it("falls back to the nearest installed weight, then drops italic", () => {
    expect(pickFontStyle("Geist", 700, false, avail).style).toBe("SemiBold");
    expect(pickFontStyle("Inter", 400, true, avail)).toEqual({ style: "Italic", exact: true });
    expect(pickFontStyle("Geist", 500, true, avail)).toEqual({ style: "Medium", exact: false });
  });
});

describe("bundle", () => {
  const ok = { version: 1, source: { file: "a.pen", exportedAt: "2026-10-09" }, page: "P", screens: [{ id: "a", bounds: { w: 1, h: 1 }, node: { id: "a", type: "frame" } }] };
  it("accepts a valid bundle", () => expect(() => checkBundle(ok)).not.toThrow());
  it("rejects another version", () => expect(() => checkBundle({ ...ok, version: 2 })).toThrow(/version/));
  it("rejects a mismatched entry", () => expect(() => checkBundle({ ...ok, screens: [{ ...ok.screens[0], id: "b" }] })).toThrow(/wraps/));
});

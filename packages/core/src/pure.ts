// Pure translation rules: no Figma API here, so every rule is unit-tested.

import type { PenPadding, PenSize } from "./types";

export const isVarRef = (x: unknown): x is string => typeof x === "string" && x.startsWith("$");
export const varName = (x: string) => x.slice(1);

export type Size =
  | { kind: "unset" }
  | { kind: "fixed"; v: number }
  | { kind: "fill"; fb?: number }
  | { kind: "fit"; fb?: number };

/**
 * Pencil sizes: a number, a `$var`, `fill_container`, `fit_content`, either with an optional
 * fallback in parentheses (`fill_container(320)`) used when there is nothing to fill or fit.
 */
export function parseSize(s: PenSize | undefined, resolve: (name: string) => unknown = () => undefined): Size {
  if (s === undefined) return { kind: "unset" };
  if (typeof s === "number") return { kind: "fixed", v: s };
  if (isVarRef(s)) {
    const v = resolve(varName(s));
    return typeof v === "number" ? { kind: "fixed", v } : { kind: "unset" };
  }
  const m = /^(fill_container|fit_content)(?:\(([-\d.]+)\))?$/.exec(s);
  if (m) {
    const fb = m[2] !== undefined ? parseFloat(m[2]) : undefined;
    return m[1] === "fill_container" ? { kind: "fill", fb } : { kind: "fit", fb };
  }
  const f = parseFloat(s);
  return isNaN(f) ? { kind: "unset" } : { kind: "fixed", v: f };
}

export type Sizing = "FIXED" | "HUG" | "FILL";

/**
 * Figma layout sizing for one axis of a frame.
 * - `fill_container` only fills inside an auto-layout parent; elsewhere it is a fixed size.
 * - `fit_content`, and an unset size on a frame, hug when the frame itself has auto layout.
 *   (Pencil frames with no width hug their children; Figma's default is a fixed 100.)
 */
export function sizingFor(size: Size, opts: { inAutoLayout: boolean; hasAutoLayout: boolean; isFrame: boolean }): Sizing {
  if (size.kind === "fill" && opts.inAutoLayout) return "FILL";
  if ((size.kind === "fit" || (size.kind === "unset" && opts.isFrame)) && opts.hasAutoLayout) return "HUG";
  return "FIXED";
}

/** `[t,r,b,l]` from Pencil's number | [v,h] | [t,r,b,l] padding. Values may still be `$var`s. */
export function expandPadding<T>(p: T | [T, T] | [T, T, T, T]): [T, T, T, T] {
  if (!Array.isArray(p)) return [p, p, p, p];
  if (p.length === 2) return [p[0], p[1], p[0], p[1]];
  return [p[0], p[1], p[2], p[3]];
}
export type _Padding = PenPadding;

/**
 * Pencil's default layout is a row. A frame with no `layout` key is horizontal auto layout,
 * not free positioning — the most common cause of a "scrambled" port.
 */
export function layoutModeFor(layout: string | undefined, isNew: boolean): "HORIZONTAL" | "VERTICAL" | "NONE" | undefined {
  const lay = layout !== undefined ? layout : isNew ? "horizontal" : undefined;
  if (lay === undefined) return undefined;
  return lay === "vertical" ? "VERTICAL" : lay === "horizontal" ? "HORIZONTAL" : "NONE";
}

export function primaryAlign(j: string): "MIN" | "CENTER" | "MAX" | "SPACE_BETWEEN" {
  return j === "center" ? "CENTER" : j === "end" ? "MAX" : j === "space_between" || j === "space_around" ? "SPACE_BETWEEN" : "MIN";
}
export function counterAlign(a: string): "MIN" | "CENTER" | "MAX" {
  return a === "center" ? "CENTER" : a === "end" ? "MAX" : "MIN";
}

export interface RGBA { r: number; g: number; b: number; a: number }

/** `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa` → 0..1 channels. */
export function parseHex(h: string): RGBA {
  h = h.replace("#", "");
  if (h.length === 3 || h.length === 4) h = h.split("").map((c) => c + c).join("");
  const ch = (i: number) => parseInt(h.slice(i, i + 2), 16) / 255;
  return { r: ch(0), g: ch(2), b: ch(4), a: h.length === 8 ? ch(6) : 1 };
}

type Mat = [[number, number, number], [number, number, number]];
function invert(m: Mat): Mat {
  const [[a, b, c], [d, e, f]] = m;
  const det = a * e - b * d;
  return [
    [e / det, -b / det, (b * f - c * e) / det],
    [-d / det, a / det, (c * d - a * f) / det],
  ];
}

/**
 * Figma `gradientTransform` for a Pencil gradient. Pencil describes a gradient by centre, size and
 * rotation in unit space (0° points up); Figma wants the inverse of the matrix that maps the
 * gradient's unit square onto the node.
 */
export function gradientTransform(g: { gradientType?: string; rotation?: number; center?: { x?: number; y?: number }; size?: { width?: number; height?: number } }): Mat {
  const cx = g.center?.x ?? 0.5, cy = g.center?.y ?? 0.5;
  const sw = g.size?.width ?? 1, sh = g.size?.height ?? 1;
  let M: Mat;
  if ((g.gradientType ?? "linear") === "linear") {
    const th = ((g.rotation ?? 0) * Math.PI) / 180;
    const dx = -Math.sin(th) * sh, dy = -Math.cos(th) * sh;
    const Sx = cx - dx / 2, Sy = cy - dy / 2;
    const Qx = -dy, Qy = dx;
    M = [[dx, Qx, Sx - 0.5 * Qx], [dy, Qy, Sy - 0.5 * Qy]];
  } else {
    M = [[sw, 0, cx - 0.5 * sw], [0, sh, cy - 0.5 * sh]];
  }
  return invert(M);
}

/** Weight → candidate Figma style names, most likely first. Foundries disagree on spacing ("SemiBold" vs "Semi Bold"). */
const WEIGHT_NAMES: Record<number, string[]> = {
  100: ["Thin", "Hairline"],
  200: ["ExtraLight", "Extra Light", "UltraLight", "Ultra Light"],
  300: ["Light"],
  400: ["Regular", "Normal", "Book"],
  500: ["Medium"],
  600: ["SemiBold", "Semi Bold", "DemiBold", "Demi Bold"],
  700: ["Bold"],
  800: ["ExtraBold", "Extra Bold", "UltraBold", "Ultra Bold"],
  900: ["Black", "Heavy"],
};

export function normalizeWeight(w: string | number | undefined): number {
  if (w === undefined || w === "normal") return 400;
  if (w === "bold") return 700;
  const n = typeof w === "number" ? w : parseInt(w, 10);
  if (!n) return 400;
  return Math.min(900, Math.max(100, Math.round(n / 100) * 100));
}

/**
 * Pick an installed Figma style for a family + weight (+ italic). Falls back to the nearest weight
 * that exists, then drops italic, so a missing style never aborts a build. `available` is the set
 * of `${family}|${style}` from `figma.listAvailableFontsAsync()`.
 */
export function pickFontStyle(family: string, weight: number, italic: boolean, available: Set<string>): { style: string; exact: boolean } {
  const has = (s: string) => available.has(family + "|" + s);
  const order = [weight, ...[100, 200, 300, 400, 500, 600, 700, 800, 900].filter((x) => x !== weight).sort((a, b) => Math.abs(a - weight) - Math.abs(b - weight) || b - a)];
  const variants = (base: string) => (italic ? (base === "Regular" ? ["Italic", "Regular Italic"] : [base + " Italic", base + "Italic"]) : [base]);
  for (const wantItalic of italic ? [true, false] : [false]) {
    for (const w of order) {
      for (const base of WEIGHT_NAMES[w]) {
        for (const s of wantItalic ? variants(base) : [base]) if (has(s)) return { style: s, exact: w === weight && wantItalic === italic };
      }
    }
  }
  return { style: WEIGHT_NAMES[weight][0], exact: false };
}

/** Pencil `lineHeight` is a multiplier (1.4); Figma wants a percentage. */
export const lineHeightPercent = (m: number) => m * 100;

// Engine rules from docs/rules.md, run against an in-memory Figma (fake-figma.ts).

import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEngine } from "../src/engine";
import { importVariables } from "../src/variables";
import { frameOverlaps, missingComponents, textOverflow } from "../src/verify";
import { checkBundle } from "../src/bundle";
import type { Bounds, PenNode } from "../src/types";
import { installFakeFigma, uninstallFakeFigma } from "./fake-figma";

let fake: ReturnType<typeof installFakeFigma>;
beforeEach(() => { fake = installFakeFigma(); });
afterEach(uninstallFakeFigma);

/** Build one screen; returns the engine, the result and the built frame. */
async function screen(node: PenNode, bounds: Bounds = { w: 0, h: 0 }) {
  const engine = await createEngine();
  const result = await engine.buildScreen(node, fake.page as any, bounds);
  const root: any = result.id ? await (globalThis as any).figma.getNodeByIdAsync(result.id) : null;
  const find = (pid: string): any => root?.findOne((n: any) => n.getSharedPluginData("pen2fig", "pid") === pid);
  return { engine, result, root, find };
}
const frame = (id: string, p: Record<string, unknown> = {}, children: PenNode[] = []): PenNode => ({ id, type: "frame", name: id, ...p, children } as PenNode);
const text = (id: string, content: string, p: Record<string, unknown> = {}): PenNode => ({ id, type: "text", content, fill: "#000000", ...p } as PenNode);
const rect = (id: string, w: number, h: number, p: Record<string, unknown> = {}): PenNode => ({ id, type: "rectangle", width: w, height: h, ...p } as PenNode);

describe("layout", () => {
  it("builds a frame with no layout key as a horizontal row", async () => {
    const { root, find } = await screen(frame("s", { width: 200, height: 50 }, [frame("row", {}, [rect("a", 10, 10), rect("b", 30, 10)])]));
    const row = find("row");
    expect(row.layoutMode).toBe("HORIZONTAL");
    expect(find("b").x).toBe(10);
    expect(root.layoutMode).toBe("HORIZONTAL");
  });

  it("hugs an auto-layout frame with no size instead of Figma's fixed 100", async () => {
    const { find } = await screen(frame("s", { width: 400, height: 400, layout: "vertical" }, [
      frame("stack", { layout: "vertical", gap: 4, padding: 8 }, [rect("a", 50, 10), rect("b", 30, 20)]),
    ]));
    const st = find("stack");
    expect(st.layoutSizingHorizontal).toBe("HUG");
    expect([st.width, st.height]).toEqual([66, 50]);
  });

  it("fills inside auto layout", async () => {
    const { find } = await screen(frame("s", { width: 300, height: 100, layout: "vertical", padding: 10 }, [frame("bar", { width: "fill_container", height: 20 })]));
    expect(find("bar").layoutSizingHorizontal).toBe("FILL");
    expect(find("bar").width).toBe(280);
  });

  it("treats fill_container outside auto layout as fixed: fallback first, then the parent", async () => {
    const { find } = await screen(frame("s", { width: 200, height: 100, layout: "none" }, [
      frame("a", { width: "fill_container(120)", height: 10 }),
      frame("b", { width: "fill_container", height: 10 }),
    ]));
    expect(find("a").width).toBe(120);
    expect(find("b").width).toBe(200);
    expect(find("b").layoutSizingHorizontal).toBe("FIXED");
  });

  it("sizes the frame before its children, so their fill_container resolves", async () => {
    const { find } = await screen(frame("s", { width: 300, height: 100, layout: "vertical" }, [
      frame("card", { width: 240, layout: "vertical" }, [frame("line", { width: "fill_container", height: 1 })]),
    ]));
    expect(find("line").width).toBe(240);
  });

  it("gives a top-level fill_container frame the bounds measured in Pencil", async () => {
    const { root, result } = await screen(frame("s", { width: "fill_container", height: "fill_container", layout: "vertical" }, [rect("a", 10, 10)]), { w: 390, h: 844 });
    expect(result.status).toBe("ok");
    expect([root.width, root.height]).toEqual([390, 844]);
    expect(root.layoutSizingVertical).toBe("FIXED");
  });

  it("lets a top-level frame with no height hug, as Pencil does", async () => {
    const { root } = await screen(frame("s", { width: 390, layout: "vertical", padding: 10 }, [rect("a", 10, 10)]), { w: 390, h: 30 });
    expect(root.layoutSizingVertical).toBe("HUG");
    expect(root.height).toBe(30);
  });

  it("reports a size delta against the Pencil bounds", async () => {
    const { result } = await screen(frame("s", { width: 400, height: 300 }), { w: 390, h: 300 });
    expect(result.status).toBe("Δ10,0");
  });

  it("keeps x/y for absolute children inside auto layout", async () => {
    const { find } = await screen(frame("s", { width: 200, height: 200, layout: "vertical" }, [rect("pin", 8, 8, { layoutPosition: "absolute", x: 150, y: 12 })]));
    expect(find("pin").layoutPositioning).toBe("ABSOLUTE");
    expect([find("pin").x, find("pin").y]).toEqual([150, 12]);
  });

  it("folds space_around into SPACE_BETWEEN, with a warning", async () => {
    const { engine, root } = await screen(frame("s", { width: 200, height: 20, justifyContent: "space_around" }, [rect("a", 10, 10), rect("b", 10, 10)]));
    expect(root.primaryAxisAlignItems).toBe("SPACE_BETWEEN");
    expect(engine.warnings).toContain("space_around → SPACE_BETWEEN");
  });
});

describe("strokes and paints", () => {
  it("draws nothing for a stroke without a width", async () => {
    const { find } = await screen(frame("s", { width: 100, height: 100 }, [frame("hair", { width: 50, height: 1, stroke: "#FF0000" })]));
    expect(find("hair").strokes).toHaveLength(1);
    expect(find("hair").strokeWeight).toBe(0);
  });

  it("maps per-side widths to per-side weights on frames, and the largest side elsewhere", async () => {
    const sides = { top: 0, right: 0, bottom: 2, left: 1 };
    const { find } = await screen(frame("s", { width: 100, height: 100, layout: "none" }, [
      frame("f", { width: 10, height: 10, stroke: "#000", strokeWidth: sides }),
      { id: "e", type: "ellipse", width: 10, height: 10, stroke: "#000", strokeWidth: sides } as PenNode,
    ]));
    expect([find("f").strokeTopWeight, find("f").strokeBottomWeight, find("f").strokeLeftWeight]).toEqual([0, 2, 1]);
    expect(find("e").strokeWeight).toBe(2);
  });

  it("keeps text with no fill invisible", async () => {
    const { find } = await screen(frame("s", { width: 100, height: 100 }, [{ id: "t", type: "text", content: "ghost" } as PenNode]));
    expect(find("t").fills).toEqual([]);
  });

  it("binds variable paints and stores the resolved colour too", async () => {
    const v = fake.addVariable("brand", { r: 0.4, g: 0.2, b: 0.9, a: 1 });
    const { find } = await screen(frame("s", { width: 100, height: 100 }, [frame("f", { width: 10, height: 10, fill: "$brand" })]));
    const [p] = find("f").fills;
    expect(p.color).toEqual({ r: 0.4, g: 0.2, b: 0.9 });
    expect(p.boundVariables.color.id).toBe(v.id);
  });

  it("shows a missing variable as magenta and warns", async () => {
    const { engine, find } = await screen(frame("s", { width: 100, height: 100 }, [frame("f", { width: 10, height: 10, fill: "$nope" })]));
    expect(find("f").fills[0].color).toEqual({ r: 1, g: 0, b: 1 });
    expect(engine.warnings).toContain("missing variable $nope");
  });

  it("binds number variables (gap, padding, radius)", async () => {
    const gap = fake.addVariable("space-4", 16);
    const { root } = await screen(frame("s", { width: 100, height: 100, gap: "$space-4", cornerRadius: "$space-4" }, [rect("a", 10, 10)]));
    expect(root.itemSpacing).toBe(16);
    expect(root.boundVariables.itemSpacing.id).toBe(gap.id);
    expect(root.topLeftRadius).toBe(16);
  });

  it("follows variable aliases when resolving", async () => {
    const base = fake.addVariable("ink-900", { r: 0, g: 0, b: 0.1, a: 1 });
    fake.addVariable("ink", { type: "VARIABLE_ALIAS", id: base.id });
    const { find } = await screen(frame("s", { width: 100, height: 100 }, [frame("f", { width: 10, height: 10, fill: "$ink" })]));
    expect(find("f").fills[0].color).toEqual({ r: 0, g: 0, b: 0.1 });
  });

  it("builds gradients, image placeholders and shader base colours", async () => {
    const { engine, find } = await screen(frame("s", { width: 100, height: 100, layout: "none" }, [
      frame("g", { width: 10, height: 10, fill: { type: "gradient", gradientType: "linear", colors: [{ color: "#000", position: 0 }, { color: "#fff", position: 1 }] } }),
      frame("img", { width: 10, height: 10, fill: { type: "image", url: "./hero.png", mode: "fit" } }),
      frame("sh", { width: 10, height: 10, fill: { type: "shader", uniforms: { u_base: "#123456" } } }),
    ]));
    expect(find("g").fills[0].type).toBe("GRADIENT_LINEAR");
    expect(find("g").fills[0].gradientStops).toHaveLength(2);
    expect(JSON.parse(find("img").getSharedPluginData("pen2fig", "img"))).toEqual({ url: "./hero.png", mode: "fit" });
    expect(find("sh").fills[0].color.b).toBeCloseTo(0x56 / 255);
    expect(engine.warnings.some((w) => w.startsWith("shader"))).toBe(true);
  });

  it("repairs paints whose stored colour drifted from their variable", async () => {
    const v = fake.addVariable("bg", { r: 1, g: 1, b: 1, a: 1 });
    const { engine, root, find } = await screen(frame("s", { width: 100, height: 100 }, [frame("f", { width: 10, height: 10, fill: "$bg" })]));
    v.setValueForMode(Object.keys(v.valuesByMode)[0], { r: 0, g: 0, b: 0, a: 1 });
    expect(engine.repairPaints(root)).toBe(1);
    expect(find("f").fills[0].color).toEqual({ r: 0, g: 0, b: 0 });
  });
});

describe("fonts", () => {
  it("uses the nearest installed weight and warns, without stopping the build", async () => {
    const { engine, result, find } = await screen(frame("s", { width: 300, height: 100 }, [text("t", "Heavy", { fontFamily: "Inter", fontWeight: "900" })]));
    expect(result.status).not.toMatch(/^ERROR/);
    expect(find("t").fontName).toEqual({ family: "Inter", style: "Bold" });
    expect(engine.warnings).toContain("font Inter 900 → Bold");
  });

  it("falls back to the default family when a family isn't installed at all", async () => {
    const { engine, result, find } = await screen(frame("s", { width: 300, height: 100 }, [text("t", "Hi", { fontFamily: "Nope Sans", fontWeight: "600" })]));
    expect(result.status).not.toMatch(/^ERROR/);
    expect(find("t").fontName).toEqual({ family: "Inter", style: "Semi Bold" });
    expect(engine.warnings.some((w) => w.includes("Nope Sans"))).toBe(true);
  });

  it("maps line height to a percentage and fixed-width text to auto height", async () => {
    const { find } = await screen(frame("s", { width: 300, height: 200, layout: "vertical" }, [
      text("t", "a".repeat(80), { fontSize: 10, lineHeight: 1.5, textGrowth: "fixed-width", width: "fill_container" }),
    ]));
    const t = find("t");
    expect(t.lineHeight).toEqual({ unit: "PERCENT", value: 150 });
    expect(t.textAutoResize).toBe("HEIGHT");
    expect(t.width).toBe(300);
    expect(t.height).toBe(30); // 400px of text in 300px → 2 lines of 15
  });
});

describe("text styling", () => {
  it("resolves variable underline and strikethrough flags, which Figma can't bind", async () => {
    fake.addVariable("links-underlined", false, "BOOLEAN");
    const { find } = await screen(frame("s", { width: 300, height: 100 }, [
      text("a", "on", { underline: true }),
      text("b", "var off", { underline: "$links-underlined" }),
      text("c", "struck", { strikethrough: true }),
    ]));
    expect([find("a").textDecoration, find("b").textDecoration, find("c").textDecoration]).toEqual(["UNDERLINE", "NONE", "STRIKETHROUGH"]);
  });

  it("warns about a missing variable flag instead of underlining", async () => {
    const { engine, find } = await screen(frame("s", { width: 300, height: 100 }, [text("a", "x", { underline: "$nope" })]));
    expect(find("a").textDecoration).toBe("NONE");
    expect(engine.warnings).toContain("missing variable $nope");
  });

  it("links the text node to href", async () => {
    const { find } = await screen(frame("s", { width: 300, height: 100 }, [text("a", "Docs", { href: "https://docs.pencil.dev" })]));
    expect(find("a").hyperlink).toEqual({ type: "URL", value: "https://docs.pencil.dev" });
  });

  it("resolves a variable font style", async () => {
    fake.addVariable("quote-style", "italic", "STRING");
    const { find } = await screen(frame("s", { width: 300, height: 100 }, [text("a", "said", { fontStyle: "$quote-style" })]));
    expect(find("a").fontName).toEqual({ family: "Inter", style: "Italic" });
  });

  it("clears decoration and links through instance overrides", async () => {
    const engine = await createEngine();
    await engine.buildComponent(frame("link", { reusable: true }, [text("t", "More", { underline: true, href: "https://a.example" })]), (globalThis as any).figma.createPage(), { w: 0, h: 0 });
    const r = await engine.buildScreen(frame("s", { width: 300, height: 100 }, [{ id: "r", type: "ref", ref: "link", descendants: { t: { underline: false, href: "" } } } as PenNode]), fake.page as any, { w: 300, h: 100 });
    const inst: any = (await (globalThis as any).figma.getNodeByIdAsync(r.id!)).children[0];
    const t = inst.findOne((n: any) => n.type === "TEXT");
    expect(inst.type).toBe("INSTANCE");
    expect([t.textDecoration, t.hyperlink]).toEqual(["NONE", null]);
  });
});

describe("components and instances", () => {
  // A button: a horizontal frame with an inner box and a label.
  const button = frame("btn", { reusable: true, padding: 8, gap: 4 }, [frame("box", { width: 40, height: 20 }), text("lbl", "Button")]);
  async function withButton() {
    const engine = await createEngine();
    const lib = (globalThis as any).figma.createPage();
    await engine.buildComponent(button, lib, { w: 0, h: 0 });
    return engine;
  }
  const ref = (descendants?: Record<string, unknown>, p: Record<string, unknown> = {}): PenNode => ({ id: "r", type: "ref", ref: "btn", ...(descendants && { descendants }), ...p } as PenNode);
  const host = (child: PenNode) => frame("s", { width: 400, height: 100 }, [child]);
  const built = async (engine: Awaited<ReturnType<typeof createEngine>>, node: PenNode) => {
    const r = await engine.buildScreen(node, fake.page as any, { w: 400, h: 100 });
    const root: any = await (globalThis as any).figma.getNodeByIdAsync(r.id!);
    return root.findOne((n: any) => n.getSharedPluginData("pen2fig", "pid") === "r");
  };

  it("registers reusable nodes as components and builds refs as instances", async () => {
    const engine = await withButton();
    expect(Object.keys(engine.registry.components)).toEqual(["btn"]);
    const inst = await built(engine, host(ref()));
    expect(inst.type).toBe("INSTANCE");
    expect(inst.findOne((n: any) => n.type === "TEXT").characters).toBe("Button");
  });

  it("applies text overrides and keeps the instance", async () => {
    const engine = await withButton();
    const inst = await built(engine, host(ref({ lbl: { content: "Go", fontWeight: "700" } })));
    expect(inst.type).toBe("INSTANCE");
    const t = inst.findOne((n: any) => n.type === "TEXT");
    expect(t.characters).toBe("Go");
    expect(t.fontName.style).toBe("Bold");
  });

  it("detaches when Figma silently ignores a nested size override, then re-applies it", async () => {
    const engine = await withButton();
    const node = await built(engine, host(ref({ box: { width: 80 } })));
    expect(node.type).toBe("FRAME");
    expect(node.findOne((n: any) => n.getSharedPluginData("pen2fig", "pid") === "box").width).toBe(80);
    expect(engine.warnings.some((w) => /detached .* size\/layout/.test(w))).toBe(true);
  });

  it("applies a replacement that matches the existing children as overrides", async () => {
    const engine = await withButton();
    const inst = await built(engine, host(ref({ btn: undefined as any, lbl: { content: "x" } })));
    expect(inst.type).toBe("INSTANCE");
  });

  it("detaches for a replacement subtree, since instances can't gain children", async () => {
    const engine = await withButton();
    const node = await built(engine, host(ref({ box: { type: "frame", children: [rect("dot", 4, 4)] } })));
    expect(node.type).toBe("FRAME");
    expect(node.findOne((n: any) => n.getSharedPluginData("pen2fig", "pid") === "dot")).not.toBeNull();
    expect(engine.warnings.some((w) => /detached .* replacement/.test(w))).toBe(true);
  });

  it("leaves a MISSING placeholder for a component that wasn't built, which the check reports", async () => {
    const engine = await createEngine();
    const r = await engine.buildScreen(host(ref()), fake.page as any, { w: 400, h: 100 });
    const root: any = await (globalThis as any).figma.getNodeByIdAsync(r.id!);
    expect(missingComponents(root)).toEqual([{ screen: "s", kind: "missing-component", detail: "btn" }]);
  });

  it("refuses to rebuild a component that has instances", async () => {
    const engine = await withButton();
    await built(engine, host(ref()));
    await expect(engine.buildComponent(button, (globalThis as any).figma.createPage(), { w: 0, h: 0 })).rejects.toThrow(/instance/);
  });

  it("swaps registered icons and colours them", async () => {
    const figma = (globalThis as any).figma;
    const icon = figma.createComponent(); icon.name = "Icon/star"; icon.resize(24, 24);
    const glyph = figma.createRectangle(); glyph.strokes = [{ type: "SOLID", color: { r: 0, g: 0, b: 0 } }]; icon.appendChild(glyph);
    const engine = await createEngine();
    engine.register("icon", "star", icon.id);
    const r = await engine.buildScreen(frame("s", { width: 100, height: 100 }, [{ id: "i", type: "icon", icon: "star", width: 16, height: 16, fill: "#FF0000" } as PenNode]), fake.page as any, { w: 100, h: 100 });
    const inst: any = (await figma.getNodeByIdAsync(r.id)).children[0];
    expect(inst.type).toBe("INSTANCE");
    expect(inst.width).toBe(16);
    expect(inst.children[0].strokes[0].color).toEqual({ r: 1, g: 0, b: 0 });
  });
});

describe("other nodes", () => {
  it("builds groups, paths, arcs and polygons", async () => {
    const { find } = await screen(frame("s", { width: 200, height: 200, layout: "none" }, [
      { id: "g", type: "group", name: "pair", children: [rect("a", 10, 10, { x: 5, y: 5 }), rect("b", 10, 10, { x: 20, y: 5 })] } as PenNode,
      { id: "p", type: "path", geometry: "M0 0L10 10", width: 10, height: 10, fill: "#00FF00" } as PenNode,
      { id: "arc", type: "ellipse", width: 20, height: 20, sweepAngle: 90 } as PenNode,
      { id: "tri", type: "polygon", width: 20, height: 20, polygonCount: 3 } as PenNode,
    ]));
    expect(find("g").type).toBe("GROUP");
    expect(find("g").children).toHaveLength(2);
    expect(find("p").findOne((n: any) => n.type === "VECTOR").fills[0].color).toEqual({ r: 0, g: 1, b: 0 });
    expect(find("arc").arcData.endingAngle - find("arc").arcData.startingAngle).toBeCloseTo(Math.PI / 2);
    expect(find("tri").pointCount).toBe(3);
  });

  it("skips annotations and warns about unknown node types", async () => {
    const { engine, root } = await screen(frame("s", { width: 100, height: 100 }, [{ id: "n", type: "note" } as PenNode, { id: "x", type: "hologram" } as any]));
    expect(root.children).toHaveLength(0);
    expect(engine.warnings).toContain("unsupported node type hologram");
  });
});

describe("checks after a build", () => {
  it("flags text that runs past its parent, but not inside hidden or clipping layers", async () => {
    const long = "x".repeat(60); // 360px at 12px
    const { root } = await screen(frame("s", { width: 400, height: 300, layout: "vertical" }, [
      frame("narrow", { width: 100, height: 20, layout: "none" }, [text("over", long)]),
      frame("hidden", { width: 100, height: 20, layout: "none", enabled: false }, [text("h", long)]),
      frame("scroller", { width: 100, height: 20, layout: "none", clip: true }, [text("c", long)]),
    ]));
    expect(textOverflow(root).map((i) => i.detail)).toEqual([long]);
  });

  it("flags overlapping top-level frames", async () => {
    const engine = await createEngine();
    await engine.buildScreen(frame("a", { width: 100, height: 100 }), fake.page as any, { w: 100, h: 100, x: 0, y: 0 });
    await engine.buildScreen(frame("b", { width: 100, height: 100 }), fake.page as any, { w: 100, h: 100, x: 50, y: 50 });
    expect(frameOverlaps(fake.page as any)).toEqual([{ screen: "a", kind: "frame-overlap", detail: "b" }]);
  });
});

describe("example bundle", () => {
  it("builds node for node, with its variables bound", async () => {
    const bundle = JSON.parse(readFileSync(new URL("../../../examples/bundle.example.json", import.meta.url), "utf8"));
    checkBundle(bundle);
    await importVariables(bundle.variables!);
    const engine = await createEngine();
    const results = [];
    for (const s of bundle.screens) results.push(await engine.buildScreen(s.node, fake.page as any, s.bounds));
    expect(results.map((r) => r.status)).toEqual(["ok"]);
    expect(engine.warnings).toEqual([]);
    const root: any = await (globalThis as any).figma.getNodeByIdAsync(results[0].id!);
    expect(dump(root)).toMatchSnapshot();
  });
});

/** A compact, stable outline of a built tree for snapshots. */
function dump(n: any, depth = 0): string {
  const r = (x: number) => Math.round(x * 10) / 10;
  const bits = [n.type, JSON.stringify(n.name), `${r(n.width)}x${r(n.height)}`];
  if (n.layoutMode && n.layoutMode !== "NONE") bits.push(n.layoutMode.toLowerCase(), `${n.layoutSizingHorizontal}/${n.layoutSizingVertical}`);
  if (n.type === "TEXT") bits.push(JSON.stringify(n.characters), `${n.fontName.family} ${n.fontName.style} ${n.fontSize}`);
  const paint = (p: any) => p.boundVariables?.color ? "var" : p.type === "SOLID" ? "#" + ["r", "g", "b"].map((k) => Math.round(p.color[k] * 255).toString(16).padStart(2, "0")).join("") : p.type.toLowerCase();
  if (n.fills?.length) bits.push("fill " + n.fills.map(paint).join(","));
  if (n.strokes?.length) bits.push(`stroke ${n.strokes.map(paint).join(",")} ${n.strokeWeight}`);
  if (Object.keys(n.boundVariables ?? {}).length) bits.push("bound " + Object.keys(n.boundVariables).join(","));
  return ["  ".repeat(depth) + bits.join(" "), ...(n.children ?? []).map((c: any) => dump(c, depth + 1))].join("\n");
}

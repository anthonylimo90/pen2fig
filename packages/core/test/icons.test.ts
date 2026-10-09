import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEngine } from "../src/engine";
import { importIcons, prepareIconSvg, type BundleIcon } from "../src/icons";
import type { PenNode } from "../src/types";
import { installFakeFigma, uninstallFakeFigma } from "./fake-figma";

// Lucide's arrow-right as lucide-static ships it (ISC).
const ARROW = `<!-- @license lucide-static v1.54.0 - ISC -->
<svg
  class="lucide lucide-arrow-right"
  xmlns="http://www.w3.org/2000/svg"
  width="24"
  height="24"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
>
  <path d="M5 12h14" />
  <path d="m12 5 7 7-7 7" />
</svg>`;
const lucide = (svg: string): BundleIcon => ({ library: "lucide", svg });

let fake: ReturnType<typeof installFakeFigma>;
beforeEach(() => { fake = installFakeFigma(); });
afterEach(uninstallFakeFigma);
const figma = () => (globalThis as any).figma;

describe("prepareIconSvg", () => {
  it("drops the licence comment and paints currentColor black", () => {
    const s = prepareIconSvg(ARROW);
    expect(s.startsWith("<svg")).toBe(true);
    expect(s).not.toMatch(/currentColor|<!--/);
    expect(s).toMatch(/stroke="#000000"/);
  });
});

describe("importIcons", () => {
  it("creates an Icon/<name> component per icon and registers it", async () => {
    const engine = await createEngine();
    const page = figma().createPage();
    const r = await importIcons({ "arrow-right": lucide(ARROW) }, page, engine);
    expect(r).toEqual({ created: 1, reused: 0, failed: [] });
    const [c] = page.children;
    expect([c.type, c.name, c.width, c.height]).toEqual(["COMPONENT", "Icon/arrow-right", 24, 24]);
    expect(c.fills).toEqual([]);
    expect(c.children).toHaveLength(2);
    expect(c.children[0].strokes).toHaveLength(1);
    expect(c.children[0].strokeWeight).toBe(2);
    expect(c.children[0].constraints).toEqual({ horizontal: "SCALE", vertical: "SCALE" });
    expect(engine.registry.icons["arrow-right"]).toBe(c.id);
  });

  it("reuses registered icons on a re-run instead of duplicating them", async () => {
    const page = figma().createPage();
    await importIcons({ "arrow-right": lucide(ARROW) }, page, await createEngine());
    const again = await importIcons({ "arrow-right": lucide(ARROW) }, page, await createEngine());
    expect(again).toEqual({ created: 0, reused: 1, failed: [] });
    expect(page.children).toHaveLength(1);
  });

  it("prefers an icon component the file already has under that name", async () => {
    const page = figma().createPage();
    const mine = figma().createComponent(); mine.name = "Icon/arrow-right"; page.appendChild(mine);
    const engine = await createEngine();
    const r = await importIcons({ "arrow-right": lucide(ARROW) }, page, engine);
    expect(r.reused).toBe(1);
    expect(engine.registry.icons["arrow-right"]).toBe(mine.id);
  });

  it("reports an SVG Figma can't read and carries on", async () => {
    const page = figma().createPage();
    const r = await importIcons({ broken: lucide("not svg"), "arrow-right": lucide(ARROW) }, page, await createEngine());
    expect(r.created).toBe(1);
    expect(r.failed).toEqual(["broken: Invalid SVG"]);
  });

  it("lays new icons out in a grid below what the page already holds", async () => {
    const page = figma().createPage();
    const old = figma().createFrame(); old.resize(10, 100); page.appendChild(old);
    const names = Array.from({ length: 13 }, (_, i) => "i" + i);
    await importIcons(Object.fromEntries(names.map((n) => [n, lucide(ARROW)])), page, await createEngine());
    const icons = page.children.slice(1);
    expect(icons.every((c: any) => c.y >= 100)).toBe(true);
    expect(icons[12].x).toBe(0);
    expect(icons[12].y).toBeGreaterThan(icons[0].y);
  });

  it("lets icon nodes build as coloured, sized instances", async () => {
    const engine = await createEngine();
    await importIcons({ "arrow-right": lucide(ARROW) }, figma().createPage(), engine);
    const spec = { id: "s", type: "frame", width: 100, height: 40, children: [{ id: "i", type: "icon_font", iconFontName: "arrow-right", iconFontFamily: "lucide", width: 16, height: 16, fill: "#FF0000" }] } as PenNode;
    const r = await engine.buildScreen(spec, fake.page as any, { w: 100, h: 40 });
    const inst: any = (await figma().getNodeByIdAsync(r.id)).children[0];
    expect(inst.type).toBe("INSTANCE");
    expect(inst.name).toBe("Icon/arrow-right");
    expect([inst.width, inst.height]).toEqual([16, 16]);
    expect(inst.children.map((v: any) => v.strokes[0].color)).toEqual([{ r: 1, g: 0, b: 0 }, { r: 1, g: 0, b: 0 }]);
    expect(engine.warnings).toEqual([]);
  });
});

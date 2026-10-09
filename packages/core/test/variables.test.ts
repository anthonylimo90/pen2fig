import { afterEach, describe, expect, it } from "vitest";
import { installFakeFigma, uninstallFakeFigma } from "./fake-figma";
import { importVariables, planVariables } from "../src/variables";
import type { PenVariables } from "../src/types";

const themed: PenVariables = {
  themes: { mode: ["light", "dark"] },
  variables: {
    bg: { type: "color", value: [{ value: "#ffffff" }, { value: "#000000", theme: { mode: "dark" } }] },
    surface: { type: "color", value: "$bg" },
    "space-4": { type: "number", value: 16 },
    font: { type: "string", value: "Inter" },
  },
};

describe("planVariables", () => {
  it("turns the first theme axis into modes, default first", () => {
    const p = planVariables(themed);
    expect(p.axis).toBe("mode");
    expect(p.modes).toEqual(["light", "dark"]);
    const bg = p.vars.find((v) => v.name === "bg")!;
    expect(bg.type).toBe("COLOR");
    expect(bg.values).toEqual([{ r: 1, g: 1, b: 1, a: 1 }, { r: 0, g: 0, b: 0, a: 1 }]);
  });
  it("uses one Default mode without themes, and keeps aliases", () => {
    const p = planVariables({ variables: { a: { type: "number", value: "8" }, b: { type: "number", value: "$a" } } });
    expect(p.modes).toEqual(["Default"]);
    expect(p.vars).toEqual([
      { name: "a", type: "FLOAT", values: [8] },
      { name: "b", type: "FLOAT", values: [{ alias: "a" }] },
    ]);
  });
  it("lets later matching entries win, like Pencil", () => {
    const p = planVariables({ themes: { mode: ["light", "dark"] }, variables: { c: { type: "color", value: [{ value: "#111" }, { value: "#222", theme: { mode: "dark" } }, { value: "#333", theme: { mode: "dark" } }] } } });
    expect(p.vars[0].values[1]).toEqual({ r: 0x33 / 255, g: 0x33 / 255, b: 0x33 / 255, a: 1 });
  });
  it("warns about a second theme axis and unreadable values instead of failing", () => {
    const p = planVariables({
      themes: { mode: ["light", "dark"], density: ["compact", "cozy"] },
      variables: { gap: { type: "number", value: [{ value: 8 }, { value: 4, theme: { density: "compact" } }] }, bad: { type: "color", value: "rgb(0,0,0)" }, odd: { type: "gradient" as any, value: 1 } },
    });
    expect(p.vars.map((v) => v.name)).toEqual(["gap"]);
    expect(p.vars[0].values).toEqual([8, 8]);
    expect(p.warnings.join("\n")).toMatch(/density/);
    expect(p.warnings.join("\n")).toMatch(/bad/);
    expect(p.warnings.join("\n")).toMatch(/odd: unknown type/);
  });
});

afterEach(uninstallFakeFigma);

describe("importVariables", () => {
  it("creates a collection with one mode per theme and binds aliases", async () => {
    const f = installFakeFigma();
    const r = await importVariables(themed);
    expect(r).toMatchObject({ collection: "Pencil", modes: ["light", "dark"], created: 4, updated: 0, kept: [] });
    const [c] = f.collections;
    expect(c.modes.map((m) => m.name)).toEqual(["light", "dark"]);
    const bg = f.variables.find((v) => v.name === "bg"), surface = f.variables.find((v) => v.name === "surface");
    expect(bg!.valuesByMode[c.modes[1].modeId]).toEqual({ r: 0, g: 0, b: 0, a: 1 });
    expect(surface!.valuesByMode[c.modes[0].modeId]).toEqual({ type: "VARIABLE_ALIAS", id: bg!.id });
  });

  it("updates its own variables on a re-run instead of duplicating them", async () => {
    const f = installFakeFigma();
    await importVariables(themed);
    const r = await importVariables({ ...themed, variables: { ...themed.variables, "space-4": { type: "number", value: 20 } } });
    expect(r).toMatchObject({ created: 0, updated: 4 });
    expect(f.variables).toHaveLength(4);
    expect(f.variables.find((v) => v.name === "space-4")!.valuesByMode[f.collections[0].modes[0].modeId]).toBe(20);
  });

  it("leaves variables in other collections alone", async () => {
    const f = installFakeFigma();
    f.addVariable("bg", { r: 1, g: 0, b: 0, a: 1 });
    const r = await importVariables(themed);
    expect(r.kept).toEqual(["bg"]);
    expect(f.variables.filter((v) => v.name === "bg")).toHaveLength(1);
    // The alias still resolves to the existing variable.
    const surface = f.variables.find((v) => v.name === "surface");
    expect(Object.values(surface!.valuesByMode)[0]).toEqual({ type: "VARIABLE_ALIAS", id: f.variables[0].id });
  });

  it("skips values for modes the Figma plan won't allow", async () => {
    installFakeFigma({ maxModes: 1 });
    const r = await importVariables(themed);
    expect(r.created).toBe(4);
    expect(r.warnings.join("\n")).toMatch(/mode dark not added/);
  });
});

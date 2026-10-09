// Pencil variables → a Figma variable collection, so `$name` references bind instead of falling back
// to magenta. Run before `createEngine`: the engine reads local variables once, when it starts.
//
// Pencil's `GetVariables()` returns `{ variables: { name: { type, value } }, themes: { axis: [modes] } }`.
// A value is either plain or a list of `{ value, theme: { axis: mode } }` entries. Figma has one set of
// modes per collection, so the first theme axis becomes the collection's modes; values that vary on
// other axes use their default, with a warning.

import { isVarRef, parseHex, varName } from "./pure";
import type { PenVariables } from "./types";

export type FigmaVarType = "COLOR" | "FLOAT" | "STRING" | "BOOLEAN";
export type PlannedValue = { alias: string } | number | string | boolean | { r: number; g: number; b: number; a: number };

export interface VariablePlan {
  /** Theme axis that became the modes, if any. */
  axis?: string;
  /** Mode names; the first is the collection's default. */
  modes: string[];
  vars: { name: string; type: FigmaVarType; values: PlannedValue[] }[];
  warnings: string[];
}

const TYPES: Record<string, FigmaVarType> = { color: "COLOR", number: "FLOAT", string: "STRING", boolean: "BOOLEAN" };

/** Pure: decide modes, types and per-mode values. No Figma API. */
export function planVariables(def: PenVariables): VariablePlan {
  const warnings: string[] = [];
  const axes = Object.entries(def.themes ?? {}).filter(([, m]) => Array.isArray(m) && m.length);
  const [axis, modes] = axes[0] ?? [undefined, ["Default"]];
  if (axes.length > 1) warnings.push(`theme axes ${axes.slice(1).map(([a]) => a).join(", ")} → default values (Figma takes one axis per collection)`);

  const vars: VariablePlan["vars"] = [];
  for (const [name, v] of Object.entries(def.variables ?? {})) {
    const type = TYPES[v?.type];
    if (!type) { warnings.push(`variable ${name}: unknown type ${v?.type}`); continue; }
    const entries = Array.isArray(v.value) ? v.value : [{ value: v.value }];
    if (!entries.length) { warnings.push(`variable ${name}: no value`); continue; }
    if (entries.some((e) => e.theme && Object.keys(e.theme).some((k) => k !== axis))) warnings.push(`variable ${name}: varies on another theme axis → default`);
    const base = [...entries].reverse().find((e) => !e.theme || !Object.keys(e.theme).length) ?? entries[0];
    const values: PlannedValue[] = [];
    let ok = true;
    for (const m of modes) {
      // Later entries win, as in Pencil.
      const e = (axis && [...entries].reverse().find((x) => x.theme?.[axis] === m)) || base;
      const val = convert(e.value, type);
      if (val === undefined) { warnings.push(`variable ${name}: can't read ${JSON.stringify(e.value)} as ${v.type}`); ok = false; break; }
      values.push(val);
    }
    if (ok) vars.push({ name, type, values });
  }
  return { axis, modes, vars, warnings };
}

function convert(x: unknown, type: FigmaVarType): PlannedValue | undefined {
  if (isVarRef(x)) return { alias: varName(x) };
  if (type === "COLOR") return typeof x === "string" && /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(x) ? parseHex(x) : undefined;
  if (type === "FLOAT") { const n = typeof x === "number" ? x : typeof x === "string" ? parseFloat(x) : NaN; return isNaN(n) ? undefined : n; }
  if (type === "BOOLEAN") return typeof x === "boolean" ? x : x === "true" ? true : x === "false" ? false : undefined;
  return x === undefined || x === null ? undefined : String(x);
}

export interface VariableImportOptions {
  /** Collection to create or reuse. Default `Pencil`. */
  collection?: string;
  /** Replace values of variables this importer created before. Default true. Variables in other collections are never touched. */
  overwrite?: boolean;
}

export interface VariableImportResult {
  collection: string;
  modes: string[];
  created: number;
  updated: number;
  /** Names left alone because a variable of that name already exists elsewhere, or with another type. */
  kept: string[];
  warnings: string[];
}

/** Create or update a Figma variable collection from Pencil variables. Runs inside a Figma plugin. */
export async function importVariables(def: PenVariables, opts: VariableImportOptions = {}): Promise<VariableImportResult> {
  const plan = planVariables(def);
  const COLL = opts.collection ?? "Pencil";
  const overwrite = opts.overwrite ?? true;
  const res: VariableImportResult = { collection: COLL, modes: plan.modes, created: 0, updated: 0, kept: [], warnings: plan.warnings };

  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  let coll = collections.find((c) => c.name === COLL);
  if (!coll) {
    coll = figma.variables.createVariableCollection(COLL);
    coll.renameMode(coll.modes[0].modeId, plan.modes[0]);
  }
  // Mode id per planned mode, matched by name. Figma plans cap the number of modes.
  const modeIds: (string | undefined)[] = plan.modes.map((m, i) => coll!.modes.find((x) => x.name === m)?.modeId ?? (i === 0 && coll!.modes.length === 1 && !plan.axis ? coll!.modes[0].modeId : undefined));
  for (let i = 0; i < plan.modes.length; i++) {
    if (modeIds[i]) continue;
    try { modeIds[i] = coll.addMode(plan.modes[i]); }
    catch (e: any) { res.warnings.push(`mode ${plan.modes[i]} not added (${e.message}); its values are skipped`); }
  }

  const byName = new Map<string, Variable>();
  for (const v of await figma.variables.getLocalVariablesAsync()) byName.set(v.name, v);

  // Pass 1: make the variables, so aliases in pass 2 have something to point at.
  const targets: [Variable, VariablePlan["vars"][number]][] = [];
  for (const pv of plan.vars) {
    const ex = byName.get(pv.name);
    if (ex) {
      if (ex.variableCollectionId !== coll.id || ex.resolvedType !== pv.type || !overwrite) { res.kept.push(pv.name); continue; }
      targets.push([ex, pv]); res.updated++;
      continue;
    }
    const v = figma.variables.createVariable(pv.name, coll, pv.type);
    byName.set(pv.name, v);
    targets.push([v, pv]); res.created++;
  }

  // Pass 2: values.
  for (const [v, pv] of targets) {
    pv.values.forEach((val, i) => {
      const modeId = modeIds[i];
      if (!modeId) return;
      let out: VariableValue;
      if (typeof val === "object" && "alias" in val) {
        const t = byName.get(val.alias);
        if (!t) { res.warnings.push(`variable ${pv.name}: alias $${val.alias} not found`); return; }
        out = figma.variables.createVariableAlias(t);
      } else out = val as VariableValue;
      try { v.setValueForMode(modeId, out); } catch (e: any) { res.warnings.push(`variable ${pv.name}: ${e.message}`); }
    });
  }
  return res;
}

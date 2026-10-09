// bundle.json — what the extractor writes and the plugin builds. Versioned so a Pencil format
// change fails loudly instead of producing a quietly wrong file.

import type { Bounds, PenNode, PenVariables } from "./types";

export const BUNDLE_VERSION = 1;

export interface BundleScreen {
  /** Pencil node id. Re-running a bundle updates the Figma frame built from this id. */
  id: string;
  bounds: Bounds;
  node: PenNode;
}

export interface Bundle {
  version: typeof BUNDLE_VERSION;
  source: { file: string; exportedAt: string; pencil?: string };
  /** Figma page to build into; created if missing. */
  page: string;
  /** Reusable nodes, built as components before any screen. Order matters: dependencies first. */
  components?: BundleScreen[];
  screens: BundleScreen[];
  /** Image fills by URL or path, uploaded once and copied to every node that uses them. */
  images?: Record<string, { path?: string; url?: string }>;
  /** Pencil variables, imported into a Figma collection before anything is built. */
  variables?: PenVariables;
}

export function checkBundle(b: unknown): asserts b is Bundle {
  const x = b as Bundle;
  if (!x || typeof x !== "object") throw new Error("bundle: not an object");
  if (x.version !== BUNDLE_VERSION) throw new Error(`bundle: version ${x.version} — this build reads version ${BUNDLE_VERSION}`);
  if (typeof x.page !== "string" || !x.page) throw new Error("bundle: page is required");
  if (!Array.isArray(x.screens)) throw new Error("bundle: screens must be an array");
  if (x.variables !== undefined && (typeof x.variables !== "object" || typeof x.variables.variables !== "object")) throw new Error("bundle: variables must be GetVariables() output");
  for (const s of [...(x.components ?? []), ...x.screens]) {
    if (!s.id || !s.node || !s.bounds) throw new Error(`bundle: entry ${s?.id ?? "?"} needs id, bounds and node`);
    if (s.node.id !== s.id) throw new Error(`bundle: entry ${s.id} wraps node ${s.node.id}`);
  }
}

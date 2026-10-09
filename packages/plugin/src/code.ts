// Plugin main thread: receives a bundle from the UI (dropped file or a job from `pen2fig serve`),
// builds it, swaps image placeholders for real bytes, verifies, and reports back.

import {
  checkBundle, createEngine, frameOverlaps, importVariables, missingComponents, textOverflow,
  type Bundle, type Issue, type ScreenResult, type VariableImportResult,
} from "@pen2fig/core";

const NS = "pen2fig";

figma.showUI(__html__, { width: 360, height: 420 });

type ToCode =
  | { type: "build"; jobId?: string; bundle: unknown }
  | { type: "image-bytes"; reqId: number; bytes?: Uint8Array; error?: string };

export interface Report {
  jobId?: string;
  page: string;
  variables?: Omit<VariableImportResult, "warnings">;
  components: ScreenResult[];
  screens: ScreenResult[];
  images: { placed: number; failed: string[] };
  issues: Issue[];
  warnings: string[];
  ms: number;
}

// ── image bytes come through the UI (only it can reach localhost) ────────────
let reqSeq = 0;
const pending = new Map<number, (r: { bytes?: Uint8Array; error?: string }) => void>();
function fetchImage(key: string): Promise<{ bytes?: Uint8Array; error?: string }> {
  const reqId = ++reqSeq;
  return new Promise((resolve) => {
    pending.set(reqId, resolve);
    figma.ui.postMessage({ type: "fetch-image", reqId, key });
  });
}

/** Ledger on the page: pen screen id → Figma frame id, so a re-run replaces instead of duplicating. */
function ledger(page: PageNode): Record<string, string> {
  return JSON.parse(page.getSharedPluginData(NS, "frames") || "{}");
}

async function pageNamed(name: string): Promise<PageNode> {
  const p = figma.root.children.find((x) => x.name === name) ?? (() => { const n = figma.createPage(); n.name = name; return n; })();
  await p.loadAsync();
  return p;
}

async function run(bundle: Bundle, jobId?: string): Promise<Report> {
  const t0 = Date.now();
  // Variables first: the engine reads local variables once, when it is created.
  const vars = bundle.variables ? await importVariables(bundle.variables) : undefined;
  const engine = await createEngine({ namespace: NS });
  const report: Report = { jobId, page: bundle.page, components: [], screens: [], images: { placed: 0, failed: [] }, issues: [], warnings: engine.warnings, ms: 0 };
  if (vars) { const { warnings, ...rest } = vars; report.variables = rest; engine.warnings.push(...warnings); }

  if (bundle.components?.length) {
    const lib = await pageNamed("Components");
    await figma.setCurrentPageAsync(lib);
    for (const c of bundle.components) {
      try {
        const node = await engine.buildComponent(c.node, lib, c.bounds);
        const dw = Math.round(node.width - c.bounds.w), dh = Math.round(node.height - c.bounds.h);
        report.components.push({ id: node.id, name: node.name, status: dw || dh ? `Δ${dw},${dh}` : "ok" });
      } catch (e: any) {
        report.components.push({ name: c.node.name ?? c.id, status: `ERROR ${e.message}` });
      }
    }
  }

  const page = await pageNamed(bundle.page);
  await figma.setCurrentPageAsync(page);
  const map = ledger(page);
  for (const s of bundle.screens) {
    const old = map[s.id] ? await figma.getNodeByIdAsync(map[s.id]) : null;
    const bounds = { ...s.bounds };
    if (old && "x" in old && bounds.x === undefined) { bounds.x = (old as FrameNode).x; bounds.y = (old as FrameNode).y; }
    const r = await engine.buildScreen(s.node, page, bounds);
    if (r.id) { if (old) old.remove(); map[s.id] = r.id; }
    report.screens.push(r);
  }
  page.setSharedPluginData(NS, "frames", JSON.stringify(map));

  // Images: upload each distinct source once, then copy the hash to every node that uses it.
  const built = (await Promise.all(report.screens.filter((s) => s.id).map((s) => figma.getNodeByIdAsync(s.id!)))) as FrameNode[];
  const tagged: { node: SceneNode & MinimalFillsMixin; url: string; mode: string }[] = [];
  for (const f of built) for (const n of [f, ...f.findAll(() => true)]) {
    const raw = n.getSharedPluginData(NS, "img");
    if (raw && "fills" in n) tagged.push({ node: n as any, ...JSON.parse(raw) });
  }
  const hashes = new Map<string, string | null>();
  for (const t of tagged) {
    if (!hashes.has(t.url)) {
      const r = await fetchImage(t.url);
      if (r.bytes) { hashes.set(t.url, figma.createImage(r.bytes).hash); }
      else { hashes.set(t.url, null); report.images.failed.push(`${t.url}: ${r.error ?? "no bytes"}`); }
    }
    const hash = hashes.get(t.url);
    if (!hash) continue;
    const scaleMode = t.mode === "fit" ? "FIT" : t.mode === "tile" ? "TILE" : "FILL";
    t.node.fills = [{ type: "IMAGE", imageHash: hash, scaleMode }];
    report.images.placed++;
  }

  for (const f of built) report.issues.push(...textOverflow(f), ...missingComponents(f));
  report.issues.push(...frameOverlaps(page));
  report.ms = Date.now() - t0;
  return report;
}

figma.ui.onmessage = async (msg: ToCode) => {
  if (msg.type === "image-bytes") {
    pending.get(msg.reqId)?.({ bytes: msg.bytes, error: msg.error });
    pending.delete(msg.reqId);
    return;
  }
  if (msg.type === "build") {
    try {
      checkBundle(msg.bundle);
      figma.ui.postMessage({ type: "status", text: `Building ${msg.bundle.screens.length} screen(s) on “${msg.bundle.page}”…` });
      const report = await run(msg.bundle, msg.jobId);
      figma.ui.postMessage({ type: "report", report });
    } catch (e: any) {
      figma.ui.postMessage({ type: "report", report: { jobId: msg.jobId, error: e.message } });
    }
  }
};

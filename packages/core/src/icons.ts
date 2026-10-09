// Icon SVGs from the bundle → `Icon/<name>` components, registered with the engine so icon nodes
// build as instances. `pen2fig bundle` fetches the SVGs (Lucide), because the plugin has no network.

import type { Engine } from "./engine";

export interface BundleIcon {
  library: string;
  svg: string;
  /** Where the SVG came from, for provenance. */
  source?: string;
}

/**
 * Make an icon SVG safe for `figma.createNodeFromSvg`: drop comments (Lucide puts its licence
 * there) and paint `currentColor` black. The engine recolours icons per instance anyway.
 */
export function prepareIconSvg(svg: string): string {
  return svg.replace(/<!--[\s\S]*?-->/g, "").replace(/currentColor/g, "#000000").trim();
}

export interface IconImportResult {
  created: number;
  /** Already registered, or found in the file as a component with the icon's name. */
  reused: number;
  failed: string[];
}

/**
 * Create a component per icon in `container` and register it. An icon that is already registered
 * (and still exists), or that the file already has as a component named `Icon/<name>`, is reused,
 * so your own icon components win over the imported ones.
 */
export async function importIcons(icons: Record<string, BundleIcon>, container: BaseNode & ChildrenMixin, engine: Engine): Promise<IconImportResult> {
  const res: IconImportResult = { created: 0, reused: 0, failed: [] };
  const prefix = engine.iconPrefix;
  const existing = new Map<string, ComponentNode>();
  for (const n of "findAll" in container ? (container as PageNode).findAll((x) => x.type === "COMPONENT" && x.name.startsWith(prefix)) : []) existing.set(n.name, n as ComponentNode);

  // New components go in a grid below whatever the container already holds.
  const COLS = 12, CELL = 48;
  let slot = 0;
  const top = Math.max(0, ...(container.children as SceneNode[]).map((c) => c.y + c.height + CELL));

  for (const [name, icon] of Object.entries(icons)) {
    const id = engine.registry.icons[name];
    if (id && (await figma.getNodeByIdAsync(id))) { res.reused++; continue; }
    const found = existing.get(prefix + name);
    if (found) { engine.register("icon", name, found.id); res.reused++; continue; }
    let svg: FrameNode;
    try { svg = figma.createNodeFromSvg(prepareIconSvg(icon.svg)); }
    catch (e: any) { res.failed.push(`${name}: ${e.message}`); continue; }
    const c = figma.createComponent();
    c.name = prefix + name;
    c.fills = [];
    c.clipsContent = false;
    c.resize(svg.width, svg.height);
    for (const k of [...svg.children]) {
      c.appendChild(k);
      if ("constraints" in k) k.constraints = { horizontal: "SCALE", vertical: "SCALE" };
    }
    svg.remove();
    container.appendChild(c);
    c.x = (slot % COLS) * CELL;
    c.y = top + Math.floor(slot / COLS) * CELL;
    slot++;
    if (icon.source) c.setSharedPluginData(engine.namespace, "src", icon.source);
    engine.register("icon", name, c.id);
    res.created++;
  }
  return res;
}

// Pencil node → Figma node builder. Runs inside a Figma plugin (the `figma` global).
//
// The rules that matter, learned porting a 600-frame file:
// - Pencil's default layout is a horizontal row (see pure.ts `layoutModeFor`).
// - A stroke without a width draws nothing in Pencil; Figma defaults to 1px.
// - Sizes are applied after a node is in its parent, so `fill_container` resolves.
// - Instances can't take new children, and Figma silently ignores some descendant overrides
//   (nested sizes, auto-layout direction). Those instances are detached, and the override re-applied.
// - Bound-variable paints get the resolved colour too, or Figma renders black until refresh.

import {
  counterAlign, expandPadding, gradientTransform, isVarRef, layoutModeFor, lineHeightPercent,
  normalizeWeight, parseHex, parseSize, pickFontStyle, primaryAlign, sizingFor, varName,
} from "./pure";
import type { Bounds, PenEffect, PenFill, PenNode, PenOverride, PenProps, PenRef } from "./types";

export interface EngineOptions {
  /** Shared plugin data namespace for pen ids and the registry. Default `pen2fig`. */
  namespace?: string;
  /** Component name prefix that marks icon components. Default `Icon/`. */
  iconPrefix?: string;
  /** Font family used when a node names none. Default `Inter`. */
  defaultFont?: string;
}

export interface ScreenResult { id?: string; name: string; status: "ok" | `Δ${number},${number}` | `ERROR ${string}` }

type Paintable = { fills?: readonly Paint[] | typeof figma.mixed; strokes?: readonly Paint[] };
type AnyNode = SceneNode & Record<string, any>;

export async function createEngine(opts: EngineOptions = {}) {
  const NS = opts.namespace ?? "pen2fig";
  const ICON = opts.iconPrefix ?? "Icon/";
  const DEFAULT_FONT = opts.defaultFont ?? "Inter";
  figma.skipInvisibleInstanceChildren = false;

  const warnings: string[] = [];
  const warn = (m: string) => { if (warnings.length < 200) warnings.push(m); };

  // ── variables ──────────────────────────────────────────────────────────────
  const allVars = await figma.variables.getLocalVariablesAsync();
  const VAR: Record<string, Variable> = {};
  const VBYID: Record<string, Variable> = {};
  for (const v of allVars) { VAR[v.name] = v; VBYID[v.id] = v; }
  function resolveVar(name: string, depth = 0): any {
    const v = VAR[name];
    if (!v || depth > 10) return undefined;
    const val = Object.values(v.valuesByMode)[0] as any;
    if (val && typeof val === "object" && val.type === "VARIABLE_ALIAS") {
      const t = VBYID[val.id];
      return t ? resolveVar(t.name, depth + 1) : undefined;
    }
    return val;
  }
  const num = (x: unknown): any => (isVarRef(x) ? resolveVar(varName(x)) : x);
  const size = (s: unknown) => parseSize(s as any, resolveVar);

  // ── registry: pen component id → Figma component id, icon name → component id ──
  const registry = {
    components: JSON.parse(figma.root.getSharedPluginData(NS, "components") || "{}") as Record<string, string>,
    icons: JSON.parse(figma.root.getSharedPluginData(NS, "icons") || "{}") as Record<string, string>,
  };
  const saveRegistry = () => {
    figma.root.setSharedPluginData(NS, "components", JSON.stringify(registry.components));
    figma.root.setSharedPluginData(NS, "icons", JSON.stringify(registry.icons));
  };
  const compCache: Record<string, ComponentNode | null> = {};
  async function getComp(id: string) {
    if (id in compCache) return compCache[id];
    const fid = registry.components[id];
    const c = fid ? ((await figma.getNodeByIdAsync(fid)) as ComponentNode | null) : null;
    return (compCache[id] = c);
  }
  const iconCache: Record<string, ComponentNode | null> = {};
  async function getIcon(name: string) {
    if (name in iconCache) return iconCache[name];
    const id = registry.icons[name];
    const c = id ? ((await figma.getNodeByIdAsync(id)) as ComponentNode | null) : null;
    return (iconCache[name] = c);
  }
  const tag = (node: BaseNode, id?: string) => { if (id) node.setSharedPluginData(NS, "pid", id); };
  /** Mark a node whose Pencil fill is an image, so the runner can swap the placeholder for real bytes. */
  const tagImage = (node: BaseNode, fill: PenProps["fill"]) => {
    for (const f of Array.isArray(fill) ? fill : fill ? [fill] : []) {
      if (f && typeof f === "object" && f.type === "image" && f.enabled !== false && f.url) {
        node.setSharedPluginData(NS, "img", JSON.stringify({ url: f.url, mode: f.mode ?? "fill" }));
        return;
      }
    }
  };
  const pidOf = (node: BaseNode) => node.getSharedPluginData(NS, "pid");

  // ── paints & effects ───────────────────────────────────────────────────────
  function hexPaint(h: string): SolidPaint {
    const c = parseHex(h);
    return { type: "SOLID", color: { r: c.r, g: c.g, b: c.b }, opacity: c.a };
  }
  function colorPaint(c: string): SolidPaint {
    if (isVarRef(c)) {
      const v = VAR[varName(c)];
      if (!v) { warn("missing variable " + c); return hexPaint("#FF00FF"); }
      const rv = resolveVar(varName(c)) || { r: 0, g: 0, b: 0 };
      return figma.variables.setBoundVariableForPaint({ type: "SOLID", color: { r: rv.r, g: rv.g, b: rv.b } }, "color", v);
    }
    return hexPaint(c);
  }
  function gradientPaint(g: Extract<PenFill, { type: "gradient" }>): GradientPaint {
    const stops = (g.colors || []).map((s): ColorStop => {
      if (isVarRef(s.color)) {
        const rv = resolveVar(varName(s.color));
        const stop: any = { color: { ...(rv || { r: 0, g: 0, b: 0 }), a: rv?.a ?? 1 }, position: num(s.position) };
        const v = VAR[varName(s.color)];
        if (v) stop.boundVariables = { color: { type: "VARIABLE_ALIAS", id: v.id } };
        return stop;
      }
      const c = parseHex(s.color);
      return { color: c, position: num(s.position) };
    });
    const type = g.gradientType || "linear";
    return {
      type: type === "linear" ? "GRADIENT_LINEAR" : type === "radial" ? "GRADIENT_RADIAL" : "GRADIENT_ANGULAR",
      gradientTransform: gradientTransform({
        gradientType: type, rotation: num(g.rotation), center: g.center,
        size: g.size ? { width: num(g.size.width ?? 1), height: num(g.size.height ?? 1) } : undefined,
      }) as Transform,
      gradientStops: stops,
      opacity: g.opacity !== undefined ? num(g.opacity) : 1,
    };
  }
  function paints(fill: PenFill | PenFill[] | undefined | null): Paint[] {
    if (fill === undefined || fill === null) return [];
    const out: Paint[] = [];
    for (const f of Array.isArray(fill) ? fill : [fill]) {
      if (typeof f === "string") { out.push(colorPaint(f)); continue; }
      if (!f || f.enabled === false) continue;
      if (f.type === "color") out.push(colorPaint(f.color));
      else if (f.type === "gradient") out.push(gradientPaint(f));
      else if (f.type === "image") { warn("image fill → placeholder (see images in the bundle)"); out.push(hexPaint("#E6EAF2")); }
      else if (f.type === "mesh_gradient") { warn("mesh gradient → first colour"); if (f.colors?.[0]) out.push(colorPaint(f.colors[0])); }
      else if (f.type === "shader") {
        const base = f.uniforms?.u_base;
        if (typeof base === "string") { warn("shader → u_base colour (render it with the shader tool)"); out.push(colorPaint(base)); }
        else warn("shader fill dropped");
      }
    }
    return out;
  }
  function effects(e: PenEffect | PenEffect[] | undefined): Effect[] {
    if (!e) return [];
    const out: Effect[] = [];
    for (const x of Array.isArray(e) ? e : [e]) {
      if (x.enabled === false) continue;
      if (x.type === "shadow") {
        let color: RGBA = { r: 0, g: 0, b: 0, a: 0.25 };
        let bound: Variable | undefined;
        if (x.color) {
          if (isVarRef(x.color)) { const rv = resolveVar(varName(x.color)); color = { ...rv, a: rv?.a ?? 1 }; bound = VAR[varName(x.color)]; }
          else color = parseHex(x.color);
        }
        let eff: DropShadowEffect | InnerShadowEffect = {
          type: x.shadowType === "inner" ? "INNER_SHADOW" : "DROP_SHADOW",
          color, offset: { x: num(x.offset?.x) || 0, y: num(x.offset?.y) || 0 },
          radius: num(x.blur) || 0, spread: 0, visible: true, blendMode: "NORMAL",
        } as DropShadowEffect;
        if (bound) eff = figma.variables.setBoundVariableForEffect(eff, "color", bound) as DropShadowEffect;
        out.push(eff);
      } else if (x.type === "blur") out.push({ type: "LAYER_BLUR", radius: num(x.radius) || 0, visible: true } as Effect);
      else if (x.type === "background_blur") out.push({ type: "BACKGROUND_BLUR", radius: num(x.radius) || 0, visible: true } as Effect);
    }
    return out;
  }

  // ── fonts ──────────────────────────────────────────────────────────────────
  const AVAIL = new Set((await figma.listAvailableFontsAsync()).map((f) => f.fontName.family + "|" + f.fontName.style));
  function fontOf(n: PenProps): FontName {
    let fam = n.fontFamily || DEFAULT_FONT;
    if (isVarRef(fam)) fam = resolveVar(varName(fam)) || DEFAULT_FONT;
    let w: any = n.fontWeight;
    if (isVarRef(w)) w = resolveVar(varName(w));
    const pick = pickFontStyle(fam, normalizeWeight(w), n.fontStyle === "italic", AVAIL);
    if (!pick.exact) warn(`font ${fam} ${n.fontWeight ?? 400}${n.fontStyle === "italic" ? " italic" : ""} → ${pick.style}`);
    return { family: fam, style: pick.style };
  }
  const loaded = new Set<string>();
  async function loadFont(fn: FontName) {
    const k = fn.family + "|" + fn.style;
    if (loaded.has(k)) return;
    await figma.loadFontAsync(fn);
    loaded.add(k);
  }
  async function preloadFonts(spec: any): Promise<void> {
    if (!spec || typeof spec !== "object") return;
    if (spec.type === "text" || spec.content !== undefined) { try { await loadFont(fontOf(spec)); } catch { warn("font unavailable for " + (spec.name || spec.id)); } }
    for (const c of spec.children || []) await preloadFonts(c);
    if (spec.descendants) for (const d of Object.values(spec.descendants)) await preloadFonts(d);
  }

  // ── property appliers ──────────────────────────────────────────────────────
  const isAL = (n: any): boolean => !!n && "layoutMode" in n && n.layoutMode !== "NONE";
  function bindNum(node: AnyNode, field: string, val: unknown) {
    if (val === undefined) return;
    if (isVarRef(val)) {
      try { node[field] = resolveVar(varName(val)); } catch {}
      const v = VAR[varName(val)];
      if (v) { try { node.setBoundVariable(field as VariableBindableNodeField, v); } catch { warn("bind " + field + " failed"); } }
    } else node[field] = val;
  }
  function applyLayout(f: AnyNode, n: PenProps, isNew: boolean) {
    const mode = layoutModeFor(n.layout, isNew);
    if (mode !== undefined) {
      f.layoutMode = mode;
      if (isNew && mode !== "NONE") { f.primaryAxisSizingMode = "AUTO"; f.counterAxisSizingMode = "AUTO"; f.strokesIncludedInLayout = !!n.layoutIncludeStroke; }
    }
    if (!isAL(f)) return;
    if (n.gap !== undefined) bindNum(f, "itemSpacing", n.gap);
    if (n.padding !== undefined) {
      const [t, r, b, l] = expandPadding(n.padding as any);
      bindNum(f, "paddingTop", t); bindNum(f, "paddingRight", r); bindNum(f, "paddingBottom", b); bindNum(f, "paddingLeft", l);
    }
    if (n.justifyContent !== undefined) { if (n.justifyContent === "space_around") warn("space_around → SPACE_BETWEEN"); f.primaryAxisAlignItems = primaryAlign(n.justifyContent); }
    if (n.alignItems !== undefined) f.counterAxisAlignItems = counterAlign(n.alignItems);
    if (n.layoutIncludeStroke !== undefined) f.strokesIncludedInLayout = !!n.layoutIncludeStroke;
  }
  function applyStroke(node: AnyNode, n: PenProps, isNew: boolean) {
    if (n.stroke === undefined && n.strokeWidth === undefined && n.strokeAlignment === undefined) return;
    if (n.stroke !== undefined) node.strokes = paints(n.stroke);
    const sw = n.strokeWidth;
    if (sw !== undefined) {
      if (typeof sw === "object" && !isVarRef(sw)) {
        if ("strokeTopWeight" in node) {
          node.strokeTopWeight = num(sw.top) || 0; node.strokeRightWeight = num(sw.right) || 0;
          node.strokeBottomWeight = num(sw.bottom) || 0; node.strokeLeftWeight = num(sw.left) || 0;
        } else node.strokeWeight = Math.max(num(sw.top) || 0, num(sw.right) || 0, num(sw.bottom) || 0, num(sw.left) || 0);
      } else node.strokeWeight = num(sw);
    } else if (n.stroke !== undefined && isNew) node.strokeWeight = 0; // Pencil draws no stroke without a width
    if (n.strokeAlignment) node.strokeAlign = n.strokeAlignment === "center" ? "CENTER" : n.strokeAlignment === "outer" ? "OUTSIDE" : "INSIDE";
    if (n.strokeLinecap && "strokeCap" in node) node.strokeCap = n.strokeLinecap === "round" ? "ROUND" : n.strokeLinecap === "square" ? "SQUARE" : "NONE";
    if (n.strokeLinejoin && "strokeJoin" in node) node.strokeJoin = n.strokeLinejoin.toUpperCase();
  }
  function applyRadius(node: AnyNode, r: PenProps["cornerRadius"]) {
    if (r === undefined || !("topLeftRadius" in node)) return;
    const [tl, tr, br, bl] = Array.isArray(r) ? r : [r, r, r, r];
    bindNum(node, "topLeftRadius", tl); bindNum(node, "topRightRadius", tr);
    bindNum(node, "bottomRightRadius", br); bindNum(node, "bottomLeftRadius", bl);
  }
  function applyCommon(node: AnyNode, n: PenProps) {
    if (n.name !== undefined) node.name = n.name;
    if (n.enabled === false || n.enabled === true) node.visible = n.enabled;
    if (n.opacity !== undefined) bindNum(node, "opacity", n.opacity);
    if (n.effect !== undefined && "effects" in node) node.effects = effects(n.effect);
    if (n.flipX || n.flipY) warn("flip ignored on " + (n.name || n.id));
  }

  /** Size a node that is already in its parent. `fallback` is the Pencil-measured bounds. */
  function applySize(node: AnyNode, n: PenProps, parent: AnyNode | null, fallback?: { w: number; h: number }) {
    const W = size(n.width), H = size(n.height);
    const inAL = isAL(parent) && n.layoutPosition !== "absolute";
    const pw = parent && "width" in parent ? parent.width : 100, ph = parent && "height" in parent ? parent.height : 100;
    const fixedOf = (S: ReturnType<typeof size>, axis: "w" | "h"): number | undefined => {
      if (S.kind === "fixed") return S.v;
      if (S.kind === "fill") return S.fb ?? fallback?.[axis] ?? (axis === "w" ? pw : ph);
      if (S.kind === "fit") return S.fb ?? fallback?.[axis];
      return fallback?.[axis];
    };
    if (node.type === "TEXT") {
      const growth = n.textGrowth;
      if (growth === "fixed-width" || growth === "fixed-width-height") {
        const w = fixedOf(W, "w") ?? node.width;
        const h = growth === "fixed-width-height" ? fixedOf(H, "h") ?? node.height : node.height;
        node.resize(Math.max(w, 0.01), Math.max(h, 0.01));
        node.textAutoResize = growth === "fixed-width" ? "HEIGHT" : "NONE";
        if (inAL && W.kind === "fill") node.layoutSizingHorizontal = "FILL";
        if (inAL && H.kind === "fill" && growth === "fixed-width-height") node.layoutSizingVertical = "FILL";
      } else node.textAutoResize = "WIDTH_AND_HEIGHT";
      return;
    }
    const hasAL = isAL(node);
    const isInstance = node.type === "INSTANCE";
    if (isInstance) {
      if (W.kind !== "unset" || H.kind !== "unset") {
        const w = fixedOf(W, "w"), h = fixedOf(H, "h");
        try { node.resize(Math.max(w !== undefined && (W.kind !== "fit" || !hasAL) ? w : node.width, 0.01), Math.max(h !== undefined && (H.kind !== "fit" || !hasAL) ? h : node.height, 0.01)); } catch (e: any) { warn("resize " + n.name + " " + e.message); }
      }
      if (W.kind === "fill" && inAL) node.layoutSizingHorizontal = "FILL";
      else if (W.kind === "fixed") node.layoutSizingHorizontal = "FIXED";
      else if (W.kind === "fit" && hasAL) node.layoutSizingHorizontal = "HUG";
      if (H.kind === "fill" && inAL) node.layoutSizingVertical = "FILL";
      else if (H.kind === "fixed") node.layoutSizingVertical = "FIXED";
      else if (H.kind === "fit" && hasAL) node.layoutSizingVertical = "HUG";
      return;
    }
    const w = fixedOf(W, "w"), h = fixedOf(H, "h");
    const cw = w !== undefined && (W.kind !== "fit" || !hasAL) ? w : node.width;
    const ch = h !== undefined && (H.kind !== "fit" || !hasAL) ? h : node.height;
    try { node.resize(Math.max(cw, 0.01), Math.max(ch, 0.01)); } catch (e: any) { warn("resize " + n.name + " " + e.message); }
    if (inAL || hasAL) {
      const isFrame = node.type === "FRAME" || node.type === "COMPONENT";
      try { node.layoutSizingHorizontal = sizingFor(W, { inAutoLayout: inAL, hasAutoLayout: hasAL, isFrame }); } catch (e: any) { warn("sizeH " + n.name + ": " + e.message); }
      try { node.layoutSizingVertical = sizingFor(H, { inAutoLayout: inAL, hasAutoLayout: hasAL, isFrame }); } catch (e: any) { warn("sizeV " + n.name + ": " + e.message); }
    }
  }
  function place(node: AnyNode, n: PenProps, parent: AnyNode) {
    if (n.layoutPosition === "absolute" && isAL(parent)) node.layoutPositioning = "ABSOLUTE";
    if (!isAL(parent) || n.layoutPosition === "absolute") { node.x = n.x || 0; node.y = n.y || 0; }
    if (n.rotation) node.rotation = num(n.rotation);
  }

  // ── builders ───────────────────────────────────────────────────────────────
  const isIconComp = (c: ComponentNode | null) => !!c && c.name.startsWith(ICON);
  function setIconColor(inst: InstanceNode, fill: PenProps["fill"]) {
    if (fill === undefined) return;
    const p = paints(fill);
    if (!p.length) return;
    for (const v of inst.findAll((x) => "strokes" in x && x.type !== "INSTANCE" && x.type !== "FRAME") as (SceneNode & Paintable & AnyNode)[]) {
      if (v.strokes?.length) v.strokes = [p[0]];
      if (v.fills && v.fills !== figma.mixed && (v.fills as Paint[]).length) v.fills = [p[0]];
    }
  }

  async function buildIcon(n: PenProps, parent: AnyNode) {
    const name = (n.icon ?? (n as any).iconFontName) as string;
    const comp = await getIcon(name);
    let node: AnyNode;
    if (!comp) { warn("icon missing " + name); node = figma.createFrame() as AnyNode; node.fills = []; }
    else node = comp.createInstance() as AnyNode;
    parent.appendChild(node);
    const w = num(size(n.width).kind === "fixed" ? (size(n.width) as any).v : 24) || 24;
    const h = num(size(n.height).kind === "fixed" ? (size(n.height) as any).v : 24) || 24;
    if (comp) { node.rescale(Math.min(w, h) / node.width); if (w !== h) node.resize(w, h); }
    node.name = n.name || ICON + name;
    tag(node, n.id);
    applyCommon(node, n);
    if (comp) setIconColor(node as InstanceNode, n.fill);
    place(node, n, parent);
    if (n.width === "fill_container" && isAL(parent)) node.layoutSizingHorizontal = "FILL";
    return node;
  }

  function applyText(t: AnyNode, n: PenProps, isNew: boolean) {
    if (n.fontSize !== undefined) bindNum(t, "fontSize", n.fontSize);
    if (isVarRef(n.fontFamily) && VAR[varName(n.fontFamily)]) { try { t.setBoundVariable("fontFamily", VAR[varName(n.fontFamily)]); } catch (e: any) { warn("bind fontFamily: " + e.message); } }
    if (n.lineHeight !== undefined) t.lineHeight = { unit: "PERCENT", value: lineHeightPercent(num(n.lineHeight)) };
    if (n.letterSpacing !== undefined) {
      t.letterSpacing = { unit: "PIXELS", value: num(n.letterSpacing) };
      if (isVarRef(n.letterSpacing) && VAR[varName(n.letterSpacing)]) { try { t.setBoundVariable("letterSpacing", VAR[varName(n.letterSpacing)]); } catch {} }
    }
    if (n.textAlign) t.textAlignHorizontal = { left: "LEFT", center: "CENTER", right: "RIGHT", justify: "JUSTIFIED" }[n.textAlign];
    if (n.textAlignVertical) t.textAlignVertical = { top: "TOP", middle: "CENTER", bottom: "BOTTOM" }[n.textAlignVertical];
    if (n.underline) t.textDecoration = "UNDERLINE";
    else if (n.strikethrough) t.textDecoration = "STRIKETHROUGH";
    if (n.fill !== undefined) t.fills = paints(n.fill);
    else if (isNew) t.fills = []; // Pencil text with no fill is invisible
  }

  async function buildText(n: PenProps, parent: AnyNode) {
    const t = figma.createText() as AnyNode;
    const fn = fontOf(n);
    await loadFont(fn);
    t.fontName = fn;
    let content: any = n.content ?? "";
    if (isVarRef(content)) content = resolveVar(varName(content)) ?? content;
    t.characters = String(content);
    parent.appendChild(t);
    tag(t, n.id);
    applyText(t, n, true);
    applyCommon(t, n);
    applyStroke(t, n, true);
    place(t, n, parent);
    applySize(t, n, parent);
    return t;
  }

  async function buildShape(n: PenNode & PenProps, parent: AnyNode) {
    let node: AnyNode;
    if (n.type === "ellipse") {
      node = figma.createEllipse() as AnyNode;
      const a = num((n as any).startAngle) || 0, s = (n as any).sweepAngle !== undefined ? num((n as any).sweepAngle) : 360, ir = num((n as any).innerRadius) || 0;
      if (s !== 360 || ir) {
        const rad = (d: number) => (d * Math.PI) / 180;
        node.arcData = { startingAngle: s >= 0 ? -rad(a + s) : -rad(a), endingAngle: s >= 0 ? -rad(a) : -rad(a) + rad(-s), innerRadius: ir };
      }
    } else if (n.type === "polygon") { node = figma.createPolygon() as AnyNode; node.pointCount = num((n as any).polygonCount) || 3; }
    else node = figma.createRectangle() as AnyNode;
    parent.appendChild(node);
    tag(node, n.id);
    node.fills = paints(n.fill);
    tagImage(node, n.fill);
    applyStroke(node, n, true);
    if (n.type !== "ellipse") applyRadius(node, n.cornerRadius);
    applyCommon(node, n);
    place(node, n, parent);
    applySize(node, n, parent);
    return node;
  }

  async function buildPath(n: PenProps & { geometry?: string; viewBox?: number[]; fillRule?: string }, parent: AnyNode) {
    const sw = size(n.width), sh = size(n.height);
    const w = (sw.kind === "fixed" ? sw.v : 24) || 24, h = (sh.kind === "fixed" ? sh.v : 24) || 24;
    const vb = n.viewBox ? n.viewBox.join(" ") : null;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" ${vb ? `viewBox="${vb}"` : ""} preserveAspectRatio="none"><path d="${n.geometry || ""}" fill="#000" fill-rule="${n.fillRule || "nonzero"}"/></svg>`;
    let wrap: AnyNode;
    try { wrap = figma.createNodeFromSvg(svg) as AnyNode; } catch (e: any) { warn("path " + n.name + ": " + e.message); wrap = figma.createFrame() as AnyNode; }
    wrap.fills = [];
    wrap.clipsContent = false;
    parent.appendChild(wrap);
    wrap.name = n.name || "path";
    tag(wrap, n.id);
    for (const v of wrap.findAll((x: SceneNode) => x.type === "VECTOR") as AnyNode[]) {
      v.fills = paints(n.fill);
      applyStroke(v, n, true);
      v.constraints = { horizontal: "SCALE", vertical: "SCALE" };
    }
    applyCommon(wrap, n);
    place(wrap, n, parent);
    if (!vb) applySize(wrap, n, parent);
    else {
      try { wrap.resize(w, h); } catch {}
      if (isAL(parent)) {
        if (sw.kind === "fill") wrap.layoutSizingHorizontal = "FILL";
        if (sh.kind === "fill") wrap.layoutSizingVertical = "FILL";
      }
    }
    return wrap;
  }

  async function buildFrame(n: PenProps & { children?: PenNode[] }, parent: AnyNode | null, o: { asComponent?: boolean; fallback?: Bounds } = {}) {
    const f = (o.asComponent ? figma.createComponent() : figma.createFrame()) as AnyNode;
    f.fills = [];
    f.clipsContent = !!num(n.clip);
    if (parent) parent.appendChild(f);
    tag(f, n.id);
    applyLayout(f, n, true);
    f.fills = paints(n.fill);
    tagImage(f, n.fill);
    applyStroke(f, n, true);
    applyRadius(f, n.cornerRadius);
    applyCommon(f, n);
    if (parent) place(f, n, parent);
    // Size before children so fill_container children resolve against it.
    const W = size(n.width), H = size(n.height);
    const pre = {
      w: W.kind === "fixed" ? W.v : o.fallback?.w ?? (W.kind === "fill" && parent ? parent.width : 100),
      h: H.kind === "fixed" ? H.v : o.fallback?.h ?? (H.kind === "fill" && parent ? parent.height : 100),
    };
    try { f.resize(Math.max(pre.w, 0.01), Math.max(pre.h, 0.01)); } catch {}
    for (const c of n.children || []) await build(c, f);
    if (parent) applySize(f, n, parent, o.fallback);
    else if (isAL(f)) {
      const horiz = f.layoutMode === "HORIZONTAL";
      const PK = (horiz ? W : H).kind, CK = (horiz ? H : W).kind;
      f.primaryAxisSizingMode = PK === "fixed" || (o.fallback && PK !== "fit" && PK !== "unset") ? "FIXED" : "AUTO";
      f.counterAxisSizingMode = CK === "fit" || CK === "unset" ? "AUTO" : "FIXED";
      const fw = W.kind === "fixed" ? W.v : W.kind !== "fit" && W.kind !== "unset" ? o.fallback?.w : undefined;
      const fh = H.kind === "fixed" ? H.v : H.kind !== "fit" && H.kind !== "unset" ? o.fallback?.h : undefined;
      if (fw !== undefined || fh !== undefined) {
        const p = f.primaryAxisSizingMode, c = f.counterAxisSizingMode;
        f.resize(fw ?? f.width, fh ?? f.height);
        f.primaryAxisSizingMode = p; f.counterAxisSizingMode = c;
      }
    } else {
      f.resize(Math.max((W.kind === "fixed" ? W.v : o.fallback?.w) || f.width, 0.01), Math.max((H.kind === "fixed" ? H.v : o.fallback?.h) || f.height, 0.01));
    }
    if (!isAL(f) && (W.kind === "fit" || H.kind === "fit") && f.children.length) {
      let mw = 0, mh = 0;
      for (const c of f.children) { mw = Math.max(mw, c.x + c.width); mh = Math.max(mh, c.y + c.height); }
      f.resize(W.kind === "fit" ? mw : f.width, H.kind === "fit" ? mh : f.height);
    }
    return f;
  }

  async function buildGroup(n: PenProps & { children?: PenNode[] }, parent: AnyNode) {
    const tmp = figma.createFrame();
    tmp.fills = []; tmp.clipsContent = false; tmp.layoutMode = "NONE";
    parent.appendChild(tmp);
    for (const c of n.children || []) await build(c, tmp as AnyNode);
    if (!tmp.children.length) { tmp.name = n.name || "group"; tag(tmp, n.id); place(tmp as AnyNode, n, parent); return tmp as AnyNode; }
    const g = figma.group([...tmp.children], parent as any, [...parent.children].indexOf(tmp)) as AnyNode;
    tmp.remove();
    g.name = n.name || "group";
    tag(g, n.id);
    applyCommon(g, n);
    place(g, n, parent);
    return g;
  }

  // ── instances ──────────────────────────────────────────────────────────────
  /** Walk a `/`-joined pen id path inside an instance. */
  function resolvePath(inst: AnyNode, path: string): AnyNode | null {
    let cur: AnyNode | null = inst;
    for (const p of path.split("/")) {
      if (!cur) return null;
      cur = cur.findOne((x: BaseNode) => pidOf(x) === p) as AnyNode | null;
    }
    return cur;
  }

  async function applyOverride(node: AnyNode, o: PenOverride) {
    const mc = node.type === "INSTANCE" ? await (node as InstanceNode).getMainComponentAsync() : null;
    const isIcon = isIconComp(mc);
    if (node.type === "TEXT") {
      const segs = node.getStyledTextSegments(["fontName"]);
      for (const s of segs) await figma.loadFontAsync(s.fontName);
      if (o.fontFamily !== undefined || o.fontWeight !== undefined || o.fontStyle !== undefined) {
        const cur: FontName = node.fontName !== figma.mixed ? node.fontName : segs[0].fontName;
        const fn = fontOf({ fontFamily: o.fontFamily ?? cur.family, fontWeight: o.fontWeight ?? styleWeight(cur.style), fontStyle: o.fontStyle ?? (/Italic/.test(cur.style) ? "italic" : "normal") });
        await loadFont(fn);
        node.fontName = fn;
      }
      if (o.content !== undefined) { let c: any = o.content; if (isVarRef(c)) c = resolveVar(varName(c)) ?? c; node.characters = String(c); }
      applyText(node, o, false);
    } else if (o.fill !== undefined) {
      if (isIcon) setIconColor(node as InstanceNode, o.fill);
      else if ("fills" in node) { node.fills = paints(o.fill); tagImage(node, o.fill); }
    }
    if (o.icon !== undefined && node.type === "INSTANCE") {
      const ic = await getIcon(o.icon);
      if (ic) {
        const s = node.width;
        (node as InstanceNode).swapComponent(ic);
        if (Math.abs(node.width - s) > 0.01) { try { node.rescale(s / node.width); } catch { try { node.resize(s, s); } catch {} } }
      } else warn("icon missing " + o.icon);
    }
    if (isIcon && (o.width !== undefined || o.height !== undefined)) {
      const a = size(o.width ?? o.height), b = size(o.height ?? o.width);
      const w = a.kind === "fixed" ? a.v : 0, h = b.kind === "fixed" ? b.v : 0;
      if (w && h && Math.abs(Math.min(w, h) - node.width) > 0.01) { try { node.rescale(Math.min(w, h) / node.width); } catch { try { node.resize(Math.min(w, h), Math.min(w, h)); } catch (e: any) { warn("icon resize " + e.message); } } }
    }
    if (node.type !== "TEXT" && "layoutMode" in node) applyLayout(node, o, false);
    if (node.type !== "TEXT") applyStroke(node, o, false);
    if (o.cornerRadius !== undefined) applyRadius(node, o.cornerRadius);
    if (o.clip !== undefined && "clipsContent" in node) node.clipsContent = !!num(o.clip);
    applyCommon(node, o);
    if (!isIcon && (o.width !== undefined || o.height !== undefined || o.textGrowth !== undefined)) {
      const growth = o.textGrowth ?? (node.type === "TEXT" ? (node.textAutoResize === "HEIGHT" ? "fixed-width" : node.textAutoResize === "NONE" ? "fixed-width-height" : "auto") : undefined);
      applySize(node, { ...o, textGrowth: growth as any }, node.parent as AnyNode);
    }
    if ((o.x !== undefined || o.y !== undefined) && (!isAL(node.parent) || node.layoutPositioning === "ABSOLUTE")) {
      if (o.x !== undefined) node.x = o.x;
      if (o.y !== undefined) node.y = o.y;
    }
  }
  function styleWeight(style: string): string {
    const s = style.replace(/ ?Italic$/, "") || "Regular";
    const map: Record<string, string> = { Thin: "100", ExtraLight: "200", "Extra Light": "200", Light: "300", Regular: "400", Medium: "500", SemiBold: "600", "Semi Bold": "600", Bold: "700", ExtraBold: "800", "Extra Bold": "800", Black: "900" };
    return map[s] ?? "400";
  }

  async function childMatches(c: AnyNode, sp: PenNode): Promise<boolean> {
    if (sp.type === "icon") { if (c.type !== "INSTANCE") return false; const m = await c.getMainComponentAsync(); return !!m && m.name === ICON + sp.icon; }
    if (sp.type === "text") return c.type === "TEXT" && c.characters === String(sp.content ?? "");
    if (sp.type === "ref") { if (c.type !== "INSTANCE") return false; const m = await c.getMainComponentAsync(); return !!m && pidOf(m) === (sp as PenRef).ref; }
    return false;
  }
  /**
   * A replacement subtree that matches the instance's existing children (same icons, texts, refs in
   * order) is applied as overrides instead, so the instance survives. Returns false when it must detach.
   */
  async function softReplace(tgt: AnyNode, spec: PenOverride): Promise<boolean> {
    const kids = spec.children || [];
    const props: any = { ...spec }; delete props.children; delete props.type; delete props.id;
    if (!spec.type) {
      if (!("children" in tgt) || tgt.children.length !== kids.length) return false;
      for (let i = 0; i < kids.length; i++) if (!(await childMatches(tgt.children[i], kids[i]))) return false;
      await applyOverride(tgt, props);
      for (let i = 0; i < kids.length; i++) {
        const k: any = { ...kids[i] }; delete k.type; delete k.id; delete k.icon; delete k.content; delete k.library;
        await applyOverride(tgt.children[i], k);
      }
      return true;
    }
    if (spec.type === "frame" && kids.length === 0 && tgt.type === "FRAME") {
      for (const c of tgt.children) c.visible = false;
      await applyOverride(tgt, props);
      return true;
    }
    return false;
  }

  async function buildRef(n: PenRef, parent: AnyNode) {
    const comp = await getComp(n.ref);
    if (!comp) { warn("component not built yet: " + n.ref); const f = figma.createFrame(); f.name = "MISSING " + n.ref; parent.appendChild(f); return f as AnyNode; }
    let node = comp.createInstance() as AnyNode;
    parent.appendChild(node);
    tag(node, n.id);
    const rootProps: any = { ...n };
    for (const k of ["type", "ref", "descendants", "id", "children"]) delete rootProps[k];
    const desc = n.descendants || {};
    const replacements = Object.entries(desc).filter(([, v]) => v && (v.type || v.children));
    const sized: [string, PenOverride][] = [];
    for (const [path, o] of Object.entries(desc)) {
      if (o && (o.type || o.children)) continue;
      const tgt = resolvePath(node, path);
      if (!tgt) { warn(`override target ${path} not found in ${comp.name}`); continue; }
      await applyOverride(tgt, o);
      if (tgt.type !== "TEXT" && tgt !== node && (o.width !== undefined || o.height !== undefined || o.layout !== undefined)) sized.push([path, o]);
    }
    const hard: [string, PenOverride][] = [];
    for (const [path, spec] of replacements) { const tgt = resolvePath(node, path); if (tgt && (await softReplace(tgt, spec))) continue; hard.push([path, spec]); }
    if (hard.length) {
      // Instances cannot take new children: detach, then replace in place.
      warn(`detached ${comp.name} for ${hard.length} replacement(s)`);
      node = (node as InstanceNode).detachInstance() as AnyNode;
      tag(node, n.id);
      for (const [path, spec] of hard) {
        const tgt = node.findOne((x: BaseNode) => pidOf(x) === path.split("/").pop()) as AnyNode | null;
        if (!tgt) { warn("replace target " + path + " missing"); continue; }
        if (!spec.type) {
          const { children: kids, ...props } = spec;
          await applyOverride(tgt, props);
          for (const c of [...tgt.children]) c.remove();
          for (const c of kids || []) await build(c, tgt);
          continue;
        }
        const par = tgt.parent as AnyNode, idx = par.children.indexOf(tgt);
        const built = await build(spec as PenNode, par);
        if (built) par.insertChild(idx, built);
        tgt.remove();
      }
    }
    if (sized.length && node.type === "INSTANCE") {
      // Figma ignores nested size and direction overrides on instances without an error. Check, then detach.
      const LM: Record<string, string> = { vertical: "VERTICAL", horizontal: "HORIZONTAL", none: "NONE" };
      const bad = sized.filter(([p, o]) => {
        const t = resolvePath(node, p); if (!t) return false;
        const SW = size(o.width), SH = size(o.height);
        return (SW.kind === "fixed" && Math.abs(t.width - SW.v) > 0.5) || (SH.kind === "fixed" && Math.abs(t.height - SH.v) > 0.5) || (o.layout !== undefined && "layoutMode" in t && t.layoutMode !== LM[o.layout]);
      });
      if (bad.length) {
        warn(`detached ${comp.name} for ${bad.length} size/layout override(s)`);
        node = (node as InstanceNode).detachInstance() as AnyNode;
        tag(node, n.id);
        for (const [p, o] of bad) { const t = node.findOne((x: BaseNode) => pidOf(x) === p.split("/").pop()) as AnyNode | null; if (t) await applyOverride(t, o); }
      }
    }
    const { width, height, ...rest } = rootProps;
    await applyOverride(node, rest);
    place(node, n, parent);
    applySize(node, { width, height, layoutPosition: n.layoutPosition }, parent);
    return node;
  }

  async function build(n: PenNode, parent: AnyNode, o?: { asComponent?: boolean; fallback?: Bounds }): Promise<AnyNode | null> {
    switch (n.type) {
      case "frame": return buildFrame(n, parent, o);
      case "text": return buildText(n, parent);
      case "icon": case "icon_font": return buildIcon(n, parent);
      case "ref": return buildRef(n as PenRef, parent);
      case "rectangle": case "ellipse": case "polygon": return buildShape(n, parent);
      case "path": return buildPath(n as any, parent);
      case "group": return buildGroup(n, parent);
      case "note": case "context": case "prompt": return null;
      default: warn("unsupported node type " + (n as any).type); return null;
    }
  }

  /** Re-bind solid paints whose stored colour drifted from their variable (Figma shows the stored one). */
  function repairPaints(root: SceneNode): number {
    const fix = (arr: unknown): Paint[] | null => {
      if (!Array.isArray(arr)) return null;
      let changed = false;
      const out = arr.map((p: any) => {
        const b = p.boundVariables?.color;
        if (p.type !== "SOLID" || !b) return p;
        const v = VBYID[b.id]; const rv = v && resolveVar(v.name);
        if (rv && Math.abs(rv.r - p.color.r) + Math.abs(rv.g - p.color.g) + Math.abs(rv.b - p.color.b) > 0.01) {
          changed = true;
          return figma.variables.setBoundVariableForPaint({ ...p, color: { r: rv.r, g: rv.g, b: rv.b } }, "color", v);
        }
        return p;
      });
      return changed ? out : null;
    };
    let n = 0;
    const all = [root, ...("findAll" in root ? (root as FrameNode).findAll(() => true) : [])] as AnyNode[];
    for (const x of all) {
      if ("fills" in x && x.fills !== figma.mixed) { const f = fix(x.fills); if (f) { try { x.fills = f; n++; } catch {} } }
      if ("strokes" in x) { const s = fix(x.strokes); if (s) { try { x.strokes = s; n++; } catch {} } }
    }
    return n;
  }

  // ── public API ─────────────────────────────────────────────────────────────
  /** Build a reusable Pencil node as a component and register it. Refuses to replace one that has instances. */
  async function buildComponent(spec: PenNode, container: BaseNode & ChildrenMixin, bounds?: Bounds) {
    await preloadFonts(spec);
    const pid = spec.id!;
    if (registry.components[pid]) {
      const old = (await figma.getNodeByIdAsync(registry.components[pid])) as ComponentNode | null;
      if (old) {
        const uses = await old.getInstancesAsync();
        if (uses.length) throw new Error(`${spec.name} already has ${uses.length} instance(s); rebuild dependents first`);
        old.remove();
      }
      delete registry.components[pid]; delete compCache[pid];
    }
    const c = (await buildFrame(spec as any, null, { asComponent: true, fallback: bounds })) as unknown as ComponentNode;
    container.appendChild(c);
    c.name = spec.name ?? pid;
    registry.components[pid] = c.id;
    saveRegistry();
    return c;
  }

  /** Build a top-level screen at its Pencil position. Reports a size delta against the Pencil bounds. */
  async function buildScreen(spec: PenNode, container: BaseNode & ChildrenMixin, bounds: Bounds): Promise<ScreenResult> {
    try {
      await preloadFonts(spec);
      const f = (await buildFrame(spec as any, null, { fallback: bounds })) as unknown as FrameNode;
      container.appendChild(f);
      if (bounds.x !== undefined) f.x = bounds.x;
      if (bounds.y !== undefined) f.y = bounds.y;
      repairPaints(f);
      const dw = Math.round(f.width - bounds.w), dh = Math.round(f.height - bounds.h);
      return { id: f.id, name: spec.name ?? spec.id ?? "screen", status: dw || dh ? `Δ${dw},${dh}` : "ok" };
    } catch (e: any) {
      return { name: spec.name ?? spec.id ?? "screen", status: `ERROR ${e.message}` };
    }
  }

  /** Register an existing Figma component as the target for a pen component id or an icon name. */
  function register(kind: "component" | "icon", key: string, figmaId: string) {
    (kind === "component" ? registry.components : registry.icons)[key] = figmaId;
    saveRegistry();
  }

  return { build, buildComponent, buildScreen, preloadFonts, repairPaints, register, resolveVar, warnings, registry, namespace: NS };
}

export type Engine = Awaited<ReturnType<typeof createEngine>>;

// An in-memory stand-in for the Figma plugin API: enough of the scene graph, auto layout, instances,
// fonts and variables to run the engine. Where Figma has a behaviour the engine works around, the
// fake reproduces it (marked QUIRK), so a test proves the workaround and not just the happy path.
//
// Layout is simplified: text is 0.5em per character, nothing wraps mid-word, and rotation is ignored.

/* eslint-disable @typescript-eslint/no-explicit-any */
type Axis = "w" | "h";

let SEQ = 0;
let ALL = new Map<string, Node>();
let LOADED = new Set<string>();
const fontKey = (f: { family: string; style: string }) => f.family + "|" + f.style;

class Node {
  id = String(++SEQ);
  name: string;
  visible = true;
  parent: any = null;
  removed = false;
  rotation = 0;
  opacity = 1;
  layoutPositioning: "AUTO" | "ABSOLUTE" = "AUTO";
  constraints = { horizontal: "MIN", vertical: "MIN" };
  boundVariables: Record<string, unknown> = {};
  _x = 0; _y = 0; _w = 100; _h = 100;
  _fill = { w: false, h: false };
  /** Inside an instance (not the instance itself). */
  _inInst = false;
  _pd = new Map<string, string>();

  constructor(public type: string) { this.name = type[0] + type.slice(1).toLowerCase(); ALL.set(this.id, this); }

  getSharedPluginData(ns: string, k: string) { return this._pd.get(ns + "\0" + k) ?? ""; }
  setSharedPluginData(ns: string, k: string, v: string) { this._pd.set(ns + "\0" + k, v); }
  setBoundVariable(field: string, v: { id: string } | null) { if (v) this.boundVariables[field] = { type: "VARIABLE_ALIAS", id: v.id }; else delete this.boundVariables[field]; }
  remove() {
    if (this.parent) { const c = this.parent.children; c.splice(c.indexOf(this), 1); }
    this.parent = null; this.removed = true; ALL.delete(this.id);
  }

  /** The auto-layout parent that positions and sizes this node, if any. */
  get _flow(): Frame | null {
    const p = this.parent;
    return p instanceof Frame && p.layoutMode !== "NONE" && this.layoutPositioning !== "ABSOLUTE" ? p : null;
  }
  get x() { const p = this._flow; return p ? p._offset(this, "w") : this._x; }
  set x(v: number) { this._x = v; }
  get y() { const p = this._flow; return p ? p._offset(this, "h") : this._y; }
  set y(v: number) { this._y = v; }
  get width() { return this._size("w"); }
  get height() { return this._size("h"); }
  _size(a: Axis): number { const p = this._flow; return p && this._fill[a] ? p._fillSize(this, a) : this._intrinsic(a); }
  _intrinsic(a: Axis): number { return a === "w" ? this._w : this._h; }
  resize(w: number, h: number) {
    if (this._inInst) return; // QUIRK: Figma ignores nested size overrides on instance sublayers, silently.
    if (!(w > 0 && h > 0)) throw new Error(`resize: invalid size ${w}x${h}`);
    this._w = w; this._h = h;
  }
  rescale(s: number) { this.resize(this.width * s, this.height * s); }

  get layoutSizingHorizontal() { return this._sizing("w"); }
  set layoutSizingHorizontal(v: string) { this._setSizing("w", v); }
  get layoutSizingVertical() { return this._sizing("h"); }
  set layoutSizingVertical(v: string) { this._setSizing("h", v); }
  _sizing(a: Axis) { return this._fill[a] ? "FILL" : this._hug(a) ? "HUG" : "FIXED"; }
  _hug(_a: Axis) { return false; }
  _setSizing(a: Axis, v: string) {
    if (v === "FILL") {
      // QUIRK: FILL only exists inside auto layout.
      if (!this._flow) throw new Error("FILL can only be set on children of auto-layout frames");
      this._fill[a] = true;
      return;
    }
    this._fill[a] = false;
    this._setHug(a, v === "HUG");
  }
  _setHug(_a: Axis, on: boolean) { if (on) throw new Error("HUG can only be set on auto-layout frames and text nodes"); }

  get absoluteBoundingBox() {
    let x = 0, y = 0;
    for (let n: any = this; n && n.type !== "PAGE"; n = n.parent) if (n.type !== "GROUP") { x += n.x; y += n.y; }
    return { x, y, width: this.width, height: this.height };
  }
}

class Shape extends Node {
  fills: any[] = [];
  strokes: any[] = [];
  strokeWeight = 1; // QUIRK: a new stroke is 1px wide; Pencil draws nothing without a width.
  strokeAlign = "INSIDE";
  effects: any[] = [];
}
class Rect extends Shape {
  topLeftRadius = 0; topRightRadius = 0; bottomRightRadius = 0; bottomLeftRadius = 0;
  strokeTopWeight = 0; strokeRightWeight = 0; strokeBottomWeight = 0; strokeLeftWeight = 0;
  constructor(type = "RECTANGLE") { super(type); this.fills = [{ type: "SOLID", color: { r: 0.85, g: 0.85, b: 0.85 } }]; }
}
class Ellipse extends Shape { arcData = { startingAngle: 0, endingAngle: 2 * Math.PI, innerRadius: 0 }; constructor() { super("ELLIPSE"); } }
class Polygon extends Shape { pointCount = 3; constructor() { super("POLYGON"); } }
class Vector extends Shape { strokeCap = "NONE"; strokeJoin = "MITER"; constructor() { super("VECTOR"); } }

function findAll(root: any, fn: (n: any) => boolean = () => true): any[] {
  const out: any[] = [];
  const walk = (n: any) => { for (const c of n.children ?? []) { if (fn(c)) out.push(c); walk(c); } };
  walk(root);
  return out;
}
function adopt(parent: any, n: any, index?: number) {
  // QUIRK: instances can't take new children.
  if (parent.type === "INSTANCE" || parent._inInst) throw new Error("Cannot move node. New parent is an instance or is inside of an instance");
  if (n.parent) { const c = n.parent.children; c.splice(c.indexOf(n), 1); }
  n.parent = parent;
  if (index === undefined) parent.children.push(n); else parent.children.splice(index, 0, n);
}

class Frame extends Rect {
  children: any[] = [];
  clipsContent = true;
  _layoutMode = "NONE";
  _pAuto = false; _cAuto = false;
  paddingTop = 0; paddingRight = 0; paddingBottom = 0; paddingLeft = 0;
  itemSpacing = 0;
  primaryAxisAlignItems = "MIN";
  counterAxisAlignItems = "MIN";
  strokesIncludedInLayout = false;
  constructor(type = "FRAME") { super(type); this.fills = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }]; }

  get layoutMode() { return this._layoutMode; }
  set layoutMode(v: string) { if (!this._inInst) this._layoutMode = v; } // QUIRK: direction overrides on instance sublayers are ignored.
  get primaryAxisSizingMode() { return this._pAuto ? "AUTO" : "FIXED"; }
  set primaryAxisSizingMode(v: string) { this._pAuto = v === "AUTO"; }
  get counterAxisSizingMode() { return this._cAuto ? "AUTO" : "FIXED"; }
  set counterAxisSizingMode(v: string) { this._cAuto = v === "AUTO"; }
  resize(w: number, h: number) {
    super.resize(w, h);
    // QUIRK: resizing an auto-layout frame fixes both axes.
    if (!this._inInst && this._layoutMode !== "NONE") { this._pAuto = false; this._cAuto = false; }
  }

  appendChild(n: any) { adopt(this, n); }
  insertChild(i: number, n: any) { adopt(this, n, i); }
  findAll(fn?: (n: any) => boolean) { return findAll(this, fn); }
  findOne(fn: (n: any) => boolean) { return findAll(this, fn)[0] ?? null; }

  _primary(a: Axis) { return (this._layoutMode === "HORIZONTAL") === (a === "w"); }
  _hug(a: Axis) { return this._layoutMode !== "NONE" && (this._primary(a) ? this._pAuto : this._cAuto); }
  _setHug(a: Axis, on: boolean) {
    if (this._layoutMode === "NONE") { super._setHug(a, on); return; }
    if (this._primary(a)) this._pAuto = on; else this._cAuto = on;
  }
  _pad(a: Axis): [number, number] { return a === "w" ? [this.paddingLeft, this.paddingRight] : [this.paddingTop, this.paddingBottom]; }
  _kids() { return this.children.filter((c: Node) => c.visible && c.layoutPositioning !== "ABSOLUTE"); }
  _intrinsic(a: Axis): number {
    if (!this._hug(a)) return super._intrinsic(a);
    // A FILL child counts at its own size here, which breaks the hug ↔ fill cycle.
    const sizes = this._kids().map((k: Node) => k._intrinsic(a));
    const [s, e] = this._pad(a);
    const content = this._primary(a) ? sizes.reduce((x, y) => x + y, 0) + this.itemSpacing * Math.max(sizes.length - 1, 0) : Math.max(0, ...sizes);
    return s + e + content;
  }
  _fillSize(child: Node, a: Axis): number {
    const [s, e] = this._pad(a);
    const inner = this._size(a) - s - e;
    if (!this._primary(a)) return Math.max(inner, 0);
    const kids = this._kids();
    const fixed = kids.filter((k: Node) => !k._fill[a]).reduce((x: number, k: Node) => x + k._size(a), 0);
    const fills = kids.filter((k: Node) => k._fill[a]).length;
    return Math.max((inner - fixed - this.itemSpacing * (kids.length - 1)) / fills, 0);
  }
  _offset(child: Node, a: Axis): number {
    const [s, e] = this._pad(a);
    const inner = this._size(a) - s - e;
    if (!this._primary(a)) {
      const free = inner - child._size(a);
      return s + (this.counterAxisAlignItems === "CENTER" ? free / 2 : this.counterAxisAlignItems === "MAX" ? free : 0);
    }
    const kids = this._kids();
    const sizes = kids.map((k: Node) => k._size(a));
    const free = inner - sizes.reduce((x, y) => x + y, 0) - this.itemSpacing * (kids.length - 1);
    const al = this.primaryAxisAlignItems;
    let pos = s + (al === "CENTER" ? free / 2 : al === "MAX" ? free : 0);
    const gap = al === "SPACE_BETWEEN" && kids.length > 1 ? this.itemSpacing + free / (kids.length - 1) : this.itemSpacing;
    for (let i = 0; i < kids.length; i++) { if (kids[i] === child) return pos; pos += sizes[i] + gap; }
    return s;
  }
}

class Component extends Frame {
  _instances: Instance[] = [];
  constructor() { super("COMPONENT"); }
  createInstance() {
    const inst = clone(this, "INSTANCE", false) as Instance;
    inst._main = this;
    this._instances.push(inst);
    return inst;
  }
  async getInstancesAsync() { return this._instances.filter((i) => !i.removed && i.type === "INSTANCE"); }
}

class Instance extends Frame {
  _main!: Component;
  constructor() { super("INSTANCE"); }
  async getMainComponentAsync() { return this._main; }
  detachInstance() {
    const f = new Frame();
    copyProps(this, f);
    f.type = "FRAME";
    const p = this.parent, idx = p ? p.children.indexOf(this) : -1;
    for (const c of [...this.children]) { this.children.splice(this.children.indexOf(c), 1); c.parent = f; f.children.push(c); }
    // Sublayers become ordinary layers; nested instances stay instances.
    const free = (n: any) => { n._inInst = false; if (n.type !== "INSTANCE") for (const c of n.children ?? []) free(c); };
    for (const c of f.children) free(c);
    if (p) { p.children[idx] = f; f.parent = p; this.parent = null; }
    this.remove();
    return f;
  }
  swapComponent(c: Component) {
    for (const k of [...this.children]) k.remove();
    for (const k of c.children) { const n = clone(k, k.type, true); n.parent = this; this.children.push(n); }
    this._main = c;
    this._w = c._w; this._h = c._h;
  }
}

class Text extends Shape {
  _chars = "";
  _font = { family: "Inter", style: "Regular" };
  fontSize = 12;
  lineHeight: any = { unit: "AUTO" };
  letterSpacing: any = { unit: "PIXELS", value: 0 };
  textAutoResize = "WIDTH_AND_HEIGHT";
  textAlignHorizontal = "LEFT";
  textAlignVertical = "TOP";
  textDecoration = "NONE";
  constructor() { super("TEXT"); this.strokeWeight = 1; }
  get characters() { return this._chars; }
  set characters(v: string) {
    if (!LOADED.has(fontKey(this._font))) throw new Error(`unloaded font "${this._font.family} ${this._font.style}"`); // QUIRK
    this._chars = v;
  }
  get fontName() { return this._font; }
  set fontName(f: { family: string; style: string }) {
    if (!LOADED.has(fontKey(f))) throw new Error(`unloaded font "${f.family} ${f.style}"`); // QUIRK
    this._font = f;
  }
  getStyledTextSegments() { return [{ start: 0, end: this._chars.length, fontName: this._font }]; }
  _lineH() { return this.lineHeight.unit === "PERCENT" ? (this.fontSize * this.lineHeight.value) / 100 : this.fontSize * 1.2; }
  _natural() { return this._chars.length * (this.fontSize * 0.5 + (this.letterSpacing.value ?? 0)); }
  _intrinsic(a: Axis): number {
    if (this.textAutoResize === "WIDTH_AND_HEIGHT") return a === "w" ? this._natural() : this._lineH();
    if (this.textAutoResize === "HEIGHT" && a === "h") return Math.max(1, Math.ceil(this._natural() / this.width)) * this._lineH();
    return super._intrinsic(a);
  }
  _hug(a: Axis) { return this.textAutoResize === "WIDTH_AND_HEIGHT" || (this.textAutoResize === "HEIGHT" && a === "h"); }
  _setHug(_a: Axis, on: boolean) { if (on) this.textAutoResize = "WIDTH_AND_HEIGHT"; }
}

class Group extends Node {
  children: any[] = [];
  effects: any[] = [];
  constructor() { super("GROUP"); }
  appendChild(n: any) { adopt(this, n); }
  insertChild(i: number, n: any) { adopt(this, n, i); }
  findAll(fn?: (n: any) => boolean) { return findAll(this, fn); }
  findOne(fn: (n: any) => boolean) { return findAll(this, fn)[0] ?? null; }
  _intrinsic(a: Axis) {
    const lo = Math.min(...this.children.map((c: Node) => (a === "w" ? c.x : c.y)));
    return Math.max(...this.children.map((c: Node) => (a === "w" ? c.x + c.width : c.y + c.height))) - lo;
  }
}

class Page extends Node {
  children: any[] = [];
  constructor(name: string) { super("PAGE"); this.name = name; }
  appendChild(n: any) { adopt(this, n); }
  insertChild(i: number, n: any) { adopt(this, n, i); }
  findAll(fn?: (n: any) => boolean) { return findAll(this, fn); }
  findOne(fn: (n: any) => boolean) { return findAll(this, fn)[0] ?? null; }
  async loadAsync() {}
}

const SKIP = new Set(["id", "parent", "children", "_pd", "boundVariables", "_fill", "_instances", "removed"]);
function copyProps(from: any, to: any) {
  for (const k of Object.keys(from)) if (!SKIP.has(k)) to[k] = structuredClone(from[k]);
  to._fill = { ...from._fill };
  to.boundVariables = structuredClone(from.boundVariables);
  to._pd = new Map(from._pd);
}
function clone(n: any, type: string, inInst: boolean): any {
  const C: any = { FRAME: Frame, COMPONENT: Frame, INSTANCE: Instance, RECTANGLE: Rect, ELLIPSE: Ellipse, POLYGON: Polygon, VECTOR: Vector, TEXT: Text, GROUP: Group }[type];
  const out = new C();
  copyProps(n, out);
  out.type = type;
  out._main = n.type === "INSTANCE" ? n._main : out._main;
  out._inInst = inInst;
  for (const c of n.children ?? []) { const k = clone(c, c.type === "COMPONENT" ? "FRAME" : c.type, true); k.parent = out; out.children.push(k); }
  if (type === "INSTANCE" && n._main && n.type === "INSTANCE") n._main._instances.push(out);
  return out;
}

export interface FakeVariable { id: string; name: string; variableCollectionId: string; resolvedType: string; valuesByMode: Record<string, unknown>; setValueForMode(m: string, v: unknown): void }
export interface FakeCollection { id: string; name: string; modes: { modeId: string; name: string }[]; renameMode(id: string, name: string): void; addMode(name: string): string }

/** Install a fresh fake as the `figma` global. Each call starts an empty document. */
export function installFakeFigma(opts: { fonts?: string[]; maxModes?: number } = {}) {
  SEQ = 0; ALL = new Map(); LOADED = new Set();
  const fonts = opts.fonts ?? ["Inter|Regular", "Inter|Italic", "Inter|Medium", "Inter|Semi Bold", "Inter|Bold"];
  const root: any = new Page("Document");
  root.type = "DOCUMENT";
  const page = new Page("Page 1");
  adopt(root, page);
  const variables: FakeVariable[] = [];
  const collections: FakeCollection[] = [];
  const createVariableCollection = (name: string): FakeCollection => {
    const c: FakeCollection = {
      id: "VariableCollectionId:" + ++SEQ, name, modes: [{ modeId: ++SEQ + ":0", name: "Mode 1" }],
      renameMode(id, n) { c.modes.find((m) => m.modeId === id)!.name = n; },
      addMode(n) {
        // QUIRK: the Figma plan caps modes per collection.
        if (c.modes.length >= (opts.maxModes ?? 4)) throw new Error(`Limited to ${opts.maxModes ?? 4} modes only`);
        const m = { modeId: ++SEQ + ":0", name: n }; c.modes.push(m); return m.modeId;
      },
    };
    collections.push(c);
    return c;
  };
  const createVariable = (name: string, coll: FakeCollection, resolvedType: string): FakeVariable => {
    const v: FakeVariable = { id: "VariableID:" + ++SEQ, name, variableCollectionId: coll.id, resolvedType, valuesByMode: {}, setValueForMode(m, x) { v.valuesByMode[m] = x; } };
    variables.push(v);
    return v;
  };
  let defaultColl: FakeCollection | undefined;
  const bind = (obj: any, field: string, v: FakeVariable) => ({ ...obj, boundVariables: { ...obj.boundVariables, [field]: { type: "VARIABLE_ALIAS", id: v.id } } });

  const figma: any = {
    mixed: Symbol("mixed"),
    skipInvisibleInstanceChildren: true,
    root,
    currentPage: page,
    createFrame: () => new Frame(),
    createComponent: () => new Component(),
    createText: () => new Text(),
    createRectangle: () => new Rect(),
    createEllipse: () => new Ellipse(),
    createPolygon: () => new Polygon(),
    createPage: () => { const p = new Page("Page"); adopt(root, p); return p; },
    createNodeFromSvg(svg: string) {
      const attr = (k: string) => parseFloat(new RegExp(`${k}="([\\d.]+)"`).exec(svg)?.[1] ?? "100");
      const f = new Frame(); f._w = attr("width"); f._h = attr("height");
      const v = new Vector(); v._w = f._w; v._h = f._h; v.fills = [{ type: "SOLID", color: { r: 0, g: 0, b: 0 } }];
      adopt(f, v);
      return f;
    },
    group(nodes: any[], parent: any, index?: number) {
      if (!nodes.length) throw new Error("Grouped nodes must not be empty");
      const g = new Group();
      adopt(parent, g, index);
      for (const n of nodes) adopt(g, n);
      return g;
    },
    async getNodeByIdAsync(id: string) { return ALL.get(id) ?? null; },
    async setCurrentPageAsync(p: any) { figma.currentPage = p; },
    async listAvailableFontsAsync() { return fonts.map((f) => { const [family, style] = f.split("|"); return { fontName: { family, style } }; }); },
    async loadFontAsync(f: { family: string; style: string }) {
      if (!fonts.includes(fontKey(f))) throw new Error(`font "${f.family} ${f.style}" is not available`);
      LOADED.add(fontKey(f));
    },
    variables: {
      async getLocalVariablesAsync() { return variables; },
      async getLocalVariableCollectionsAsync() { return collections; },
      createVariableCollection,
      createVariable,
      createVariableAlias: (v: FakeVariable) => ({ type: "VARIABLE_ALIAS", id: v.id }),
      setBoundVariableForPaint: (p: any, field: string, v: FakeVariable) => bind(p, field, v),
      setBoundVariableForEffect: (e: any, field: string, v: FakeVariable) => bind(e, field, v),
    },
  };
  (globalThis as any).figma = figma;

  return {
    figma,
    page,
    variables,
    collections,
    /** Add a local variable with one mode, in a collection called "Local". */
    addVariable(name: string, value: unknown, resolvedType = typeof value === "number" ? "FLOAT" : typeof value === "string" ? "STRING" : "COLOR"): FakeVariable {
      defaultColl ??= createVariableCollection("Local");
      const v = createVariable(name, defaultColl, resolvedType);
      v.setValueForMode(defaultColl.modes[0].modeId, value);
      return v;
    },
  };
}

export function uninstallFakeFigma() { delete (globalThis as any).figma; }

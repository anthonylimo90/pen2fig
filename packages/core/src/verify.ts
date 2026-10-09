// Checks run on built screens. Each one caught real porting bugs; none of them need the source file.

export interface Issue {
  screen: string;
  kind: "text-overflow" | "frame-overlap" | "missing-component" | "size-delta";
  detail: string;
}

/**
 * Visible text that runs past its parent or the screen edge. Hidden subtrees are skipped by walking
 * (findAll(n => n.visible) still returns text inside a hidden parent, with stale bounds).
 * Layers that clip on purpose (horizontal scroll rows) are skipped when `allowClipped` is true.
 */
export function textOverflow(screen: FrameNode, opts: { tolerance?: number; allowClipped?: boolean } = {}): Issue[] {
  const tol = opts.tolerance ?? 1.5;
  const out: Issue[] = [];
  const fb = screen.absoluteBoundingBox;
  if (!fb) return out;
  const walk = (n: SceneNode, clippedAbove: boolean) => {
    let kids: readonly SceneNode[] | undefined;
    try { if (n.visible === false) return; kids = "children" in n ? n.children : undefined; } catch { return; }
    if (n.type === "TEXT" && !(opts.allowClipped !== false && clippedAbove)) {
      const b = n.absoluteBoundingBox, pb = (n.parent as SceneNode | null)?.absoluteBoundingBox;
      if (b && pb && (b.x + b.width > pb.x + pb.width + tol || b.x + b.width > fb.x + fb.width + tol)) {
        out.push({ screen: screen.name, kind: "text-overflow", detail: n.characters.slice(0, 60) });
      }
    }
    const clips = clippedAbove || ("clipsContent" in n && (n as FrameNode).clipsContent && n !== screen);
    if (kids) for (const k of kids) walk(k, clips);
  };
  walk(screen, false);
  return out;
}

/** Top-level frames on a page that overlap each other — usually a bad position header. */
export function frameOverlaps(page: PageNode): Issue[] {
  const fr = page.children.filter((c) => c.type === "FRAME") as FrameNode[];
  const out: Issue[] = [];
  for (let i = 0; i < fr.length; i++) for (let j = i + 1; j < fr.length; j++) {
    const a = fr[i], b = fr[j];
    if (a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height) {
      out.push({ screen: a.name, kind: "frame-overlap", detail: b.name });
    }
  }
  return out;
}

/** Placeholder frames the engine leaves when a ref points at a component that was never built. */
export function missingComponents(screen: FrameNode): Issue[] {
  return screen.findAll((n) => n.name.startsWith("MISSING ")).map((n) => ({ screen: screen.name, kind: "missing-component" as const, detail: n.name.slice(8) }));
}

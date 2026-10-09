// Pencil (.pen) node shapes as returned by the Pencil MCP `Get(id, {includePathGeometry: true})`.
// The format is undocumented; these types cover what real files use. Unknown fields are kept
// (index signature) so the engine can warn instead of failing.

/** A value or a `$variable` reference. */
export type Var<T> = T | `$${string}`;

/** `120`, `"$space-4"`, `"fill_container"`, `"fill_container(320)"`, `"fit_content"`, `"fit_content(48)"`. */
export type PenSize = number | string;

export type PenPadding = Var<number> | [Var<number>, Var<number>] | [Var<number>, Var<number>, Var<number>, Var<number>];

export interface PenGradientStop {
  color: string;
  position: Var<number>;
}

export type PenFill =
  | string
  | { type: "color"; color: string; enabled?: boolean }
  | {
      type: "gradient";
      gradientType?: "linear" | "radial" | "angular";
      colors?: PenGradientStop[];
      rotation?: Var<number>;
      center?: { x?: number; y?: number };
      size?: { width?: Var<number>; height?: Var<number> };
      opacity?: Var<number>;
      enabled?: boolean;
    }
  | { type: "image"; url?: string; mode?: string; enabled?: boolean }
  | { type: "mesh_gradient"; colors?: string[]; enabled?: boolean }
  | { type: "shader"; url?: string; uniforms?: Record<string, unknown>; enabled?: boolean };

export interface PenEffect {
  type: "shadow" | "blur" | "background_blur";
  shadowType?: "outer" | "inner";
  color?: string;
  offset?: { x?: Var<number>; y?: Var<number> };
  blur?: Var<number>;
  radius?: Var<number>;
  enabled?: boolean;
}

export type PenStrokeWidth = Var<number> | { top?: Var<number>; right?: Var<number>; bottom?: Var<number>; left?: Var<number> };

/** Properties shared by every node, and the set allowed in a `descendants` override. */
export interface PenProps {
  id?: string;
  name?: string;
  enabled?: boolean;
  opacity?: Var<number>;
  x?: number;
  y?: number;
  rotation?: Var<number>;
  width?: PenSize;
  height?: PenSize;
  layoutPosition?: "absolute";
  fill?: PenFill | PenFill[];
  stroke?: PenFill | PenFill[];
  strokeWidth?: PenStrokeWidth;
  strokeAlignment?: "inner" | "center" | "outer";
  strokeLinecap?: "butt" | "round" | "square";
  strokeLinejoin?: "miter" | "round" | "bevel";
  effect?: PenEffect | PenEffect[];
  cornerRadius?: Var<number> | [Var<number>, Var<number>, Var<number>, Var<number>];
  // layout
  layout?: "horizontal" | "vertical" | "none";
  gap?: Var<number>;
  padding?: PenPadding;
  justifyContent?: "start" | "center" | "end" | "space_between" | "space_around";
  alignItems?: "start" | "center" | "end";
  layoutIncludeStroke?: boolean;
  clip?: Var<boolean | number>;
  // text
  content?: string;
  fontFamily?: string;
  fontWeight?: string;
  fontStyle?: "normal" | "italic";
  fontSize?: Var<number>;
  lineHeight?: Var<number>;
  letterSpacing?: Var<number>;
  textAlign?: "left" | "center" | "right" | "justify";
  textAlignVertical?: "top" | "middle" | "bottom";
  textGrowth?: "auto" | "fixed-width" | "fixed-width-height";
  underline?: boolean;
  strikethrough?: boolean;
  // icon
  icon?: string;
  library?: string;
  flipX?: boolean;
  flipY?: boolean;
  [extra: string]: unknown;
}

export interface PenFrame extends PenProps { type: "frame"; reusable?: boolean; children?: PenNode[] }
export interface PenGroup extends PenProps { type: "group"; children?: PenNode[] }
export interface PenText extends PenProps { type: "text" }
export interface PenIcon extends PenProps { type: "icon" | "icon_font"; icon?: string; iconFontName?: string }
export interface PenShape extends PenProps {
  type: "rectangle" | "ellipse" | "polygon";
  startAngle?: Var<number>;
  sweepAngle?: Var<number>;
  innerRadius?: Var<number>;
  polygonCount?: Var<number>;
}
export interface PenPath extends PenProps { type: "path"; geometry?: string; viewBox?: number[]; fillRule?: "nonzero" | "evenodd" }
/** An instance of a reusable node. `descendants` keys are `/`-joined id paths inside the component. */
export interface PenRef extends PenProps {
  type: "ref";
  ref: string;
  descendants?: Record<string, PenOverride>;
}
/** A property override, or — when it has `type` or `children` — a replacement subtree. */
export type PenOverride = PenProps & { type?: PenNode["type"]; children?: PenNode[] };
export interface PenAnnotation extends PenProps { type: "note" | "context" | "prompt" }

export type PenNode = PenFrame | PenGroup | PenText | PenIcon | PenShape | PenPath | PenRef | PenAnnotation;

/** Canvas bounds of a top-level node, measured in Pencil. Used as the size fallback for `fill_container` roots. */
export interface Bounds { w: number; h: number; x?: number; y?: number }

/** One variable from Pencil's `GetVariables()`. A themed value is a list; later matching entries win. */
export interface PenVariable {
  type: "color" | "number" | "string" | "boolean";
  value: unknown | { value: unknown; theme?: Record<string, string> }[];
}
/** Pencil's `GetVariables()` result. `themes` maps an axis (`mode`) to its values (`["light", "dark"]`). */
export interface PenVariables { variables: Record<string, PenVariable>; themes?: Record<string, string[]> }

import type { RGBA } from "../engine/types";

export type ToolId =
  | "pencil" | "eraser" | "bucket" | "picker" | "outline" | "airbrush"
  | "line" | "rect" | "ellipse" | "circle" | "polygon"
  | "select" | "wand" | "lasso";

export interface ToolDef {
  id: ToolId;
  icon: string; // sprite symbol name
  /** paints single pixels */
  drawing: boolean;
  /** shape tool that redraws from a clean start each move */
  shape: boolean;
}

export const CORE_TOOLS: ToolDef[] = [
  { id: "pencil", icon: "i-pencil", drawing: true, shape: false },
  { id: "eraser", icon: "i-eraser", drawing: true, shape: false },
  { id: "bucket", icon: "i-bucket", drawing: true, shape: false },
  { id: "picker", icon: "i-picker", drawing: false, shape: false },
  // continuous random-dot spray; the speck size range is user-tunable
  { id: "airbrush", icon: "i-airbrush", drawing: true, shape: false },
  // freehand closed shape that fills itself on release (lasso + bucket in one)
  { id: "outline", icon: "i-outline", drawing: false, shape: false },
];

export const SHAPE_TOOLS: ToolDef[] = [
  { id: "line", icon: "i-line", drawing: false, shape: true },
  { id: "rect", icon: "i-rect", drawing: false, shape: true },
  { id: "ellipse", icon: "i-ellipse", drawing: false, shape: true },
  { id: "circle", icon: "i-circle", drawing: false, shape: true },
  { id: "polygon", icon: "i-poly", drawing: false, shape: true },
];

export const SELECT_TOOLS: ToolDef[] = [
  { id: "select", icon: "i-select", drawing: false, shape: false },
  { id: "wand", icon: "i-wand", drawing: false, shape: false },
  { id: "lasso", icon: "i-lasso", drawing: false, shape: false },
];
export const isSelectTool = (id: ToolId): boolean =>
  id === "select" || id === "wand" || id === "lasso";

export const isShapeTool = (id: ToolId): boolean => SHAPE_TOOLS.some((t) => t.id === id);

/** Unified drawing symmetry: one mirror axis whose angle the user picks from
 *  0/45/90/135; the separate symFour flag optionally adds the perpendicular
 *  axis (four-way symmetry). Vertical/horizontal are no longer separate modes. */
export type SymMode = "off" | "on";
export const SYM_CYCLE: SymMode[] = ["off", "on"];
export const nextSym = (m: SymMode): SymMode => SYM_CYCLE[(SYM_CYCLE.indexOf(m) + 1) % SYM_CYCLE.length];
/** selectable symmetry-axis angles (degrees) */
export const SYM_ANGLES = [0, 45, 90, 135] as const;

/** brush/shape tools whose marks honour drawing symmetry */
export const SYM_TOOLS = ["pencil", "eraser", "airbrush", "line", "rect", "ellipse", "circle", "polygon", "outline"] as const;
export const isSymTool = (id: string): boolean => (SYM_TOOLS as readonly string[]).includes(id);

export interface BrushState {
  color: RGBA;
  size: number;   // pixel diameter (>=1)
  alpha: number;  // 0..100
  pressure: number; // 0..1, 1 for touch/mouse
}

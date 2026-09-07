import type { RGBA } from "../engine/types";

export type ToolId =
  | "pencil" | "eraser" | "bucket" | "picker"
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

/** Drawing symmetry. lr = mirror across the vertical centre (左右), tb = across
 *  the horizontal centre (上下), both = four-way (四向). */
export type SymMode = "off" | "lr" | "tb" | "both";
export const SYM_CYCLE: SymMode[] = ["off", "lr", "tb", "both"];
export const nextSym = (m: SymMode): SymMode => SYM_CYCLE[(SYM_CYCLE.indexOf(m) + 1) % SYM_CYCLE.length];

/** brush/shape tools whose marks honour drawing symmetry */
export const SYM_TOOLS = ["pencil", "eraser", "line", "rect", "ellipse", "circle", "polygon"] as const;
export const isSymTool = (id: string): boolean => (SYM_TOOLS as readonly string[]).includes(id);

export interface BrushState {
  color: RGBA;
  size: number;   // pixel diameter (>=1)
  alpha: number;  // 0..100
  pressure: number; // 0..1, 1 for touch/mouse
}

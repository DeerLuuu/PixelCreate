/** Gesture / action ids kept in their own tiny module so both the registry and
 *  the session can import them without a cycle. */
export type GestureId =
  | "doubleTapMargin" | "doubleTapCanvas" | "twoFingerDoubleTap"
  | "tripleTap" | "fourFinger" | "longPress";

export type GestureActionId =
  | "none" | "undo" | "redo" | "zoomIn" | "zoomOut" | "fitView"
  | "togglePlay" | "toggleOnion" | "toggleGrid" | "toggleSymmetry"
  | "toggleTimeline" | "framePreview" | "nextFrame" | "prevFrame"
  | "openPalette" | "pickColor";

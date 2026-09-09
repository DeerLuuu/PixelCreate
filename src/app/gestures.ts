// Gesture → action mapping.
//
// Every touch gesture in the viewport runs through this table instead of a
// hard-coded behaviour, so the user can re-map any of them from Settings.
// Pure data + helpers: no DOM, no session import.
import type { GestureActionId, GestureId } from "./gesture-ids";

export type { GestureActionId, GestureId };

export interface GestureActionDef {
  id: GestureActionId;
  /** i18n key */
  label: string;
}

/** everything a gesture can be bound to (label = i18n key) */
export const GESTURE_ACTIONS: GestureActionDef[] = [
  { id: "none", label: "gactNone" },
  { id: "undo", label: "gactUndo" },
  { id: "redo", label: "gactRedo" },
  { id: "zoomIn", label: "gactZoomIn" },
  { id: "zoomOut", label: "gactZoomOut" },
  { id: "fitView", label: "gactFit" },
  { id: "togglePlay", label: "gactPlay" },
  { id: "toggleOnion", label: "gactOnion" },
  { id: "toggleGrid", label: "gactGrid" },
  { id: "toggleSymmetry", label: "gactSymmetry" },
  { id: "toggleTimeline", label: "gactTimeline" },
  { id: "framePreview", label: "gactPreview" },
  { id: "nextFrame", label: "gactNextFrame" },
  { id: "prevFrame", label: "gactPrevFrame" },
  { id: "nextLayer", label: "gactNextLayer" },
  { id: "prevLayer", label: "gactPrevLayer" },
  { id: "openPalette", label: "gactPalette" },
  { id: "pickColor", label: "gactPick" },
];

export const GESTURE_ACTION_IDS: GestureActionId[] = GESTURE_ACTIONS.map((a) => a.id);

export interface GestureDef {
  id: GestureId;
  /** i18n keys */
  label: string;
  desc: string;
  /** the behaviour that shipped before the mapping existed */
  defaultAction: GestureActionId;
  /** actions that make sense for this gesture */
  actions: GestureActionId[];
  /** backing Prefs field */
  field: string;
}

const ALL: GestureActionId[] = GESTURE_ACTION_IDS;
const NO_PICK: GestureActionId[] = ALL.filter((a) => a !== "pickColor");

export const GESTURES: GestureDef[] = [
  {
    id: "doubleTapMargin",
    label: "gestureDoubleTapMargin",
    desc: "gestureDoubleTapMarginDesc",
    defaultAction: "undo",
    actions: NO_PICK,
    field: "gDoubleTapMargin",
  },
  {
    id: "doubleTapCanvas",
    label: "gestureDoubleTapCanvas",
    desc: "gestureDoubleTapCanvasDesc",
    defaultAction: "none",
    actions: NO_PICK,
    field: "gDoubleTapCanvas",
  },
  {
    id: "twoFingerDoubleTap",
    label: "gestureTwoFingerDoubleTap",
    desc: "gestureTwoFingerDoubleTapDesc",
    defaultAction: "redo",
    actions: NO_PICK,
    field: "gTwoFingerDoubleTap",
  },
  {
    id: "twoFingerLongPress",
    label: "gestureTwoFingerLongPress",
    desc: "gestureTwoFingerLongPressDesc",
    defaultAction: "nextLayer",
    actions: ALL,
    field: "gTwoFingerLongPress",
  },
  {
    id: "threeFingerLongPress",
    label: "gestureThreeFingerLongPress",
    desc: "gestureThreeFingerLongPressDesc",
    defaultAction: "nextLayer",
    actions: ALL,
    field: "gThreeFingerLongPress",
  },
  {
    id: "tripleTap",
    label: "gestureTripleTap",
    desc: "gestureTripleTapDesc",
    defaultAction: "zoomIn",
    actions: ALL,
    field: "gTripleTap",
  },
  {
    id: "fourFinger",
    label: "gestureFourFinger",
    desc: "gestureFourFingerDesc",
    defaultAction: "framePreview",
    actions: ALL,
    field: "gFourFinger",
  },
  {
    id: "longPress",
    label: "gestureLongPress",
    desc: "gestureLongPressDesc",
    defaultAction: "pickColor",
    actions: ALL,
    field: "gLongPress",
  },
];

export const GESTURE_BY_ID: Map<GestureId, GestureDef> = new Map(GESTURES.map((g) => [g.id, g]));

/** dotted settings path of one gesture */
export function gesturePath(id: GestureId): string {
  return "gesture." + id;
}

/** true when `action` is allowed for `id` (used to validate loaded prefs) */
export function isActionAllowed(id: GestureId, action: string): boolean {
  const g = GESTURE_BY_ID.get(id);
  return !!g && g.actions.includes(action as GestureActionId);
}

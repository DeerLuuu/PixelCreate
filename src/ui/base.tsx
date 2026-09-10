// App-facing base module: the Session-aware glue plus re-exports of the
// SESSION-free kit primitives, so existing call sites keep importing "./base".
// The real implementations live in src/ui/kit (see docs/UI.md §1).
import { useSyncExternalStore } from "react";
import { SESSION } from "./singleton";
import { makeT } from "./i18n";
import type { Lang } from "./i18n";
import type { Snapshot } from "../app/session";
import { ScrubNum as ScrubNumBase } from "./kit/scrub";
import type { ScrubNumProps } from "./kit/scrub";

export { Icon, Btn, TipHost, Overlay, Keep, useBlankTap, useLandscape } from "./kit/primitives";

export function useSession(): Snapshot {
  return useSyncExternalStore(
    (cb) => SESSION.subscribe(cb),
    () => SESSION.snapshot(),
    () => SESSION.snapshot()
  );
}

/**
 * Numeric input with a scrub gesture and a live formula pad.
 * Thin wrapper over the kit component: it only injects the translated pad
 * tooltip, keeping the kit free of Session/i18n imports.
 */
export function ScrubNum(props: ScrubNumProps) {
  return <ScrubNumBase {...props} padTitle={makeT(SESSION.prefs.lang as Lang)("calcHint")} />;
}

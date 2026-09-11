// Animation tags (named frame ranges) — model, structural ops, playback
// window and the Session API. Playback itself is timer-driven, so the stepping
// rules are proven on the pure functions in src/app/playback.ts and the Session
// is checked for which window it picks.
import { Session } from "../src/app/session";
import { Doc } from "../src/engine/doc";
import * as ops from "../src/engine/ops";
import {
  clampRange, nextTagName, normalizeTags, tagAt, tagById, tagLanes, tagRangeLabel,
  tagsAfterInsert, tagsAfterRemove,
} from "../src/engine/tags";
import { fullWindow, nextPlayFrameIn, startPlayFrameIn, windowOf } from "../src/app/playback";
import * as project from "../src/io/project";
import { aseToDoc, parseAse } from "../src/io/aseread";
import { writeAse } from "../src/io/asewrite";
import { stubEnv } from "./session.test";
import { eq, ok } from "./common";

const tag = (from: number, to: number, name = "tag"): { id: string; name: string; from: number; to: number } =>
  ({ id: name, name, from, to });

/** frames 0..4 with two tags: "walk" = 1-3, "jump" = 4-4 */
function docWithTags(): Doc {
  const doc = new Doc(2, 2, "t");
  for (let i = 0; i < 4; i++) ops.addFrame(doc, doc.frames.length);
  doc.tags = [tag(1, 3, "walk"), tag(4, 4, "jump")];
  return doc;
}

export function testTags(): void {
  // ---------------- pure helpers ----------------
  eq("tag.at.inside", tagAt([tag(1, 3, "a"), tag(5, 6, "b")], 2)?.name, "a");
  eq("tag.at.edges", [tagAt([tag(1, 3)], 1)?.name, tagAt([tag(1, 3)], 3)?.name], ["tag", "tag"]);
  eq("tag.at.outside", tagAt([tag(1, 3)], 4), null);
  eq("tag.at.none", tagAt([], 0), null);
  eq("tag.by-id", tagById([tag(1, 3, "a")], "a")?.from, 1);
  eq("tag.by-id.missing", tagById([tag(1, 3, "a")], "zzz"), null);
  eq("tag.label.range", tagRangeLabel({ from: 2, to: 6 }), "3–7");
  eq("tag.label.single", tagRangeLabel({ from: 0, to: 0 }), "1");

  eq("tag.name.first", nextTagName([], "Tag"), "Tag 1");
  eq("tag.name.skips-used", nextTagName([tag(0, 0, "Tag 1"), tag(1, 1, "Tag 3")], "Tag"), "Tag 2");

  eq("tag.clamp.inside", clampRange(1, 3, 5), { from: 1, to: 3 });
  eq("tag.clamp.swapped", clampRange(3, 1, 5), { from: 1, to: 3 });
  eq("tag.clamp.over", clampRange(-2, 9, 5), { from: 0, to: 4 });
  eq("tag.clamp.empty-doc", clampRange(0, 0, 0), null);

  eq("tag.normalize.drops-empty", normalizeTags([tag(0, 0, "a")], 0), []);
  eq("tag.normalize.sorts", normalizeTags([tag(3, 4, "b"), tag(0, 1, "a")], 6).map((t) => t.name), ["a", "b"]);
  eq("tag.normalize.clamps", normalizeTags([{ ...tag(0, 9, "a"), color: "#fff" }], 3).map((t) => [t.from, t.to, t.color]),
    [[0, 2, "#fff"]]);

  // ---------------- ranges follow frame edits ----------------
  {
    const t = [tag(2, 4, "a")];
    tagsAfterInsert(t, 1);
    eq("tag.insert.before", [t[0].from, t[0].to], [3, 5]);
  }
  {
    const t = [tag(2, 4, "a")];
    tagsAfterInsert(t, 3);
    eq("tag.insert.inside-grows", [t[0].from, t[0].to], [2, 5]);
  }
  {
    const t = [tag(2, 4, "a")];
    tagsAfterInsert(t, 5);
    eq("tag.insert.after", [t[0].from, t[0].to], [2, 4]);
  }
  eq("tag.remove.inside", tagsAfterRemove([tag(2, 4, "a")], 3, 4).map((x) => [x.from, x.to]), [[2, 3]]);
  eq("tag.remove.first", tagsAfterRemove([tag(2, 4, "a")], 2, 4).map((x) => [x.from, x.to]), [[2, 3]]);
  eq("tag.remove.last", tagsAfterRemove([tag(2, 4, "a")], 4, 4).map((x) => [x.from, x.to]), [[2, 3]]);
  eq("tag.remove.shift", tagsAfterRemove([tag(2, 4, "a")], 0, 4).map((x) => [x.from, x.to]), [[1, 3]]);
  eq("tag.remove.kills-single", tagsAfterRemove([tag(3, 3, "a")], 3, 4), []);

  // ---------------- ops keep tags valid ----------------
  {
    const doc = docWithTags();
    ops.addFrame(doc, 2); // inside "walk"
    eq("ops.add-frame.inside", doc.tags.map((t) => [t.name, t.from, t.to]), [["walk", 1, 4], ["jump", 5, 5]]);
  }
  {
    const doc = docWithTags();
    ops.addFrame(doc, 0); // before everything
    eq("ops.add-frame.before", doc.tags.map((t) => [t.from, t.to]), [[2, 4], [5, 5]]);
  }
  {
    const doc = docWithTags();
    ops.duplicateFrame(doc, 2); // duplicating a tagged frame extends that tag
    eq("ops.dupe-frame", doc.tags.map((t) => [t.from, t.to]), [[1, 4], [5, 5]]);
  }
  {
    const doc = docWithTags();
    ops.removeFrame(doc, 2);
    eq("ops.remove-frame", doc.tags.map((t) => [t.from, t.to]), [[1, 2], [3, 3]]);
  }
  {
    const doc = docWithTags();
    ops.removeFrame(doc, 4); // the whole "jump" tag goes away
    eq("ops.remove-frame.drops-tag", doc.tags.map((t) => t.name), ["walk"]);
  }
  {
    const doc = docWithTags();
    ops.moveFrame(doc, 0, 4); // ranges stay put, only clamped
    eq("ops.move-frame.keeps-ranges", doc.tags.map((t) => [t.name, t.from, t.to]), [["walk", 1, 3], ["jump", 4, 4]]);
  }

  // ---------------- playback window ----------------
  eq("window.no-tag", windowOf(null, 5), { from: 0, to: 4 });
  eq("window.full", fullWindow(5), { from: 0, to: 4 });
  eq("window.tag", windowOf(tag(1, 3), 5), { from: 1, to: 3 });
  eq("window.clamped", windowOf({ from: 3, to: 99 }, 5), { from: 3, to: 4 });
  eq("window.garbage", windowOf({ from: 4, to: 1 }, 5), { from: 0, to: 4 });

  const w = windowOf(tag(2, 4), 8);
  eq("play.start.keeps-inside", startPlayFrameIn("loop", 3, w), 3);
  eq("play.start.once-rewinds-in-window", startPlayFrameIn("once", 4, w), 2);
  eq("play.start.before-window", startPlayFrameIn("loop", 0, w), 2);
  eq("play.start.once-mid", startPlayFrameIn("once", 3, w), 3);

  // loop stays inside 2..4
  {
    const seen: number[] = [];
    let fi = 2, dir: 1 | -1 = 1;
    for (let i = 0; i < 6; i++) {
      const step = nextPlayFrameIn("loop", fi, dir, w);
      fi = step.fi;
      dir = step.dir;
      seen.push(fi);
    }
    eq("play.loop.window", seen, [3, 4, 2, 3, 4, 2]);
  }
  // reverse wraps to the window END, not the timeline end
  eq("play.reverse.window", nextPlayFrameIn("reverse", 2, -1, w).fi, 4);
  // once stops at the window end
  eq("play.once.window.stop", nextPlayFrameIn("once", 4, 1, w), { fi: 4, dir: 1, stop: true });
  eq("play.once.window.next", nextPlayFrameIn("once", 3, 1, w).fi, 4);
  // ping-pong bounces inside the window
  {
    const seen: number[] = [];
    let fi = 2, dir: 1 | -1 = 1;
    for (let i = 0; i < 6; i++) {
      const step = nextPlayFrameIn("pingpong", fi, dir, w);
      fi = step.fi;
      dir = step.dir;
      seen.push(fi);
    }
    eq("play.pingpong.window", seen, [3, 4, 3, 2, 3, 4]);
  }
  // a one-frame window never advances (and stops in "once")
  eq("play.single.window", nextPlayFrameIn("loop", 6, 1, windowOf(tag(6, 6), 8)), { fi: 6, dir: 1, stop: true });

  // ---------------- overlapping tags get their own lane ----------------
  {
    const lanes = tagLanes([{ ...tag(0, 2, "a") }, { ...tag(5, 7, "b") }, { ...tag(9, 9, "c") }]);
    eq("tag.lanes.disjoint", [lanes.lanes, lanes.laneOf.get("a"), lanes.laneOf.get("b"), lanes.laneOf.get("c")], [1, 0, 0, 0]);
  }
  {
    // touching ranges (0-1 and 2-3) do not overlap: same lane
    const lanes = tagLanes([{ ...tag(0, 1, "a") }, { ...tag(2, 3, "b") }]);
    eq("tag.lanes.touching", [lanes.lanes, lanes.laneOf.get("b")], [1, 0]);
  }
  {
    const lanes = tagLanes([{ ...tag(1, 4, "walk") }, { ...tag(3, 6, "run") }]);
    eq("tag.lanes.overlap", [lanes.lanes, lanes.laneOf.get("walk"), lanes.laneOf.get("run")], [2, 0, 1]);
  }
  {
    // nested + a third tag that can reuse the first lane again
    const lanes = tagLanes([{ ...tag(0, 9, "all") }, { ...tag(2, 3, "x") }, { ...tag(4, 5, "y") }]);
    eq("tag.lanes.nested", [lanes.lanes, lanes.laneOf.get("all"), lanes.laneOf.get("x"), lanes.laneOf.get("y")], [2, 0, 1, 1]);
  }
  eq("tag.lanes.empty", tagLanes([]).lanes, 1);
  {
    // input order must not change the packing
    const lanes = tagLanes([{ ...tag(3, 6, "run") }, { ...tag(1, 4, "walk") }]);
    eq("tag.lanes.order-independent", [lanes.laneOf.get("walk"), lanes.laneOf.get("run")], [0, 1]);
  }

  // ---------------- Session API ----------------
  stubEnv();
  const s = new Session();
  for (let i = 0; i < 4; i++) s.frameAdd();          // 5 frames
  s.history.clear();
  s.setFrame(2);
  s.setFrameSelMode(true);
  s.toggleFrameSel(3);
  s.toggleFrameSel(4);                                // picks frames 3 and 4

  const made = s.tagAdd();
  ok("session.tag.add", !!made);
  eq("session.tag.range-from-pick", [made?.from, made?.to], [3, 4]);
  eq("session.tag.default-name", made?.name !== "", true);
  eq("session.tag.color-set", !!made?.color, true);
  eq("session.tag.list", s.doc.tags.length, 1);
  ok("session.tag.recorded", s.history.canUndo());
  s.undo();
  eq("session.tag.undo", s.doc.tags.length, 0);
  s.redo();
  eq("session.tag.redo", s.doc.tags.length, 1);

  const id = s.doc.tags[0].id;
  eq("session.tag.at", s.tagAt(4)?.id, id);
  eq("session.tag.at-outside", s.tagAt(0), null);
  s.setFrame(4);
  eq("session.tag.active", s.activeTag()?.id, id);
  s.setFrame(1);
  eq("session.tag.active-none", s.activeTag(), null);

  s.tagRename(id, "  walk  ");
  eq("session.tag.rename", s.doc.tags[0].name, "walk");
  s.tagSetRange(id, 4, 1);                            // swapped on purpose
  eq("session.tag.range-normalised", [s.doc.tags[0].from, s.doc.tags[0].to], [1, 4]);
  s.tagSetColor(id, "#123456");
  eq("session.tag.color", s.doc.tags[0].color, "#123456");
  const stepsBefore = s.history.list().labels.length;
  s.tagRename(id, "walk");                            // no-op: must not record
  eq("session.tag.no-op", s.history.list().labels.length, stepsBefore);

  // second tag gets its own name and colour
  const second = s.tagAdd();
  eq("session.tag.second-name", s.doc.tags.map((x) => x.name).filter((n) => n === second?.name).length, 1);
  eq("session.tag.second-color", second?.color === s.doc.tags[0].color, false);
  eq("session.tag.explicit-name", s.tagAdd("run", 0, 0)?.name, "run");

  // picking a tag's frames turns on pick mode with exactly that range
  s.setFrameSelMode(false);
  s.tagSelectFrames(id);
  eq("session.tag.pick-frames", [s.frameSelList(), s.frameSelOn], [[1, 2, 3, 4], true]);

  // playback started inside a tag is scoped to it…
  s.setFrameSelMode(false);
  s.loopMode = "loop";
  s.setFrame(2);
  s.startPlayback();
  eq("session.play.tag", s.playingTag()?.id, id);
  eq("session.play.window", windowOf(s.playingTag(), s.doc.frames.length), { from: 1, to: 4 });
  s.stopPlayback();
  eq("session.play.stopped", s.playingTag(), null);

  // …and started outside every tag it plays the whole timeline
  const loose = new Session();
  for (let i = 0; i < 4; i++) loose.frameAdd();
  loose.setFrame(3);
  const far = loose.tagAdd(undefined, 0, 1);
  eq("session.play.outside.prep", [far?.from, far?.to], [0, 1]);
  loose.setFrame(3);
  loose.startPlayback();
  eq("session.play.outside.tag", loose.playingTag(), null);
  eq("session.play.outside.window", windowOf(loose.playingTag(), loose.doc.frames.length), { from: 0, to: 4 });

  // clicking another tag's frame while playing switches the running loop to it
  {
    const d = new Session();
    for (let i = 0; i < 6; i++) d.frameAdd();        // 7 frames
    const a = d.tagAdd("walk", 1, 2)!;
    const b = d.tagAdd("run", 4, 6)!;
    d.setFrame(1);
    d.startPlayback();
    eq("session.switch.play-a", d.playingTag()?.id, a.id);
    d.setFrame(5);                                   // click a frame of "run"
    eq("session.switch.state", [d.playing, d.playingTag()?.id], [true, b.id]);
    eq("session.switch.window", windowOf(d.playingTag(), d.doc.frames.length), { from: 4, to: 6 });
    d.setFrame(3);                                   // untagged frame: whole timeline
    eq("session.switch.untagged", [d.playing, d.playingTag()], [true, null]);
    eq("session.switch.untagged-window", windowOf(d.playingTag(), d.doc.frames.length), { from: 0, to: 6 });
    d.setFrame(1);                                   // back into "walk"
    eq("session.switch.back", d.playingTag()?.id, a.id);
    ok("session.switch.recorded", d.history.canUndo());   // a user click is undoable
    d.stopPlayback();
    d.setFrame(5);                                   // stopped: clicking only moves the playhead
    eq("session.switch.stopped", d.playingTag(), null);

    // tapping a tag bar plays exactly that animation from its first frame
    d.stopPlayback();
    d.tagPlay(b.id);
    eq("session.tagplay.jump", d.curFrame(), 4);
    eq("session.tagplay.scope", [d.playing, d.playingTag()?.id], [true, b.id]);
    d.tagPlay(a.id);                                  // …and switches straight to another one
    eq("session.tagplay.other", [d.curFrame(), d.playingTag()?.id], [1, a.id]);
    d.stopPlayback();
  }

  // overlapping tags: the CLICKED tag plays, never "the first tag holding that frame"
  {
    const d = new Session();
    for (let i = 0; i < 6; i++) d.frameAdd();        // 7 frames
    const outer = d.tagAdd("walk", 0, 5)!;
    const inner = d.tagAdd("run", 2, 4)!;            // nested inside "walk"
    d.tagPlay(inner.id);
    eq("session.overlap.inner-wins", d.playingTag()?.id, inner.id);
    eq("session.overlap.inner-window", windowOf(d.playingTag(), d.doc.frames.length), { from: 2, to: 4 });
    eq("session.overlap.jump", d.curFrame(), 2);
    eq("session.overlap.active-tag", d.activeTag()?.id, inner.id);   // chip follows what plays
    d.tagPlay(outer.id);
    eq("session.overlap.outer-wins", [d.playingTag()?.id, d.curFrame()], [outer.id, 0]);
    // clicking a frame that both tags cover keeps the animation being played
    d.setFrame(3);
    eq("session.overlap.stays", d.playingTag()?.id, outer.id);
    d.setFrame(6);                                    // …but a frame outside switches to none
    eq("session.overlap.outside", [d.playing, d.playingTag()], [true, null]);
    d.setFrame(1);
    eq("session.overlap.back-inside", d.playingTag()?.id, outer.id);
    d.stopPlayback();

    // the play button still derives the range from the playhead (first match)
    d.setFrame(3);
    d.startPlayback();
    eq("session.overlap.play-button", d.playingTag()?.id, outer.id);
    d.stopPlayback();
  }
  // "once" inside a tag rewinds to the tag's FIRST frame, not frame 1
  loose.stopPlayback();
  loose.tagSetRange(far!.id, 2, 3);
  loose.setFrame(3);
  loose.loopMode = "once";
  loose.startPlayback();
  eq("session.play.once-rewinds-to-tag", loose.curFrame(), 2);
  loose.stopPlayback();

  // deleting tagged frames keeps the tag (and the doc) valid
  {
    const d = new Session();
    for (let i = 0; i < 4; i++) d.frameAdd();
    const t2 = d.tagAdd("run", 1, 3)!;
    d.history.clear();
    d.setFrameSelMode(true);
    d.toggleFrameSel(2);
    d.framesDeleteSelected();
    eq("session.tag.after-delete", d.doc.tags.map((x) => [x.name, x.from, x.to]), [["run", 1, 2]]);
    ok("session.tag.after-delete.valid", d.doc.tags.every((x) => x.to < d.doc.frames.length && x.from <= x.to));
    // undo restores both the frames and the tag range
    d.undo();
    eq("session.tag.after-delete.undo", d.doc.tags.map((x) => [x.from, x.to]), [[t2.from, t2.to]]);
  }

  // tags survive a project save/load round trip (.pxc)
  {
    const d = new Session();
    for (let i = 0; i < 2; i++) d.frameAdd();
    d.tagAdd("idle", 0, 0);
    d.tagAdd("run", 1, 2);
    SPACE = d;
  }
}

/** set by testTags so the async half can reuse the session's document */
let SPACE: Session | null = null;

/** .pxc / .aseprite round trips for tags (both formats must keep the ranges) */
export async function testTagsIo(): Promise<void> {
  stubEnv();
  const s = SPACE;
  if (!s) { ok("tags.io.session", false); return; }

  const text = await project.serializeSpace([{ doc: s.doc, x: 0, y: 0, li: 0, fi: 0 }], 0, null, "rle");
  const back = await project.parseSpace(text);
  ok("tags.pxc.parsed", !!back);
  eq("tags.pxc.round-trip", back?.entries[0].doc.tags.map((t) => [t.name, t.from, t.to]),
    s.doc.tags.map((t) => [t.name, t.from, t.to]));

  // .aseprite: written as a real tag chunk, read back with the same ranges
  const bytes = await writeAse(s.doc);
  const file = parseAse(bytes);
  ok("tags.ase.parsed", !!file);
  eq("tags.ase.chunk", file?.tags.map((t) => [t.name, t.from, t.to]),
    s.doc.tags.map((t) => [t.name, t.from, t.to]));
  const doc2 = aseToDoc(file!);
  eq("tags.ase.doc", doc2?.tags.map((t) => [t.name, t.from, t.to]),
    s.doc.tags.map((t) => [t.name, t.from, t.to]));
  // and the colour survives through the deprecated tag colour bytes
  eq("tags.ase.colour", doc2?.tags[0].color, s.doc.tags[0].color?.toLowerCase());

  // Aseprite's loop metadata is kept for a lossless round trip
  const withMeta = new Doc(2, 2, "m");
  for (let i = 0; i < 3; i++) ops.addFrame(withMeta, withMeta.frames.length);
  withMeta.tags = [{ id: "x", name: "loop", from: 1, to: 2, dir: 2, repeat: 3, color: "#3ad6e8" }];
  const meta = aseToDoc(parseAse(await writeAse(withMeta))!);
  eq("tags.ase.meta", meta?.tags.map((t) => [t.dir, t.repeat]), [[2, 3]]);
  eq("tags.ase.play-range", windowOf(meta?.tags[0], 4), { from: 1, to: 2 });
}

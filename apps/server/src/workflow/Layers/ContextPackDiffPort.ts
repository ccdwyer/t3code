import type { TicketId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ServerConfig } from "../../config.ts";
import { GitVcsDriver } from "../../vcs/GitVcsDriver.ts";
import {
  ContextPackDiffPort,
  type ContextPackDiffPortShape,
} from "../Services/ContextPackDiffPort.ts";
import { type ContextPackDiffFile, parseNumstatZ } from "../contextPack.ts";
import { ticketBaseRef } from "../ticketRefs.ts";
import { ticketScratchDir } from "../instructionTemplate.ts";

/** Byte cap on each git call's stdout — a pack line is ~60 bytes, so this is generous. */
const STAT_MAX_OUTPUT_BYTES = 64_000;
/** Row cap on rendered files. */
const STAT_MAX_FILES = 200;
/**
 * Cap on untracked files stat'ed individually. Each costs one `git diff
 * --no-index` process, so this bounds process count, not just output.
 */
const STAT_MAX_UNTRACKED = 50;

const make = Effect.gen(function* () {
  const git = yield* GitVcsDriver;
  const config = yield* ServerConfig;

  const statTicketDiff: ContextPackDiffPortShape["statTicketDiff"] = (ticketId: TicketId) =>
    Effect.gen(function* () {
      const refName = `workflow/${ticketId as string}`;
      const refs = yield* git
        .listRefs({ cwd: config.cwd, query: refName, limit: 100 })
        // A repo that cannot list refs simply has no stat to show; the section
        // is optional enrichment and must never fail routing.
        .pipe(Effect.orElseSucceed(() => ({ refs: [] as ReadonlyArray<never> })));
      const ref = refs.refs.find(
        (candidate) =>
          candidate.name === refName &&
          candidate.isRemote !== true &&
          candidate.worktreePath !== null,
      );
      const cwd = ref?.worktreePath;
      if (cwd === undefined || cwd === null || cwd === "") {
        // No worktree: omit the section rather than reporting an empty diff.
        return null;
      }

      // Tracked: `diff <base>` already spans staged AND unstaged, so one call
      // covers both. `-z` because a filename may contain anything but NUL.
      const tracked = yield* git
        .execute({
          operation: "ContextPack.diffStat.tracked",
          cwd,
          args: ["diff", "--numstat", "-z", `${ticketBaseRef(ticketId)}^{commit}`, "--"],
          maxOutputBytes: STAT_MAX_OUTPUT_BYTES,
        })
        .pipe(Effect.orElseSucceed(() => ({ stdout: "", stdoutTruncated: false })));

      const untrackedList = yield* git
        .execute({
          operation: "ContextPack.diffStat.untracked.list",
          cwd,
          args: ["ls-files", "--others", "--exclude-standard", "-z"],
          maxOutputBytes: STAT_MAX_OUTPUT_BYTES,
        })
        .pipe(Effect.orElseSucceed(() => ({ stdout: "", stdoutTruncated: false })));

      // The ticket's own scratch tree holds description spill and handoff files.
      // A repo that does not gitignore `.t3` would otherwise leak them into the
      // pack as "changes the previous lane made".
      // ticketScratchDir throws on a path-unsafe id; an unusable prefix must not
      // take down the section, so fall back to one that matches nothing.
      let scratchPrefix: string;
      try {
        scratchPrefix = `${ticketScratchDir(ticketId as string)}/`;
      } catch {
        scratchPrefix = "\u0000never-matches";
      }
      const allUntracked = untrackedList.stdout
        .split("\u0000")
        .filter((path) => path.length > 0 && !path.startsWith(scratchPrefix));
      const untrackedPaths = allUntracked.slice(0, STAT_MAX_UNTRACKED);

      const untrackedStats = yield* Effect.forEach(
        untrackedPaths,
        (path) =>
          git
            .execute({
              operation: "ContextPack.diffStat.untracked.stat",
              cwd,
              args: ["diff", "--no-index", "--numstat", "-z", "--", "/dev/null", path],
              // `--no-index` exits 1 whenever the files differ, which is always.
              allowNonZeroExit: true,
              maxOutputBytes: STAT_MAX_OUTPUT_BYTES,
            })
            .pipe(
              Effect.orElseSucceed(() => ({
                stdout: "",
                stdoutTruncated: false,
              })),
            ),
        { concurrency: 4 },
      );

      const trackedParsed = parseNumstatZ(tracked.stdout, tracked.stdoutTruncated);
      const untrackedFiles: Array<ContextPackDiffFile> = [];
      let untrackedPartial = untrackedList.stdoutTruncated;
      for (const stat of untrackedStats) {
        const parsed = parseNumstatZ(stat.stdout, stat.stdoutTruncated);
        untrackedFiles.push(...parsed.files);
        if (parsed.partial) {
          untrackedPartial = true;
        }
      }

      const files = [...trackedParsed.files, ...untrackedFiles].filter(
        (file) => !file.path.startsWith(scratchPrefix),
      );
      const capped = files.slice(0, STAT_MAX_FILES);
      return {
        files: capped,
        partial:
          trackedParsed.partial ||
          untrackedPartial ||
          allUntracked.length > untrackedPaths.length ||
          files.length > capped.length,
      };
    });

  return { statTicketDiff } satisfies ContextPackDiffPortShape;
});

export const ContextPackDiffPortLive = Layer.effect(ContextPackDiffPort, make);

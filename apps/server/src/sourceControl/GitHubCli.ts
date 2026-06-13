import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";

import {
  TrimmedNonEmptyString,
  type SourceControlRepositoryVisibility,
  type VcsError,
} from "@t3tools/contracts";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GitHubPullRequests from "./gitHubPullRequests.ts";

const DEFAULT_TIMEOUT_MS = 30_000;

export class GitHubCliError extends Schema.TaggedErrorClass<GitHubCliError>()("GitHubCliError", {
  operation: Schema.String,
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `GitHub CLI failed in ${this.operation}: ${this.detail}`;
  }
}

export interface GitHubPullRequestSummary {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly baseRefName: string;
  readonly headRefName: string;
  readonly state?: "open" | "closed" | "merged";
  readonly isCrossRepository?: boolean;
  readonly headRepositoryNameWithOwner?: string | null;
  readonly headRepositoryOwnerLogin?: string | null;
}

export interface GitHubRepositoryCloneUrls {
  readonly nameWithOwner: string;
  readonly url: string;
  readonly sshUrl: string;
}

export type GitHubMergeStrategy = "squash" | "merge" | "rebase";

export interface GitHubPullRequestDetail {
  readonly state: string;
  readonly mergedAt: string | null;
  readonly reviewDecision: string | null;
  readonly headRefOid: string;
  readonly url: string;
}

export interface GitHubPullRequestCheck {
  readonly name: string;
  readonly state: string;
  readonly bucket: string;
  readonly link: string;
}

export interface GitHubPullRequestReview {
  readonly id: string;
  readonly author: string;
  readonly state: string;
  readonly body: string;
  readonly submittedAt: string;
}

export interface GitHubPullRequestReviewComment {
  readonly id: number;
  readonly user: string;
  readonly body: string;
  readonly path: string | null;
  readonly createdAt: string;
}

export interface GitHubCliShape {
  readonly execute: (input: {
    readonly cwd: string;
    readonly args: ReadonlyArray<string>;
    readonly timeoutMs?: number;
  }) => Effect.Effect<VcsProcess.VcsProcessOutput, GitHubCliError>;

  readonly listOpenPullRequests: (input: {
    readonly cwd: string;
    readonly headSelector: string;
    readonly limit?: number;
  }) => Effect.Effect<ReadonlyArray<GitHubPullRequestSummary>, GitHubCliError>;

  readonly getPullRequest: (input: {
    readonly cwd: string;
    readonly reference: string;
  }) => Effect.Effect<GitHubPullRequestSummary, GitHubCliError>;

  readonly getRepositoryCloneUrls: (input: {
    readonly cwd: string;
    readonly repository: string;
  }) => Effect.Effect<GitHubRepositoryCloneUrls, GitHubCliError>;

  readonly createRepository: (input: {
    readonly cwd: string;
    readonly repository: string;
    readonly visibility: SourceControlRepositoryVisibility;
  }) => Effect.Effect<GitHubRepositoryCloneUrls, GitHubCliError>;

  readonly createPullRequest: (input: {
    readonly cwd: string;
    readonly baseBranch: string;
    readonly headSelector: string;
    readonly title: string;
    readonly bodyFile: string;
    readonly draft?: boolean;
  }) => Effect.Effect<void, GitHubCliError>;

  readonly mergePullRequest: (input: {
    readonly cwd: string;
    readonly number: number;
    readonly strategy: GitHubMergeStrategy;
  }) => Effect.Effect<void, GitHubCliError>;

  readonly getPullRequestDetail: (input: {
    readonly cwd: string;
    readonly number: number;
  }) => Effect.Effect<GitHubPullRequestDetail, GitHubCliError>;

  readonly listPullRequestChecks: (input: {
    readonly cwd: string;
    readonly number: number;
  }) => Effect.Effect<ReadonlyArray<GitHubPullRequestCheck>, GitHubCliError>;

  readonly listPullRequestReviews: (input: {
    readonly cwd: string;
    readonly number: number;
  }) => Effect.Effect<ReadonlyArray<GitHubPullRequestReview>, GitHubCliError>;

  readonly listPullRequestReviewComments: (input: {
    readonly cwd: string;
    readonly repo: string;
    readonly number: number;
  }) => Effect.Effect<ReadonlyArray<GitHubPullRequestReviewComment>, GitHubCliError>;

  readonly getDefaultBranch: (input: {
    readonly cwd: string;
  }) => Effect.Effect<string | null, GitHubCliError>;

  readonly checkoutPullRequest: (input: {
    readonly cwd: string;
    readonly reference: string;
    readonly force?: boolean;
  }) => Effect.Effect<void, GitHubCliError>;
}

export class GitHubCli extends Context.Service<GitHubCli, GitHubCliShape>()(
  "t3/sourceControl/GitHubCli",
) {}

function errorText(error: VcsError | unknown): string {
  if (typeof error === "object" && error !== null) {
    const tag = "_tag" in error && typeof error._tag === "string" ? error._tag : "";
    const detail = "detail" in error && typeof error.detail === "string" ? error.detail : "";
    const message = "message" in error && typeof error.message === "string" ? error.message : "";
    return [tag, detail, message].filter(Boolean).join("\n");
  }

  return String(error);
}

function normalizeGitHubCliError(
  operation: "execute" | "stdout",
  error: VcsError | unknown,
): GitHubCliError {
  const text = errorText(error);
  const lower = text.toLowerCase();

  if (lower.includes("command not found: gh") || lower.includes("enoent")) {
    return new GitHubCliError({
      operation,
      detail: "GitHub CLI (`gh`) is required but not available on PATH.",
      cause: error,
    });
  }

  if (
    lower.includes("authentication failed") ||
    lower.includes("not logged in") ||
    lower.includes("gh auth login") ||
    lower.includes("no oauth token")
  ) {
    return new GitHubCliError({
      operation,
      detail: "GitHub CLI is not authenticated. Run `gh auth login` and retry.",
      cause: error,
    });
  }

  if (
    lower.includes("could not resolve to a pullrequest") ||
    lower.includes("repository.pullrequest") ||
    lower.includes("no pull requests found for branch") ||
    lower.includes("pull request not found")
  ) {
    return new GitHubCliError({
      operation,
      detail: "Pull request not found. Check the PR number or URL and try again.",
      cause: error,
    });
  }

  return new GitHubCliError({
    operation,
    detail: text,
    cause: error,
  });
}

const RawGitHubRepositoryCloneUrlsSchema = Schema.Struct({
  nameWithOwner: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  sshUrl: TrimmedNonEmptyString,
});

const RawGitHubPullRequestDetailSchema = Schema.Struct({
  state: Schema.String,
  mergedAt: Schema.NullOr(Schema.String),
  reviewDecision: Schema.NullOr(Schema.String),
  headRefOid: Schema.String,
  url: Schema.String,
});

const RawGitHubPullRequestCheckSchema = Schema.Struct({
  name: Schema.optional(Schema.NullOr(Schema.String)),
  state: Schema.optional(Schema.NullOr(Schema.String)),
  bucket: Schema.optional(Schema.NullOr(Schema.String)),
  link: Schema.optional(Schema.NullOr(Schema.String)),
});

const RawGitHubPullRequestChecksSchema = Schema.Array(RawGitHubPullRequestCheckSchema);

const RawGitHubPullRequestReviewsSchema = Schema.Struct({
  reviews: Schema.Array(
    Schema.Struct({
      id: Schema.optional(Schema.NullOr(Schema.String)),
      author: Schema.optional(Schema.NullOr(Schema.Struct({ login: Schema.optional(Schema.String) }))),
      state: Schema.optional(Schema.NullOr(Schema.String)),
      body: Schema.optional(Schema.NullOr(Schema.String)),
      submittedAt: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ),
});

const RawGitHubPullRequestReviewCommentsSchema = Schema.Array(
  Schema.Struct({
    id: Schema.Number,
    user: Schema.optional(Schema.NullOr(Schema.Struct({ login: Schema.optional(Schema.String) }))),
    body: Schema.optional(Schema.NullOr(Schema.String)),
    path: Schema.optional(Schema.NullOr(Schema.String)),
    created_at: Schema.optional(Schema.NullOr(Schema.String)),
  }),
);

function normalizeRepositoryCloneUrls(
  raw: Schema.Schema.Type<typeof RawGitHubRepositoryCloneUrlsSchema>,
): GitHubRepositoryCloneUrls {
  return {
    nameWithOwner: raw.nameWithOwner,
    url: raw.url,
    sshUrl: raw.sshUrl,
  };
}

/**
 * `gh repo create` prints the canonical URL of the new repository on stdout
 * (e.g. `https://github.com/owner/repo`). Reading it back here avoids a
 * follow-up `gh repo view`, which can race GitHub's GraphQL eventual
 * consistency window and falsely report the just-created repo as missing.
 */
function deriveRepositoryCloneUrlsFromCreateOutput(
  stdout: string,
  repository: string,
): GitHubRepositoryCloneUrls {
  const fallbackHost = "github.com";
  const match = stdout.match(/https?:\/\/[^\s]+/);
  if (match) {
    const cleaned = match[0].replace(/\.git$/, "");
    try {
      const parsed = new URL(cleaned);
      const pathname = parsed.pathname.replace(/^\/+|\/+$/g, "");
      const segments = pathname.split("/").filter(Boolean);
      if (segments.length === 2) {
        const nameWithOwner = `${segments[0]}/${segments[1]}`;
        return {
          nameWithOwner,
          url: `${parsed.origin}/${nameWithOwner}`,
          sshUrl: `git@${parsed.host}:${nameWithOwner}.git`,
        };
      }
    } catch {
      // Fall through to the input-derived defaults below.
    }
  }
  return {
    nameWithOwner: repository,
    url: `https://${fallbackHost}/${repository}`,
    sshUrl: `git@${fallbackHost}:${repository}.git`,
  };
}

function decodeGitHubJson<S extends Schema.Top>(
  raw: string,
  schema: S,
  operation:
    | "listOpenPullRequests"
    | "getPullRequest"
    | "getRepositoryCloneUrls"
    | "getPullRequestDetail"
    | "listPullRequestChecks"
    | "listPullRequestReviews"
    | "listPullRequestReviewComments",
  invalidDetail: string,
): Effect.Effect<S["Type"], GitHubCliError, S["DecodingServices"]> {
  return Schema.decodeEffect(Schema.fromJsonString(schema))(raw).pipe(
    Effect.mapError(
      (error) =>
        new GitHubCliError({
          operation,
          detail: `${invalidDetail}: ${SchemaIssue.makeFormatterDefault()(error.issue)}`,
          cause: error,
        }),
    ),
  );
}

export const make = Effect.fn("makeGitHubCli")(function* () {
  const process = yield* VcsProcess.VcsProcess;

  const execute: GitHubCliShape["execute"] = (input) =>
    process
      .run({
        operation: "GitHubCli.execute",
        command: "gh",
        args: input.args,
        cwd: input.cwd,
        timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      })
      .pipe(Effect.mapError((error) => normalizeGitHubCliError("execute", error)));

  return GitHubCli.of({
    execute,
    listOpenPullRequests: (input) =>
      execute({
        cwd: input.cwd,
        args: [
          "pr",
          "list",
          "--head",
          input.headSelector,
          "--state",
          "open",
          "--limit",
          String(input.limit ?? 1),
          "--json",
          "number,title,url,baseRefName,headRefName,state,mergedAt,isCrossRepository,headRepository,headRepositoryOwner",
        ],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          raw.length === 0
            ? Effect.succeed([])
            : Effect.sync(() => GitHubPullRequests.decodeGitHubPullRequestListJson(raw)).pipe(
                Effect.flatMap((decoded) => {
                  if (!Result.isSuccess(decoded)) {
                    return Effect.fail(
                      new GitHubCliError({
                        operation: "listOpenPullRequests",
                        detail: `GitHub CLI returned invalid PR list JSON: ${GitHubPullRequests.formatGitHubJsonDecodeError(decoded.failure)}`,
                        cause: decoded.failure,
                      }),
                    );
                  }

                  return Effect.succeed(
                    decoded.success.map(({ updatedAt: _updatedAt, ...summary }) => summary),
                  );
                }),
              ),
        ),
      ),
    getPullRequest: (input) =>
      execute({
        cwd: input.cwd,
        args: [
          "pr",
          "view",
          input.reference,
          "--json",
          "number,title,url,baseRefName,headRefName,state,mergedAt,isCrossRepository,headRepository,headRepositoryOwner",
        ],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          Effect.sync(() => GitHubPullRequests.decodeGitHubPullRequestJson(raw)).pipe(
            Effect.flatMap((decoded) => {
              if (!Result.isSuccess(decoded)) {
                return Effect.fail(
                  new GitHubCliError({
                    operation: "getPullRequest",
                    detail: `GitHub CLI returned invalid pull request JSON: ${GitHubPullRequests.formatGitHubJsonDecodeError(decoded.failure)}`,
                    cause: decoded.failure,
                  }),
                );
              }

              return Effect.succeed(
                (({ updatedAt: _updatedAt, ...summary }) => summary)(decoded.success),
              );
            }),
          ),
        ),
      ),
    getRepositoryCloneUrls: (input) =>
      execute({
        cwd: input.cwd,
        args: ["repo", "view", input.repository, "--json", "nameWithOwner,url,sshUrl"],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          decodeGitHubJson(
            raw,
            RawGitHubRepositoryCloneUrlsSchema,
            "getRepositoryCloneUrls",
            "GitHub CLI returned invalid repository JSON.",
          ),
        ),
        Effect.map(normalizeRepositoryCloneUrls),
      ),
    createRepository: (input) =>
      execute({
        cwd: input.cwd,
        args: ["repo", "create", input.repository, `--${input.visibility}`],
      }).pipe(
        Effect.map((result) =>
          deriveRepositoryCloneUrlsFromCreateOutput(result.stdout, input.repository),
        ),
      ),
    createPullRequest: (input) =>
      execute({
        cwd: input.cwd,
        args: [
          "pr",
          "create",
          "--base",
          input.baseBranch,
          "--head",
          input.headSelector,
          "--title",
          input.title,
          "--body-file",
          input.bodyFile,
          ...(input.draft ? ["--draft"] : []),
        ],
      }).pipe(Effect.asVoid),
    mergePullRequest: (input) =>
      execute({
        cwd: input.cwd,
        args: [
          "pr",
          "merge",
          String(input.number),
          input.strategy === "merge"
            ? "--merge"
            : input.strategy === "rebase"
              ? "--rebase"
              : "--squash",
        ],
      }).pipe(Effect.asVoid),
    getPullRequestDetail: (input) =>
      execute({
        cwd: input.cwd,
        args: [
          "pr",
          "view",
          String(input.number),
          "--json",
          "state,mergedAt,reviewDecision,headRefOid,url",
        ],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          decodeGitHubJson(
            raw,
            RawGitHubPullRequestDetailSchema,
            "getPullRequestDetail",
            "GitHub CLI returned invalid pull request detail JSON.",
          ),
        ),
        Effect.map((raw) => ({
          state: raw.state,
          mergedAt: raw.mergedAt,
          reviewDecision: raw.reviewDecision,
          headRefOid: raw.headRefOid,
          url: raw.url,
        })),
      ),
    listPullRequestChecks: (input) =>
      // `gh pr checks` exits 8 while checks are pending and 1 when some fail,
      // yet still prints valid JSON. Tolerate those exit codes (and 0) as long
      // as stdout parses; any other exit code is a real failure.
      process
        .run({
          operation: "GitHubCli.execute",
          command: "gh",
          args: ["pr", "checks", String(input.number), "--json", "name,state,bucket,link"],
          cwd: input.cwd,
          timeoutMs: DEFAULT_TIMEOUT_MS,
          allowNonZeroExit: true,
        })
        .pipe(
          Effect.mapError((error) => normalizeGitHubCliError("execute", error)),
          Effect.flatMap((result) => {
            const exitCode = result.exitCode as number;
            if (exitCode !== 0 && exitCode !== 1 && exitCode !== 8) {
              return Effect.fail(
                new GitHubCliError({
                  operation: "listPullRequestChecks",
                  detail:
                    result.stderr.trim() ||
                    `gh pr checks exited with code ${exitCode}.`,
                }),
              );
            }
            const raw = result.stdout.trim();
            if (raw.length === 0) {
              return Effect.succeed([] as ReadonlyArray<GitHubPullRequestCheck>);
            }
            return decodeGitHubJson(
              raw,
              RawGitHubPullRequestChecksSchema,
              "listPullRequestChecks",
              "GitHub CLI returned invalid pull request checks JSON.",
            ).pipe(
              Effect.map((checks) =>
                checks.map((check) => ({
                  name: check.name ?? "",
                  state: check.state ?? "",
                  bucket: check.bucket ?? "",
                  link: check.link ?? "",
                })),
              ),
            );
          }),
        ),
    listPullRequestReviews: (input) =>
      execute({
        cwd: input.cwd,
        args: ["pr", "view", String(input.number), "--json", "reviews"],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          decodeGitHubJson(
            raw,
            RawGitHubPullRequestReviewsSchema,
            "listPullRequestReviews",
            "GitHub CLI returned invalid pull request reviews JSON.",
          ),
        ),
        Effect.map((decoded) =>
          decoded.reviews.map((review) => ({
            id: review.id ?? "",
            author: review.author?.login ?? "",
            state: review.state ?? "",
            body: review.body ?? "",
            submittedAt: review.submittedAt ?? "",
          })),
        ),
      ),
    listPullRequestReviewComments: (input) =>
      execute({
        cwd: input.cwd,
        args: ["api", `repos/${input.repo}/pulls/${input.number}/comments`],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          decodeGitHubJson(
            raw,
            RawGitHubPullRequestReviewCommentsSchema,
            "listPullRequestReviewComments",
            "GitHub CLI returned invalid pull request review comments JSON.",
          ),
        ),
        Effect.map((decoded) =>
          decoded.map((comment) => ({
            id: comment.id,
            user: comment.user?.login ?? "",
            body: comment.body ?? "",
            path: comment.path ?? null,
            createdAt: comment.created_at ?? "",
          })),
        ),
      ),
    getDefaultBranch: (input) =>
      execute({
        cwd: input.cwd,
        args: ["repo", "view", "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"],
      }).pipe(
        Effect.map((value) => {
          const trimmed = value.stdout.trim();
          return trimmed.length > 0 ? trimmed : null;
        }),
      ),
    checkoutPullRequest: (input) =>
      execute({
        cwd: input.cwd,
        args: ["pr", "checkout", input.reference, ...(input.force ? ["--force"] : [])],
      }).pipe(Effect.asVoid),
  });
});

export const layer = Layer.effect(GitHubCli, make());

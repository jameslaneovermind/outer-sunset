import {
  RESOURCE_MIME_TYPE,
  registerAppResource,
  registerAppTool,
} from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  CallToolResult,
  ReadResourceResult,
} from "@modelcontextprotocol/sdk/types.js";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  type BoardData,
  type FileConflict,
  computeLifecycleEvents,
  computeNeedsAttention,
  computeStats,
  formatBoardDigest,
} from "./data/board.js";
import { getCached, getStale, invalidateCache, setCache } from "./data/cache.js";
import {
  type GitHubPR,
  fetchGitHubPRs,
  fetchPRDetail,
  getGitHubUsername,
  requestReview,
} from "./data/github.js";
import {
  type LinearIssue,
  fetchLinearIssues,
  fetchIssueDetail,
  startLinearIssue,
} from "./data/linear.js";
import { type LinkedItem, linkIssuesToPRs } from "./data/linker.js";
import {
  loadSession,
  recordBoardView,
  setActiveTask,
} from "./data/session.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DIST_DIR = __filename.endsWith(".ts")
  ? path.join(__dirname, "..", "dist", "ui")
  : path.join(__dirname, "..", "ui");

const CACHE_KEY_LINEAR = "linear:issues";
const CACHE_KEY_GITHUB = "github:prs";
const CACHE_KEY_GH_USER = "github:user";

const CACHE_KEY_PR_FILES = "github:pr-files";

async function detectConflicts(
  prs: GitHubPR[],
  token: string,
): Promise<FileConflict[]> {
  const openPRs = prs.filter((p) => p.state === "open");
  if (openPRs.length < 2) return [];

  let prFiles = getCached<Map<number, string[]>>(CACHE_KEY_PR_FILES);
  if (!prFiles) {
    prFiles = new Map();
    const results = await Promise.allSettled(
      openPRs.map(async (pr) => {
        try {
          const files = await githubFetchFiles(token, pr.repoFullName, pr.number);
          return { number: pr.number, files };
        } catch {
          return { number: pr.number, files: [] as string[] };
        }
      }),
    );
    for (const r of results) {
      if (r.status === "fulfilled") {
        prFiles.set(r.value.number, r.value.files);
      }
    }
    setCache(CACHE_KEY_PR_FILES, prFiles);
  }

  const fileMap = new Map<string, { number: number; title: string }[]>();
  for (const pr of openPRs) {
    const files = prFiles.get(pr.number) ?? [];
    for (const f of files) {
      if (!fileMap.has(f)) fileMap.set(f, []);
      fileMap.get(f)!.push({ number: pr.number, title: pr.title });
    }
  }

  return [...fileMap.entries()]
    .filter(([, prs]) => prs.length > 1)
    .map(([file, prs]) => ({ file, prs }))
    .sort((a, b) => b.prs.length - a.prs.length)
    .slice(0, 10);
}

async function githubFetchFiles(
  token: string,
  repoFullName: string,
  prNumber: number,
): Promise<string[]> {
  const res = await fetch(
    `https://api.github.com/repos/${repoFullName}/pulls/${prNumber}/files?per_page=100`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );
  if (!res.ok) return [];
  const files = (await res.json()) as Array<{ filename: string }>;
  return files.map((f) => f.filename);
}

async function fetchFullBoardData(forceRefresh = false): Promise<BoardData> {
  const linearToken = process.env.LINEAR_API_TOKEN;
  const githubToken = process.env.GITHUB_TOKEN;
  const errors: string[] = [];

  let issues: LinearIssue[] = [];
  if (linearToken) {
    if (!forceRefresh) {
      const cached = getCached<LinearIssue[]>(CACHE_KEY_LINEAR);
      if (cached) {
        issues = cached;
      }
    } else {
      invalidateCache(CACHE_KEY_LINEAR);
    }
    if (issues.length === 0) {
      try {
        const teamKey = process.env.LINEAR_TEAM_KEY || undefined;
        issues = await fetchLinearIssues(linearToken, teamKey);
        setCache(CACHE_KEY_LINEAR, issues);
      } catch (err) {
        const stale = getStale<LinearIssue[]>(CACHE_KEY_LINEAR);
        if (stale) {
          issues = stale;
          errors.push("Linear: using cached data (fetch failed)");
        } else {
          errors.push(
            `Linear: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
  } else {
    errors.push(
      "LINEAR_API_TOKEN not set. Add it to your MCP server config.",
    );
  }

  let prs: GitHubPR[] = [];
  let ghUsername: string | null = null;
  if (githubToken) {
    if (!forceRefresh) {
      const cachedPRs = getCached<GitHubPR[]>(CACHE_KEY_GITHUB);
      const cachedUser = getCached<string>(CACHE_KEY_GH_USER);
      if (cachedPRs) prs = cachedPRs;
      if (cachedUser) ghUsername = cachedUser;
    } else {
      invalidateCache(CACHE_KEY_GITHUB);
      invalidateCache(CACHE_KEY_GH_USER);
    }
    if (prs.length === 0) {
      try {
        ghUsername = await getGitHubUsername(githubToken);
        setCache(CACHE_KEY_GH_USER, ghUsername);
        const owner = process.env.GITHUB_OWNER || undefined;
        prs = await fetchGitHubPRs(githubToken, ghUsername, owner);
        setCache(CACHE_KEY_GITHUB, prs);
      } catch (err) {
        const stalePRs = getStale<GitHubPR[]>(CACHE_KEY_GITHUB);
        const staleUser = getStale<string>(CACHE_KEY_GH_USER);
        if (stalePRs) {
          prs = stalePRs;
          if (staleUser) ghUsername = staleUser;
          errors.push("GitHub: using cached data (fetch failed)");
        } else {
          errors.push(
            `GitHub: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
  }

  const items = linkIssuesToPRs(issues, prs);
  const needsAttention = computeNeedsAttention(items, prs, ghUsername);
  const stats = computeStats(prs);
  stats.inProgressIssues = issues.filter((i) => {
    const s = i.status.toLowerCase();
    return s === "in progress" || s === "started";
  }).length;

  const conflicts = githubToken
    ? await detectConflicts(prs, githubToken).catch(() => [] as FileConflict[])
    : [];

  const lifecycle = computeLifecycleEvents(prs, ghUsername);

  return {
    items,
    issues,
    prs,
    needsAttention,
    stats,
    conflicts,
    lifecycle,
    fetchedAt: new Date().toISOString(),
    errors,
  };
}

export function createServer(): McpServer {
  const server = new McpServer({
    name: "outer-sunset",
    version: "0.1.0",
  });

  const boardResourceUri = "ui://outer-sunset/board.html";

  registerAppTool(
    server,
    "show_board",
    {
      title: "Show Board",
      description:
        "Show your engineering board — a visual dashboard of what you're working on right now. " +
        "Displays your Linear issues and GitHub PRs grouped by status, highlights what needs your attention " +
        "(stale PRs, pending reviews, failing CI), and links issues to PRs automatically. " +
        "Use this when someone asks to see their board, dashboard, what's in flight, what they're working on, " +
        "whether any PRs need review, what's blocking them, or wants a status overview.",
      inputSchema: {
        team: z.string().optional().describe("Linear team key (e.g. 'ENG')"),
      },
      _meta: { ui: { resourceUri: boardResourceUri } },
    },
    async ({ team }): Promise<CallToolResult> => {
      if (team) {
        process.env.LINEAR_TEAM_KEY = team;
      }
      const data = await fetchFullBoardData();
      const summary = formatBoardDigest(data);
      await recordBoardView().catch(() => {});

      return {
        content: [{ type: "text", text: summary }],
        structuredContent: data as unknown as Record<string, unknown>,
      };
    },
  );

  registerAppTool(
    server,
    "fetch_board_data",
    {
      title: "Fetch Board Data",
      description: "Fetches fresh board data for the UI. App-only.",
      inputSchema: {
        force: z
          .boolean()
          .optional()
          .describe("Bypass cache and force refresh"),
      },
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ force }): Promise<CallToolResult> => {
      const data = await fetchFullBoardData(force ?? false);
      return {
        content: [{ type: "text", text: JSON.stringify(data) }],
        structuredContent: data as unknown as Record<string, unknown>,
      };
    },
  );

  // ── Conversational follow-up tools ──────────────────────────────────────

  registerAppTool(
    server,
    "get_pr_details",
    {
      title: "Get PR Details",
      description:
        "Get detailed information about a specific GitHub pull request — description, " +
        "changed files, CI check results, reviewer statuses, and diff size. Use when " +
        "someone asks about a specific PR, wants a summary, or asks what files it touches.",
      inputSchema: {
        owner: z.string().describe("Repository owner (e.g. 'overmindtech')"),
        repo: z.string().describe("Repository name (e.g. 'workspace')"),
        number: z.number().describe("PR number"),
      },
      _meta: { ui: { visibility: ["llm", "app"] } },
    },
    async ({ owner, repo, number: prNumber }): Promise<CallToolResult> => {
      const githubToken = process.env.GITHUB_TOKEN;
      if (!githubToken) {
        return {
          content: [{ type: "text", text: "GITHUB_TOKEN not set." }],
          isError: true,
        };
      }
      try {
        const detail = await fetchPRDetail(githubToken, owner, repo, prNumber);
        return {
          content: [{ type: "text", text: JSON.stringify(detail, null, 2) }],
          structuredContent: detail as unknown as Record<string, unknown>,
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );

  registerAppTool(
    server,
    "get_issue_details",
    {
      title: "Get Issue Details",
      description:
        "Get detailed information about a specific Linear issue — description, labels, " +
        "recent comments, estimate, parent issue, and cycle. Use when someone asks about " +
        "a specific issue, wants context on what it involves, or asks what's blocking it.",
      inputSchema: {
        identifier: z.string().describe("Issue identifier (e.g. 'ENG-3642')"),
      },
      _meta: { ui: { visibility: ["llm", "app"] } },
    },
    async ({ identifier }): Promise<CallToolResult> => {
      const linearToken = process.env.LINEAR_API_TOKEN;
      if (!linearToken) {
        return {
          content: [{ type: "text", text: "LINEAR_API_TOKEN not set." }],
          isError: true,
        };
      }
      try {
        const detail = await fetchIssueDetail(linearToken, identifier);
        return {
          content: [{ type: "text", text: JSON.stringify(detail, null, 2) }],
          structuredContent: detail as unknown as Record<string, unknown>,
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );

  registerAppTool(
    server,
    "get_board_stats",
    {
      title: "Get Board Stats",
      description:
        "Get a text summary of your engineering board — open PR count, in-progress issues, " +
        "average PR age, what needs attention. Use when someone asks for a quick status " +
        "update without needing the full visual board.",
      inputSchema: {},
      _meta: { ui: { visibility: ["llm"] } },
    },
    async (): Promise<CallToolResult> => {
      const data = await fetchFullBoardData();
      return {
        content: [{ type: "text", text: formatBoardDigest(data) }],
      };
    },
  );

  // ── Write actions ─────────────────────────────────────────────────────

  registerAppTool(
    server,
    "start_task",
    {
      title: "Start Task",
      description:
        "Start working on a Linear issue — assigns it to you and moves it to In Progress. " +
        "Returns the issue description so the agent can begin working on it. Use when someone " +
        "says 'start task', 'work on this issue', or 'pick up ENG-XXX'.",
      inputSchema: {
        issue_id: z.string().describe("Linear issue UUID (internal ID)"),
        team_key: z.string().optional().describe("Linear team key (e.g. 'ENG'). Uses LINEAR_TEAM_KEY env if not provided."),
      },
      _meta: { ui: { visibility: ["llm", "app"] } },
    },
    async ({ issue_id, team_key }): Promise<CallToolResult> => {
      const linearToken = process.env.LINEAR_API_TOKEN;
      if (!linearToken) {
        return { content: [{ type: "text", text: "LINEAR_API_TOKEN not set." }], isError: true };
      }

      if (process.env.ENABLE_ACTIONS !== "true") {
        return {
          content: [{ type: "text", text: "Write actions are disabled. Set ENABLE_ACTIONS=true in your MCP server config to enable." }],
          isError: true,
        };
      }

      const tk = team_key || process.env.LINEAR_TEAM_KEY;
      if (!tk) {
        return { content: [{ type: "text", text: "No team key provided. Set LINEAR_TEAM_KEY or pass team_key." }], isError: true };
      }

      try {
        const result = await startLinearIssue(linearToken, issue_id, tk);
        invalidateCache(CACHE_KEY_LINEAR);

        await setActiveTask({
          identifier: result.identifier,
          title: result.title,
          description: result.description,
          url: result.url,
          startedAt: new Date().toISOString(),
        });

        const lines = [
          `Started ${result.identifier}: ${result.title}`,
          `Status: ${result.status} · Assigned to: ${result.assignee ?? "you"}`,
          "",
          result.description
            ? `Issue description:\n${result.description}`
            : "No description provided.",
          "",
          `Want me to start working on it?`,
        ];

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );

  registerAppTool(
    server,
    "request_review",
    {
      title: "Request Review",
      description:
        "Request a review on a GitHub pull request from specific reviewers. Use when someone " +
        "wants to add reviewers to a PR, or when the board shows 'no reviewers assigned'.",
      inputSchema: {
        owner: z.string().describe("Repository owner"),
        repo: z.string().describe("Repository name"),
        pr_number: z.number().describe("PR number"),
        reviewers: z.array(z.string()).describe("GitHub usernames to request review from"),
      },
      _meta: { ui: { visibility: ["llm", "app"] } },
    },
    async ({ owner, repo, pr_number, reviewers: reviewerLogins }): Promise<CallToolResult> => {
      const githubToken = process.env.GITHUB_TOKEN;
      if (!githubToken) {
        return { content: [{ type: "text", text: "GITHUB_TOKEN not set." }], isError: true };
      }

      if (process.env.ENABLE_ACTIONS !== "true") {
        return {
          content: [{ type: "text", text: "Write actions are disabled. Set ENABLE_ACTIONS=true in your MCP server config to enable." }],
          isError: true,
        };
      }

      try {
        await requestReview(githubToken, owner, repo, pr_number, reviewerLogins);
        invalidateCache(CACHE_KEY_GITHUB);
        return {
          content: [{ type: "text", text: `Requested review from ${reviewerLogins.map((r) => `@${r}`).join(", ")} on PR #${pr_number}.` }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );

  // ── Context continuity ─────────────────────────────────────────────────

  registerAppTool(
    server,
    "get_context",
    {
      title: "Get Context",
      description:
        "Get your current working context — what task you're working on, recent actions, " +
        "and board status. Use this at the start of a new conversation to quickly understand " +
        "what the user was doing. Also useful when someone asks 'what was I working on', " +
        "'where did I leave off', or 'catch me up'.",
      inputSchema: {},
      _meta: { ui: { visibility: ["llm"] } },
    },
    async (): Promise<CallToolResult> => {
      const [session, data] = await Promise.all([
        loadSession(),
        fetchFullBoardData(),
      ]);

      const lines: string[] = [];

      if (session.activeTask) {
        const task = session.activeTask;
        lines.push(`**Active task:** ${task.identifier} — ${task.title}`);
        if (task.branch) lines.push(`Branch: \`${task.branch}\``);
        if (task.prNumber) lines.push(`PR: #${task.prNumber}`);
        lines.push(`Started: ${task.startedAt}`);
        lines.push(`URL: ${task.url}`);
        if (task.description) {
          lines.push("");
          lines.push("Description:");
          lines.push(task.description.slice(0, 500));
        }

        if (task.prNumber) {
          const pr = data.prs.find((p) => p.number === task.prNumber);
          if (pr) {
            const reviewStatus = pr.reviewers
              .filter((r) => !r.login.endsWith("[bot]"))
              .map((r) => `@${r.login}: ${r.state}`)
              .join(", ") || "no reviewers";
            lines.push("");
            lines.push(`PR status: ${pr.state} · CI: ${pr.checksStatus} · Reviews: ${reviewStatus}`);
          }
        }
      } else {
        lines.push("**No active task.** The user hasn't started a task in this session.");
      }

      if (session.recentActions.length > 0) {
        lines.push("");
        lines.push("**Recent actions:**");
        for (const a of session.recentActions.slice(-5)) {
          lines.push(`- ${a.action}: ${a.detail} (${a.timestamp})`);
        }
      }

      lines.push("");
      lines.push(formatBoardDigest(data));

      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  // ── Orchestration tools ─────────────────────────────────────────────────

  registerAppTool(
    server,
    "generate_standup",
    {
      title: "Generate Standup",
      description:
        "Generate a standup summary from your board data. Covers what you did recently " +
        "(merged PRs), what you're working on (in progress issues, open PRs), and what's " +
        "blocked or needs attention. Use when someone says 'write my standup', 'standup update', " +
        "'what did I do yesterday', or 'daily update'.",
      inputSchema: {},
      _meta: { ui: { visibility: ["llm"] } },
    },
    async (): Promise<CallToolResult> => {
      const data = await fetchFullBoardData();
      const now = Date.now();
      const ONE_DAY = 24 * 60 * 60 * 1000;
      const yesterday = now - ONE_DAY;

      const recentlyMerged = data.prs
        .filter((p) => p.mergedAt && new Date(p.mergedAt).getTime() > yesterday)
        .map((p) => `- Merged PR #${p.number}: ${p.title}`);

      const inProgress = data.issues
        .filter((i) => {
          const s = i.status.toLowerCase();
          return s === "in progress" || s === "started";
        })
        .map((i) => {
          const linkedPR = data.prs.find((p) => p.state === "open" && p.linkedIssue === i.identifier);
          return `- ${i.identifier}: ${i.title}${linkedPR ? ` (PR #${linkedPR.number})` : " (no PR yet)"}`;
        });

      const openPRs = data.prs
        .filter((p) => p.state === "open")
        .map((p) => {
          const status: string[] = [];
          const humanReviewers = p.reviewers.filter((r) => !r.login.endsWith("[bot]"));
          if (humanReviewers.length === 0) status.push("no reviewers");
          else {
            const approved = humanReviewers.filter((r) => r.state === "APPROVED");
            const pending = humanReviewers.filter((r) => r.state === "PENDING");
            if (approved.length > 0) status.push(`${approved.length} approved`);
            if (pending.length > 0) status.push(`waiting on ${pending.map((r) => `@${r.login}`).join(", ")}`);
          }
          if (p.checksStatus === "failing") status.push("CI failing");
          return `- PR #${p.number}: ${p.title} (${status.join(", ") || "open"})`;
        });

      const blocked = data.needsAttention
        .filter((a) => a.severity === "high")
        .map((a) => `- ${a.title}: ${a.subtitle}`);

      const lines: string[] = ["## Standup Summary", ""];

      if (recentlyMerged.length > 0) {
        lines.push("**Done (last 24h):**");
        lines.push(...recentlyMerged);
        lines.push("");
      }

      if (inProgress.length > 0 || openPRs.length > 0) {
        lines.push("**Working on:**");
        if (inProgress.length > 0) lines.push(...inProgress);
        if (openPRs.length > 0) lines.push(...openPRs);
        lines.push("");
      }

      if (blocked.length > 0) {
        lines.push("**Blocked / needs attention:**");
        lines.push(...blocked);
        lines.push("");
      }

      if (recentlyMerged.length === 0 && inProgress.length === 0 && openPRs.length === 0) {
        lines.push("No recent activity found.");
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  registerAppTool(
    server,
    "suggest_next_task",
    {
      title: "Suggest Next Task",
      description:
        "Suggest which task to work on next based on priority, age, and current workload. " +
        "Analyzes your Todo issues and recommends the best one to pick up. Use when someone " +
        "asks 'what should I work on next', 'what's most important', or 'suggest a task'.",
      inputSchema: {},
      _meta: { ui: { visibility: ["llm"] } },
    },
    async (): Promise<CallToolResult> => {
      const data = await fetchFullBoardData();
      const now = Date.now();
      const ONE_DAY = 24 * 60 * 60 * 1000;

      const inProgressCount = data.issues.filter((i) => {
        const s = i.status.toLowerCase();
        return s === "in progress" || s === "started";
      }).length;

      const todoIssues = data.issues
        .filter((i) => {
          const s = i.status.toLowerCase();
          return s === "todo" || s === "unstarted" || s === "backlog" || s === "triage";
        })
        .map((i) => {
          let score = 0;
          // Priority: 1=urgent(+40), 2=high(+25), 3=medium(+10), 4=low(+0)
          if (i.priority === 1) score += 40;
          else if (i.priority === 2) score += 25;
          else if (i.priority === 3) score += 10;
          // Age bonus: older issues get slight priority
          const ageDays = (now - new Date(i.createdAt).getTime()) / ONE_DAY;
          score += Math.min(ageDays, 20);
          // Recently updated issues might be more relevant
          const updateAge = (now - new Date(i.updatedAt).getTime()) / ONE_DAY;
          if (updateAge < 2) score += 5;
          return { issue: i, score, ageDays: Math.round(ageDays) };
        })
        .sort((a, b) => b.score - a.score);

      if (todoIssues.length === 0) {
        return {
          content: [{ type: "text", text: "No Todo issues found. Your backlog is empty — nice!" }],
        };
      }

      const top = todoIssues[0];
      const priorityLabel = ["", "Urgent", "High", "Medium", "Low"][top.issue.priority] ?? "";
      const reasoning: string[] = [];
      if (top.issue.priority <= 2) reasoning.push(`${priorityLabel} priority`);
      if (top.ageDays > 7) reasoning.push(`${top.ageDays} days old`);
      if (top.issue.priority > 2 && top.ageDays <= 7) reasoning.push("recently created");

      const lines = [
        `**Recommended:** ${top.issue.identifier} — ${top.issue.title}`,
        reasoning.length > 0 ? `Reason: ${reasoning.join(", ")}` : "",
        "",
        `You currently have ${inProgressCount} issue${inProgressCount !== 1 ? "s" : ""} in progress.`,
        "",
      ];

      if (todoIssues.length > 1) {
        lines.push("**Other options:**");
        for (const item of todoIssues.slice(1, 4)) {
          const p = ["", "Urgent", "High", "Medium", "Low"][item.issue.priority] ?? "";
          lines.push(`- ${item.issue.identifier}: ${item.issue.title}${p ? ` (${p})` : ""}`);
        }
      }

      lines.push("", `Say "start ${top.issue.identifier}" to pick it up.`);

      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  registerAppTool(
    server,
    "review_nudge",
    {
      title: "Review Nudge",
      description:
        "Check which of your PRs are waiting on review for a long time and suggest follow-up " +
        "actions. Use when someone asks 'are any PRs stuck', 'who do I need to chase', " +
        "'review status', or 'what's waiting on review'. Also useful proactively — if you " +
        "notice PRs have been waiting, mention this to the user.",
      inputSchema: {},
      _meta: { ui: { visibility: ["llm"] } },
    },
    async (): Promise<CallToolResult> => {
      const data = await fetchFullBoardData();
      const now = Date.now();
      const ONE_HOUR = 60 * 60 * 1000;

      const ghUsername = getCached<string>(CACHE_KEY_GH_USER);

      const waitingPRs = data.prs
        .filter((p) => p.state === "open" && p.author === ghUsername)
        .map((p) => {
          const humanReviewers = p.reviewers.filter(
            (r) => !r.login.endsWith("[bot]") && !r.login.endsWith("-bot"),
          );
          const pending = humanReviewers.filter((r) => r.state === "PENDING");
          const noReviewers = humanReviewers.length === 0;
          const waitHours = (now - new Date(p.updatedAt).getTime()) / ONE_HOUR;
          return { pr: p, pending, noReviewers, waitHours };
        })
        .filter((p) => p.noReviewers || p.pending.length > 0)
        .sort((a, b) => b.waitHours - a.waitHours);

      if (waitingPRs.length === 0) {
        return {
          content: [{ type: "text", text: "All your PRs have reviews or are not waiting. Nothing to chase." }],
        };
      }

      const lines = ["**PRs waiting on review:**", ""];
      for (const { pr, pending, noReviewers, waitHours } of waitingPRs) {
        const waitStr = waitHours < 24
          ? `${Math.round(waitHours)}h`
          : `${Math.round(waitHours / 24)}d`;
        if (noReviewers) {
          lines.push(`- **PR #${pr.number}**: ${pr.title} — no reviewers assigned (${waitStr} since last update)`);
        } else {
          const names = pending.map((r) => `@${r.login}`).join(", ");
          lines.push(`- **PR #${pr.number}**: ${pr.title} — waiting on ${names} (${waitStr})`);
        }
      }

      const stale = waitingPRs.filter((p) => p.waitHours > 24);
      if (stale.length > 0) {
        lines.push("");
        lines.push(`${stale.length} PR${stale.length > 1 ? "s have" : " has"} been waiting over 24 hours. Consider pinging the reviewers or requesting new ones.`);
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  registerAppResource(
    server,
    boardResourceUri,
    boardResourceUri,
    { mimeType: RESOURCE_MIME_TYPE, description: "Engineering Board UI" },
    async (): Promise<ReadResourceResult> => {
      const htmlPath = path.join(DIST_DIR, "index.html");
      let html: string;
      try {
        html = await fs.readFile(htmlPath, "utf-8");
      } catch {
        throw new Error(
          `Could not read UI bundle at ${htmlPath}. Run "pnpm build:ui" first.`,
        );
      }
      return {
        contents: [
          {
            uri: boardResourceUri,
            mimeType: RESOURCE_MIME_TYPE,
            text: html,
          },
        ],
      };
    },
  );

  return server;
}

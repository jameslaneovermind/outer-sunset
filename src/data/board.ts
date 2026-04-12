import type { GitHubPR } from "./github.js";
import type { LinearIssue } from "./linear.js";
import type { LinkedItem } from "./linker.js";

export interface FileConflict {
  file: string;
  prs: { number: number; title: string }[];
}

export interface LifecycleEvent {
  type: "ready_to_merge" | "newly_approved";
  message: string;
  prNumber: number;
  url: string;
}

export interface BoardData {
  items: LinkedItem[];
  issues: LinearIssue[];
  prs: GitHubPR[];
  needsAttention: AttentionItem[];
  stats: BoardStats;
  conflicts: FileConflict[];
  lifecycle: LifecycleEvent[];
  fetchedAt: string;
  errors: string[];
}

export interface AttentionItem {
  type: "stale_pr" | "pending_review" | "failing_ci" | "aging_issue" | "no_reviewers";
  title: string;
  subtitle: string;
  url: string;
  severity: "high" | "medium" | "low";
}

export interface BoardStats {
  openPRs: number;
  inProgressIssues: number;
  mergedThisWeek: number;
  avgPRAgeDays: number | null;
}

export function computeNeedsAttention(
  items: LinkedItem[],
  prs: GitHubPR[],
  username: string | null,
): AttentionItem[] {
  const now = Date.now();
  const ONE_HOUR = 60 * 60 * 1000;
  const ONE_DAY = 24 * ONE_HOUR;

  const prAttention = new Map<number, AttentionItem>();
  const severityRank = { high: 0, medium: 1, low: 2 };

  function setBest(prNumber: number, candidate: AttentionItem) {
    const existing = prAttention.get(prNumber);
    if (!existing || severityRank[candidate.severity] < severityRank[existing.severity]) {
      prAttention.set(prNumber, candidate);
    }
  }

  for (const pr of prs) {
    if (pr.state !== "open") continue;

    if (
      username &&
      pr.author !== username &&
      pr.reviewers.some((r) => r.login === username && r.state === "PENDING")
    ) {
      setBest(pr.number, {
        type: "pending_review",
        title: `PR #${pr.number} — you're requested to review`,
        subtitle: `${pr.title} by @${pr.author}`,
        url: pr.url,
        severity: "high",
      });
      continue;
    }

    if (pr.author !== username) continue;

    if (pr.checksStatus === "failing") {
      setBest(pr.number, {
        type: "failing_ci",
        title: `PR #${pr.number} — CI failing`,
        subtitle: pr.title,
        url: pr.url,
        severity: "high",
      });
    }

    const pendingReviewers = pr.reviewers.filter((r) => r.state === "PENDING");
    if (pendingReviewers.length > 0) {
      const names = pendingReviewers.map((r) => `@${r.login}`).join(", ");
      setBest(pr.number, {
        type: "pending_review",
        title: `PR #${pr.number} — waiting on ${names}`,
        subtitle: pr.title,
        url: pr.url,
        severity: "medium",
      });
    }

    if (pr.reviewers.length === 0) {
      const ageHours = (now - new Date(pr.createdAt).getTime()) / ONE_HOUR;
      if (ageHours > 4) {
        setBest(pr.number, {
          type: "no_reviewers",
          title: `PR #${pr.number} — no reviewers assigned`,
          subtitle: `${pr.title} · opened ${formatDuration(now - new Date(pr.createdAt).getTime())} ago`,
          url: pr.url,
          severity: "medium",
        });
      }
    }

    const prAge = now - new Date(pr.createdAt).getTime();
    if (prAge > 3 * ONE_DAY && pr.reviewers.every((r) => r.state !== "APPROVED")) {
      setBest(pr.number, {
        type: "stale_pr",
        title: `PR #${pr.number} — open ${formatDuration(prAge)}`,
        subtitle: `${pr.title} · no approvals yet`,
        url: pr.url,
        severity: prAge > 7 * ONE_DAY ? "high" : "medium",
      });
    }
  }

  const attention = [...prAttention.values()];

  for (const item of items) {
    if (!item.issue || item.pr) continue;
    const status = item.issue.status.toLowerCase();
    if (status !== "in progress" && status !== "started") continue;
    const age = now - new Date(item.issue.updatedAt).getTime();
    if (age > 3 * ONE_DAY) {
      attention.push({
        type: "aging_issue",
        title: `${item.issue.identifier} — no PR yet`,
        subtitle: `${item.issue.title} · in progress ${formatDuration(age)}`,
        url: item.issue.url,
        severity: age > 7 * ONE_DAY ? "high" : "low",
      });
    }
  }

  attention.sort((a, b) => severityRank[a.severity] - severityRank[b.severity]);

  return attention;
}

export function computeStats(prs: GitHubPR[]): BoardStats {
  const now = Date.now();
  const weekAgo = now - 7 * 24 * 60 * 60 * 1000;

  const openPRs = prs.filter((p) => p.state === "open").length;
  const mergedThisWeek = prs.filter(
    (p) => p.mergedAt && new Date(p.mergedAt).getTime() > weekAgo,
  ).length;

  const openAges = prs
    .filter((p) => p.state === "open")
    .map((p) => (now - new Date(p.createdAt).getTime()) / (24 * 60 * 60 * 1000));

  const avgPRAgeDays =
    openAges.length > 0
      ? Math.round((openAges.reduce((a, b) => a + b, 0) / openAges.length) * 10) / 10
      : null;

  return {
    openPRs,
    inProgressIssues: 0,
    mergedThisWeek,
    avgPRAgeDays,
  };
}

export function formatDuration(ms: number): string {
  const hours = Math.floor(ms / (60 * 60 * 1000));
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

export function computeLifecycleEvents(prs: GitHubPR[], username: string | null): LifecycleEvent[] {
  const events: LifecycleEvent[] = [];

  for (const pr of prs) {
    if (pr.author !== username) continue;

    if (pr.state === "open") {
      const humanReviewers = pr.reviewers.filter(
        (r) => !r.login.endsWith("[bot]") && !r.login.endsWith("-bot"),
      );
      const allApproved = humanReviewers.length > 0 && humanReviewers.every((r) => r.state === "APPROVED");

      if (allApproved && pr.checksStatus === "passing") {
        events.push({
          type: "ready_to_merge",
          message: `PR #${pr.number} is approved and CI is green — ready to merge`,
          prNumber: pr.number,
          url: pr.url,
        });
      } else if (allApproved) {
        events.push({
          type: "newly_approved",
          message: `PR #${pr.number} has all approvals${pr.checksStatus === "pending" ? " (CI still running)" : ""}`,
          prNumber: pr.number,
          url: pr.url,
        });
      }
    }
  }

  return events;
}

export function formatBoardDigest(data: BoardData): string {
  if (data.errors.length > 0 && data.items.length === 0) {
    return `Board could not load: ${data.errors.join("; ")}`;
  }

  const counts: string[] = [];
  if (data.stats.openPRs > 0) counts.push(`${data.stats.openPRs} open PRs`);
  if (data.stats.inProgressIssues > 0)
    counts.push(`${data.stats.inProgressIssues} in progress`);
  if (data.stats.mergedThisWeek > 0)
    counts.push(`${data.stats.mergedThisWeek} merged this week`);
  if (data.stats.avgPRAgeDays != null)
    counts.push(`${data.stats.avgPRAgeDays}d avg PR age`);

  const header =
    counts.length > 0
      ? `Here's your board — ${counts.join(" · ")}.`
      : "Here's your board.";

  const lines: string[] = [header];

  if (data.needsAttention.length > 0) {
    lines.push("");
    lines.push("Needs attention:");
    for (const item of data.needsAttention) {
      lines.push(`  - ${item.title}: ${item.subtitle}`);
    }
  }

  const failingCI = data.prs.filter(
    (p) => p.state === "open" && p.checksStatus === "failing",
  );
  const allPassing =
    data.prs.filter((p) => p.state === "open").length > 0 &&
    failingCI.length === 0;

  if (allPassing) {
    lines.push("");
    lines.push("All CI checks passing.");
  } else if (failingCI.length > 0) {
    lines.push("");
    lines.push(
      `CI failing on ${failingCI.map((p) => `PR #${p.number}`).join(", ")}.`,
    );
  }

  if (data.lifecycle.length > 0) {
    lines.push("");
    for (const event of data.lifecycle) {
      lines.push(`> ${event.message}.`);
    }
  }

  if (data.conflicts.length > 0) {
    lines.push("");
    lines.push("Potential conflicts:");
    for (const c of data.conflicts.slice(0, 3)) {
      const prNums = c.prs.map((p) => `#${p.number}`).join(" and ");
      lines.push(`  - ${c.file} — touched by PRs ${prNums}`);
    }
  }

  if (data.errors.length > 0) {
    lines.push("");
    lines.push(`Note: ${data.errors.join("; ")}`);
  }

  return lines.join("\n");
}

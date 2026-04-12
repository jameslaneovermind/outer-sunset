import type { LinearIssue } from "./linear.js";
import type { GitHubPR } from "./github.js";

export interface LinkedItem {
  issue?: LinearIssue;
  pr?: GitHubPR;
}

/**
 * Links Linear issues to GitHub PRs using two strategies (checked in order):
 * 1. Branch name contains issue identifier (e.g. `james/eng-412-fix`)
 * 2. PR title contains issue identifier (e.g. `[ENG-412] Fix login`)
 *
 * If multiple PRs match one issue, the most recently updated one wins.
 */
export function linkIssuesToPRs(
  issues: LinearIssue[],
  prs: GitHubPR[],
): LinkedItem[] {
  const issueMap = new Map<string, LinearIssue>();
  for (const issue of issues) {
    issueMap.set(issue.identifier.toLowerCase(), issue);
  }

  const linkedIssueIds = new Set<string>();
  const linkedPRNumbers = new Set<number>();
  const links: LinkedItem[] = [];

  const prsByIssue = new Map<string, GitHubPR[]>();

  for (const pr of prs) {
    const matchedId = findIssueIdInPR(pr, issueMap);
    if (matchedId) {
      pr.linkedIssue = matchedId.toUpperCase();
      const existing = prsByIssue.get(matchedId) ?? [];
      existing.push(pr);
      prsByIssue.set(matchedId, existing);
    }
  }

  for (const [issueId, matchedPRs] of prsByIssue) {
    matchedPRs.sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
    const bestPR = matchedPRs[0];
    const issue = issueMap.get(issueId);

    if (issue) {
      linkedIssueIds.add(issueId);
      linkedPRNumbers.add(bestPR.number);
      links.push({ issue, pr: bestPR });
    }
  }

  for (const issue of issues) {
    if (!linkedIssueIds.has(issue.identifier.toLowerCase())) {
      links.push({ issue });
    }
  }

  for (const pr of prs) {
    if (!linkedPRNumbers.has(pr.number)) {
      links.push({ pr });
    }
  }

  return links;
}

function findIssueIdInPR(
  pr: GitHubPR,
  issueMap: Map<string, LinearIssue>,
): string | undefined {
  for (const id of issueMap.keys()) {
    if (branchContainsId(pr.branch, id)) return id;
  }

  for (const id of issueMap.keys()) {
    if (textContainsId(pr.title, id)) return id;
  }

  return undefined;
}

const ID_SEPARATORS = /[-_/\\.\s]/;

function branchContainsId(branch: string, issueId: string): boolean {
  const normalized = branch.toLowerCase();
  const id = issueId.toLowerCase();

  const idx = normalized.indexOf(id);
  if (idx === -1) return false;

  const before = idx > 0 ? normalized[idx - 1] : "";
  const after = normalized[idx + id.length] ?? "";

  return (
    (idx === 0 || ID_SEPARATORS.test(before)) &&
    (after === "" || ID_SEPARATORS.test(after))
  );
}

function textContainsId(text: string, issueId: string): boolean {
  if (!text) return false;
  const normalized = text.toLowerCase();
  const id = issueId.toLowerCase();

  const idx = normalized.indexOf(id);
  if (idx === -1) return false;

  const before = idx > 0 ? normalized[idx - 1] : " ";
  const after = normalized[idx + id.length] ?? " ";

  return /[\s\W]/.test(before) && /[\s\W]/.test(after);
}

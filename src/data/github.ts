const GITHUB_API = "https://api.github.com";

export interface Reviewer {
  login: string;
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "PENDING" | "DISMISSED";
  submittedAt?: string;
}

export interface GitHubPR {
  number: number;
  title: string;
  state: "open" | "closed" | "merged";
  author: string;
  branch: string;
  reviewers: Reviewer[];
  checksStatus: "pending" | "passing" | "failing" | "unknown";
  additions: number;
  deletions: number;
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
  url: string;
  repoFullName: string;
  linkedIssue?: string;
}

interface SearchItem {
  number: number;
  title: string;
  state: string;
  html_url: string;
  created_at: string;
  updated_at: string;
  user: { login: string } | null;
  pull_request?: {
    merged_at: string | null;
    html_url: string;
  };
  repository_url: string;
}

interface PRDetail {
  head: { ref: string };
  body: string | null;
  additions: number;
  deletions: number;
  merged: boolean;
  merged_at: string | null;
  requested_reviewers: Array<{ login: string }>;
}

interface ReviewItem {
  user: { login: string } | null;
  state: string;
  submitted_at: string;
}

interface CheckRun {
  status: string;
  conclusion: string | null;
  name?: string;
  started_at?: string;
  completed_at?: string;
}

interface FileItem {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
}

export interface PRDetailResult {
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed" | "merged";
  author: string;
  branch: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  mergeable: boolean | null;
  reviewers: Reviewer[];
  checksStatus: "pending" | "passing" | "failing" | "unknown";
  checks: { name: string; status: string; conclusion: string | null; durationSeconds: number | null }[];
  files: { path: string; status: string; additions: number; deletions: number }[];
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
  url: string;
  repoFullName: string;
}

const FETCH_TIMEOUT_MS = 15_000;

async function githubFetch<T>(
  endpoint: string,
  token: string,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(`${GITHUB_API}${endpoint}`, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`GitHub API timeout (${endpoint})`);
    }
    throw err;
  }
  clearTimeout(timer);

  if (res.status === 401 || res.status === 403) {
    throw new Error(
      `GitHub authentication failed (${res.status}). Check your GITHUB_TOKEN.`,
    );
  }

  if (res.status === 429) {
    throw new Error("GitHub rate limit reached. Try again in a few minutes.");
  }

  if (!res.ok) {
    throw new Error(`GitHub API error: ${res.status} ${res.statusText}`);
  }

  return (await res.json()) as T;
}

export async function getGitHubUsername(token: string): Promise<string> {
  const user = await githubFetch<{ login: string }>("/user", token);
  return user.login;
}

export async function fetchGitHubPRs(
  token: string,
  username?: string,
  owner?: string,
): Promise<GitHubPR[]> {
  const login = username ?? (await getGitHubUsername(token));

  const ownerFilter = owner ? `+org:${owner}` : "";
  const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
    .toISOString()
    .split("T")[0];
  const authorQuery = encodeURIComponent(
    `author:${login} is:pr is:open updated:>=${cutoff}${ownerFilter}`,
  );
  const reviewQuery = encodeURIComponent(
    `review-requested:${login} is:pr is:open${ownerFilter}`,
  );

  const [authorResults, reviewResults] = await Promise.all([
    githubFetch<{ items: SearchItem[] }>(
      `/search/issues?q=${authorQuery}&sort=updated&per_page=50`,
      token,
    ),
    githubFetch<{ items: SearchItem[] }>(
      `/search/issues?q=${reviewQuery}&sort=updated&per_page=20`,
      token,
    ),
  ]);

  const seen = new Set<string>();
  const allItems: SearchItem[] = [];

  for (const item of [...authorResults.items, ...reviewResults.items]) {
    const key = item.html_url;
    if (!seen.has(key)) {
      seen.add(key);
      allItems.push(item);
    }
  }

  const prs = await Promise.all(
    allItems.map((item) => enrichPR(item, token)),
  );

  return prs;
}

async function enrichPR(item: SearchItem, token: string): Promise<GitHubPR> {
  const repoFullName = item.repository_url.replace(
    `${GITHUB_API}/repos/`,
    "",
  );

  const [detail, reviews] = await Promise.all([
    githubFetch<PRDetail & { head: { ref: string; sha: string } }>(
      `/repos/${repoFullName}/pulls/${item.number}`,
      token,
    ),
    fetchReviews(repoFullName, item.number, token),
  ]);

  const checksStatus = await fetchChecksStatusBySha(
    repoFullName,
    detail.head.sha,
    token,
  );

  const isMerged = detail.merged || detail.merged_at != null;

  const reviewerMap = new Map<string, Reviewer>();

  for (const requested of detail.requested_reviewers) {
    reviewerMap.set(requested.login, {
      login: requested.login,
      state: "PENDING",
    });
  }

  for (const review of reviews) {
    if (!review.user) continue;
    const existing = reviewerMap.get(review.user.login);
    if (
      !existing ||
      new Date(review.submitted_at) >
        new Date(existing.submittedAt ?? "1970-01-01")
    ) {
      reviewerMap.set(review.user.login, {
        login: review.user.login,
        state: review.state as Reviewer["state"],
        submittedAt: review.submitted_at,
      });
    }
  }

  return {
    number: item.number,
    title: item.title,
    state: isMerged ? "merged" : (item.state as "open" | "closed"),
    author: item.user?.login ?? "unknown",
    branch: detail.head.ref,
    reviewers: [...reviewerMap.values()],
    checksStatus,
    additions: detail.additions,
    deletions: detail.deletions,
    createdAt: item.created_at,
    updatedAt: item.updated_at,
    mergedAt: detail.merged_at,
    url: item.html_url,
    repoFullName,
    linkedIssue: undefined,
  };
}

async function fetchReviews(
  repoFullName: string,
  prNumber: number,
  token: string,
): Promise<ReviewItem[]> {
  try {
    return await githubFetch<ReviewItem[]>(
      `/repos/${repoFullName}/pulls/${prNumber}/reviews`,
      token,
    );
  } catch {
    return [];
  }
}

async function fetchChecksStatusBySha(
  repoFullName: string,
  sha: string,
  token: string,
): Promise<GitHubPR["checksStatus"]> {
  try {
    const checks = await githubFetch<{ check_runs: CheckRun[] }>(
      `/repos/${repoFullName}/commits/${sha}/check-runs?per_page=100`,
      token,
    );

    if (checks.check_runs.length === 0) return "unknown";

    const hasFailure = checks.check_runs.some(
      (c) => c.conclusion === "failure" || c.conclusion === "timed_out",
    );
    if (hasFailure) return "failing";

    const allComplete = checks.check_runs.every(
      (c) => c.status === "completed",
    );
    if (allComplete) return "passing";

    return "pending";
  } catch {
    return "unknown";
  }
}

interface FullPRResponse {
  title: string;
  body: string | null;
  state: string;
  merged: boolean;
  merged_at: string | null;
  additions: number;
  deletions: number;
  changed_files: number;
  mergeable: boolean | null;
  head: { ref: string; sha: string };
  user: { login: string } | null;
  html_url: string;
  created_at: string;
  updated_at: string;
  requested_reviewers: Array<{ login: string }>;
}

export async function fetchPRDetail(
  token: string,
  owner: string,
  repo: string,
  number: number,
): Promise<PRDetailResult> {
  const repoFullName = `${owner}/${repo}`;

  const detail = await githubFetch<FullPRResponse>(
    `/repos/${repoFullName}/pulls/${number}`,
    token,
  );

  const sha = detail.head.sha;

  const [reviews, filesRes, checksRes] = await Promise.all([
    fetchReviews(repoFullName, number, token),
    githubFetch<FileItem[]>(
      `/repos/${repoFullName}/pulls/${number}/files?per_page=100`,
      token,
    ).catch(() => [] as FileItem[]),
    githubFetch<{ check_runs: CheckRun[] }>(
      `/repos/${repoFullName}/commits/${sha}/check-runs?per_page=100`,
      token,
    ).catch(() => ({ check_runs: [] as CheckRun[] })),
  ]);

  const reviewerMap = new Map<string, Reviewer>();
  for (const requested of detail.requested_reviewers) {
    reviewerMap.set(requested.login, { login: requested.login, state: "PENDING" });
  }
  for (const review of reviews) {
    if (!review.user) continue;
    const existing = reviewerMap.get(review.user.login);
    if (!existing || new Date(review.submitted_at) > new Date(existing.submittedAt ?? "1970-01-01")) {
      reviewerMap.set(review.user.login, {
        login: review.user.login,
        state: review.state as Reviewer["state"],
        submittedAt: review.submitted_at,
      });
    }
  }

  const isMerged = detail.merged || detail.merged_at != null;

  return {
    number,
    title: detail.title,
    body: detail.body,
    state: isMerged ? "merged" : (detail.state as "open" | "closed"),
    author: detail.user?.login ?? "unknown",
    branch: detail.head.ref,
    additions: detail.additions,
    deletions: detail.deletions,
    changedFiles: detail.changed_files,
    mergeable: detail.mergeable,
    reviewers: [...reviewerMap.values()],
    checksStatus: deriveChecksStatus(checksRes.check_runs),
    checks: checksRes.check_runs.map((c) => ({
      name: c.name ?? "check",
      status: c.status,
      conclusion: c.conclusion,
      durationSeconds:
        c.started_at && c.completed_at
          ? Math.round((new Date(c.completed_at).getTime() - new Date(c.started_at).getTime()) / 1000)
          : null,
    })),
    files: filesRes.map((f) => ({
      path: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
    })),
    createdAt: detail.created_at,
    updatedAt: detail.updated_at,
    mergedAt: detail.merged_at,
    url: detail.html_url,
    repoFullName,
  };
}

function deriveChecksStatus(runs: CheckRun[]): PRDetailResult["checksStatus"] {
  if (runs.length === 0) return "unknown";
  if (runs.some((c) => c.conclusion === "failure" || c.conclusion === "timed_out")) return "failing";
  if (runs.every((c) => c.status === "completed")) return "passing";
  return "pending";
}

export async function requestReview(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
  reviewers: string[],
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(
      `${GITHUB_API}/repos/${owner}/${repo}/pulls/${prNumber}/requested_reviewers`,
      {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ reviewers }),
        signal: controller.signal,
      },
    );
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error("GitHub API timeout (request review)");
    }
    throw err;
  }
  clearTimeout(timer);

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Failed to request review (${res.status}): ${body}`);
  }
}

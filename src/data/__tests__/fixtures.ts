import type { GitHubPR, Reviewer } from "../github.js";
import type { LinearIssue } from "../linear.js";

const NOW = Date.now();
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export function hoursAgo(h: number): string {
  return new Date(NOW - h * HOUR).toISOString();
}

export function daysAgo(d: number): string {
  return new Date(NOW - d * DAY).toISOString();
}

export function makePR(overrides: Partial<GitHubPR> = {}): GitHubPR {
  return {
    number: 100,
    title: "Test PR",
    state: "open",
    author: "james",
    branch: "main",
    reviewers: [],
    checksStatus: "passing",
    additions: 10,
    deletions: 5,
    createdAt: daysAgo(1),
    updatedAt: hoursAgo(2),
    mergedAt: null,
    url: "https://github.com/test/repo/pull/100",
    repoFullName: "test/repo",
    ...overrides,
  };
}

export function makeIssue(overrides: Partial<LinearIssue> = {}): LinearIssue {
  return {
    id: "issue-1",
    identifier: "ENG-100",
    title: "Test issue",
    status: "Todo",
    assignee: "James",
    priority: 2,
    createdAt: daysAgo(3),
    updatedAt: daysAgo(1),
    url: "https://linear.app/team/issue/ENG-100",
    ...overrides,
  };
}

export function makeReviewer(overrides: Partial<Reviewer> = {}): Reviewer {
  return {
    login: "dylan",
    state: "APPROVED",
    submittedAt: hoursAgo(1),
    ...overrides,
  };
}

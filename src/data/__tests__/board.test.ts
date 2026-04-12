import { describe, it, expect } from "vitest";
import {
  computeNeedsAttention,
  computeStats,
  computeLifecycleEvents,
  formatBoardDigest,
  formatDuration,
} from "../board.js";
import type { BoardData } from "../board.js";
import { makeIssue, makePR, makeReviewer, daysAgo, hoursAgo } from "./fixtures.js";

describe("computeNeedsAttention", () => {
  it("flags PRs where you are requested to review", () => {
    const pr = makePR({
      number: 1,
      author: "dylan",
      reviewers: [makeReviewer({ login: "james", state: "PENDING" })],
    });

    const result = computeNeedsAttention([], [pr], "james");

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("pending_review");
    expect(result[0].severity).toBe("high");
    expect(result[0].title).toContain("you're requested to review");
  });

  it("flags your PRs with failing CI", () => {
    const pr = makePR({
      number: 2,
      author: "james",
      checksStatus: "failing",
    });

    const result = computeNeedsAttention([], [pr], "james");

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("failing_ci");
    expect(result[0].severity).toBe("high");
  });

  it("flags your PRs with no reviewers (after 4h)", () => {
    const pr = makePR({
      number: 3,
      author: "james",
      reviewers: [],
      createdAt: hoursAgo(6),
    });

    const result = computeNeedsAttention([], [pr], "james");

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("no_reviewers");
  });

  it("does not flag PRs with no reviewers under 4h old", () => {
    const pr = makePR({
      number: 4,
      author: "james",
      reviewers: [],
      createdAt: hoursAgo(2),
    });

    const result = computeNeedsAttention([], [pr], "james");

    expect(result).toHaveLength(0);
  });

  it("flags stale PRs (>3d, no approvals)", () => {
    const pr = makePR({
      number: 5,
      author: "james",
      createdAt: daysAgo(5),
      reviewers: [makeReviewer({ state: "COMMENTED" })],
    });

    const result = computeNeedsAttention([], [pr], "james");

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("stale_pr");
    expect(result[0].severity).toBe("medium");
  });

  it("escalates stale PRs >7d to high severity", () => {
    const pr = makePR({
      number: 6,
      author: "james",
      createdAt: daysAgo(10),
      reviewers: [],
    });

    const result = computeNeedsAttention([], [pr], "james");

    const stalePR = result.find((r) => r.type === "stale_pr");
    expect(stalePR?.severity).toBe("high");
  });

  it("deduplicates — one item per PR (highest severity wins)", () => {
    const pr = makePR({
      number: 7,
      author: "james",
      checksStatus: "failing",
      createdAt: daysAgo(5),
      reviewers: [makeReviewer({ state: "PENDING" })],
    });

    const result = computeNeedsAttention([], [pr], "james");

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("failing_ci");
  });

  it("flags aging in-progress issues with no PR", () => {
    const issue = makeIssue({
      identifier: "ENG-999",
      status: "In Progress",
      updatedAt: daysAgo(5),
    });

    const result = computeNeedsAttention([{ issue }], [], "james");

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("aging_issue");
  });

  it("does not flag in-progress issues that have a linked PR", () => {
    const issue = makeIssue({
      identifier: "ENG-888",
      status: "In Progress",
      updatedAt: daysAgo(5),
    });
    const pr = makePR({ number: 8, state: "closed" });

    const result = computeNeedsAttention([{ issue, pr }], [], "james");

    expect(result).toHaveLength(0);
  });

  it("ignores closed/merged PRs", () => {
    const pr = makePR({
      number: 9,
      author: "james",
      state: "merged",
      checksStatus: "failing",
    });

    const result = computeNeedsAttention([], [pr], "james");

    expect(result).toHaveLength(0);
  });

  it("sorts high severity before medium before low", () => {
    const prs = [
      makePR({ number: 10, author: "james", checksStatus: "failing", createdAt: hoursAgo(1) }),
      makePR({ number: 11, author: "james", reviewers: [], createdAt: hoursAgo(6) }),
    ];
    const issue = makeIssue({ status: "In Progress", updatedAt: daysAgo(5) });

    const result = computeNeedsAttention([{ issue }], prs, "james");

    expect(result[0].severity).toBe("high");
    expect(result[result.length - 1].severity).toBe("low");
  });
});

describe("computeStats", () => {
  it("counts open PRs", () => {
    const prs = [
      makePR({ state: "open" }),
      makePR({ state: "merged" }),
      makePR({ state: "open" }),
    ];

    const stats = computeStats(prs);

    expect(stats.openPRs).toBe(2);
  });

  it("counts merged this week", () => {
    const prs = [
      makePR({ state: "merged", mergedAt: daysAgo(2) }),
      makePR({ state: "merged", mergedAt: daysAgo(10) }),
    ];

    const stats = computeStats(prs);

    expect(stats.mergedThisWeek).toBe(1);
  });

  it("computes average PR age for open PRs", () => {
    const prs = [
      makePR({ state: "open", createdAt: daysAgo(2) }),
      makePR({ state: "open", createdAt: daysAgo(4) }),
    ];

    const stats = computeStats(prs);

    expect(stats.avgPRAgeDays).toBeCloseTo(3, 0);
  });

  it("returns null avg when no open PRs", () => {
    const prs = [makePR({ state: "merged" })];

    const stats = computeStats(prs);

    expect(stats.avgPRAgeDays).toBeNull();
  });

  it("handles empty input", () => {
    const stats = computeStats([]);

    expect(stats.openPRs).toBe(0);
    expect(stats.mergedThisWeek).toBe(0);
    expect(stats.avgPRAgeDays).toBeNull();
  });

  it("initializes inProgressIssues to 0", () => {
    const stats = computeStats([]);

    expect(stats.inProgressIssues).toBe(0);
  });
});

describe("computeLifecycleEvents", () => {
  it("detects ready-to-merge PRs (approved + CI green)", () => {
    const pr = makePR({
      number: 20,
      author: "james",
      checksStatus: "passing",
      reviewers: [makeReviewer({ login: "dylan", state: "APPROVED" })],
    });

    const events = computeLifecycleEvents([pr], "james");

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("ready_to_merge");
    expect(events[0].message).toContain("approved and CI is green");
  });

  it("detects newly approved PRs (approved but CI not passing)", () => {
    const pr = makePR({
      number: 21,
      author: "james",
      checksStatus: "pending",
      reviewers: [makeReviewer({ login: "dylan", state: "APPROVED" })],
    });

    const events = computeLifecycleEvents([pr], "james");

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("newly_approved");
    expect(events[0].message).toContain("CI still running");
  });

  it("ignores PRs by other authors", () => {
    const pr = makePR({
      number: 22,
      author: "dylan",
      checksStatus: "passing",
      reviewers: [makeReviewer({ login: "james", state: "APPROVED" })],
    });

    const events = computeLifecycleEvents([pr], "james");

    expect(events).toHaveLength(0);
  });

  it("ignores bot reviewers when checking approvals", () => {
    const pr = makePR({
      number: 23,
      author: "james",
      checksStatus: "passing",
      reviewers: [makeReviewer({ login: "dependabot[bot]", state: "APPROVED" })],
    });

    const events = computeLifecycleEvents([pr], "james");

    expect(events).toHaveLength(0);
  });

  it("requires all human reviewers to approve", () => {
    const pr = makePR({
      number: 24,
      author: "james",
      checksStatus: "passing",
      reviewers: [
        makeReviewer({ login: "dylan", state: "APPROVED" }),
        makeReviewer({ login: "sarah", state: "COMMENTED" }),
      ],
    });

    const events = computeLifecycleEvents([pr], "james");

    expect(events).toHaveLength(0);
  });

  it("returns empty for no PRs", () => {
    expect(computeLifecycleEvents([], "james")).toEqual([]);
  });
});

describe("formatDuration", () => {
  it("formats hours", () => {
    expect(formatDuration(3 * 60 * 60 * 1000)).toBe("3h");
  });

  it("formats days", () => {
    expect(formatDuration(5 * 24 * 60 * 60 * 1000)).toBe("5d");
  });

  it("rounds down partial days to hours", () => {
    expect(formatDuration(23 * 60 * 60 * 1000)).toBe("23h");
  });

  it("shows 0h for sub-hour durations", () => {
    expect(formatDuration(30 * 60 * 1000)).toBe("0h");
  });
});

describe("formatBoardDigest", () => {
  function makeBoardData(overrides: Partial<BoardData> = {}): BoardData {
    return {
      items: [],
      issues: [],
      prs: [],
      needsAttention: [],
      stats: { openPRs: 0, inProgressIssues: 0, mergedThisWeek: 0, avgPRAgeDays: null },
      conflicts: [],
      lifecycle: [],
      fetchedAt: new Date().toISOString(),
      errors: [],
      ...overrides,
    };
  }

  it("shows error message when board fails to load", () => {
    const data = makeBoardData({ errors: ["Linear: timeout"] });

    const digest = formatBoardDigest(data);

    expect(digest).toBe("Board could not load: Linear: timeout");
  });

  it("includes stats in header", () => {
    const data = makeBoardData({
      stats: { openPRs: 3, inProgressIssues: 1, mergedThisWeek: 2, avgPRAgeDays: 4.5 },
      items: [{ issue: makeIssue() }],
    });

    const digest = formatBoardDigest(data);

    expect(digest).toContain("3 open PRs");
    expect(digest).toContain("1 in progress");
    expect(digest).toContain("2 merged this week");
    expect(digest).toContain("4.5d avg PR age");
  });

  it("lists attention items", () => {
    const data = makeBoardData({
      items: [{ issue: makeIssue() }],
      needsAttention: [
        { type: "failing_ci", title: "PR #1 — CI failing", subtitle: "fix stuff", url: "", severity: "high" },
      ],
    });

    const digest = formatBoardDigest(data);

    expect(digest).toContain("Needs attention:");
    expect(digest).toContain("PR #1 — CI failing: fix stuff");
  });

  it("shows all CI passing when no failures", () => {
    const data = makeBoardData({
      prs: [makePR({ state: "open", checksStatus: "passing" })],
      items: [{ pr: makePR() }],
    });

    const digest = formatBoardDigest(data);

    expect(digest).toContain("All CI checks passing.");
  });

  it("shows CI failures", () => {
    const data = makeBoardData({
      prs: [
        makePR({ number: 10, state: "open", checksStatus: "failing" }),
        makePR({ number: 11, state: "open", checksStatus: "failing" }),
      ],
      items: [{ pr: makePR() }],
    });

    const digest = formatBoardDigest(data);

    expect(digest).toContain("CI failing on PR #10, PR #11.");
  });

  it("includes lifecycle events", () => {
    const data = makeBoardData({
      items: [{ pr: makePR() }],
      lifecycle: [
        { type: "ready_to_merge", message: "PR #5 is ready to merge", prNumber: 5, url: "" },
      ],
    });

    const digest = formatBoardDigest(data);

    expect(digest).toContain("> PR #5 is ready to merge.");
  });

  it("includes conflict warnings", () => {
    const data = makeBoardData({
      items: [{ pr: makePR() }],
      conflicts: [
        { file: "src/api.ts", prs: [{ number: 1, title: "a" }, { number: 2, title: "b" }] },
      ],
    });

    const digest = formatBoardDigest(data);

    expect(digest).toContain("Potential conflicts:");
    expect(digest).toContain("src/api.ts — touched by PRs #1 and #2");
  });

  it("appends errors as notes when data is partially available", () => {
    const data = makeBoardData({
      items: [{ issue: makeIssue() }],
      errors: ["GitHub: using cached data (fetch failed)"],
    });

    const digest = formatBoardDigest(data);

    expect(digest).toContain("Note: GitHub: using cached data (fetch failed)");
    expect(digest).not.toContain("Board could not load");
  });

  it("returns minimal header for empty board", () => {
    const data = makeBoardData();

    const digest = formatBoardDigest(data);

    expect(digest).toBe("Here's your board.");
  });
});

import { describe, it, expect } from "vitest";
import { linkIssuesToPRs } from "../linker.js";
import { makeIssue, makePR } from "./fixtures.js";

describe("linkIssuesToPRs", () => {
  it("links PR to issue via branch name", () => {
    const issues = [makeIssue({ identifier: "ENG-100" })];
    const prs = [makePR({ branch: "james/eng-100-fix-bug" })];

    const result = linkIssuesToPRs(issues, prs);

    expect(result).toHaveLength(1);
    expect(result[0].issue?.identifier).toBe("ENG-100");
    expect(result[0].pr?.number).toBe(100);
  });

  it("links PR to issue via title mention", () => {
    const issues = [makeIssue({ identifier: "ENG-200" })];
    const prs = [makePR({ branch: "feature/unrelated", title: "[ENG-200] Add feature" })];

    const result = linkIssuesToPRs(issues, prs);

    expect(result).toHaveLength(1);
    expect(result[0].issue?.identifier).toBe("ENG-200");
    expect(result[0].pr?.number).toBe(100);
  });

  it("leaves unlinked issues as issue-only items", () => {
    const issues = [makeIssue({ identifier: "ENG-300" })];
    const prs = [makePR({ branch: "feature/something-else", title: "unrelated" })];

    const result = linkIssuesToPRs(issues, prs);

    expect(result).toHaveLength(2);
    const issueOnly = result.find((r) => r.issue && !r.pr);
    const prOnly = result.find((r) => r.pr && !r.issue);
    expect(issueOnly?.issue?.identifier).toBe("ENG-300");
    expect(prOnly?.pr?.number).toBe(100);
  });

  it("leaves unlinked PRs as pr-only items", () => {
    const issues: ReturnType<typeof makeIssue>[] = [];
    const prs = [makePR()];

    const result = linkIssuesToPRs(issues, prs);

    expect(result).toHaveLength(1);
    expect(result[0].pr?.number).toBe(100);
    expect(result[0].issue).toBeUndefined();
  });

  it("picks most recently updated PR when multiple match", () => {
    const issues = [makeIssue({ identifier: "ENG-400" })];
    const prs = [
      makePR({ number: 1, branch: "james/eng-400-v1", updatedAt: "2024-01-01T00:00:00Z" }),
      makePR({ number: 2, branch: "james/eng-400-v2", updatedAt: "2024-06-01T00:00:00Z" }),
    ];

    const result = linkIssuesToPRs(issues, prs);

    const linked = result.find((r) => r.issue && r.pr);
    expect(linked?.pr?.number).toBe(2);
    // The older PR should appear as unlinked
    const unlinked = result.find((r) => r.pr && !r.issue);
    expect(unlinked?.pr?.number).toBe(1);
  });

  it("handles empty inputs", () => {
    expect(linkIssuesToPRs([], [])).toEqual([]);
  });

  it("is case-insensitive for branch matching", () => {
    const issues = [makeIssue({ identifier: "ENG-500" })];
    const prs = [makePR({ branch: "James/ENG-500-Fix" })];

    const result = linkIssuesToPRs(issues, prs);

    expect(result).toHaveLength(1);
    expect(result[0].issue).toBeDefined();
    expect(result[0].pr).toBeDefined();
  });

  it("does not match partial identifiers", () => {
    const issues = [makeIssue({ identifier: "ENG-10" })];
    const prs = [makePR({ branch: "james/eng-100-fix" })];

    const result = linkIssuesToPRs(issues, prs);

    expect(result).toHaveLength(2);
    expect(result.find((r) => r.issue && r.pr)).toBeUndefined();
  });

  it("sets linkedIssue on matched PRs", () => {
    const issues = [makeIssue({ identifier: "ENG-600" })];
    const prs = [makePR({ branch: "james/eng-600-work" })];

    linkIssuesToPRs(issues, prs);

    expect(prs[0].linkedIssue).toBe("ENG-600");
  });
});

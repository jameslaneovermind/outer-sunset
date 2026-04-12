import type { App } from "@modelcontextprotocol/ext-apps";
import { useApp, useHostStyles } from "@modelcontextprotocol/ext-apps/react";
import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

// ── Types ──────────────────────────────────────────────────────────────────

interface Reviewer {
  login: string;
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "PENDING" | "DISMISSED";
  submittedAt?: string;
}

interface GitHubPR {
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
  linkedIssue?: string;
}

interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  status: string;
  assignee: string | null;
  priority: number;
  createdAt: string;
  updatedAt: string;
  url: string;
}

interface LinkedItem {
  issue?: LinearIssue;
  pr?: GitHubPR;
}

interface AttentionItem {
  type: string;
  title: string;
  subtitle: string;
  url: string;
  severity: "high" | "medium" | "low";
  prNumber?: number;
  issueId?: string;
}

interface BoardStats {
  openPRs: number;
  inProgressIssues: number;
  mergedThisWeek: number;
  avgPRAgeDays: number | null;
}

interface FileConflict {
  file: string;
  prs: { number: number; title: string }[];
}

interface LifecycleEvent {
  type: string;
  message: string;
  prNumber: number;
  url: string;
}

interface BoardData {
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

interface PRDetailData {
  body: string | null;
  changedFiles: number;
  mergeable: boolean | null;
  checks: { name: string; status: string; conclusion: string | null; durationSeconds: number | null }[];
  files: { path: string; status: string; additions: number; deletions: number }[];
}

interface IssueDetailData {
  description: string | null;
  labels: string[];
  comments: { author: string; body: string; createdAt: string }[];
  estimate: number | null;
  parentTitle: string | null;
  cycleName: string | null;
}

// ── Beach palette ──────────────────────────────────────────────────────────

const BRAND = {
  coral: "#e05c3a",
  coralLight: "#f08c6e",
  coralFaded: "rgba(224,92,58,0.07)",
  ocean: "#1e7cad",
  oceanLight: "#5ea8cc",
  oceanFaded: "rgba(30,124,173,0.07)",
  seafoam: "#2d9e8f",
  seafoamLight: "#5dc0b3",
  sand: "#c4a265",
  sandLight: "#dcc899",
  sandFaded: "rgba(196,162,101,0.08)",
  driftwood: "#8a7e72",
  navy: "#1a3349",
  sky: "#7ab8db",
};

// ── Theme ──────────────────────────────────────────────────────────────────

const FALLBACK = {
  "--color-background-primary": "transparent",
  "--color-background-secondary": "rgba(0,0,0,0.025)",
  "--color-background-tertiary": "rgba(0,0,0,0.04)",
  "--color-background-danger": "rgba(239,68,68,0.06)",
  "--color-background-warning": "rgba(234,179,8,0.06)",
  "--color-background-success": "rgba(34,197,94,0.06)",
  "--color-text-primary": "#111111",
  "--color-text-secondary": "#555555",
  "--color-text-tertiary": "#888888",
  "--color-text-danger": "#c0452a",
  "--color-text-warning": "#a68a3a",
  "--color-text-success": "#257a6e",
  "--color-border-primary": "#e5e5e5",
  "--color-border-secondary": "#f0f0f0",
  "--color-border-danger": "rgba(239,68,68,0.2)",
  "--font-sans": "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  "--font-mono": "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, monospace",
  "--border-radius-sm": "6px",
  "--border-radius-md": "8px",
} as const;

type ThemeKey = keyof typeof FALLBACK;

function useTheme() {
  const hostStyles = useHostStyles();
  return useMemo(() => {
    const get = (key: ThemeKey): string =>
      (hostStyles as Record<string, string | undefined>)?.[key] ?? FALLBACK[key];
    return { get };
  }, [hostStyles]);
}

// ── Helpers ────────────────────────────────────────────────────────────────

const ONE_DAY = 24 * 60 * 60 * 1000;

function relativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function ageDays(dateStr: string): number {
  return (Date.now() - new Date(dateStr).getTime()) / ONE_DAY;
}

function ageBorderColor(item: LinkedItem): string {
  const refDate = item.pr?.createdAt ?? item.issue?.updatedAt;
  if (!refDate) return "#e0e0e0";
  const days = ageDays(refDate);
  if (days > 5) return BRAND.coral;
  if (days > 2) return BRAND.sand;
  return "#e0e0e0";
}

function isBot(login: string): boolean {
  return login.endsWith("[bot]") || login.endsWith("-bot") || login === "dependabot";
}

function lastMeaningfulEvent(item: LinkedItem): string {
  const pr = item.pr;
  if (pr) {
    const humanReviews = pr.reviewers
      .filter((r) => !isBot(r.login) && r.submittedAt)
      .sort((a, b) => new Date(b.submittedAt!).getTime() - new Date(a.submittedAt!).getTime());

    if (humanReviews.length > 0) {
      const latest = humanReviews[0];
      const action =
        latest.state === "APPROVED" ? "approved" :
        latest.state === "CHANGES_REQUESTED" ? "requested changes" :
        "commented";
      return `@${latest.login} ${action} ${relativeTime(latest.submittedAt!)}`;
    }

    const opened = `opened ${relativeTime(pr.createdAt)}`;

    if (pr.checksStatus === "failing") return `CI failing · ${opened}`;
    if (pr.checksStatus === "passing" && pr.reviewers.some((r) => r.state === "PENDING" && !isBot(r.login))) {
      return `waiting for review · ${opened}`;
    }
    if (pr.checksStatus === "passing") return `CI passed · ${opened}`;

    if (pr.reviewers.length > 0 && pr.reviewers.every((r) => isBot(r.login))) {
      return `no human reviews · ${opened}`;
    }
    if (pr.reviewers.length === 0 && ageDays(pr.createdAt) > 0.5) {
      return `no reviewers assigned · ${opened}`;
    }

    return opened;
  }

  if (item.issue) {
    return `updated ${relativeTime(item.issue.updatedAt)}`;
  }

  return "";
}

function statusGroup(status: string): string {
  const s = status.toLowerCase();
  if (s === "in progress" || s === "started") return "In Progress";
  if (s === "todo" || s === "unstarted") return "Todo";
  if (s === "done" || s === "completed") return "Done";
  if (s === "backlog" || s === "triage") return "Backlog";
  return status;
}

function boardColumn(item: LinkedItem): string {
  if (item.pr) {
    if (item.pr.state === "merged") return "Merged";
    if (item.pr.state === "open") {
      return item.pr.reviewers.length > 0 ? "In Review" : "PR Open";
    }
  }
  if (item.issue) {
    const group = statusGroup(item.issue.status);
    if (group === "In Progress") return "In Progress";
    if (group === "Todo" || group === "Backlog") return "Todo";
    if (group === "Done") return "Merged";
  }
  return "Other";
}

const COLUMN_ORDER: Record<string, number> = {
  "In Progress": 0, "PR Open": 1, "In Review": 2, Todo: 3, Backlog: 4, Merged: 5, Other: 6,
};

function reviewerIcon(state: Reviewer["state"]): string {
  switch (state) {
    case "APPROVED": return "\u2713";
    case "CHANGES_REQUESTED": return "\u2717";
    case "PENDING": return "\u23F3";
    case "COMMENTED": return "\u{1F4AC}";
    case "DISMISSED": return "\u2014";
    default: return "?";
  }
}

function reviewerColor(state: Reviewer["state"]): string {
  switch (state) {
    case "APPROVED": return BRAND.seafoam;
    case "CHANGES_REQUESTED": return BRAND.coral;
    case "PENDING": return BRAND.sand;
    default: return BRAND.driftwood;
  }
}

function checksColor(status: GitHubPR["checksStatus"]): string {
  switch (status) {
    case "passing": return BRAND.seafoam;
    case "failing": return BRAND.coral;
    case "pending": return BRAND.sand;
    default: return BRAND.driftwood;
  }
}

let fallbackKeyCounter = 0;
function itemKey(item: LinkedItem): string {
  if (item.issue && item.pr) return `${item.issue.id}:${item.pr.number}`;
  if (item.issue) return item.issue.id;
  if (item.pr) return `pr:${item.pr.number}`;
  return `unknown:${++fallbackKeyCounter}`;
}

// ── SVG Icons ──────────────────────────────────────────────────────────────

function PalmIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0 }}>
      <path d="M12.5 22C12.3 19 12 16.5 12 14" stroke={BRAND.driftwood} strokeWidth="2" strokeLinecap="round" />
      <path d="M12 14Q7 11 3 12.5Q5.5 8.5 12 11Z" fill={BRAND.seafoam} />
      <path d="M12 14Q8 8 5 5Q9 5.5 12 10Z" fill={BRAND.seafoam} opacity="0.85" />
      <path d="M12 14Q16 8 19 5Q15 5.5 12 10Z" fill={BRAND.ocean} opacity="0.85" />
      <path d="M12 14Q17 11 21 12.5Q18.5 8.5 12 11Z" fill={BRAND.ocean} />
      <circle cx="19" cy="4" r="2" fill={BRAND.coral} opacity="0.6" />
    </svg>
  );
}

function CheckCircle({ color }: { color: string }) {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" style={{ flexShrink: 0 }}>
      <circle cx="5" cy="5" r="4" stroke={color} strokeWidth="1.2" />
      <path d="M3.2 5.2L4.5 6.5L7 3.8" stroke={color} strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function XCircle({ color }: { color: string }) {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" style={{ flexShrink: 0 }}>
      <circle cx="5" cy="5" r="4" stroke={color} strokeWidth="1.2" />
      <path d="M3.5 3.5L6.5 6.5M6.5 3.5L3.5 6.5" stroke={color} strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

function Spinner({ color }: { color: string }) {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" style={{ flexShrink: 0 }}>
      <circle cx="5" cy="5" r="4" stroke={color} strokeWidth="1.2" strokeDasharray="12 8" opacity="0.6" />
    </svg>
  );
}

function CIBadge({ status }: { status: GitHubPR["checksStatus"] }) {
  const color = checksColor(status);
  if (status === "passing") return <CheckCircle color={color} />;
  if (status === "failing") return <XCircle color={color} />;
  if (status === "pending") return <Spinner color={color} />;
  return null;
}

function ReviewerBadge({ state }: { state: Reviewer["state"] }) {
  const color = reviewerColor(state);
  if (state === "APPROVED") return <CheckCircle color={color} />;
  if (state === "CHANGES_REQUESTED") return <XCircle color={color} />;
  return <span style={{ color, fontSize: "10px", lineHeight: 1 }}>{reviewerIcon(state)}</span>;
}

// ── Components ─────────────────────────────────────────────────────────────

function ErrorBanner({ messages }: { messages: string[] }) {
  const t = useTheme();
  return (
    <div
      style={{
        padding: "10px 12px",
        background: t.get("--color-background-danger"),
        border: `1px solid ${t.get("--color-border-danger")}`,
        borderRadius: t.get("--border-radius-md"),
        color: t.get("--color-text-danger"),
        fontSize: "12px",
        lineHeight: 1.6,
        marginBottom: "12px",
      }}
    >
      {messages.map((msg, i) => (
        <div key={i}>{msg}</div>
      ))}
    </div>
  );
}

function EmptyState() {
  const t = useTheme();
  return (
    <div style={{ padding: "32px 16px", textAlign: "center", color: t.get("--color-text-tertiary") }}>
      <div style={{ fontSize: "20px", marginBottom: "8px" }}>🌅</div>
      <div style={{ fontSize: "13px", marginBottom: "4px", color: t.get("--color-text-secondary") }}>No data found</div>
      <div style={{ fontSize: "12px" }}>
        Set LINEAR_API_TOKEN and/or GITHUB_TOKEN in your MCP server config.
      </div>
    </div>
  );
}

function LoadingSkeleton() {
  const t = useTheme();
  return (
    <div style={{ padding: "16px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "16px" }}>
        <div style={{ width: "18px", height: "18px", borderRadius: "50%", background: BRAND.oceanFaded }} />
        <div style={{ width: "120px", height: "16px", borderRadius: "4px", background: t.get("--color-background-tertiary") }} />
      </div>
      {[1, 2, 3].map((i) => (
        <div
          key={i}
          style={{
            height: "60px",
            background: t.get("--color-background-secondary"),
            borderRadius: t.get("--border-radius-md"),
            marginBottom: "8px",
            animation: "pulse 1.5s ease-in-out infinite",
            animationDelay: `${i * 150}ms`,
          }}
        />
      ))}
      <style>{`@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
@keyframes cardUpdated { 0% { opacity: 0.6; } 100% { opacity: 1; } }`}</style>
    </div>
  );
}

function AttentionSection({ items, linkedItems, app, onRefresh, suggestedReviewers, changedKeys }: {
  items: AttentionItem[];
  linkedItems: LinkedItem[];
  app: App;
  onRefresh: () => void;
  suggestedReviewers: string[];
  changedKeys: Set<string>;
}) {
  const t = useTheme();
  const [collapsed, setCollapsed] = useState(false);

  const resolvedItems = useMemo(() => {
    return items.map((attn) => {
      const prMatch = attn.title.match(/PR #(\d+)/);
      const issueMatch = attn.title.match(/^([A-Z]+-\d+)/);

      let linked: LinkedItem | null = null;
      if (prMatch) {
        const prNum = parseInt(prMatch[1], 10);
        linked = linkedItems.find((li) => li.pr?.number === prNum) ?? null;
      }
      if (!linked && issueMatch) {
        linked = linkedItems.find((li) => li.issue?.identifier === issueMatch[1]) ?? null;
      }
      return { attn, linked };
    });
  }, [items, linkedItems]);

  if (items.length === 0) {
    return (
      <div
        style={{
          padding: "8px 12px",
          background: t.get("--color-background-success"),
          borderRadius: t.get("--border-radius-md"),
          fontSize: "12px",
          color: t.get("--color-text-success"),
          marginBottom: "14px",
          display: "flex",
          alignItems: "center",
          gap: "6px",
        }}
      >
        <CheckCircle color={t.get("--color-text-success")} />
        All clear — nothing needs attention
      </div>
    );
  }

  return (
    <div style={{ marginBottom: "14px" }}>
      <div
        onClick={() => setCollapsed(!collapsed)}
        style={{
          display: "flex", alignItems: "center", gap: "6px",
          cursor: "pointer", padding: "6px 0", fontSize: "12px",
          fontWeight: 600, color: t.get("--color-text-secondary"),
          userSelect: "none", letterSpacing: "0.01em",
        }}
      >
        <span style={{ width: "6px", height: "6px", borderRadius: "50%", background: BRAND.coral, flexShrink: 0 }} />
        Needs attention
        <span style={{ fontWeight: 400, color: t.get("--color-text-tertiary") }}>({items.length})</span>
        <span style={{ fontSize: "8px", marginLeft: "auto", color: t.get("--color-text-tertiary") }}>{collapsed ? "\u25B6" : "\u25BC"}</span>
      </div>
      {!collapsed &&
        resolvedItems.map(({ attn, linked }, i) =>
          linked ? (
            <LinkedCard
              key={itemKey(linked)}
              item={linked}
              app={app}
              onRefresh={onRefresh}
              suggestedReviewers={suggestedReviewers}
              changed={changedKeys.has(linked.pr ? `pr:${linked.pr.number}` : linked.issue ? `issue:${linked.issue.id}` : "")}
            />
          ) : (
            <FallbackAttentionCard key={i} item={attn} />
          ),
        )}
    </div>
  );
}

function FallbackAttentionCard({ item }: { item: AttentionItem }) {
  const t = useTheme();
  const severityColor = { high: BRAND.coral, medium: BRAND.sand, low: BRAND.driftwood };
  const idMatch = item.title.match(/^((?:PR #\d+|[A-Z]+-\d+))\s*—\s*(.*)/);
  const idText = idMatch ? idMatch[1] : null;
  const descText = idMatch ? idMatch[2] : item.title;

  return (
    <div
      style={{
        padding: "8px 10px",
        borderLeft: `3px solid ${severityColor[item.severity]}`,
        background: t.get("--color-background-secondary"),
        borderRadius: `0 ${t.get("--border-radius-sm")} ${t.get("--border-radius-sm")} 0`,
        marginBottom: "4px", fontSize: "12px",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "6px", minWidth: 0 }}>
        {idText && (
          <a
            href={item.url} target="_blank" rel="noopener noreferrer"
            style={{
              fontFamily: t.get("--font-mono"), fontSize: "11px",
              color: BRAND.ocean, textDecoration: "none",
              flexShrink: 0, fontWeight: 500,
              borderBottom: `1px dotted ${BRAND.oceanLight}`,
            }}
          >
            {idText}
          </a>
        )}
        <span style={{ color: t.get("--color-text-primary"), fontWeight: 450, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {descText}
        </span>
      </div>
      <div style={{ color: t.get("--color-text-tertiary"), fontSize: "11px", marginTop: "2px" }}>
        {item.subtitle}
      </div>
    </div>
  );
}

function ClickableId({ text, url, mono, t }: { text: string; url: string; mono: boolean; t: ReturnType<typeof useTheme> }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      style={{
        fontFamily: mono ? t.get("--font-mono") : "inherit",
        fontSize: "11px", color: BRAND.ocean, textDecoration: "none",
        flexShrink: 0, fontWeight: 500, cursor: "pointer",
        borderBottom: `1px dotted ${BRAND.oceanLight}`,
      }}
    >
      {text}
    </a>
  );
}

function LinkedCard({ item, app, onRefresh, suggestedReviewers, changed }: {
  item: LinkedItem;
  app: App;
  onRefresh: () => void;
  suggestedReviewers: string[];
  changed?: boolean;
}) {
  const t = useTheme();
  const [expanded, setExpanded] = useState(false);
  const [prDetail, setPrDetail] = useState<PRDetailData | null>(null);
  const [issueDetail, setIssueDetail] = useState<IssueDetailData | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const issue = item.issue;
  const pr = item.pr;
  const title = issue?.title ?? pr?.title ?? "Unknown";
  const identifier = issue?.identifier ?? (pr ? `PR #${pr.number}` : "");
  const identifierUrl = issue?.url ?? pr?.url ?? "#";

  const borderColor = ageBorderColor(item);
  const event = lastMeaningfulEvent(item);

  const humanReviewers = pr?.reviewers.filter((r) => !isBot(r.login)) ?? [];
  const botReviewers = pr?.reviewers.filter((r) => isBot(r.login)) ?? [];
  const hasOnlyBots = pr && botReviewers.length > 0 && humanReviewers.length === 0;
  const needsReviewers = pr && pr.state === "open" && (pr.reviewers.length === 0 || hasOnlyBots);

  const borderStyle: React.CSSProperties = expanded
    ? { borderLeft: "3px solid", borderImage: `linear-gradient(to bottom, ${borderColor} 0%, ${borderColor}22 100%) 1` }
    : { borderLeft: `3px solid ${borderColor}` };

  const handleExpand = useCallback(async () => {
    const willExpand = !expanded;
    setExpanded(willExpand);
    if (!willExpand || detailLoading) return;

    if (pr && !prDetail) {
      setDetailLoading(true);
      try {
        const [owner, repo] = (pr as unknown as { repoFullName?: string }).repoFullName?.split("/") ??
          pr.url.replace("https://github.com/", "").split("/").slice(0, 2);
        const result = await app.callServerTool({
          name: "get_pr_details",
          arguments: { owner, repo, number: pr.number },
        });
        const d = result.structuredContent as unknown as PRDetailData;
        if (d) setPrDetail(d);
      } catch { /* fall through to basic view */ }
      setDetailLoading(false);
    }

    if (issue && !issueDetail) {
      setDetailLoading(true);
      try {
        const result = await app.callServerTool({
          name: "get_issue_details",
          arguments: { identifier: issue.identifier },
        });
        const d = result.structuredContent as unknown as IssueDetailData;
        if (d) setIssueDetail(d);
      } catch { /* fall through */ }
      setDetailLoading(false);
    }
  }, [expanded, pr, issue, prDetail, issueDetail, detailLoading, app]);

  const handleRequestReview = useCallback(async (e: React.MouseEvent, reviewers: string[]) => {
    e.stopPropagation();
    if (!pr || reviewers.length === 0) return;
    setActionLoading("review");
    try {
      const [owner, repo] = pr.url.replace("https://github.com/", "").split("/").slice(0, 2);
      await app.callServerTool({
        name: "request_review",
        arguments: { owner, repo, pr_number: pr.number, reviewers },
      });
      onRefresh();
    } catch { /* ignore */ }
    setActionLoading(null);
  }, [pr, app, onRefresh]);

  const linkStyle = { color: BRAND.ocean, textDecoration: "none" as const, fontSize: "11px", fontWeight: 500 as const, cursor: "pointer" as const };

  return (
    <div
      style={{
        padding: "8px 10px", ...borderStyle,
        background: changed ? BRAND.oceanFaded : t.get("--color-background-secondary"),
        borderRadius: `0 ${t.get("--border-radius-sm")} ${t.get("--border-radius-sm")} 0`,
        marginBottom: "4px", cursor: "pointer",
        transition: "background 0.8s ease",
        animation: changed ? "cardUpdated 0.6s ease" : undefined,
      }}
      onClick={handleExpand}
    >
      {/* Main row */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "6px", minWidth: 0 }}>
          <ClickableId text={identifier} url={identifierUrl} mono t={t} />
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: t.get("--color-text-primary"), fontWeight: 450 }}>
            {title}
          </span>
          {issue && pr && <ClickableId text={`PR #${pr.number}`} url={pr.url} mono t={t} />}
        </div>
        {issue && issue.priority > 0 && issue.priority <= 2 && (
          <span style={{ fontSize: "10px", flexShrink: 0, fontWeight: 600, color: issue.priority === 1 ? BRAND.coral : BRAND.sand }}>
            {issue.priority === 1 ? "Urgent" : "High"}
          </span>
        )}
      </div>

      {/* PR info row */}
      {pr && (
        <div style={{ fontSize: "11px", color: t.get("--color-text-tertiary"), marginTop: "4px", display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
          {humanReviewers.length > 0 && (
            <span style={{ display: "flex", gap: "6px", alignItems: "center" }}>
              {humanReviewers.map((r) => (
                <span key={r.login} style={{ display: "inline-flex", alignItems: "center", gap: "3px" }}>
                  <ReviewerBadge state={r.state} />
                  <span>@{r.login}</span>
                </span>
              ))}
            </span>
          )}
          {hasOnlyBots && <span style={{ fontStyle: "italic", color: BRAND.sand }}>no human reviews</span>}
          {pr.reviewers.length === 0 && <span style={{ fontStyle: "italic" }}>no reviewers</span>}
          {pr.checksStatus !== "unknown" && (
            <span style={{ display: "inline-flex", alignItems: "center", gap: "3px" }}>
              <CIBadge status={pr.checksStatus} />
              <span>CI</span>
            </span>
          )}
        </div>
      )}

      {/* Event row */}
      <div style={{ fontSize: "11px", color: t.get("--color-text-tertiary"), marginTop: "3px", display: "flex", gap: "8px", alignItems: "center" }}>
        {issue?.assignee && <span>@{issue.assignee}</span>}
        {event && <span>{event}</span>}
        {!pr && issue && <span style={{ fontStyle: "italic" }}>no PR</span>}
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div
          style={{
            marginTop: "8px", paddingTop: "8px",
            borderTop: `1px solid ${t.get("--color-border-secondary")}`,
            fontSize: "11px", color: t.get("--color-text-secondary"),
            display: "flex", flexDirection: "column", gap: "5px",
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {detailLoading && (
            <div style={{ color: t.get("--color-text-tertiary"), fontStyle: "italic" }}>Loading details...</div>
          )}

          {/* PR description */}
          {prDetail?.body && (
            <div style={{ color: t.get("--color-text-secondary"), lineHeight: 1.5, whiteSpace: "pre-wrap", maxHeight: "60px", overflow: "hidden" }}>
              {prDetail.body.slice(0, 200)}{prDetail.body.length > 200 ? "..." : ""}
            </div>
          )}

          {/* Diff + branch */}
          {pr && (
            <div style={{ fontFamily: t.get("--font-mono"), fontSize: "11px" }}>
              <span style={{ color: BRAND.seafoam }}>+{pr.additions}</span>
              {" "}
              <span style={{ color: BRAND.coral }}>-{pr.deletions}</span>
              {prDetail && <span style={{ color: t.get("--color-text-tertiary") }}> across {prDetail.changedFiles} files</span>}
              <span style={{ color: t.get("--color-text-tertiary") }}>{" · "}{pr.branch}</span>
            </div>
          )}

          {/* CI checks detail */}
          {prDetail && prDetail.checks.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", fontFamily: t.get("--font-mono"), fontSize: "10px" }}>
              {prDetail.checks.slice(0, 8).map((c) => (
                <span key={c.name} style={{ display: "inline-flex", alignItems: "center", gap: "3px" }}>
                  {c.conclusion === "success" ? <CheckCircle color={BRAND.seafoam} /> :
                   c.conclusion === "failure" ? <XCircle color={BRAND.coral} /> :
                   <Spinner color={BRAND.sand} />}
                  <span style={{ color: t.get("--color-text-tertiary") }}>
                    {c.name}{c.durationSeconds != null ? ` ${c.durationSeconds < 60 ? `${c.durationSeconds}s` : `${Math.round(c.durationSeconds / 60)}m`}` : ""}
                  </span>
                </span>
              ))}
              {prDetail.checks.length > 8 && (
                <span style={{ color: t.get("--color-text-tertiary") }}>+{prDetail.checks.length - 8} more</span>
              )}
            </div>
          )}

          {/* Changed files */}
          {prDetail && prDetail.files.length > 0 && (
            <div style={{ fontFamily: t.get("--font-mono"), fontSize: "10px", color: t.get("--color-text-tertiary") }}>
              {prDetail.files.slice(0, 5).map((f) => (
                <div key={f.path} style={{ display: "flex", gap: "6px" }}>
                  <span style={{ color: BRAND.seafoam }}>+{f.additions}</span>
                  <span style={{ color: BRAND.coral }}>-{f.deletions}</span>
                  <span>{f.path}</span>
                </div>
              ))}
              {prDetail.files.length > 5 && <div>...and {prDetail.files.length - 5} more files</div>}
            </div>
          )}

          {/* Issue description */}
          {issueDetail?.description && !pr && (
            <div style={{ color: t.get("--color-text-secondary"), lineHeight: 1.5, whiteSpace: "pre-wrap", maxHeight: "80px", overflow: "hidden" }}>
              {issueDetail.description.slice(0, 300)}{issueDetail.description.length > 300 ? "..." : ""}
            </div>
          )}

          {/* Issue labels */}
          {issueDetail && issueDetail.labels.length > 0 && (
            <div style={{ display: "flex", gap: "4px", flexWrap: "wrap" }}>
              {issueDetail.labels.map((l) => (
                <span key={l} style={{
                  fontSize: "9px", padding: "1px 5px", borderRadius: "3px",
                  background: t.get("--color-background-tertiary"), color: t.get("--color-text-secondary"),
                }}>{l}</span>
              ))}
            </div>
          )}

          {/* Reviewers with timestamps */}
          {pr && pr.reviewers.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
              {pr.reviewers.map((r) => (
                <span key={r.login} style={{ display: "inline-flex", alignItems: "center", gap: "3px" }}>
                  <ReviewerBadge state={r.state} />
                  <span>@{r.login}</span>
                  {r.submittedAt && <span style={{ color: t.get("--color-text-tertiary") }}>{relativeTime(r.submittedAt)}</span>}
                </span>
              ))}
            </div>
          )}

          {/* Review suggestion for no-reviewer PRs */}
          {needsReviewers && suggestedReviewers.length > 0 && (
            <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap", marginTop: "2px" }}>
              <span style={{ color: t.get("--color-text-tertiary"), fontSize: "10px" }}>suggest:</span>
              {suggestedReviewers.slice(0, 3).map((login) => (
                <span
                  key={login}
                  onClick={(e) => handleRequestReview(e, [login])}
                  style={{
                    ...linkStyle, fontSize: "10px", padding: "1px 6px",
                    borderRadius: "3px", background: BRAND.oceanFaded,
                    cursor: actionLoading === "review" ? "wait" : "pointer",
                  }}
                >
                  @{login}
                </span>
              ))}
            </div>
          )}

        </div>
      )}
    </div>
  );
}

function ColumnGroup({
  title,
  items,
  defaultCollapsed = false,
  color,
  maxVisible,
  app,
  onRefresh,
  suggestedReviewers,
  changedKeys,
}: {
  title: string;
  items: LinkedItem[];
  defaultCollapsed?: boolean;
  color: string;
  maxVisible?: number;
  app: App;
  onRefresh: () => void;
  suggestedReviewers: string[];
  changedKeys: Set<string>;
}) {
  const t = useTheme();
  const [collapsed, setCollapsed] = useState(defaultCollapsed);

  if (items.length === 0) return null;

  const visible = maxVisible && !collapsed ? items.slice(0, maxVisible) : collapsed ? [] : items;
  const hiddenCount = maxVisible ? Math.max(0, items.length - maxVisible) : 0;

  return (
    <div style={{ marginBottom: "14px" }}>
      <div
        onClick={() => setCollapsed(!collapsed)}
        style={{
          display: "flex", alignItems: "center", gap: "6px",
          cursor: "pointer", padding: "6px 0", fontSize: "12px",
          fontWeight: 600, color: t.get("--color-text-secondary"),
          userSelect: "none", letterSpacing: "0.01em",
        }}
      >
        <span style={{ width: "6px", height: "6px", borderRadius: "50%", background: color, flexShrink: 0 }} />
        {title}
        <span style={{ fontWeight: 400, color: t.get("--color-text-tertiary") }}>({items.length})</span>
        <span style={{ fontSize: "8px", marginLeft: "auto", color: t.get("--color-text-tertiary") }}>{collapsed ? "\u25B6" : "\u25BC"}</span>
      </div>
      {visible.map((item) => {
        const ck = item.pr ? `pr:${item.pr.number}` : item.issue ? `issue:${item.issue.id}` : "";
        return (
          <LinkedCard key={itemKey(item)} item={item} app={app} onRefresh={onRefresh} suggestedReviewers={suggestedReviewers} changed={changedKeys.has(ck)} />
        );
      })}
      {!collapsed && hiddenCount > 0 && (
        <div style={{ fontSize: "11px", color: t.get("--color-text-tertiary"), padding: "4px 12px", fontStyle: "italic" }}>
          and {hiddenCount} more
        </div>
      )}
    </div>
  );
}

function LifecycleSection({ events }: { events: LifecycleEvent[] }) {
  const t = useTheme();
  if (events.length === 0) return null;

  return (
    <div style={{ marginBottom: "14px" }}>
      {events.map((event, i) => (
        <div key={i} style={{
          padding: "6px 10px", marginBottom: "4px",
          background: event.type === "ready_to_merge" ? "rgba(45,158,143,0.08)" : BRAND.oceanFaded,
          border: `1px solid ${event.type === "ready_to_merge" ? "rgba(45,158,143,0.2)" : "rgba(30,124,173,0.15)"}`,
          borderRadius: t.get("--border-radius-sm"),
          fontSize: "11px", display: "flex", alignItems: "center", gap: "6px",
        }}>
          <span style={{ fontSize: "10px" }}>
            {event.type === "ready_to_merge" ? "🚀" : "ℹ️"}
          </span>
          <a
            href={event.url} target="_blank" rel="noopener noreferrer"
            style={{ color: event.type === "ready_to_merge" ? BRAND.seafoam : BRAND.ocean, textDecoration: "none", fontWeight: 500 }}
          >
            {event.message}
          </a>
        </div>
      ))}
    </div>
  );
}

function ConflictSection({ conflicts }: { conflicts: FileConflict[] }) {
  const t = useTheme();
  if (conflicts.length === 0) return null;

  return (
    <div style={{
      padding: "8px 10px", marginBottom: "14px",
      background: BRAND.sandFaded,
      border: `1px solid rgba(196,162,101,0.2)`,
      borderRadius: t.get("--border-radius-sm"),
      fontSize: "11px",
    }}>
      <div style={{ fontWeight: 600, color: BRAND.sand, marginBottom: "4px", display: "flex", alignItems: "center", gap: "4px" }}>
        <span style={{ fontSize: "10px" }}>⚠</span> Potential conflicts
      </div>
      {conflicts.slice(0, 3).map((c) => (
        <div key={c.file} style={{ color: t.get("--color-text-secondary"), marginTop: "2px" }}>
          <span style={{ fontFamily: t.get("--font-mono"), fontSize: "10px" }}>{c.file}</span>
          <span style={{ color: t.get("--color-text-tertiary") }}>
            {" — PRs "}
            {c.prs.map((p, i) => (
              <span key={p.number}>
                {i > 0 && " & "}#{p.number}
              </span>
            ))}
          </span>
        </div>
      ))}
    </div>
  );
}

function StatsBar({ stats }: { stats: BoardStats }) {
  const t = useTheme();

  const statItems: { label: string; value: string }[] = [
    { label: "open PRs", value: String(stats.openPRs) },
    { label: "in progress", value: String(stats.inProgressIssues) },
  ];
  if (stats.avgPRAgeDays != null) statItems.push({ label: "avg PR age", value: `${stats.avgPRAgeDays}d` });
  if (stats.mergedThisWeek > 0) statItems.push({ label: "merged this week", value: String(stats.mergedThisWeek) });

  return (
    <div
      style={{
        display: "flex", justifyContent: "center", gap: "16px",
        padding: "10px 0 8px",
        borderTop: `1px solid ${t.get("--color-border-secondary")}`,
        marginTop: "10px",
      }}
    >
      {statItems.map((s) => (
        <div key={s.label} style={{ textAlign: "center" }}>
          <div style={{ fontSize: "14px", fontWeight: 600, color: t.get("--color-text-primary"), fontFamily: t.get("--font-mono") }}>
            {s.value}
          </div>
          <div style={{ fontSize: "9px", color: t.get("--color-text-tertiary"), letterSpacing: "0.04em", textTransform: "uppercase" }}>
            {s.label}
          </div>
        </div>
      ))}
    </div>
  );
}

const SECTION_DOT = "#9ca3af";

const COLUMN_COLORS: Record<string, string> = {
  "In Progress": BRAND.ocean, "PR Open": SECTION_DOT, "In Review": SECTION_DOT,
  Todo: SECTION_DOT, Backlog: SECTION_DOT, Merged: BRAND.seafoam, Other: SECTION_DOT,
};

function snapshotBoard(data: BoardData): Map<string, string> {
  const snap = new Map<string, string>();
  for (const item of data.items) {
    const key = item.pr ? `pr:${item.pr.number}` : item.issue ? `issue:${item.issue.id}` : "";
    if (!key) continue;
    const sig = JSON.stringify({
      status: item.pr?.state ?? item.issue?.status,
      checksStatus: item.pr?.checksStatus,
      reviewers: item.pr?.reviewers.map((r) => `${r.login}:${r.state}`).sort(),
      updatedAt: item.pr?.updatedAt ?? item.issue?.updatedAt,
    });
    snap.set(key, sig);
  }
  return snap;
}

const AUTO_REFRESH_MS = 90_000;

function Board({ app }: { app: App }) {
  const t = useTheme();
  const [data, setData] = useState<BoardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [changedKeys, setChangedKeys] = useState<Set<string>>(new Set());
  const prevSnapshot = useRef<Map<string, string>>(new Map());

  const fetchData = useCallback(
    async (force = false) => {
      setLoading(true);
      try {
        const result = await app.callServerTool({
          name: "fetch_board_data",
          arguments: { force },
        });
        const boardData = result.structuredContent as unknown as BoardData;
        if (boardData) {
          const newSnap = snapshotBoard(boardData);
          if (prevSnapshot.current.size > 0) {
            const changed = new Set<string>();
            for (const [key, sig] of newSnap) {
              const prev = prevSnapshot.current.get(key);
              if (prev !== undefined && prev !== sig) changed.add(key);
              if (prev === undefined) changed.add(key);
            }
            if (changed.size > 0) {
              setChangedKeys(changed);
              setTimeout(() => setChangedKeys(new Set()), 8000);
            }
          }
          prevSnapshot.current = newSnap;
          setData(boardData);
        }
      } catch (err) {
        console.error("Failed to fetch board data:", err);
        setData({
          items: [], issues: [], prs: [], needsAttention: [],
          stats: { openPRs: 0, inProgressIssues: 0, mergedThisWeek: 0, avgPRAgeDays: null },
          conflicts: [], lifecycle: [],
          fetchedAt: new Date().toISOString(),
          errors: [`Failed to fetch data: ${err instanceof Error ? err.message : String(err)}`],
        });
      } finally {
        setLoading(false);
      }
    },
    [app],
  );

  useEffect(() => {
    app.ontoolresult = (result) => {
      const boardData = result.structuredContent as unknown as BoardData;
      if (boardData?.items) {
        const newSnap = snapshotBoard(boardData);
        prevSnapshot.current = newSnap;
        setData(boardData);
        setLoading(false);
      }
    };
    fetchData();
  }, [app, fetchData]);

  // Auto-refresh
  useEffect(() => {
    const interval = setInterval(() => {
      fetchData(true);
    }, AUTO_REFRESH_MS);
    return () => clearInterval(interval);
  }, [fetchData]);

  // Build set of PR numbers / issue IDs that are in "needs attention" for deduplication
  const attentionKeys = useMemo(() => {
    const keys = new Set<string>();
    if (!data?.needsAttention) return keys;
    for (const a of data.needsAttention) {
      const match = a.title.match(/PR #(\d+)/);
      if (match) keys.add(`pr:${match[1]}`);
      const issueMatch = a.title.match(/^([A-Z]+-\d+)/);
      if (issueMatch) keys.add(`issue:${issueMatch[1]}`);
    }
    return keys;
  }, [data?.needsAttention]);

  const grouped = useMemo(() => {
    if (!data?.items) return [];
    const groups = new Map<string, LinkedItem[]>();
    for (const item of data.items) {
      if (item.pr && attentionKeys.has(`pr:${item.pr.number}`)) continue;
      if (item.issue && !item.pr && attentionKeys.has(`issue:${item.issue.identifier}`)) continue;

      const col = boardColumn(item);
      if (!groups.has(col)) groups.set(col, []);
      groups.get(col)!.push(item);
    }
    return [...groups.entries()].sort(
      ([a], [b]) => (COLUMN_ORDER[a] ?? 99) - (COLUMN_ORDER[b] ?? 99),
    );
  }, [data?.items, attentionKeys]);

  const suggestedReviewers = useMemo(() => {
    if (!data?.prs) return [];
    const counts = new Map<string, number>();
    const recentMerged = data.prs.filter((p) => p.mergedAt);
    for (const pr of recentMerged) {
      for (const r of pr.reviewers) {
        if (isBot(r.login)) continue;
        if (r.login === pr.author) continue;
        counts.set(r.login, (counts.get(r.login) ?? 0) + 1);
      }
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([login]) => login);
  }, [data?.prs]);

  if (loading && !data) return <LoadingSkeleton />;

  const hasData = (data?.items?.length ?? 0) > 0;

  return (
    <div style={{ padding: "12px 16px 20px", width: "100%", boxSizing: "border-box", fontFamily: t.get("--font-sans") }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "4px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <PalmIcon />
          <span style={{ fontWeight: 700, fontSize: "16px", color: BRAND.navy, letterSpacing: "-0.02em" }}>
            outer-sunset
          </span>
        </div>
        <button
          onClick={() => fetchData(true)}
          disabled={loading}
          style={{
            background: "none",
            border: `1px solid ${t.get("--color-border-primary")}`,
            borderRadius: t.get("--border-radius-sm"),
            color: t.get("--color-text-tertiary"),
            fontSize: "11px", padding: "3px 10px",
            cursor: loading ? "wait" : "pointer",
            opacity: loading ? 0.5 : 1,
            fontFamily: t.get("--font-sans"), fontWeight: 500,
            transition: "all 0.15s",
          }}
        >
          {loading ? "..." : "Refresh"}
        </button>
      </div>

      {/* Accent line */}
      <div style={{
        height: "2px", borderRadius: "1px", marginBottom: "14px",
        background: `linear-gradient(90deg, ${BRAND.coral} 0%, ${BRAND.sand} 40%, ${BRAND.ocean} 70%, transparent 100%)`,
        width: "80px",
      }} />

      {/* Errors */}
      {data?.errors && data.errors.length > 0 && <ErrorBanner messages={data.errors} />}

      {/* Needs attention */}
      {data?.needsAttention && (
        <AttentionSection
          items={data.needsAttention}
          linkedItems={data.items}
          app={app}
          onRefresh={() => fetchData(true)}
          suggestedReviewers={suggestedReviewers}
          changedKeys={changedKeys}
        />
      )}

      {/* Empty state */}
      {!hasData && !data?.errors?.length && <EmptyState />}

      {/* Grouped items */}
      {grouped.map(([col, items]) => (
        <ColumnGroup
          key={col}
          title={col}
          items={items}
          defaultCollapsed={col === "Merged"}
          color={COLUMN_COLORS[col] ?? BRAND.driftwood}
          maxVisible={col === "Merged" ? 10 : undefined}
          app={app}
          onRefresh={() => fetchData(true)}
          suggestedReviewers={suggestedReviewers}
          changedKeys={changedKeys}
        />
      ))}

      {/* Stats */}
      {data?.stats && <StatsBar stats={data.stats} />}

      {/* Footer */}
      {data?.fetchedAt && (
        <div style={{ fontSize: "10px", color: t.get("--color-text-tertiary"), textAlign: "center", marginTop: "6px" }}>
          Last fetched {relativeTime(data.fetchedAt)}
        </div>
      )}
    </div>
  );
}

// ── App Root ───────────────────────────────────────────────────────────────

function AppRoot() {
  const { app, error } = useApp({
    appInfo: { name: "outer-sunset", version: "0.1.0" },
    capabilities: {},
  });

  if (error) {
    return <ErrorBanner messages={[`Connection error: ${error.message}`]} />;
  }

  if (!app) return <LoadingSkeleton />;

  return <Board app={app} />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppRoot />
  </StrictMode>,
);

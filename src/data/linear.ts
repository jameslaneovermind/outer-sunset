const LINEAR_API_URL = "https://api.linear.app/graphql";

export interface LinearIssue {
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

const ISSUES_QUERY = `
  query MyIssues($teamKey: String) {
    viewer {
      assignedIssues(
        filter: {
          team: { key: { eq: $teamKey } }
          state: { type: { nin: ["canceled"] } }
        }
        orderBy: updatedAt
        first: 50
      ) {
        nodes {
          id
          identifier
          title
          priority
          createdAt
          updatedAt
          url
          state {
            name
            type
          }
          assignee {
            displayName
          }
        }
      }
    }
  }
`;

const ISSUES_NO_TEAM_QUERY = `
  query MyIssues {
    viewer {
      assignedIssues(
        filter: {
          state: { type: { nin: ["canceled"] } }
        }
        orderBy: updatedAt
        first: 50
      ) {
        nodes {
          id
          identifier
          title
          priority
          createdAt
          updatedAt
          url
          state {
            name
            type
          }
          assignee {
            displayName
          }
        }
      }
    }
  }
`;

export interface LinearIssueDetail extends LinearIssue {
  description: string | null;
  labels: string[];
  comments: { author: string; body: string; createdAt: string }[];
  estimate: number | null;
  parentTitle: string | null;
  cycleName: string | null;
}

const ISSUE_DETAIL_QUERY = `
  query IssueDetail($identifier: String!) {
    issueSearch(
      filter: { identifier: { eq: $identifier } }
      first: 1
    ) {
      nodes {
        id
        identifier
        title
        description
        priority
        estimate
        createdAt
        updatedAt
        url
        state { name type }
        assignee { displayName }
        labels { nodes { name } }
        comments(first: 5, orderBy: createdAt) {
          nodes {
            body
            createdAt
            user { displayName }
          }
        }
        parent { title }
        cycle { name }
      }
    }
  }
`;

interface IssueDetailNode {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number;
  estimate: number | null;
  createdAt: string;
  updatedAt: string;
  url: string;
  state: { name: string; type: string };
  assignee: { displayName: string } | null;
  labels: { nodes: Array<{ name: string }> };
  comments: {
    nodes: Array<{
      body: string;
      createdAt: string;
      user: { displayName: string } | null;
    }>;
  };
  parent: { title: string } | null;
  cycle: { name: string } | null;
}

interface LinearGraphQLResponse {
  data?: {
    viewer: {
      assignedIssues: {
        nodes: Array<{
          id: string;
          identifier: string;
          title: string;
          priority: number;
          createdAt: string;
          updatedAt: string;
          url: string;
          state: { name: string; type: string };
          assignee: { displayName: string } | null;
        }>;
      };
    };
  };
  errors?: Array<{ message: string }>;
}

const FETCH_TIMEOUT_MS = 15_000;

export async function fetchLinearIssues(
  token: string,
  teamKey?: string,
): Promise<LinearIssue[]> {
  const query = teamKey ? ISSUES_QUERY : ISSUES_NO_TEAM_QUERY;
  const variables = teamKey ? { teamKey } : {};

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: token,
      },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error("Linear API timeout");
    }
    throw err;
  }
  clearTimeout(timer);

  if (res.status === 401 || res.status === 403) {
    throw new Error(
      `Linear authentication failed (${res.status}). Check your LINEAR_API_TOKEN.`,
    );
  }

  if (res.status === 429) {
    throw new Error("Linear rate limit reached. Try again in a few minutes.");
  }

  if (!res.ok) {
    throw new Error(`Linear API error: ${res.status} ${res.statusText}`);
  }

  const json = (await res.json()) as LinearGraphQLResponse;

  if (json.errors?.length) {
    throw new Error(`Linear GraphQL error: ${json.errors[0].message}`);
  }

  const nodes = json.data?.viewer.assignedIssues.nodes ?? [];

  return nodes.map((node) => ({
    id: node.id,
    identifier: node.identifier,
    title: node.title,
    status: node.state.name,
    assignee: node.assignee?.displayName ?? null,
    priority: node.priority,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    url: node.url,
  }));
}

async function linearGraphQL<T>(token: string, query: string, variables: Record<string, unknown>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: token },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error("Linear API timeout");
    }
    throw err;
  }
  clearTimeout(timer);

  if (!res.ok) {
    throw new Error(`Linear API error: ${res.status} ${res.statusText}`);
  }

  const json = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
  if (json.errors?.length) {
    throw new Error(`Linear GraphQL error: ${json.errors[0].message}`);
  }
  if (!json.data) {
    throw new Error("No data returned from Linear");
  }
  return json.data;
}

export async function fetchIssueDetail(
  token: string,
  identifier: string,
): Promise<LinearIssueDetail> {
  const data = await linearGraphQL<{ issueSearch: { nodes: IssueDetailNode[] } }>(
    token,
    ISSUE_DETAIL_QUERY,
    { identifier },
  );

  const node = data.issueSearch.nodes[0];
  if (!node) {
    throw new Error(`Issue ${identifier} not found`);
  }

  return {
    id: node.id,
    identifier: node.identifier,
    title: node.title,
    status: node.state.name,
    assignee: node.assignee?.displayName ?? null,
    priority: node.priority,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    url: node.url,
    description: node.description,
    labels: node.labels.nodes.map((l) => l.name),
    comments: node.comments.nodes.map((c) => ({
      author: c.user?.displayName ?? "Unknown",
      body: c.body,
      createdAt: c.createdAt,
    })),
    estimate: node.estimate,
    parentTitle: node.parent?.title ?? null,
    cycleName: node.cycle?.name ?? null,
  };
}

const FIND_STATE_QUERY = `
  query FindInProgressState($teamKey: String!) {
    teams(filter: { key: { eq: $teamKey } }) {
      nodes {
        states {
          nodes {
            id
            name
            type
          }
        }
      }
    }
  }
`;

const ASSIGN_AND_START_MUTATION = `
  mutation AssignAndStart($issueId: String!, $stateId: String!, $assigneeId: String!) {
    issueUpdate(id: $issueId, input: { stateId: $stateId, assigneeId: $assigneeId }) {
      success
      issue {
        id
        identifier
        title
        description
        url
        state { name }
        assignee { displayName }
      }
    }
  }
`;

const VIEWER_ID_QUERY = `
  query ViewerId {
    viewer { id }
  }
`;

export interface StartIssueResult {
  identifier: string;
  title: string;
  description: string | null;
  url: string;
  status: string;
  assignee: string | null;
}

export async function startLinearIssue(
  token: string,
  issueId: string,
  teamKey: string,
): Promise<StartIssueResult> {
  const [statesData, viewerData] = await Promise.all([
    linearGraphQL<{ teams: { nodes: Array<{ states: { nodes: Array<{ id: string; name: string; type: string }> } }> } }>(
      token, FIND_STATE_QUERY, { teamKey },
    ),
    linearGraphQL<{ viewer: { id: string } }>(
      token, VIEWER_ID_QUERY, {},
    ),
  ]);

  const team = statesData.teams.nodes[0];
  if (!team) throw new Error(`Team ${teamKey} not found`);

  const states = team.states.nodes;
  const inProgressState =
    states.find((s) => s.name.toLowerCase() === "in progress") ??
    states.find((s) => s.type === "started");
  if (!inProgressState) throw new Error("Could not find 'In Progress' state for this team");

  const result = await linearGraphQL<{
    issueUpdate: {
      success: boolean;
      issue: {
        id: string; identifier: string; title: string;
        description: string | null; url: string;
        state: { name: string };
        assignee: { displayName: string } | null;
      };
    };
  }>(token, ASSIGN_AND_START_MUTATION, {
    issueId,
    stateId: inProgressState.id,
    assigneeId: viewerData.viewer.id,
  });

  if (!result.issueUpdate.success) {
    throw new Error("Failed to update issue in Linear");
  }

  const issue = result.issueUpdate.issue;
  return {
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description,
    url: issue.url,
    status: issue.state.name,
    assignee: issue.assignee?.displayName ?? null,
  };
}

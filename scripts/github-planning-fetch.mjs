// GraphQL is a read-only query. No mutation or user-provided query is accepted.
const fail = () => { throw new Error('GitHubの計画情報を全件取得できませんでした。'); };
export const SPEC_LABEL = '仕様';
export function planningQuery(repositoryUrl, cursor = null) {
  const [owner, name] = repositoryUrl.slice(19).split('/');
  // GitHubはGraphQLのコストを、入れ子の接続の親の件数の積から数える。blockedByとprojectItemsの上限を下げると、
  // Issue 100件あたりのコストが73から33ポイントになる（実測）。上限を超えるIssueは不完全として更新を見送る。
  return `query { rateLimit { remaining resetAt } repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(name)}) {
    issues(first:100,after:${JSON.stringify(cursor)},states:[OPEN,CLOSED]) {
      totalCount pageInfo { hasNextPage endCursor }
      nodes { number url updatedAt parent { number url } subIssuesSummary { total }
        blockedBy(first:20) { totalCount pageInfo { hasNextPage }
          nodes { number url title state labels(first:50) { totalCount pageInfo { hasNextPage } nodes { name } } }
        }
        closedByPullRequestsReferences(first:20,includeClosedPrs:false) { totalCount pageInfo { hasNextPage } nodes { number url isDraft state } }
        projectItems(first:10) { totalCount pageInfo { hasNextPage }
          nodes { project { id title url }
            fieldValues(first:100) { totalCount pageInfo { hasNextPage }
              nodes { __typename
                ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2SingleSelectField { name } } }
                ... on ProjectV2ItemFieldNumberValue { number field { ... on ProjectV2Field { name } } }
                ... on ProjectV2ItemFieldIterationValue { iterationId title startDate duration field { ... on ProjectV2IterationField { name } } }
              }
            }
          }
        }
      }
    }
  } }`;
}
const connection = value => {
  if (!value || !Array.isArray(value.nodes) || value.nodes.some(v => !v) || !Number.isSafeInteger(value.totalCount) ||
      value.totalCount !== value.nodes.length || value.pageInfo?.hasNextPage !== false) fail();
  return value.nodes;
};
export function buildPlanning({ repositoryUrl, issuePages, milestonePages, hierarchyPages }) {
  const records = new Map(issuePages.flat().filter(i => !i.pull_request).map(i => [i.number, i]));
  if (!Array.isArray(milestonePages) || !milestonePages.length || milestonePages.some(p => !Array.isArray(p)) ||
    milestonePages.slice(0, -1).some(p => p.length !== 100) || milestonePages.at(-1).length >= 100 ||
    !Array.isArray(hierarchyPages) || !hierarchyPages.length) fail();
  let total = null;
  const nodes = [];
  hierarchyPages.forEach((response, index) => {
    const data = response?.data?.repository?.issues;
    if (response.errors?.length || !data || !Array.isArray(data.nodes) || data.nodes.some(n => !n) ||
      !Number.isSafeInteger(data.totalCount) || data.totalCount < 0 || data.nodes.length > 100) fail();
    if (total === null) total = data.totalCount;
    if (data.totalCount !== total || data.pageInfo?.hasNextPage !== (index < hierarchyPages.length - 1) ||
      (index < hierarchyPages.length - 1 && (data.nodes.length !== 100 || typeof data.pageInfo.endCursor !== 'string' || !data.pageInfo.endCursor))) fail();
    nodes.push(...data.nodes);
  });
  if (nodes.length !== total || nodes.length !== records.size || new Set(nodes.map(n => n.number)).size !== nodes.length) fail();
  const issues = nodes.map(n => {
    const record = records.get(n.number);
    if (!record || n.url.toLowerCase() !== record.html_url.toLowerCase() || Date.parse(n.updatedAt) !== Date.parse(record.updated_at)) fail();
    const projects = connection(n.projectItems).map(item => {
      if (!item.project) fail();
      const p = { ...item.project, owner: null, status: null, priority: null, estimatePoints: null, iteration: null };
      const seen = new Set();
      for (const value of connection(item.fieldValues)) {
        const field = value.field?.name;
        if (!['担当', 'Status', '優先度', 'Estimate', 'Iteration'].includes(field)) continue;
        if (seen.has(field)) fail();
        seen.add(field);
        if (field === '担当' || field === 'Status' || field === '優先度') {
          if (value.__typename !== 'ProjectV2ItemFieldSingleSelectValue') fail();
          p[{ 担当: 'owner', Status: 'status', 優先度: 'priority' }[field]] = value.name;
        } else if (field === 'Estimate') {
          if (value.__typename !== 'ProjectV2ItemFieldNumberValue') fail();
          p.estimatePoints = value.number;
        } else {
          if (value.__typename !== 'ProjectV2ItemFieldIterationValue') fail();
          p.iteration = { id: value.iterationId, title: value.title, startDate: value.startDate, duration: value.duration };
        }
      }
      return p;
    });
    let moduleLabels;
    if (record.labels !== undefined) {
      if (!Array.isArray(record.labels) || record.labels.some(label => !label || typeof label.name !== 'string')) fail();
      moduleLabels = record.labels.map(label => label.name).filter(name => /^module:/i.test(name));
    }
    // 前提（blocked by）は別のrepositoryのIssueでもよい。仕様の決定を待つIssueは `仕様` ラベルで示す。
    const blockedBy = connection(n.blockedBy).map(b => {
      if (!['OPEN', 'CLOSED'].includes(b.state)) fail();
      return { number: b.number, url: b.url, title: b.title, state: b.state.toLowerCase(), spec: connection(b.labels).some(label => label.name === SPEC_LABEL) };
    });
    const pullRequests = connection(n.closedByPullRequestsReferences).filter(pr => pr.state === 'OPEN').map(pr => ({ number: pr.number, url: pr.url, draft: pr.isDraft === true }));
    const labelNames = Array.isArray(record.labels) ? record.labels.map(label => label.name) : [];
    return { ...(moduleLabels === undefined ? {} : { moduleLabels }), number: n.number, parent: n.parent, childCount: n.subIssuesSummary?.total,
      milestoneNumber: record.milestone?.number ?? null, projects, blockedBy, pullRequests, spec: labelNames.includes(SPEC_LABEL) };
  });
  return { sources: {
    hierarchy: { complete: true, url: 'https://api.github.com/graphql' },
    milestones: { complete: true, urls: milestonePages.map((_, i) => `https://api.github.com/repos/${repositoryUrl.slice(19)}/milestones?state=all&per_page=100&sort=due_on&direction=asc&page=${i + 1}`) },
  }, issues, milestones: milestonePages.flat().map(m => ({
    number: m.number, url: m.html_url, title: m.title, description: m.description, state: m.state,
    dueOn: m.due_on, updatedAt: m.updated_at, closedAt: m.closed_at,
  })) };
}

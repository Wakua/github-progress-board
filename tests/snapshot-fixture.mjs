// Fabricated data for tests only; never loaded into the normal application.
export function fixture(repo = 'https://github.com/qa-fixture/alpha', fetchedAt = '2026-10-02T12:00:00Z') {
  return { schemaVersion: 1, source: 'github', repositoryUrl: repo, fetchedAt,
    sources: { issues: { complete: true, urls: [`https://api.github.com/repos/${repo.slice(19)}/issues?state=all&per_page=100&sort=updated&direction=desc&page=1`] }, pullRequests: { complete: true, urls: [`https://api.github.com/repos/${repo.slice(19)}/pulls?state=all&per_page=100&sort=updated&direction=desc&page=1`] } },
    items: [{ kind: 'issue', number: 7, url: `${repo}/issues/7`, title: 'QA Issue', state: 'open', updatedAt: '2026-10-01T12:00:00Z', closedAt: null, estimatePoints: null, deadline: null },
      { kind: 'pull_request', number: 8, url: `${repo}/pull/8`, title: 'QA PR', state: 'closed', updatedAt: '2026-10-01T12:00:00Z', closedAt: '2026-10-01T11:00:00Z', draft: false, mergedAt: '2026-10-01T11:00:00Z', estimatePoints: null, deadline: null }] };
}

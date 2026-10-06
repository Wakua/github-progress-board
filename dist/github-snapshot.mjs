import { validatePlanning } from './github-planning.mjs';
// GitHub facts are separate from manual plans. No status maps to task completion.
export const SNAPSHOT_VERSION = 1;
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
const fail = message => { throw new Error(message); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, required, optional = []) => {
  if (!object(value) || required.some(key => !Object.hasOwn(value, key)) ||
      Object.keys(value).some(key => ![...required, ...optional].includes(key))) fail('snapshotの項目・形式が未対応です。');
};
const timestamp = (value, label) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(value) ||
      !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().replace('.000Z', 'Z') !== value.replace('.000Z', 'Z')) fail(`${label}を確認してください。`);
  return Date.parse(value);
};
export function repositoryKey(url) {
  if (typeof url !== 'string' || !/^https:\/\/github\.com\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(url) ||
      url.split('/').slice(-2).some(part => /^\.+$/.test(part)) || url.endsWith('.git')) fail('snapshotのrepository URLを確認してください。');
  return url.toLowerCase();
}
export const snapshotIdentity = (snapshot, item) => `${repositoryKey(snapshot.repositoryUrl)}:${item.kind}:${item.number}`;
export const githubStateLabel = item => item.kind === 'pull_request' && item.mergedAt ? 'Merged' :
  item.state === 'closed' ? 'Closed' : item.kind === 'pull_request' && item.draft ? 'Draft / Open' : 'Open';

export function snapshotAge(snapshot, now = Date.now()) {
  const hours = Math.max(0, Math.floor((now - Date.parse(snapshot.fetchedAt)) / 3600000));
  return { hours, stale: hours >= 24, label: hours < 1 ? '取得から1時間未満' : `取得から${hours}時間${hours >= 24 ? ' · 古いsnapshot' : ''}` };
}

export function validateSnapshot(snapshot, { projectId, repositoryUrl, now = Date.now() } = {}) {
  keys(snapshot, ['schemaVersion', 'source', 'repositoryUrl', 'fetchedAt', 'sources', 'items'], ['projectId', 'planning']);
  if (snapshot.schemaVersion !== SNAPSHOT_VERSION || snapshot.source !== 'github') fail('snapshotのバージョン・出典が未対応です。');
  const repoKey = repositoryKey(snapshot.repositoryUrl);
  if (repositoryUrl !== undefined && repoKey !== repositoryKey(repositoryUrl)) fail('別repositoryのsnapshotは取り込めません。');
  if (projectId !== undefined && snapshot.projectId !== projectId) fail('別プロジェクトのsnapshotが混入しています。');
  const fetchedAt = timestamp(snapshot.fetchedAt, '取得日時');
  if (fetchedAt > now + 300000) fail('取得日時が未来です。');
  keys(snapshot.sources, ['issues', 'pullRequests']);
  for (const [kind, endpoint] of [['issues', 'issues'], ['pullRequests', 'pulls']]) {
    const source = snapshot.sources[kind];
    keys(source, ['complete', 'urls']);
    if (source.complete !== true || !Array.isArray(source.urls) || !source.urls.length || source.urls.length > 100) fail('IssueとPRの全ページを取得したsnapshotが必要です。');
    source.urls.forEach((value, index) => {
      let url;
      try { url = new URL(value); } catch { fail('取得元URLを確認してください。'); }
      const expected = `/repos/${snapshot.repositoryUrl.slice(19)}/${endpoint}`;
      const params = { state: 'all', per_page: '100', sort: 'updated', direction: 'desc', page: String(index + 1) };
      if (url.protocol !== 'https:' || url.host !== 'api.github.com' || url.username || url.password || url.hash ||
          url.pathname.toLowerCase() !== expected.toLowerCase() || [...url.searchParams].length !== 5 ||
          Object.entries(params).some(([key, value]) => url.searchParams.get(key) !== value)) fail('取得元URLとrepository・ページが一致しません。');
    });
  }
  if (!Array.isArray(snapshot.items) || snapshot.items.length > 5000) fail('snapshotのIssue・PR一覧を確認してください。');
  const identities = new Set(), numbers = new Set();
  for (const item of snapshot.items) {
    if (!object(item) || !['issue', 'pull_request'].includes(item.kind)) fail('Issue・PRの種類を確認してください。');
    keys(item, ['kind', 'number', 'url', 'title', 'state', 'updatedAt', 'closedAt', 'estimatePoints', 'deadline'], item.kind === 'pull_request' ? ['draft', 'mergedAt'] : []);
    if (!Number.isSafeInteger(item.number) || item.number < 1) fail('Issue・PR番号を確認してください。');
    const expected = `${snapshot.repositoryUrl}/${item.kind === 'issue' ? 'issues' : 'pull'}/${item.number}`;
    if (typeof item.url !== 'string' || item.url.toLowerCase() !== expected.toLowerCase()) fail('Issue・PRの出典URLがrepository・番号と一致しません。');
    if (typeof item.title !== 'string' || !item.title.trim() || item.title.length > 1000) fail('Issue・PR名を確認してください。');
    if (!['open', 'closed'].includes(item.state)) fail('GitHubの状態を確認してください。');
    const updatedAt = timestamp(item.updatedAt, '更新日時');
    if (updatedAt > fetchedAt + 300000) fail('取得日時より後の更新が混入しています。');
    if (item.closedAt !== null && timestamp(item.closedAt, 'Closed日時') > updatedAt) fail('Closed日時と更新日時が一致しません。');
    if ((item.state === 'open' && item.closedAt !== null) || (item.state === 'closed' && item.closedAt === null)) fail('Closed日時と状態が一致しません。');
    if (item.estimatePoints !== null || item.deadline !== null) fail('未取得のEstimate・期限は不明（null）のまま保持してください。');
    if (item.kind === 'pull_request') {
      if (typeof item.draft !== 'boolean' || !Object.hasOwn(item, 'mergedAt')) fail('PRのDraft・merge状態を確認してください。');
      if (item.mergedAt !== null && (timestamp(item.mergedAt, 'merge日時') > updatedAt || item.state !== 'closed')) fail('PRのmerge日時と状態が一致しません。');
    }
    const identity = snapshotIdentity(snapshot, item);
    if (identities.has(identity) || numbers.has(item.number)) fail('snapshotのIssue・PRが重複しています。');
    identities.add(identity); numbers.add(item.number);
  }
  if (Object.hasOwn(snapshot, 'planning')) validatePlanning(snapshot.planning, snapshot);
  return snapshot;
}

export function parseSnapshotImport(raw, now = Date.now()) {
  if (typeof raw !== 'string' || new TextEncoder().encode(raw).byteLength > MAX_IMPORT_BYTES) fail('snapshotファイルは5MiB以下にしてください。');
  const value = JSON.parse(raw);
  let snapshots;
  if (value?.type === 'github-snapshot-bundle') {
    keys(value, ['type', 'schemaVersion', 'snapshots']);
    if (value.schemaVersion !== SNAPSHOT_VERSION) fail('snapshot bundleのバージョンが未対応です。');
    snapshots = value.snapshots;
  } else snapshots = [value];
  if (!Array.isArray(snapshots) || !snapshots.length || snapshots.length > 20) fail('snapshotは1〜20 repositoryずつ取り込んでください。');
  const repositories = new Set();
  for (const snapshot of snapshots) {
    validateSnapshot(snapshot, { now });
    if (Object.hasOwn(snapshot, 'projectId')) fail('取込用JSONにprojectIdを含めず、画面で取込先を選んでください。');
    const key = repositoryKey(snapshot.repositoryUrl);
    if (repositories.has(key)) fail('同じrepositoryのsnapshotが重複しています。');
    repositories.add(key);
  }
  return snapshots;
}

export function attachSnapshot(project, incoming, now = Date.now()) {
  validateSnapshot(incoming, { repositoryUrl: project.repositoryUrl, now });
  if (Object.hasOwn(incoming, 'projectId')) fail('取込用snapshotのprojectIdは指定できません。');
  const previous = project.githubSnapshot;
  if (previous) {
    if (Date.parse(incoming.fetchedAt) <= Date.parse(previous.fetchedAt)) fail('同じ取得日時または古いsnapshotでは更新できません。');
    const oldItems = new Map(previous.items.map(item => [snapshotIdentity(previous, item), item]));
    for (const item of incoming.items) {
      const old = oldItems.get(snapshotIdentity(incoming, item));
      if (old && Date.parse(item.updatedAt) < Date.parse(old.updatedAt)) fail('Issue・PRの更新日時が古くなっています。以前のsnapshotを保持しました。');
    }
  }
  project.githubSnapshot = { ...structuredClone(incoming), projectId: project.id };
}

// Build only from complete GitHub REST collection pages, with source URLs intact.
export function buildSnapshot({ repositoryUrl, fetchedAt, issuePages, pullPages, planning }) {
  repositoryKey(repositoryUrl);
  const normalizePages = (pages, endpoint) => {
    if (!Array.isArray(pages) || !pages.length || pages.some(page => !Array.isArray(page)) ||
        pages.slice(0, -1).some(page => page.length !== 100) || pages.at(-1).length >= 100) fail('ページの欠落または未取得の次ページがあります。');
    return { complete: true, urls: pages.map((_, index) => `https://api.github.com/repos/${repositoryUrl.slice(19)}/${endpoint}?state=all&per_page=100&sort=updated&direction=desc&page=${index + 1}`) };
  };
  const sources = { issues: normalizePages(issuePages, 'issues'), pullRequests: normalizePages(pullPages, 'pulls') };
  const issueRecords = issuePages.flat(), pullRecords = pullPages.flat();
  if (new Set(issueRecords.map(item => item.number)).size !== issueRecords.length ||
      new Set(pullRecords.map(item => item.number)).size !== pullRecords.length) fail('ページ間に重複があります。取得中の更新の可能性があるため再取得してください。');
  const listedPRs = new Set(issueRecords.filter(item => item.pull_request).map(item => item.number));
  const actualPRs = new Set(pullRecords.map(item => item.number));
  if (listedPRs.size !== actualPRs.size || [...listedPRs].some(number => !actualPRs.has(number))) fail('Issue一覧とPR一覧が一致しません。再取得してください。');
  const normalize = (record, kind) => {
    if (kind === 'pull_request' && record.base?.repo?.html_url?.toLowerCase() !== repositoryUrl.toLowerCase()) fail('PRのbase repositoryが一致しません。');
    const item = { kind, number: record.number, url: record.html_url, title: record.title, state: record.state,
      updatedAt: record.updated_at, closedAt: record.closed_at, estimatePoints: null, deadline: null };
    if (kind === 'pull_request') { item.draft = record.draft; item.mergedAt = record.merged_at; }
    return item;
  };
  const snapshot = { schemaVersion: SNAPSHOT_VERSION, source: 'github', repositoryUrl, fetchedAt, sources,
    items: [...issueRecords.filter(item => !item.pull_request).map(item => normalize(item, 'issue')), ...pullRecords.map(item => normalize(item, 'pull_request'))]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.number - a.number) };
  if (planning !== undefined) snapshot.planning = planning;
  return validateSnapshot(snapshot);
}

// 承認待ちのPR：担当者が作業を終えてReadyにした、開いているPR。Draftは担当者が作業中として数えない。
// 上限に達している間、AIは新しくReadyにしない（AGENTS.md）。上限はプロジェクトごとの設定で、未設定なら既定のAPPROVAL_LIMITとする。
export const APPROVAL_LIMIT = 2;
export const APPROVAL_LIMIT_MAX = 99;
export const isApprovalLimit = value => Number.isSafeInteger(value) && value >= 1 && value <= APPROVAL_LIMIT_MAX;
export const projectApprovalLimit = project => project.approvalLimit ?? APPROVAL_LIMIT;
export function approvalQueue(snapshot, limit = APPROVAL_LIMIT) {
  if (!snapshot) return null;
  const items = snapshot.items.filter(item => item.kind === 'pull_request' && item.state === 'open' && !item.draft).sort((a, b) => a.number - b.number);
  return { items, limit, full: items.length >= limit, remaining: Math.max(0, limit - items.length) };
}
// readyAllowed：true はReadyにできる、false は上限に達している、null は未取得か古いsnapshotのため判断できない。
export function approvalState(snapshot, now = Date.now(), limit = APPROVAL_LIMIT) {
  const queue = approvalQueue(snapshot, limit);
  if (!queue) return { queue, stale: false, readyAllowed: null };
  const stale = snapshotAge(snapshot, now).stale;
  return { queue, stale, readyAllowed: stale ? null : !queue.full };
}

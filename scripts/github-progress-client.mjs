import { execFileSync } from 'node:child_process';

const complete = connection => {
  if (!connection || connection.pageInfo?.hasNextPage !== false || !Array.isArray(connection.nodes) ||
      connection.nodes.some(node => !node) || connection.totalCount !== connection.nodes.length) {
    throw new Error('GitHubの情報を全件取得できませんでした。更新しません。');
  }
  return connection.nodes;
};
const connectionFields = 'totalCount pageInfo { hasNextPage }';

export function graphql(query, variables) {
  // Pass JSON on stdin, never through a shell. gh uses its existing credentials.
  const output = execFileSync('gh', ['api', 'graphql', '--hostname', 'github.com', '--input', '-', '--jq', '{data,errors}'], {
    input: JSON.stringify({ query, variables }), encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
    windowsHide: true, timeout: 60000,
  });
  const result = JSON.parse(output);
  if (result.errors?.length || !result.data) throw new Error('GitHub GraphQLの処理に失敗しました。');
  return result.data;
}

export function createProgressClient({ projectId, repository }, call = graphql) {
  if (!/^PVT_[A-Za-z0-9_-]+$/.test(projectId ?? '')) throw new Error('Projectのnode IDを指定してください。');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? '')) throw new Error('repositoryをowner/repoで指定してください。');
  const [owner, name] = repository.split('/');
  return {
    async project() {
      const { node } = await call(`query($id:ID!) { node(id:$id) { ... on ProjectV2 {
        id url fields(first:100) { ${connectionFields} nodes {
          ... on ProjectV2Field { id name dataType }
          ... on ProjectV2SingleSelectField { id name dataType }
          ... on ProjectV2IterationField { id name dataType }
        } }
      } } }`, { id: projectId });
      if (node?.id !== projectId || !node.url) throw new Error('指定したProjectを取得できません。');
      return { id: node.id, url: node.url, fields: complete(node.fields) };
    },
    async item(issue) {
      const result = await call(`query($owner:String!,$name:String!,$issue:Int!) {
        repository(owner:$owner,name:$name) { issue(number:$issue) {
          id number url state subIssuesSummary { total }
          projectItems(first:100) { ${connectionFields} nodes { id isArchived project { id }
            fieldValues(first:100) { ${connectionFields} nodes {
              ... on ProjectV2ItemFieldNumberValue { number field { ... on ProjectV2Field { id name } } }
              ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2SingleSelectField { id name } } }
            } }
          } }
        } }
      }`, { owner, name, issue });
      const record = result.repository?.issue;
      if (!record?.id || record.number !== issue || record.url.toLowerCase() !== `https://github.com/${repository}/issues/${issue}`.toLowerCase()) throw new Error('指定したIssueを取得できません。');
      const matches = complete(record.projectItems).filter(item => item.project?.id === projectId);
      if (matches.length !== 1) throw new Error('指定したProject内でIssueを一意に識別できません。');
      const item = matches[0];
      const values = {};
      let actor = null;
      for (const fieldValue of complete(item.fieldValues)) {
        if (!fieldValue.field) continue;
        const { id, name: fieldName } = fieldValue.field;
        if (Object.hasOwn(values, id)) throw new Error('重複するフィールド値があります。');
        values[id] = fieldValue.number ?? fieldValue.name ?? null;
        if (fieldName === '担当') {
          if (actor !== null) throw new Error('担当フィールドが重複しています。');
          actor = fieldValue.name;
        }
      }
      return { id: item.id, issueId: record.id, number: record.number, url: record.url, state: record.state,
        children: record.subIssuesSummary?.total, archived: item.isArchived, actor, values };
    },
    async comments(issue) {
      const comments = [];
      let cursor = null;
      let total = null;
      const cursors = new Set();
      do {
        const result = await call(`query($owner:String!,$name:String!,$issue:Int!,$cursor:String) {
          repository(owner:$owner,name:$name) { issue(number:$issue) { comments(first:100,after:$cursor) {
            totalCount pageInfo { hasNextPage endCursor } nodes { id body }
          } } }
        }`, { owner, name, issue, cursor });
        const page = result.repository?.issue?.comments;
        if (!page || !Array.isArray(page.nodes) || page.nodes.some(node => !node?.id || typeof node.body !== 'string') ||
            !Number.isSafeInteger(page.totalCount) || (total !== null && page.totalCount !== total) ||
            typeof page.pageInfo?.hasNextPage !== 'boolean') throw new Error('根拠コメントを全件取得できません。');
        total = page.totalCount;
        comments.push(...page.nodes);
        cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
        if (page.pageInfo.hasNextPage && (!cursor || cursors.has(cursor))) throw new Error('コメントの続きが取得できません。');
        cursors.add(cursor);
      } while (cursor);
      if (comments.length !== total || new Set(comments.map(comment => comment.id)).size !== total) throw new Error('根拠コメントの件数が一致しません。');
      return comments;
    },
    async createField(id, fieldName) {
      const result = await call(`mutation($input:CreateProjectV2FieldInput!) {
        createProjectV2Field(input:$input) { projectV2Field { ... on ProjectV2Field { id } } }
      }`, { input: { projectId: id, name: fieldName, dataType: 'NUMBER' } });
      if (!result.createProjectV2Field?.projectV2Field?.id) throw new Error('フィールド作成の応答を確認できません。');
    },
    async setNumber(id, itemId, fieldId, value) {
      const result = await call(`mutation($input:UpdateProjectV2ItemFieldValueInput!) {
        updateProjectV2ItemFieldValue(input:$input) { projectV2Item { id } }
      }`, { input: { projectId: id, itemId, fieldId, value: { number: value } } });
      if (result.updateProjectV2ItemFieldValue?.projectV2Item?.id !== itemId) throw new Error('数値更新の応答を確認できません。');
    },
    async comment(subjectId, body) {
      const result = await call(`mutation($input:AddCommentInput!) { addComment(input:$input) { commentEdge { node { id } } } }`,
        { input: { subjectId, body } });
      if (!result.addComment?.commentEdge?.node?.id) throw new Error('根拠コメントの応答を確認できません。');
    },
  };
}

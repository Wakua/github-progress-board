const messages = {
  case_conflict: '別の変更が保存されています。入力を残したまま最新内容を確認してください。',
  request_reused: '保存要求が一致しません。入力を保全してから再読込みしてください。',
  invalid_case: '入力内容を確認してください。入力は残っています。',
  store_unavailable: '保存先を利用できません。入力は残っています。時間をおいて再試行してください。',
};
export function createCaseRepository({ fetchImpl = fetch } = {}) {
  async function request(url, method = 'GET', body) {
    let response, value;
    try {
      response = await fetchImpl(url, { method, headers: { 'x-test-client': '1', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      value = await response.json();
    } catch { throw new Error('サーバーから応答を受け取れませんでした。入力は残っています。'); }
    if (!response.ok) throw Object.assign(new Error(messages[value?.error] || '操作を完了できませんでした。入力は残っています。'), { status: response.status, current: value?.current });
    return value;
  }
  return { load: () => request('/api/testing/cases'), newCase: () => request('/api/testing/case-ids', 'POST', {}), save: value => request('/api/testing/cases', 'PUT', value) };
}

// 絞り込みの枠（dist/bugs/filter-panel.mjs）の、画面のテスト用の模擬。
// 画面のコードが渡す選択肢と、選んだ値を覚える。テストは、choose で条件の値を選び、選んだ値と選択肢の文字を読む。
const ids = { '#main-filter': 'main', '#sub-filter': 'sub', '#status-filter': 'status', '#kind-filter': 'kind', '#decision-filter': 'decision', '#registration-filter': 'registration' };

export function createFilterPanelStub() {
  const state = { main: [], sub: [], status: [], kind: [], decision: [], registration: [] }, choices = {};
  let onChange = () => {};
  return {
    mountFilterPanel(options) {
      onChange = options.onChange ?? onChange;
      return {
        values: id => [...state[id]],
        // 本物と同じく、選択肢になくなった値の選びは外す。
        setChoices(id, list) { choices[id] = list; state[id] = state[id].filter(value => list.some(choice => choice.value === value)); }
      };
    },
    // 条件の値を選ぶ。valuesは、配列、または1つの値（'all'と空は、何も選ばない）。
    choose(selector, values) {
      const id = ids[selector];
      state[id] = Array.isArray(values) ? [...values] : (values === 'all' || values === '' ? [] : [values]);
      onChange(id);
    },
    texts: selector => (choices[ids[selector]] ?? []).map(choice => choice.text),
    selected: selector => [...state[ids[selector]]]
  };
}

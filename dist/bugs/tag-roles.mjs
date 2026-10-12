// 「カテゴリの設定」：GitHubのタグごとに、メインカテゴリかサブカテゴリかを割り当てる。
export const roleNames = { none: '使わない', main: 'メイン', sub: 'サブ' };

// 新しいタグ（role が null）を先に並べる。それぞれの中では、サーバーが返した名前順を保つ。
export function dialogOrder(tags) {
  return [...tags].sort((a, b) => (a.role === null ? 0 : 1) - (b.role === null ? 0 : 1));
}

// 保存するのは、未設定のタグ（選んだ役割で確定する）と、割り当てを変えたタグだけ。
// 開いている間にほかの人が変えた割り当てを、変えていないタグで上書きしない。
export function rolesToSave(tags, chosen) {
  const roles = [];
  for (const tag of tags) {
    const role = chosen.get(tag.id) ?? tag.role ?? 'none';
    if (tag.role === null || role !== tag.role) roles.push({ id: tag.id, role });
  }
  return roles;
}

// onSave: 割り当てを保存したときに呼ぶ。一覧の絞り込みの選択肢を、新しい割り当てで描き直す。
export function mountTagRoles({ api, json, element, notice, onSave = () => {} }) {
  const $ = selector => document.querySelector(selector);
  const dialog = $('#category-dialog'), form = $('#category-form'), list = $('#category-tags'), error = $('#category-error');
  let state = { tags: [], newCount: 0 };
  // 設定画面に描いたタグ。開いている間に背景の更新で state が変わっても、見せたタグだけを保存の対象にする。
  let shown = [];

  function showCount() {
    const badge = $('#new-tags');
    badge.textContent = '新しいタグ ' + state.newCount;
    badge.hidden = !state.newCount;
  }
  // 読み込めなかったときは、前回の結果と件数の印を残して、失敗を返す。
  async function load() {
    try { state = await api('tag-roles'); showCount(); return null; } catch (failure) { return failure; }
  }
  function renderTags() {
    shown = state.tags; list.replaceChildren();
    if (!state.tags.length) { list.append(element('p', '取得済みの報告にタグがありません。', 'empty')); }
    for (const tag of dialogOrder(state.tags)) {
      const row = element('div', undefined, 'role-row'), name = element('span', undefined, 'role-name');
      const chip = element('span', tag.name, 'tag');
      if (/^[0-9a-f]{6}$/i.test(tag.color)) chip.style.setProperty('--tag-color', '#' + tag.color);
      name.append(chip);
      if (tag.role === null) name.append(element('span', '新しい', 'new-mark'));
      const group = element('div', undefined, 'role-choice');
      group.setAttribute('role', 'radiogroup'); group.setAttribute('aria-label', tag.name + ' の役割');
      for (const [value, text] of Object.entries(roleNames)) {
        const label = element('label'), radio = element('input');
        radio.type = 'radio'; radio.name = 'role-' + tag.id; radio.value = value; radio.dataset.tag = tag.id;
        radio.checked = value === (tag.role ?? 'none');
        label.append(radio, element('span', text)); group.append(label);
      }
      row.append(name, group); list.append(row);
    }
    $('#save-category').hidden = !state.tags.length;
  }

  $('#category-settings').onclick = async () => {
    const failure = await load();
    if (failure) { notice(failure.message, true); return; }
    error.textContent = ''; renderTags(); dialog.showModal();
  };
  $('#close-category').onclick = () => dialog.close();
  form.onsubmit = async event => {
    event.preventDefault();
    const chosen = new Map([...list.querySelectorAll('input:checked')].map(radio => [Number(radio.dataset.tag), radio.value]));
    const roles = rolesToSave(shown, chosen);
    if (!roles.length) { dialog.close(); return; }
    const save = $('#save-category'); save.disabled = true; error.textContent = '';
    try {
      state = await api('tag-roles', json({ roles })); showCount(); dialog.close();
      onSave();
      notice('カテゴリの設定を保存しました。');
    } catch (failure) { error.textContent = failure.message + ' 選択は保持しています。'; }
    finally { save.disabled = false; }
  };
  return { load, tags: () => state.tags };
}

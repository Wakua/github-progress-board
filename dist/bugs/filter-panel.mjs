import {statusNames,kindNames} from './view.mjs';

// 絞り込みの条件。値のチェックボックスを入れた瞬間に、一覧を絞り込む。
// 同じ条件の中は「どれか」、条件同士は「すべて」。何も選んでいない条件は、絞り込まない。
// choicesを持たない条件（メイン・サブ）の値は、setChoicesで渡す。exclusiveの値は、その条件のほかの値と一緒には選べない。
export const filterDefs = [
  { id: 'main', name: 'メイン' },
  { id: 'sub', name: 'サブ' },
  { id: 'status', name: '対応状況', exclusive: 'incomplete', choices: [{ value: 'incomplete', text: '確認完了を除く' }, ...Object.entries(statusNames).map(([value, text]) => ({ value, text }))] },
  { id: 'kind', name: '種別', choices: Object.entries(kindNames).map(([value, text]) => ({ value, text })) },
  { id: 'registration', name: 'GitHub登録', choices: [
    { value: 'pending', text: '登録待ち・未登録' }, { value: 'creating', text: '登録中' }, { value: 'registered', text: '登録済み' },
    { value: 'failed', text: '登録失敗' }, { value: 'unknown', text: '作成結果が未確認' }] }
];

// ボタンの文字。選んだ値があれば、条件の名前のあとに並べる。
export const summaryText = (name, texts) => texts.length ? name + '：' + texts.join('・') : name;

// 選んだ値の集合を、値を選んだときの規則で更新する。
export function toggled(checked, value, on, exclusive = null) {
  const next = new Set(checked);
  if (!on) { next.delete(value); return next; }
  if (exclusive && value === exclusive) return new Set([value]);
  if (exclusive) next.delete(exclusive);
  next.add(value);
  return next;
}

// root：条件のボタンを並べる枠。onChange(id)：選びが変わったときに呼ぶ。
// 戻り値：values(id)＝選んだ値の配列、setChoices(id,[{value,text}])＝選択肢を渡す（なくなった値の選びは外す）。
export function mountFilterPanel({ root, onChange = () => {} }) {
  const make = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const groups = new Map();
  const closeAll = except => { for (const group of groups.values()) if (group !== except) group.details.open = false; };

  function sync(group) {
    for (const input of group.inputs) input.checked = group.checked.has(input.value);
    // 選択肢の文字の末尾にある未対応の件数（例：「予約（7）」の「（7）」）は、ボタンには出さない。
    group.summary.textContent = summaryText(group.def.name, group.choices.filter(choice => group.checked.has(choice.value)).map(choice => choice.text.replace(/（\d+）$/, '')));
    group.clear.hidden = !group.checked.size;
    group.details.className = 'filter-group' + (group.checked.size ? ' on' : '');
  }
  function draw(group) {
    group.inputs = [];
    const options = group.choices.map(choice => {
      const label = make('label', undefined, 'filter-option'), input = make('input');
      input.type = 'checkbox'; input.value = choice.value;
      input.onchange = () => {
        group.checked = toggled(group.checked, choice.value, input.checked, group.def.exclusive);
        sync(group); onChange(group.def.id);
      };
      group.inputs.push(input);
      label.append(input, make('span', choice.text));
      return label;
    });
    group.menu.replaceChildren(...options, group.clear);
    group.details.hidden = !group.choices.length;
    sync(group);
  }

  for (const def of filterDefs) {
    const details = make('details', undefined, 'filter-group'), summary = make('summary', def.name), menu = make('div', undefined, 'filter-menu');
    const clear = make('button', '解除', 'quiet filter-clear'); clear.type = 'button';
    details.dataset.filter = def.id;
    details.append(summary, menu); root.append(details);
    const group = { def, details, summary, menu, clear, choices: def.choices ?? [], checked: new Set(), inputs: [] };
    clear.onclick = () => { group.checked = new Set(); sync(group); onChange(def.id); };
    details.addEventListener('toggle', () => { if (details.open) closeAll(group); });
    groups.set(def.id, group);
    draw(group);
  }
  // 枠の外を押したときと、Escapeで、開いているメニューを閉じる。
  document.addEventListener('click', event => { if (!root.contains(event.target)) closeAll(); });
  root.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    // 開く・閉じるの通知は、少し遅れて届く。ほかのメニューが閉じる前でも、開いているものをすべて閉じる。
    const open = [...groups.values()].filter(group => group.details.open);
    if (!open.length) return;
    const focused = open.find(group => group.details.contains(event.target)) ?? open[0];
    closeAll();
    focused.summary.focus();
  });

  return {
    values: id => [...groups.get(id).checked],
    setChoices(id, choices) {
      const group = groups.get(id);
      group.choices = choices;
      group.checked = new Set([...group.checked].filter(value => choices.some(choice => choice.value === value)));
      draw(group);
    }
  };
}

// 絞り込みの条件を、選んで足し、外せるようにする。いつも出すのは、検索欄だけ。
export const filterTypes = [
  { id: 'main', name: 'メイン' },
  { id: 'sub', name: 'サブ' },
  { id: 'status', name: '対応状況' },
  { id: 'kind', name: '種別' },
  { id: 'registration', name: 'GitHub登録' }
];
export const defaultShown = ['main', 'sub', 'status'];
export const storageKey = 'bug-report-filters';

// 保存した文字列から、出す条件を読む。読めないときと、知らない条件を含むときは、既定にする。
export function parseShown(text) {
  try {
    const value = JSON.parse(text);
    const ids = filterTypes.map(type => type.id);
    if (Array.isArray(value) && value.every(id => ids.includes(id))) return ids.filter(id => value.includes(id));
  } catch { /* 既定にする */ }
  return [...defaultShown];
}

// root：絞り込みの枠。条件ごとに、data-filter を持つ枠（label）と、その中の select と .filter-remove がある。
// 「＋ 条件」は、root の中の .add-filter select。storage：{get(), set(text)}。onRemove：条件を外して「すべて」に戻したあとに呼ぶ。
export function mountFilterBar({ root, storage, onRemove = () => {} }) {
  const labels = new Map([...root.querySelectorAll('[data-filter]')].map(label => [label.dataset.filter, label]));
  const add = root.querySelector('.add-filter');
  const picker = add.querySelector('select');
  let shown = parseShown(storage.get());
  function render() {
    for (const type of filterTypes) labels.get(type.id).hidden = !shown.includes(type.id);
    const hiding = filterTypes.filter(type => !shown.includes(type.id));
    picker.replaceChildren(...[{ id: '', name: '＋ 条件' }, ...hiding].map(type => {
      const option = document.createElement('option');
      option.value = type.id; option.textContent = type.name; return option;
    }));
    picker.value = '';
    add.hidden = !hiding.length;
  }
  function save() { storage.set(JSON.stringify(shown)); }
  picker.onchange = () => {
    const id = picker.value;
    if (!labels.has(id)) return;
    shown = filterTypes.map(type => type.id).filter(known => shown.includes(known) || known === id);
    save(); render(); labels.get(id).querySelector('select').focus();
  };
  for (const [id, label] of labels) {
    label.querySelector('.filter-remove').onclick = () => {
      label.querySelector('select').value = 'all';
      shown = shown.filter(known => known !== id);
      save(); render(); onRemove(id);
      picker.focus(); // 押した × は隠れるため、フォーカスを「＋ 条件」へ移す
    };
  }
  render();
  return { shown: () => [...shown] };
}

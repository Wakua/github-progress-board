import { CASE_FIELDS, CASE_STATES, createCaseEditor, UnsavedCaseError } from './case-editor.mjs';

// 採用済みのケース編集画面。保存先は呼出側が渡し、ここに仮の永続化を入れない。
export function mountCaseEditor(root, { repository, window: win = window, document: doc = root.ownerDocument, requestId } = {}) {
  const editor = createCaseEditor(repository, { requestId });
  const make = (tag, text, className) => {
    const node = doc.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const button = (text, className) => { const node = make('button', text, className); node.type = 'button'; return node; };
  const field = (label, node) => { const wrapper = make('label', label); wrapper.append(node); return wrapper; };
  const select = choices => {
    const node = make('select');
    for (const [value, text] of choices) { const option = make('option', text); option.value = value; node.append(option); }
    return node;
  };
  root.classList.add('test-cases');
  const toolbar = make('div', undefined, 'case-toolbar');
  const toggle = button('一覧を閉じる', 'case-toggle');
  const listId = `case-list-${win.crypto.randomUUID()}`;
  toggle.setAttribute('aria-controls', listId);
  const title = make('h1', 'テストケース'), add = button('＋ ケース', 'primary');
  toolbar.append(toggle, title, add);
  const message = make('div', undefined, 'case-message'); message.setAttribute('role', 'alert'); message.hidden = true;
  const retry = button('再取得'); retry.hidden = true;
  const workspace = make('div', undefined, 'case-workspace');
  const list = make('section', undefined, 'case-list'); list.id = listId; list.setAttribute('aria-label', 'ケース一覧');
  const filters = make('div', undefined, 'case-filters');
  const category = select([['', 'すべて']]), state = select([['current', 'Draft・Active'], ['all', 'すべて'], ...CASE_STATES.map(value => [value, value])]);
  filters.append(field('カテゴリ', category), field('状態', state));
  const count = make('p', undefined, 'case-meta'); count.setAttribute('aria-live', 'polite');
  const rows = make('div', undefined, 'case-rows'), empty = make('p', '該当するケースはありません。', 'case-empty');
  list.append(filters, count, rows, empty);
  const panel = make('section', undefined, 'case-editor'); panel.setAttribute('aria-label', 'ケース編集'); panel.hidden = true;
  const dirty = make('span', undefined, 'case-meta');
  const heading = make('h2'); heading.tabIndex = -1;
  const form = make('form'); form.noValidate = true;
  const fields = make('fieldset');
  const controls = {}, errors = {};
  function input(name, label, { type = 'input', choices, required = false, rows: lineCount = 3, readonly = false } = {}) {
    const node = choices ? select(choices.map(value => [value, value || '未指定'])) : make(type);
    node.name = name; node.required = required; node.readOnly = readonly;
    if (type === 'textarea') node.rows = lineCount;
    const error = make('span', undefined, 'case-field-error'); error.id = `${listId}-${name}-error`; error.hidden = true;
    node.setAttribute('aria-describedby', error.id);
    controls[name] = node; errors[name] = error;
    node.addEventListener('input', () => editor.edit(name, node.value));
    node.addEventListener('change', () => editor.edit(name, node.value));
    const wrapper = field(label + (required ? ' *' : ''), node); wrapper.append(error); return wrapper;
  }
  const top = make('div', undefined, 'case-form-row');
  top.append(input('id', 'ID', { required: true, readonly: true }), input('status', '状態', { choices: CASE_STATES, required: true }), input('category', 'カテゴリ'));
  const categoryNames = make('datalist'); categoryNames.id = `${listId}-categories`; controls.category.setAttribute('list', categoryNames.id); top.append(categoryNames);
  fields.append(top, input('title', 'タイトル', { required: true }), input('steps', '手順', { required: true, type: 'textarea', rows: 4 }), input('expected', '期待結果', { required: true, type: 'textarea' }));
  const optional = make('details'); optional.append(make('summary', '補足'));
  optional.append(input('purpose', '目的', { type: 'textarea' }), input('preconditions', '事前条件', { type: 'textarea' }), input('cleanup', '事後処理', { type: 'textarea' }), input('priority', '優先度', { choices: ['', 'High', 'Medium', 'Low'] }), input('type', 'テスト種別', { choices: ['', 'Manual', 'Automated', 'Exploratory'] }), input('reference', '関連する仕様'), input('notes', '備考', { type: 'textarea' }));
  fields.append(optional);
  const failure = make('p', undefined, 'case-error'); failure.setAttribute('role', 'alert'); failure.tabIndex = -1; failure.hidden = true;
  const inspect = button('最新内容を見る'); inspect.hidden = true;
  const footer = make('div', undefined, 'case-actions'), cancel = button('キャンセル'), save = button('保存', 'primary'); save.type = 'submit';
  footer.append(cancel, save); fields.append(failure, inspect, footer); form.append(fields); panel.append(dirty, heading, form);
  const placeholder = make('div', 'ケースを選んで編集', 'case-placeholder');
  workspace.append(list, panel, placeholder);
  const notice = make('div', undefined, 'case-notice'); notice.setAttribute('role', 'status');
  const discard = make('dialog'), continueEdit = button('編集を続ける'), discardChanges = button('破棄して移動');
  const discardTitle = make('h2', '変更を破棄しますか？'); discardTitle.id = `${listId}-discard-title`; discard.setAttribute('aria-labelledby', discardTitle.id);
  const discardActions = make('div', undefined, 'case-dialog-actions'); discardActions.append(continueEdit, discardChanges);
  discard.append(discardTitle, make('p', '保存していない入力があります。'), discardActions);
  const latest = make('dialog'), latestTitle = make('h2', '最新の保存内容'), latestFields = make('dl'), backToInput = button('入力へ戻る');
  latestTitle.id = `${listId}-latest-title`; latest.setAttribute('aria-labelledby', latestTitle.id);
  latest.append(latestTitle, latestFields, backToInput);
  root.replaceChildren(toolbar, message, retry, workspace, notice, discard, latest);
  let pending = null, disposed = false, lastSelected = null, timer;
  function request(action) {
    try { return action(false); }
    catch (error) {
      if (!(error instanceof UnsavedCaseError)) throw error;
      pending = action; discard.showModal(); continueEdit.focus();
    }
  }
  async function requestCreate() {
    // createはasyncなので、未保存の確認は呼出前に行う。
    const action = discard => editor.create({ discard });
    if (editor.snapshot().dirty) { pending = action; discard.showModal(); continueEdit.focus(); }
    else await action(false);
  }
  function layout(value) {
    list.hidden = !value.sidebar; root.classList.toggle('case-sidebar-closed', !value.sidebar);
    toggle.textContent = value.sidebar ? '一覧を閉じる' : '一覧を開く'; toggle.setAttribute('aria-expanded', String(value.sidebar));
    panel.hidden = !value.draft; placeholder.hidden = !!value.draft;
  }
  function renderRows(value) {
    const visible = editor.visibleCases(); rows.replaceChildren();
    count.textContent = `${visible.length} / ${value.cases.length}件`; empty.hidden = visible.length !== 0;
    for (const record of visible) {
      const row = button('', 'case-row'); row.dataset.id = record.id;
      row.setAttribute('aria-label', `${record.id} ${record.title} ${record.status}`);
      if (value.selected === record.id) row.setAttribute('aria-current', 'true');
      row.append(make('span', record.id, 'case-id'), make('span', record.title, 'case-title'), make('span', record.status, `case-badge ${record.status}`));
      row.onclick = () => request(discard => editor.select(record.id, { discard })); rows.append(row);
    }
    rows.scrollTop = value.scrollTop;
  }
  function render(kind) {
    if (disposed) return;
    const value = editor.snapshot(), busy = ['loading', 'creating', 'saving'].includes(value.phase);
    layout(value);
    if (['load', 'select', 'filter', 'saved', 'cancel'].includes(kind)) renderRows(value);
    if (kind === 'load' || kind === 'saved') {
      category.replaceChildren(select([['', 'すべて']]).firstChild);
      categoryNames.replaceChildren();
      for (const name of [...new Set([...value.categories, value.category].filter(Boolean))]) {
        for (const control of [category, categoryNames]) { const option = make('option', name); option.value = name; control.append(option); }
      }
      category.value = value.category;
    }
    if (['select', 'saved'].includes(kind)) {
      for (const key of CASE_FIELDS) {
        if (controls[key].tagName === 'SELECT' && !Array.from(controls[key].options).some(option => option.value === value.draft[key])) {
          const option = make('option', value.draft[key]); option.value = value.draft[key]; controls[key].append(option);
        }
        controls[key].value = value.draft[key];
      }
      heading.textContent = `${value.draft.id}を編集`;
    }
    fields.disabled = busy; add.disabled = busy || value.phase === 'load-error';
    for (const row of rows.children) row.disabled = busy;
    dirty.textContent = value.dirty ? '● 未保存' : '';
    save.textContent = value.phase === 'saving' ? '保存中…' : '保存';
    for (const key of CASE_FIELDS) {
      errors[key].textContent = value.errors[key] || ''; errors[key].hidden = !value.errors[key];
      controls[key].setAttribute('aria-invalid', String(!!value.errors[key]));
    }
    failure.textContent = value.error; failure.hidden = !value.error || !value.draft;
    inspect.hidden = !value.conflict;
    message.textContent = value.phase === 'loading' ? '読み込み中…' : value.error;
    message.hidden = value.phase !== 'loading' && (!value.error || !!value.draft);
    retry.hidden = value.phase !== 'load-error';
    if (kind === 'invalid') controls[Object.keys(value.errors)[0]].focus();
    if (kind === 'save-error') failure.focus();
    if (kind === 'select' || kind === 'focus') {
      if (kind === 'select') { optional.open = false; lastSelected = value.selected; notice.textContent = ''; win.clearTimeout(timer); }
      if (win.matchMedia('(max-width:760px)').matches) editor.setSidebar(false);
      heading.focus();
    }
    if (kind === 'cancel') {
      const row = Array.from(rows.children).find(row => row.dataset.id === lastSelected); (row || add).focus();
    }
    if (kind === 'saved') {
      notice.textContent = `${value.selected}を保存しました`; win.clearTimeout(timer);
      timer = win.setTimeout(() => { notice.textContent = ''; }, 3500); save.focus({ preventScroll: true });
    }
  }
  toggle.onclick = () => {
    const value = editor.snapshot();
    if (value.sidebar) editor.setScroll(rows.scrollTop);
    editor.setSidebar(!value.sidebar);
    if (!value.sidebar) rows.scrollTop = editor.snapshot().scrollTop;
    toggle.focus({ preventScroll: true });
  };
  rows.addEventListener('scroll', () => { if (!list.hidden) editor.setScroll(rows.scrollTop); });
  category.onchange = () => editor.filter({ category: category.value }); state.onchange = () => editor.filter({ status: state.value });
  add.onclick = requestCreate; retry.onclick = () => editor.load();
  form.onsubmit = event => { event.preventDefault(); void editor.save(); };
  cancel.onclick = () => request(discard => editor.cancel({ discard }));
  continueEdit.onclick = () => { pending = null; discard.close(); };
  discard.addEventListener('cancel', () => { pending = null; });
  discardChanges.onclick = () => { const action = pending; pending = null; discard.close(); void action?.(true); };
  inspect.onclick = () => {
    const current = editor.snapshot().conflict; if (!current) return;
    latestFields.replaceChildren();
    for (const [key, label] of [['title', 'タイトル'], ['steps', '手順'], ['expected', '期待結果']]) latestFields.append(make('dt', label), make('dd', current[key]));
    latest.showModal(); backToInput.focus();
  };
  backToInput.onclick = () => latest.close();
  const beforeUnload = event => { if (editor.snapshot().dirty) { event.preventDefault(); event.returnValue = ''; } };
  win.addEventListener('beforeunload', beforeUnload);
  const unsubscribe = editor.subscribe(render); render('init');
  return { editor, ready: editor.load(), dispose() { disposed = true; unsubscribe(); win.clearTimeout(timer); win.removeEventListener('beforeunload', beforeUnload); root.replaceChildren(); } };
}

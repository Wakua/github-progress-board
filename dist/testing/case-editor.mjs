// ケース編集の画面状態。保存先・HTTP API・DBの物理モデルはここで決めない。
export const CASE_STATES = Object.freeze(['Draft', 'Active', 'Deprecated']);
export const CASE_FIELDS = Object.freeze(['id', 'title', 'purpose', 'preconditions', 'steps', 'expected', 'cleanup', 'category', 'priority', 'type', 'status', 'reference', 'notes']);
const copy = value => structuredClone(value);
export function caseValues(value = {}) {
  return Object.fromEntries(CASE_FIELDS.map(key => [key, typeof value[key] === 'string' ? value[key] : '']));
}
export function validateCase(value) {
  const errors = {};
  for (const key of ['id', 'title', 'steps', 'expected', 'status']) {
    if (typeof value?.[key] !== 'string' || !value[key].trim()) errors[key] = '入力してください。';
  }
  if (!errors.status && !CASE_STATES.includes(value.status)) errors.status = '状態を選んでください。';
  return errors;
}
export class UnsavedCaseError extends Error {}

// repositoryは内部接続口。HTTP経由でローカルのテストDBへ接続する。
// load -> {cases,categories}; newCase -> 未保存のケース; save -> 保存したケース。
export function createCaseEditor(repository, { requestId = () => crypto.randomUUID() } = {}) {
  let cases = [], categories = [], selected = null, draft = null, original = null;
  let category = '', status = 'current', sidebar = true, scrollTop = 0;
  let phase = 'idle', error = '', errors = {}, conflict = null, saveKey = null, saveFingerprint = null;
  const listeners = new Set();
  const dirty = () => draft !== null && JSON.stringify(draft) !== JSON.stringify(original);
  const busy = () => ['loading', 'creating', 'saving'].includes(phase);
  const emit = kind => { for (const listener of listeners) listener(kind); };
  function snapshot() {
    return copy({ cases, categories, selected, draft, category, status, sidebar, scrollTop, phase, error, errors, conflict, dirty: dirty() });
  }
  function guard(discard) {
    if (busy()) return false;
    if (dirty() && !discard) throw new UnsavedCaseError('未保存の入力があります。');
    return true;
  }
  function choose(record) {
    selected = record.id; draft = caseValues(record); original = copy(draft);
    errors = {}; error = ''; conflict = null; saveKey = saveFingerprint = null;
    phase = 'ready'; emit('select');
  }
  return {
    snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async load() {
      if (!guard(false)) return;
      phase = 'loading'; error = ''; emit('phase');
      try {
        const result = await repository.load();
        if (!Array.isArray(result?.cases) || !Array.isArray(result?.categories)) throw new Error('ケース一覧の形式が不正です。');
        const ids = new Set();
        for (const record of result.cases) {
          if (Object.keys(validateCase(record)).length || ids.has(record.id)) throw new Error('ケース一覧の形式が不正です。');
          ids.add(record.id);
        }
        cases = copy(result.cases); categories = [...new Set(result.categories.filter(value => typeof value === 'string' && value))];
        phase = 'ready'; emit('load');
      } catch (cause) { phase = 'load-error'; error = cause.message || 'ケースを取得できませんでした。'; emit('phase'); }
    },
    select(id, { discard = false } = {}) {
      if (id === selected) { emit('focus'); return true; }
      if (!guard(discard)) return false;
      const record = cases.find(item => item.id === id);
      if (!record) return false;
      choose(record); return true;
    },
    async create({ discard = false } = {}) {
      if (!guard(discard)) return false;
      phase = 'creating'; error = ''; emit('phase');
      try {
        const record = await repository.newCase();
        if (typeof record?.id !== 'string' || !record.id.trim() || cases.some(item => item.id === record.id)) throw new Error('ケースIDを用意できませんでした。');
        choose({ ...caseValues(), ...record, category, status: 'Draft' }); return true;
      } catch (cause) { phase = 'ready'; error = cause.message || 'ケースを追加できませんでした。'; emit('phase'); return false; }
    },
    edit(key, value) {
      if (busy() || !draft || key === 'id' || !CASE_FIELDS.includes(key)) return;
      draft[key] = String(value); delete errors[key]; error = ''; emit('input');
    },
    filter(next) {
      if (typeof next.category === 'string') category = next.category;
      if (['current', 'all', ...CASE_STATES].includes(next.status)) status = next.status;
      scrollTop = 0; emit('filter');
    },
    setScroll(value) { if (Number.isFinite(value) && value >= 0) scrollTop = value; },
    setSidebar(value) { sidebar = !!value; emit('layout'); },
    cancel({ discard = false } = {}) {
      if (!guard(discard)) return false;
      selected = null; draft = original = null; errors = {}; error = ''; conflict = null; sidebar = true; emit('cancel'); return true;
    },
    async save() {
      if (busy() || !draft) return false;
      errors = validateCase(draft); error = ''; conflict = null;
      if (Object.keys(errors).length) { emit('invalid'); return false; }
      const submitted = copy(draft), previous = cases.find(record => record.id === selected);
      const fingerprint = JSON.stringify([submitted, previous?.revision ?? null]);
      if (saveFingerprint !== fingerprint) { saveKey = requestId(); saveFingerprint = fingerprint; }
      phase = 'saving'; emit('phase');
      try {
        const saved = await repository.save({ values: copy(submitted), revision: previous?.revision ?? null, requestId: saveKey });
        if (saved?.id !== submitted.id || Object.keys(validateCase(saved)).length) throw new Error('保存結果を確認できませんでした。入力は残っています。');
        const index = cases.findIndex(record => record.id === saved.id);
        if (index < 0) cases.push(copy(saved)); else cases[index] = copy(saved);
        categories = [...new Set(cases.map(record => record.category).filter(Boolean))].sort();
        draft = caseValues(saved); original = copy(draft); phase = 'ready'; saveKey = saveFingerprint = null;
        emit('saved'); return true;
      } catch (cause) {
        phase = 'ready'; error = cause.message || '保存できませんでした。入力は残っています。';
        if (cause.status === 409 && cause.current) conflict = caseValues(cause.current);
        emit('save-error'); return false;
      }
    },
    visibleCases() {
      return copy(cases.filter(record => (!category || record.category === category) && (status === 'all' || status === 'current' && record.status !== 'Deprecated' || status === record.status)));
    },
  };
}

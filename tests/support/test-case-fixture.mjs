// UI・契約試験専用。製品の永続化アダプターではない。
export const fixtureCases = [
  { id:'TC-101',title:'日付で予約を絞り込む',category:'予約',status:'Active',steps:'1. 予約一覧を開く。\n2. 日付に「2026/12/01」を指定する。\n3. 「絞り込む」を押す。',expected:'対象の日付の予約だけが表示される。',preconditions:'12/1と12/2の予約を各2件登録している。' },
  { id:'TC-102',title:'満席の時間帯は予約できない',category:'予約',status:'Active',steps:'1. 満席の時間帯を選ぶ。\n2. 予約ボタンを確認する。',expected:'満席と表示され、予約ボタンは押せない。' },
  { id:'TC-103',title:'予約取消し後に空き枠が戻る',category:'予約',status:'Draft',steps:'1. 登録済みの予約を開く。\n2. 「予約を取り消す」を選ぶ。',expected:'取り消した枠を再び予約できる。' },
  { id:'TC-104',title:'支払い金額を税込で表示する',category:'決済',status:'Active',steps:'1. 税抜1,000円の商品を選ぶ。\n2. 支払い確認画面を開く。',expected:'合計が1,100円と表示される。' },
  { id:'TC-105',title:'予約変更の通知を送る',category:'通知',status:'Active',steps:'1. 登録済みの予約日時を変更する。\n2. 通知を確認する。',expected:'変更前と変更後の日時が通知に含まれる。' },
  { id:'TC-106',title:'旧決済画面でクーポンを使う',category:'決済',status:'Deprecated',steps:'1. 旧決済画面を開く。\n2. クーポンコードを入力する。',expected:'旧仕様の割引が適用される。' },
].map(record => ({purpose:'',preconditions:'',cleanup:'',priority:'',type:'Manual',reference:'',notes:'',revision:1,...record}));

export function memoryCaseRepository({ records = fixtureCases } = {}) {
  const cases = structuredClone(records), requests = [], receipts = new Map();
  let scenario = 'ok', sequence = 107;
  return {
    requests,
    setScenario(value) { scenario = value; },
    async load() { return { cases: structuredClone(cases), categories: ['予約','決済','通知'] }; },
    async newCase() { return { id: `TC-${sequence++}` }; },
    async save(request) {
      requests.push(structuredClone(request));
      await new Promise(resolve => setTimeout(resolve, 40));
      const action = scenario; scenario = 'ok';
      if (action === 'failure') throw new Error('保存できませんでした。入力は残っています。');
      const fingerprint = JSON.stringify([request.values,request.revision]);
      const receipt = receipts.get(request.requestId);
      if (receipt) {
        if (receipt.fingerprint !== fingerprint) throw new Error('同じ受付キーの内容が一致しません。');
        return structuredClone(receipt.record);
      }
      const index = cases.findIndex(record => record.id === request.values.id), previous = cases[index];
      if (action === 'conflict' && previous) { previous.expected = '別の担当者が保存した架空の期待結果。'; previous.revision++; }
      if ((previous?.revision ?? null) !== request.revision) throw Object.assign(new Error('別の変更が保存されています。入力を残したまま最新内容を確認してください。'), {status:409,current:structuredClone(previous)});
      const record = {...structuredClone(request.values),revision:(previous?.revision ?? 0)+1};
      if (index < 0) cases.push(record); else cases[index] = record;
      receipts.set(request.requestId,{fingerprint,record:structuredClone(record)});
      if (action === 'lost-response') throw new Error('保存結果の応答を受け取れませんでした。入力は残っています。');
      return structuredClone(record);
    },
  };
}

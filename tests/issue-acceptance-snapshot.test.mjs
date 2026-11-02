import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildSnapshot, validateSnapshot, attachSnapshot, parseSnapshotImport } from '../dist/github-snapshot.mjs';
import { issueAcceptancePending, releaseLifecycle } from '../dist/release-lifecycle.mjs';
import { main } from '../scripts/fetch-github-snapshot.mjs';
import { createGithubRefresher } from '../scripts/local-github-refresh.mjs';
import { restFixture, mockGh, QA_REPOSITORIES } from './local-github-fixture.mjs';
import { fixture } from './snapshot-fixture.mjs';

const repositoryUrl = QA_REPOSITORIES[0];
const at = '2026-10-03T12:00:00Z';
const incoming = changes => {
  const pages = restFixture(repositoryUrl);
  Object.assign(pages.issuePages[0][0], changes);
  return { repositoryUrl, fetchedAt: at, ...pages };
};

test('Issueの単独の受入行だけを読む。Milestoneの確認中と混同しない', () => {
  assert.equal(issueAcceptancePending('## 進行\r\n\r\n受入: 確認待ち\r\n'), true);
  for (const body of [null, '', '受入: 確認中', '受入: 済', '受入: 確認待ちの予定', '以下の例。受入: 確認待ち',
    '受入: 確認待ち\n受入: 済', '受入: 確認待ち\n受入: 確認待ち', '受入: 確認待ち\n受入: 不明']) {
    assert.equal(issueAcceptancePending(body), false, body);
  }
  assert.equal(releaseLifecycle({ description: '受入: 確認中' }).label, '受入確認中');
  assert.equal(releaseLifecycle({ description: '受入: 済' }).accepted, true);
});

test('引用・コード・HTML例の受入記録を数えず、例の外の単独行は読む', () => {
  const marker = '受入: 確認待ち', tick = String.fromCharCode(96);
  const examples = ['> ' + marker, '> 引用\n' + marker, '- 例\n' + marker, '1. 例\n' + marker,
    '    ' + marker, '\t' + marker, tick + marker + tick, '例 ' + tick + '\n' + marker + '\n' + tick,
    tick.repeat(4) + 'md\n' + tick.repeat(3) + '\n' + marker + '\n' + tick.repeat(4),
    '~~~text\n' + marker + '\n~~~',
    '<!--\n' + marker + '\n-->', '<pre>\n' + marker + '\n</pre>',
    '<details><summary>例</summary>\n<details>\n</details>\n' + marker + '\n</details>',
    '<div class="example">\n' + marker + '\n</div>',
    '<table>\n<tr><td>\n' + marker + '\n</td></tr>\n</table>'];
  for (const example of examples) {
    assert.equal(issueAcceptancePending(example), false, example);
    assert.equal(issueAcceptancePending(example + '\n\n' + marker), true, example);
  }
});

test('インラインコード内のHTML例で、その後の独立した受入行を隠さない', () => {
  const marker = '受入: 確認待ち', tick = String.fromCharCode(96);
  for (const token of ['<details>', '<pre>', '<code>', '<blockquote>', '<!--', '<div>']) {
    const example = '補足には ' + tick + token + tick + ' を使う。';
    assert.equal(issueAcceptancePending(example + '\n\n' + marker), true, token);
    assert.equal(issueAcceptancePending('例 ' + tick + '\n' + token + '\n' + tick + '\n\n' + marker), true, token);
  }
  const html = tick + '<code>' + tick + ' <details>\n' + marker + '\n</details>';
  assert.equal(issueAcceptancePending(html), false);
  assert.equal(issueAcceptancePending(html + '\n\n' + marker), true);
});

test('REST本文の取得済みfalseと未取得を区別し、本文そのものはsnapshotへ保存しない', () => {
  for (const body of ['受入: 確認待ち', '受入: 済', null, '']) {
    const result = buildSnapshot(incoming({body}));
    const item = result.items.find(i => i.kind === 'issue');
    assert.equal(item.acceptancePending, body === '受入: 確認待ち');
    assert.equal(Object.hasOwn(item, 'body'), false);
    assert.equal(result.items.find(i => i.kind === 'pull_request').acceptancePending, undefined);
  }
  for (const body of [undefined, {}, 17]) {
    const item = buildSnapshot(incoming({body})).items.find(i=>i.kind==='issue');
    assert.equal(Object.hasOwn(item, 'acceptancePending'), false);
  }
  assert.equal(Object.hasOwn(buildSnapshot(incoming({})).items.find(i=>i.kind==='issue'), 'acceptancePending'), false);
});

test('Closedの明示された終了理由だけを保持し、未取得とOpenから取り下げを推測しない', () => {
  for (const [state, reason, expected] of [
    ['closed', 'not_planned', true], ['closed', 'completed', false],
    ['closed', null, undefined], ['closed', undefined, undefined], ['closed', 'duplicate', undefined],
    ['open', 'not_planned', undefined], ['open', 'completed', undefined],
  ]) {
    const item=buildSnapshot(incoming({state,state_reason:reason,closed_at:state==='closed'?'2026-10-02T11:00:00Z':null})).items.find(i=>i.kind==='issue');
    assert.equal(item.notPlanned,expected);
    assert.equal(Object.hasOwn(item,'notPlanned'),expected!==undefined);
  }
});

test('旧snapshotの未取得を保ち、不正な受入値・終了理由とPRへの混入を拒否する', () => {
  const old=fixture(), copy=structuredClone(old);
  validateSnapshot(old);assert.deepEqual(old,copy);
  const issue=old.items[0];
  issue.acceptancePending=false;assert.equal(validateSnapshot(old).items[0].acceptancePending,false);
  for (const value of [null,'true',1]) {
    const bad=structuredClone(copy);bad.items[0].acceptancePending=value;
    assert.throws(()=>validateSnapshot(bad),/受入待ち/);
  }
  for (const value of [true,false,null,'true']) {
    const bad=structuredClone(copy);bad.items[0].notPlanned=value;
    assert.throws(()=>validateSnapshot(bad),/終了理由/);
  }
  for(const field of ['acceptancePending','notPlanned']){
    const bad=structuredClone(copy);bad.items[1][field]=true;
    assert.throws(()=>validateSnapshot(bad),/項目・形式/);
  }
  const project={id:'qa',repositoryUrl};
  attachSnapshot(project,buildSnapshot(incoming({body:'受入: 確認待ち',state_reason:'not_planned'})),Date.parse(at));
  const {projectId,...exported}=project.githubSnapshot;
  assert.equal(projectId,'qa');
  const imported=parseSnapshotImport(JSON.stringify(exported),Date.parse(at))[0];
  assert.equal(imported.items.find(i=>i.kind==='issue').acceptancePending,true);
  assert.equal(imported.items.find(i=>i.kind==='issue').notPlanned,true);
});

test('CLIのoffline入力にも同じ受入と終了理由の正規化を適用する', async () => {
  const dir=await mkdtemp(path.join(tmpdir(),'acceptance-cli-'));
  try{
    const input=path.join(dir,'input.json'), output=path.join(dir,'snapshot.json');
    await writeFile(input,JSON.stringify(incoming({body:'受入: 確認待ち',state_reason:'not_planned'})));
    await main(['--repo','qa-local/alpha','--output',output,'--from-pages',input]);
    const item=JSON.parse(await readFile(output,'utf8')).items.find(i=>i.kind==='issue');
    assert.equal(item.acceptancePending,true);assert.equal(item.notPlanned,true);
    assert.equal(Object.hasOwn(item,'body'),false);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('ローカル自動取得も既存のREST応答から受入記録を読み、API呼び出しを増やさない', async () => {
  const real=mockGh(),calls=[];
  const run=async(command,args,options)=>{
    calls.push(args);
    const response=await real(command,args,options);
    if(args.at(-1).includes('/issues?')){
      const records=JSON.parse(response.stdout);
      for(const record of records)if(!record.pull_request){record.body='受入: 確認待ち';record.state_reason='completed';}
      response.stdout=JSON.stringify(records);
    }
    return response;
  };
  const reader=createGithubRefresher({repositories:[repositoryUrl],run});
  const result=await reader.refresh(repositoryUrl);
  const item=result.items.find(i=>i.kind==='issue');
  assert.equal(item.acceptancePending,true);assert.equal(item.notPlanned,false);
  assert.equal(calls.length,4);
});

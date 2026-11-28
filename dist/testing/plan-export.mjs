import { createWorkbook } from './plan-workbook.mjs';

const workbookType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export function canExportPlan(plan) {
  return !!plan && ['Draft', 'In Progress'].includes(plan.state) &&
    plan.caseIds.length > 0 && plan.conditions.length > 0 &&
    plan.results.length === plan.caseIds.length * plan.conditions.length &&
    plan.results.every(result => result.status === 'Not Run' && result.recordedAt === null);
}

function exportContents(plan, cases) {
  if (!canExportPlan(plan)) throw new Error('結果を記録していない計画だけ書き出せます。');
  const byId = new Map(cases.map(testCase => [testCase.id, testCase]));
  const caseSections = plan.caseIds.map(id => {
    const testCase = byId.get(id);
    if (!testCase) throw new Error(`${id} が見つかりません。計画を再取得してください。`);
    return {
      heading: `${id}　${testCase.title}`,
      fields: [
        ['事前条件', testCase.preconditions],
        ['手順', testCase.steps],
        ['期待結果', testCase.expected],
        ['事後処理', testCase.cleanup],
      ].filter(([, value]) => value?.trim()),
    };
  });
  const metadata = [['計画ID', plan.id], ['対象バージョン', plan.version]];
  if (plan.build.trim()) metadata.push(['対象ビルド', plan.build]);
  const conditions = plan.conditions.map(({ os, version, model }) => `${os} ${version} ／ ${model}`);
  return {
    heading: plan.name, metadata, conditions, caseSections,
    instruction: `各実施条件で、下の${caseSections.length}ケースを上から順に実施する。`,
  };
}

function markdownText(text) {
  return text.replace(/[&<>]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[character])
    .replace(/[\\`*_{}\[\]#!|~+=-]/g, '\\$&');
}

function asMarkdown(contents) {
  const table = [
    '| 項目 | 内容 |',
    '| --- | --- |',
    ...contents.metadata.map(([label, value]) => `| ${label} | ${markdownText(value).replace(/\r?\n/g, '<br>')} |`),
    `| 実施条件 | ${contents.conditions.map(markdownText).join('<br>')} |`,
  ];
  return [
    `# ${markdownText(contents.heading)}`, table.join('\n'), contents.instruction,
    ...contents.caseSections.flatMap(({ heading, fields }) => [
      `## ${markdownText(heading)}`,
      ...fields.flatMap(([label, value]) => [`**${label}**`, markdownText(value).replace(/\r?\n/g, '  \n')]),
    ]),
    '',
  ].join('\n\n');
}

function workbookRows(contents) {
  return [
    { values: [contents.heading], heading: true },
    ...contents.metadata.map(values => ({ values })),
    { values: ['実施条件', contents.conditions.join('\n')] },
    { values: [contents.instruction], span: true },
    ...contents.caseSections.flatMap(({ heading, fields }) => [
      { values: [] }, { values: [heading], heading: true }, ...fields.map(values => ({ values })),
    ]),
  ];
}

export function exportPlan(plan, cases, format) {
  const contents = exportContents(plan, cases);
  const safeName = Array.from(plan.name.replace(/[\p{Cc}<>:"/\\|?*]/gu, '-')).slice(0, 64).join('').replace(/[.\s]+$/, '');
  const basename = safeName ? `${plan.id}-${safeName}` : plan.id;
  if (format === 'xlsx') {
    return { name: `${basename}.xlsx`, blob: new Blob(createWorkbook(workbookRows(contents)), { type: workbookType }) };
  }
  return { name: `${basename}.md`, blob: new Blob([asMarkdown(contents)], { type: 'text/markdown;charset=utf-8' }) };
}

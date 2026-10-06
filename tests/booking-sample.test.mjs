import test from 'node:test';
import assert from 'node:assert/strict';
import { bookingSampleWorkspace } from '../scripts/make-booking-sample.mjs';
import { validateWorkspace } from '../dist/workspace.mjs';

const workspace = bookingSampleWorkspace(new Date('2026-10-05T12:00:00Z'));
const planning = workspace.projects[0].githubSnapshot.planning;
const day = value => Date.parse(String(value).slice(0, 10));

test('試作データは検証を通り、GitHubの計画として保存される', () => {
  validateWorkspace(workspace);
  assert.equal(workspace.projects[0].repositoryUrl, 'https://github.com/example/booking-app');
});

test('期日を持つMilestoneが2件あり、どちらも期日より後のイテレーションに割り当てた作業を含む', () => {
  assert.equal(planning.milestones.length, 2);
  for (const milestone of planning.milestones) {
    assert.ok(milestone.dueOn, `${milestone.title}に期日がある`);
    const later = planning.issues.filter(issue => issue.milestoneNumber === milestone.number &&
      issue.projects.some(project => project.iteration && day(project.iteration.startDate) > day(milestone.dueOn)));
    assert.ok(later.length >= 1, `${milestone.title}に、期日より後の割当がある`);
  }
});

test('期日以内の割当、未割当、見積未設定、前提待ちも含み、はみ出しと区別できる', () => {
  const [r1] = planning.milestones;
  const inR1 = planning.issues.filter(issue => issue.milestoneNumber === r1.number && issue.childCount === 0);
  const onTime = inR1.filter(issue => issue.projects.some(p => p.iteration && day(p.iteration.startDate) <= day(r1.dueOn)));
  assert.ok(onTime.length >= 1);
  assert.ok(inR1.some(issue => issue.projects.every(p => !p.iteration)), '未割当の作業がある');
  assert.ok(inR1.some(issue => issue.projects.every(p => p.estimatePoints === null)), '見積未設定の作業がある');
  assert.ok(planning.issues.some(issue => issue.blockedBy.length > 0), '前提を持つ作業がある');
});

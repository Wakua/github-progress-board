import { githubScheduleInput } from './github-schedule-input.mjs';
import { calculateMilestoneSchedule } from './milestone-schedule.mjs';
import { githubPlan } from './github-planning.mjs';
import { githubWorkCategory } from './github-work.mjs';
import { todayInTokyo } from './engine.mjs';

export function ganttProjects(snapshot) {
  const projects = new Map();
  for (const issue of snapshot?.planning?.issues ?? []) for (const p of issue.projects) projects.set(p.id, { id:p.id, title:p.title, url:p.url });
  return [...projects.values()].sort((a,b) => a.title.localeCompare(b.title, 'ja') || a.id.localeCompare(b.id));
}
// No first-Project fallback: scheduling fields always have an explicit source.
export function releaseGanttModel(snapshot, { selectedProjectId, sourceProjectIds = {}, baseDate = todayInTokyo() } = {}) {
  if (!snapshot?.planning) return null;
  const projects = ganttProjects(snapshot);
  if (!projects.some(p => p.id === selectedProjectId)) return { projects, selectedProjectId:null, input:null, result:null };
  const input = githubScheduleInput(snapshot, { selectedProjectId, sourceProjectIds, baseDate });
  const result = calculateMilestoneSchedule(input);
  const plan = githubPlan(snapshot);
  const records = new Map((snapshot.planning.schedule?.issues ?? []).map(i => [i.key,i]));
  const items = new Map(snapshot.items.filter(i => i.kind === 'issue').map(i => [i.url.toLowerCase(), i]));
  const tasks = new Map(plan.tasks.map(t => [t.item.url.toLowerCase(), t]));
  const groups = { done:'完了・Closed', action:'要対応', active:'作業中', waiting:'前提待ち', review:'確認待ち', ready:'着手可能' };
  const localPrefix = snapshot.repositoryUrl.toLowerCase() + '/issues/';
  input.issues = input.issues.map(issue => {
    const metadata = records.get(issue.key), item = items.get(issue.key), task = tasks.get(issue.key);
    const external = !issue.key.startsWith(localPrefix);
    const identity = external ? issue.key.replace('https://github.com/','').replace('/issues/','#') : '#' + issue.key.split('/').at(-1);
    return { ...issue, title: identity + ' ' + (metadata?.title ?? item?.title ?? '未取得'),
      external, projects: metadata?.projects ?? [], category: task ? groups[githubWorkCategory(plan,task,snapshot.repositoryUrl,baseDate).group] : external ? '対象repository外' : '集約Issue' };
  });
  input.milestones = input.milestones.map(m => ({...m, title: snapshot.planning.milestones.find(p => p.url.toLowerCase() === m.key)?.title ?? m.key}));
  return { projects, selectedProjectId, input, result };
}


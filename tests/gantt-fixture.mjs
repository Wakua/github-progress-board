import { samples } from '../docs/prototypes/milestone-gantt-samples.mjs';
import { SCHEDULE_FIELDS } from '../dist/github-schedule-data.mjs';
import { validateSnapshot } from '../dist/github-snapshot.mjs';
export const repositoryUrl = 'https://github.com/example/gantt-sample';
const ref = key => ({number:Number(key.split('/').at(-1)),url:key});
function collapseInput() {
  const input = structuredClone(samples.basic.input);
  const issueKey = n => repositoryUrl + '/issues/' + n;
  const links = numbers => ({ keys: numbers.map(issueKey), totalCount: numbers.length, complete: true, problem: null });
  function add(n, title, parent, children, after = []) {
    const issue = structuredClone(input.issues.find(i => i.key === issueKey(children.length ? 200 : 201)));
    Object.assign(issue, { key: issueKey(n), title, parent: { value: parent ? issueKey(parent) : null, problem: null }, children: links(children), blockedBy: links(after) });
    issue.planning.owner.value = title;
    input.issues.push(issue);
    return issue;
  }
  add(300, '通知', null, [305]);
  add(305, 'メール通知', 300, [301]);
  add(301, '配信処理', 305, []);
  add(401, '稼働確認', null, [], [201]).planning.workProgressPercent.value = null;
  input.milestones[0].tasks = links([201, 202, 210, 301]);
  Object.assign(input.milestones[1], { title: 'リリースB', state: 'open', dueDate: '2026-11-15', tasks: links([401]) });
  return input;
}
function releaseGoalsInput(dependencies) {
  const input = collapseInput();
  const issue = n => input.issues.find(i => i.key.endsWith('/' + n));
  const goal = issue(200), crossRelease = issue(401);
  goal.title = '予約の変更を受け付ける';
  issue(300).title = '予約の結果を通知する';
  issue(201).title = '変更内容を保存する';
  issue(202).title = '変更履歴を表示する';
  issue(301).title = '予約完了メールを送る';
  crossRelease.title = '変更通知を再送する';
  goal.children.keys.push(crossRelease.key);
  goal.children.totalCount++;
  crossRelease.parent.value = goal.key;
  issue(201).planning.workProgressPercent.value = 100;
  issue(202).planning.workProgressPercent.value = 80;
  issue(301).planning.workProgressPercent.value = 0;
  if (dependencies) {
    issue(202).blockedBy = {keys:[issue(201).key], totalCount:1, complete:true, problem:null};
    issue(301).blockedBy = {keys:[issue(201).key,issue(202).key], totalCount:2, complete:true, problem:null};
  }
  return input;
}
export function ganttSnapshot(name = 'basic', progress = null, fetchedAt = '2026-10-31T00:00:00Z') {
  const input = ['goals','dependencies','inherited'].includes(name) ? releaseGoalsInput(name === 'dependencies') : name === 'collapse' ? collapseInput() : structuredClone(samples[name].input);
  const updatedAt = '2026-10-30T00:00:00Z';
  if (progress !== null) for(const i of input.issues) if(i.planning.workProgressPercent.value !== null) i.planning.workProgressPercent.value = progress;
  const toProject = i => {
    const p=i.planning;
    return { id:p.sourceProjectId, title:p.sourceProjectId==='sample-project'?'予約管理 開発':'共通基盤', url:'https://github.com/users/example/projects/'+(p.sourceProjectId==='sample-project'?1:2),
      fieldSources:Object.fromEntries(Object.entries(SCHEDULE_FIELDS).map(([k,name])=>[k,{id:p.sourceProjectId+'-'+k,name}])),
      ...Object.fromEntries(Object.keys(SCHEDULE_FIELDS).map(k=>[k,structuredClone(p[k])])) };
  };
  const rows = input.issues.map(i=>({ key:i.key,title:i.title,updatedAt,state:i.state,parent:i.parent,children:i.children,blockedBy:i.blockedBy,projects:[toProject(i)],projectsComplete:true,projectsProblem:null }));
  const local = input.issues.filter(i=>i.key.startsWith(repositoryUrl+'/issues/'));
  const milestoneNumbers = new Map(input.milestones.flatMap(m => m.tasks.keys.map(key => [key, Number(m.key.split('/').at(-1))])));
  if (name === 'inherited') {
    milestoneNumbers.clear();
    for (const [issue, milestone] of [[200, 1], [300, 1], [401, 2]]) {
      milestoneNumbers.set(repositoryUrl + '/issues/' + issue, milestone);
    }
  }
  const snapshot = {schemaVersion:1,source:'github',repositoryUrl,fetchedAt,
    sources: { issues:{complete:true,urls:['https://api.github.com/repos/example/gantt-sample/issues?state=all&per_page=100&sort=updated&direction=desc&page=1']},pullRequests:{complete:true,urls:['https://api.github.com/repos/example/gantt-sample/pulls?state=all&per_page=100&sort=updated&direction=desc&page=1']}},
    items:local.map(i=>({kind:'issue',...ref(i.key),title:i.title,state:i.state.value,updatedAt,closedAt:i.state.value==='closed'?updatedAt:null,estimatePoints:null,deadline:null})),
    planning: {sources:{hierarchy:{complete:true,url:'https://api.github.com/graphql'},milestones:{complete:true,urls:['https://api.github.com/repos/example/gantt-sample/milestones?state=all&per_page=100&sort=due_on&direction=asc&page=1']}},
      issues:local.map(i=>({number:ref(i.key).number,parent:i.parent.value?ref(i.parent.value):null,childCount:i.children.keys.length,
        milestoneNumber:milestoneNumbers.get(i.key) ?? null,
        projects:[{id:i.planning.sourceProjectId,title:toProject(i).title,url:toProject(i).url,status:i.planning.status.value,owner:i.planning.owner.value,estimatePoints:i.planning.estimatePoints.value,priority:null,
          iteration:{id:'It-'+i.planning.iteration.value.startDate+'-'+i.planning.iteration.value.endDate,title:'It',startDate:i.planning.iteration.value.startDate,duration:Math.round((Date.parse(i.planning.iteration.value.endDate)-Date.parse(i.planning.iteration.value.startDate))/86400000)+1}}],
        blockedBy:i.blockedBy.keys.map(k=>({...ref(k),title:input.issues.find(x=>x.key===k)?.title||k,state:input.issues.find(x=>x.key===k)?.state.value||'open',spec:false})),pullRequests:[],spec:false})),
      milestones:input.milestones.map(m=>({number:Number(m.key.split('/').at(-1)),url:m.key,title:m.title,description:null,state:m.state,dueOn:m.dueDate?m.dueDate+'T00:00:00Z':null,updatedAt,closedAt:m.state==='closed'?updatedAt:null})),
      schedule:{schemaVersion:1,sourceUrl:'https://api.github.com/graphql',issues:rows} }};
  validateSnapshot(snapshot);
  return snapshot;
}

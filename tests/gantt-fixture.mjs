import { samples } from '../docs/prototypes/milestone-gantt-samples.mjs';
import { SCHEDULE_FIELDS } from '../dist/github-schedule-data.mjs';
import { validateSnapshot } from '../dist/github-snapshot.mjs';
export const repositoryUrl = 'https://github.com/example/gantt-sample';
const ref = key => ({number:Number(key.split('/').at(-1)),url:key});
export function ganttSnapshot(name = 'basic', progress = null, fetchedAt = '2026-10-31T00:00:00Z') {
  const input = structuredClone(samples[name].input);
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
  const snapshot = {schemaVersion:1,source:'github',repositoryUrl,fetchedAt,
    sources: { issues:{complete:true,urls:['https://api.github.com/repos/example/gantt-sample/issues?state=all&per_page=100&sort=updated&direction=desc&page=1']},pullRequests:{complete:true,urls:['https://api.github.com/repos/example/gantt-sample/pulls?state=all&per_page=100&sort=updated&direction=desc&page=1']}},
    items:local.map(i=>({kind:'issue',...ref(i.key),title:i.title,state:i.state.value,updatedAt,closedAt:i.state.value==='closed'?updatedAt:null,estimatePoints:null,deadline:null})),
    planning: {sources:{hierarchy:{complete:true,url:'https://api.github.com/graphql'},milestones:{complete:true,urls:['https://api.github.com/repos/example/gantt-sample/milestones?state=all&per_page=100&sort=due_on&direction=asc&page=1']}},
      issues:local.map(i=>({number:ref(i.key).number,parent:i.parent.value?ref(i.parent.value):null,childCount:i.children.keys.length,
        milestoneNumber:input.milestones.find(m=>m.tasks.keys.includes(i.key))?1:null,
        projects:[{id:i.planning.sourceProjectId,title:toProject(i).title,url:toProject(i).url,status:i.planning.status.value,owner:i.planning.owner.value,estimatePoints:i.planning.estimatePoints.value,priority:null,
          iteration:{id:'It-'+i.planning.iteration.value.startDate+'-'+i.planning.iteration.value.endDate,title:'It',startDate:i.planning.iteration.value.startDate,duration:Math.round((Date.parse(i.planning.iteration.value.endDate)-Date.parse(i.planning.iteration.value.startDate))/86400000)+1}}],
        blockedBy:i.blockedBy.keys.map(k=>({...ref(k),title:input.issues.find(x=>x.key===k)?.title||k,state:input.issues.find(x=>x.key===k)?.state.value||'open',spec:false})),pullRequests:[],spec:false})),
      milestones:input.milestones.map(m=>({number:Number(m.key.split('/').at(-1)),url:m.key,title:m.title,description:null,state:m.state,dueOn:m.dueDate?m.dueDate+'T00:00:00Z':null,updatedAt,closedAt:m.state==='closed'?updatedAt:null})),
      schedule:{schemaVersion:1,sourceUrl:'https://api.github.com/graphql',issues:rows} }};
  validateSnapshot(snapshot);
  return snapshot;
}

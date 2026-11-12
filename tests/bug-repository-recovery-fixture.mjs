import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
export async function setup(root) {
 const data=await mkdtemp(path.join(tmpdir(),'bug-repository-recovery-')),args=[...process.argv];
 process.argv=[args[0],args[1],data,'0',root];
 const fixture=await import(pathToFileURL(path.join(root,'tests/bug-screens-server.mjs')).href);process.argv=args;
 const {createProgressServer}=await import(pathToFileURL(path.join(root,'server.mjs')).href);
 await fixture.server.bugWorker.stop();
 const store=fixture.server.bugStore,reports=store.listReports(store.sharedActor());
 const pending=reports.find(r=>r.title==='予約の確認メールの日付が1日ずれる');
 const creating=reports.find(r=>r.title==='予約一覧が更新されない');
 const unknown=reports.find(r=>r.title==='日付を選ぶと一覧が空になる');
 store.db.prepare('UPDATE registration_queue SET repository=? WHERE report_id=?').run(fixture.github.repository,pending.id);
 for(const [report,state] of [[creating,'creating'],[unknown,'unknown']])store.db.prepare('UPDATE registration_queue SET state=?,attempted_at=?,issue_number=NULL,issue_url=NULL,revision=revision+1 WHERE report_id=?').run(state,Date.now()-120000,report.id);
 const originals=await fixture.github.listIssues();
 for(const report of [creating,unknown])originals.get(report.github.number).body=fixture.server.bugWorker.marker(report.id)+'\n'+report.body;
 const issues=[],calls=[];
 const github={repository:'qa-fixture/booking-reports-next',getLabel:fixture.github.getLabel,
  async createIssue(title,body,labelNames=[]) {calls.push({kind:'create',title});const number=201+issues.length,issue={number,title,body,html_url:'https://github.com/'+github.repository+'/issues/'+number,labels:await Promise.all(labelNames.map(name=>github.getLabel(name)))};issues.push(issue);return issue;},
  async findIssues(marker){calls.push({kind:'find',marker});return issues.filter(i=>i.body.startsWith(marker+'\n'));},
  async getIssue(number){calls.push({kind:'get',number});return issues.find(i=>i.number===number);},
  async listIssues(){return new Map(issues.map(i=>[i.number,i]));}
 };
 let server=fixture.server;
 async function restart(client) {await new Promise(resolve=>server.close(resolve));await server.bugClosed;server=createProgressServer({repositories:[],dataDir:data,githubRepository:client.repository,githubClient:client});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return 'http://127.0.0.1:'+server.address().port;}
 const origin=await restart(github);
 return {data,origin,pending,creating,unknown,github,original:fixture.github,calls,issues,restart,get server(){return server;},async close(){await new Promise(resolve=>server.close(resolve));await server.bugClosed;}};
}
if(process.env.QA_OBSERVE==='1') {const fx=await setup(process.env.QA_PRODUCT_ROOT);console.log(JSON.stringify({origin:fx.origin,data:fx.data,pending:fx.pending.id,creating:fx.creating.id,unknown:fx.unknown.id}));}

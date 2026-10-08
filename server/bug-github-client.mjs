import {execFile} from 'node:child_process';
import {normalizeRepositoryUrl} from '../dist/workspace.mjs';
export function parseBugRepository(value = '') {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new Error('BUG_REPORTING_GITHUB_REPOをowner/repositoryで指定してください。');
  const repository = value.trim();
  if (!repository) return null;
  try { return normalizeRepositoryUrl(repository.startsWith('https://') ? repository : 'https://github.com/' + repository).slice(19); }
  catch { throw new Error('BUG_REPORTING_GITHUB_REPOをowner/repositoryで指定してください。'); }
}
export class GitHubFailure extends Error {
  constructor(message,{status=0,headers={},uncertain=false}={}) {super(message);Object.assign(this,{status,headers,uncertain});}
}
export function parseResponse(output) {
  const match=/^HTTP\/\S+ (\d{3})[^\r\n]*\r?\n([\s\S]*?)\r?\n\r?\n([\s\S]*)$/.exec(output);
  if(!match) throw new GitHubFailure('GitHubの応答を確認できません。',{uncertain:true});
  const headers={};
  for(const line of match[2].split(/\r?\n/)){const colon=line.indexOf(':');if(colon>0)headers[line.slice(0,colon).toLowerCase()]=line.slice(colon+1).trim();}
  let data;try{data=JSON.parse(match[3]);}catch{throw new GitHubFailure('GitHubの応答を確認できません。',{status:Number(match[1]),headers,uncertain:true});}
  return {status:Number(match[1]),headers,data};
}
export async function runGh(args,input) {
  return new Promise((resolve,reject)=>{
    const child=execFile('gh',args,{encoding:'utf8',timeout:30000,maxBuffer:12*1024**2,windowsHide:true},(error,stdout)=>{
      if(!stdout) {reject(new GitHubFailure('GitHubへ接続できません。',{uncertain:true}));return;}
      try {resolve(parseResponse(stdout));}catch(failure){reject(failure);}
    });
    child.stdin.on('error',()=>{});child.stdin.end(input);
  });
}
export function validateIssue(issue,repository) {
  if(!issue || issue.pull_request || !Number.isSafeInteger(issue.number) || issue.number<1 ||
    typeof issue.html_url!=='string' || issue.html_url.toLowerCase()!==('https://github.com/'+repository+'/issues/'+issue.number).toLowerCase() || (typeof issue.body!=='string'&&issue.body!==null)) throw new GitHubFailure('GitHub Issueの接続先または内容を確認できません。',{uncertain:true});
  return {...issue,body:issue.body??''};
}
export function validateLabels(labels) {
  if(!Array.isArray(labels)) throw new GitHubFailure('タグの応答を確認できません。');
  const result=labels.map(label=>{
    if(!label || !Number.isSafeInteger(label.id) || label.id<1 || typeof label.name!=='string' || !label.name || label.name.length>100 || !/^[0-9a-f]{6}$/i.test(label.color)) throw new GitHubFailure('タグの応答を確認できません。');
    return {id:label.id,name:label.name,color:label.color.toLowerCase()};
  });
  if(new Set(result.map(label=>label.id)).size!==result.length || new Set(result.map(label=>label.name)).size!==result.length) throw new GitHubFailure('タグの応答が重複しています。');
  return result;
}
export class GitHubClient {
  constructor(repository,{run=runGh}={}) {
    const configured = parseBugRepository(repository);
    if (!configured) throw new Error('GitHubの接続先を設定してください。');
    this.repository=configured;this.run=run;
  }
  async request(method,route,body) {
    const allowed=method==='POST' ? route==='issues' :
      method==='GET' && (/^issues\/\d+$/.test(route)||/^issues\?state=all&sort=created&direction=desc&per_page=100&page=\d+$/.test(route));
    if(!allowed)throw new Error('許可されたGitHub操作ではありません。');
    const args=['api','--hostname','github.com','--method',method,'--include','-H','Accept: application/vnd.github+json','-H','X-GitHub-Api-Version: 2022-11-28','repos/'+this.repository+'/'+route];
    if(body)args.push('--input','-');
    const response=await this.run(args,body?JSON.stringify(body):undefined);
    if(response.status<200 || response.status>=300) {
      const status=response.status;
      let message=status===401||status===403?'GitHubの権限または利用制限を確認してください。':status===404?'GitHubリポジトリまたはIssueを確認してください。':status===429?'GitHubの利用制限に達しました。':status===400||status===422?'GitHubへの報告内容を確認してください。':'GitHubの処理を完了できませんでした。';
      const headers={...response.headers};
      if(typeof response.data?.message==='string' && /rate limit/i.test(response.data.message))headers['rate-limited']='true';
      throw new GitHubFailure(message,{status,headers,uncertain:method==='POST'&&status>=500});
    }
    return response.data;
  }
  async createIssue(title,body) {return validateIssue(await this.request('POST','issues',{title,body}),this.repository);}
  async getIssue(number) {
    if(!Number.isSafeInteger(number)||number<1)throw new Error('Issue番号が不正です。');
    return validateIssue(await this.request('GET','issues/'+number),this.repository);
  }
  // 識別子を持つIssueを、新しい順の一覧から探す。createdAfterより1時間以上古いIssueに達したら、それ以前は読まない。
  async findIssues(marker,{createdAfter}={}) {
    const found=new Map(),bound=createdAfter?Date.parse(createdAfter)-3600000:NaN;
    for(let page=1;page<=50;page++){
      const items=await this.request('GET','issues?state=all&sort=created&direction=desc&per_page=100&page='+page);
      if(!Array.isArray(items)||items.length>100)throw new GitHubFailure('Issue一覧の応答を確認できません。');
      for(const item of items) {
        if(item.pull_request)continue;
        validateIssue({...item,body:item.body??''},this.repository);
        if(typeof item.body==='string'&&item.body.startsWith(marker+'\n'))found.set(item.number,item);
      }
      if(items.length<100||Date.parse(items.at(-1).created_at)<bound)return [...found.values()];
    }
    throw new GitHubFailure('Issue一覧を全件取得できませんでした。照合結果を確定しません。');
  }
}

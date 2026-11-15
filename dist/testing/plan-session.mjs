import {planValues,clone} from './plan-model.mjs';
// 応答断を含む同じ操作の再試行には、同じ受付キーと入力を使う。
export function createPlanSession(repository,{requestId=()=>crypto.randomUUID()}={}) {
 let pending=null,busy=false;
 return {
  load:()=>repository.load(),newPlan:()=>repository.newPlan(),
  async save(plan,{action='save',acknowledgeWarnings=false}={}){
   if(busy)throw new Error('保存中です。');
   const packet={action,values:planValues(plan),revision:plan.revision??null,acknowledgeWarnings};
   const fingerprint=JSON.stringify(packet);
   if(pending?.fingerprint!==fingerprint)pending={fingerprint,packet:{...packet,requestId:requestId()}};
   busy=true;
   try{const result=await repository.save(clone(pending.packet));pending=null;return result;}
   finally{busy=false;}
  }
 };
}

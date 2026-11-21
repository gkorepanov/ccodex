import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import {spawn} from 'node:child_process';
const args=JSON.parse(process.argv[3].startsWith('@')?fs.readFileSync(process.argv[3].slice(1),'utf8'):process.argv[3]);
if(!['continue','finish'].includes(process.argv[2])||!args.require_native||args.expected_native_pid!==Number(process.env.FAKE_PEER_OWNER_PID))throw Error('Expected native-only, same-owner delivery');
const jobId=crypto.createHash('sha256').update(args.request_id).digest('hex').slice(0,32),root=process.env.CLAUDE_BRIDGE_STATE;
fs.mkdirSync(root,{recursive:true});const file=path.join(root,jobId+'.json');
const writeJob=(f,j)=>{const t=f+'.'+process.pid+'.tmp';fs.writeFileSync(t,JSON.stringify(j),{mode:0o600});fs.renameSync(t,f)};
const transcript=process.env.FAKE_PEER_TRANSCRIPT;
if(process.argv[2]==='finish'){
 setTimeout(()=>{
  const group=fs.readdirSync(root).filter(f=>/^[a-f0-9]{32}\.json$/.test(f)).map(f=>JSON.parse(fs.readFileSync(path.join(root,f)))).filter(j=>j.job_id===jobId||j.steer_of===jobId);
  const answer='app: '+group.map(j=>j.prompt).join(' | '),tail=fs.readFileSync(transcript,'utf8').trim().split('\n').map(JSON.parse).findLast(x=>x.uuid);
  fs.appendFileSync(transcript,JSON.stringify({type:'assistant',uuid:crypto.randomUUID(),parentUuid:tail.uuid,sessionId:args.session_id,timestamp:new Date().toISOString(),message:{role:'assistant',model:'claude-opus-5-5',id:'msg_peer_'+jobId,content:[{type:'text',text:answer}],stop_reason:'end_turn'}})+'\n');
  for(const j of group){Object.assign(j,{status:'completed',result:answer});writeJob(path.join(root,j.job_id+'.json'),j);}
 },Number(process.env.FAKE_PEER_DELAY??150));
}else if(fs.existsSync(file))console.log(fs.readFileSync(file,'utf8'));
else{
 const uuid=crypto.randomUUID(),promptId=crypto.randomUUID(),marker='[Codex bridge request '+jobId+']\n';
 const job={...args,job_id:jobId,status:'running',transport:'native_peer',delivery_message_uuid:uuid};writeJob(file,job);
 fs.appendFileSync(process.env.FAKE_PEER_SENDS,JSON.stringify({requestId:args.request_id,owner:args.expected_native_pid})+'\n');
 const last=fs.readFileSync(transcript,'utf8').trim().split('\n').map(JSON.parse).findLast(x=>x.uuid);
 const at=new Date().toISOString(),body=marker+(args.steer_of?'[Codex bridge steer '+args.steer_of+']\n':'')+args.prompt;
 const origin={kind:'peer',from:'bridge:codex',name:'Codex session bridge',msg_id:jobId,body};
 fs.appendFileSync(transcript,JSON.stringify(args.steer_of?{type:'attachment',uuid:crypto.randomUUID(),parentUuid:last.uuid,sessionId:args.session_id,timestamp:at,attachment:{type:'queued_command',source_uuid:uuid,origin,prompt:body}}:{type:'user',uuid,parentUuid:last.uuid,sessionId:args.session_id,promptId,timestamp:at,cwd:'/work',message:{role:'user',content:body},origin})+'\n');
 if(!args.steer_of){const child=spawn(process.execPath,[process.argv[1],'finish',JSON.stringify(args)],{env:process.env,stdio:'ignore',detached:true});child.unref();}
 console.log(JSON.stringify(job));
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { createYdbRequestStore } from './ydb-request-store.mjs';

function fakeSql() {
  const receipts = new Map(), replies = new Map(), audit = new Map(), calls = [];
  async function execute(strings, ...values) {
    const query = strings.join(' ? ').replace(/\s+/g, ' ').trim(); calls.push(query);
    if (query.startsWith('SELECT event_digest FROM standby_max_webhook_events')) {
      const row=receipts.get(values[0]); return row ? [[{event_digest:row.event_digest}]] : [];
    }
    if (query.startsWith('INSERT INTO standby_max_webhook_events')) {
      const [digest,eventType,eventTimestamp,chatId,messageId,senderId,receivedAt]=values;
      receipts.set(digest,{event_digest:digest,event_type:eventType,event_timestamp:eventTimestamp,chat_id:chatId,message_id:messageId,sender_user_id:senderId,received_at:receivedAt}); return [];
    }
    if (query.startsWith('INSERT INTO standby_max_command_replies')) {
      const [digest,kind,actor,text,status,created,next,lock,lease,attempts,error]=values;
      if(replies.has(digest)) throw new Error('duplicate reply');
      replies.set(digest,{event_digest:digest,command_kind:kind,actor_id:actor,reply_text:text,status,created_at:created,next_attempt_at:next,lock_until:lock,lease_token:lease,attempts,last_error:error}); return [];
    }
    if (query.startsWith('INSERT INTO standby_operator_audit_events')) {
      const [id,occurred,actor,action,target,metadata]=values;
      audit.set(id,{event_id:id,occurred_at:occurred,actor_id:actor,action,target_id:target,metadata}); return [];
    }
    if (query.startsWith('SELECT event_digest FROM standby_max_command_replies')) {
      const [now]=values;
      const rows=[...replies.values()].filter(row=>query.includes("status = 'queued'") ? row.status==='queued'&&row.next_attempt_at<=now : row.status==='sending'&&row.lock_until!==''&&row.lock_until<=now).map(row=>({event_digest:row.event_digest}));
      return [rows];
    }
    if (query.startsWith('SELECT * FROM standby_max_command_replies')) {
      const row=replies.get(values[0]); return row ? [[{...row}]] : [];
    }
    if (query.startsWith('SELECT status, lease_token, attempts FROM standby_max_command_replies')) {
      const row=replies.get(values[0]); return row ? [[{status:row.status,lease_token:row.lease_token,attempts:row.attempts}]] : [];
    }
    if (query.startsWith('SELECT status, lease_token FROM standby_max_command_replies')) {
      const row=replies.get(values[0]); return row ? [[{status:row.status,lease_token:row.lease_token}]] : [];
    }
    if (query.startsWith("UPDATE standby_max_command_replies SET status = 'sending'")) {
      const [until,token,digest]=values; const row=replies.get(digest); if(row) Object.assign(row,{status:'sending',lock_until:until,lease_token:token}); return [];
    }
    if (query.startsWith("UPDATE standby_max_command_replies SET status = 'sent'")) {
      const [at,digest]=values; const row=replies.get(digest); if(row) Object.assign(row,{status:'sent',next_attempt_at:at,lock_until:'',lease_token:'',last_error:''}); return [];
    }
    if (query.startsWith('UPDATE standby_max_command_replies SET status =')) {
      const [status,attempts,next,error,digest]=values; const row=replies.get(digest); if(row) Object.assign(row,{status,attempts,next_attempt_at:next,lock_until:'',lease_token:'',last_error:error}); return [];
    }
    if (query.startsWith('DELETE FROM standby_max_command_replies ON')) {
      const [cutoff,limit]=values; const rows=[...replies.values()].filter(row=>row.status==='sent'&&row.created_at<cutoff).slice(0,Number(limit)); for(const row of rows) replies.delete(row.event_digest); return [];
    }
    return [];
  }
  execute.begin=async(_options,callback)=>callback(execute);
  return {sql:execute,receipts,replies,audit,calls};
}
const event=(digest='a'.repeat(64),reply={})=>({digest,eventType:'message_created',eventTimestamp:1800000000000,chatId:'987654321',messageId:'mid-1',senderUserId:'12345',reply:{commandKind:'help',actorId:'12345',text:'Help without private data',auditEvent:{eventId:'audit-event-0001',targetId:'group'},...reply}});

test('MAX webhook receipt, command reply and audit are atomically idempotent',async()=>{
  const fake=fakeSql(),store=createYdbRequestStore({sql:fake.sql,clock:()=>1800000000000});
  await store.ensureMaxWebhookSchema(); await store.ensureMaxCommandReplySchema();
  assert.deepEqual(await store.recordMaxWebhookEvent(event()),{duplicate:false,queuedReply:true});
  assert.deepEqual(await store.recordMaxWebhookEvent(event()),{duplicate:true});
  assert.equal(fake.receipts.size,1); assert.equal(fake.replies.size,1); assert.equal(fake.audit.size,1);
  assert.equal(fake.replies.get('a'.repeat(64)).reply_text,'Help without private data');
  assert.equal(fake.audit.get('audit-event-0001').action,'max.command.help');
  assert.equal(JSON.stringify(fake.replies.get('a'.repeat(64))).includes('phone'),false);
});

test('outbox leases fence stale workers and successful delivery completes once',async()=>{
  const fake=fakeSql(); let id=0;
  const store=createYdbRequestStore({sql:fake.sql,clock:()=>1800000000000,idFactory:()=> 'lease-'+(++id)});
  await store.recordMaxWebhookEvent(event());
  const [first]=await store.claimDueMaxCommandReplies({now:1800000000000,limit:10,leaseMs:1000});
  assert.equal(first.leaseToken,'lease-1');
  assert.equal(await store.completeMaxCommandReply({eventDigest:first.eventDigest,leaseToken:'stale',now:1800000000100}),null);
  assert.equal((await store.completeMaxCommandReply({eventDigest:first.eventDigest,leaseToken:first.leaseToken,now:1800000000100})).status,'sent');
  assert.equal(fake.replies.get(first.eventDigest).status,'sent');
  assert.equal(await store.claimDueMaxCommandReplies({now:1800000000200}),[]);
});

test('failed delivery is rescheduled with bounded retry and eventually dead-lettered',async()=>{
  const fake=fakeSql(); let id=0;
  const store=createYdbRequestStore({sql:fake.sql,clock:()=>1800000000000,idFactory:()=> 'lease-'+(++id)});
  await store.recordMaxWebhookEvent(event());
  const [first]=await store.claimDueMaxCommandReplies({now:1800000000000});
  const retry=await store.failMaxCommandReply({eventDigest:first.eventDigest,leaseToken:first.leaseToken,errorCode:'max_network_error',retryable:true,now:1800000000000,retryBaseMs:5000,maxAttempts:2});
  assert.equal(retry.status,'queued'); assert.equal(Date.parse(retry.nextAttemptAt),1800000005000);
  assert.deepEqual(await store.claimDueMaxCommandReplies({now:1800000001000}),[]);
  const [second]=await store.claimDueMaxCommandReplies({now:1800000005000});
  const dead=await store.failMaxCommandReply({eventDigest:second.eventDigest,leaseToken:second.leaseToken,errorCode:'max_network_error',retryable:true,now:1800000005000,retryBaseMs:5000,maxAttempts:2});
  assert.equal(dead.status,'dead'); assert.equal(fake.replies.get(first.eventDigest).last_error,'max_network_error');
});

test('outbox rejects unsafe reply data and invalid lease/retry inputs',async()=>{
  const store=createYdbRequestStore({sql:fakeSql().sql});
  await assert.rejects(()=>store.recordMaxWebhookEvent(event('b'.repeat(64),{text:'x'.repeat(4001)})),/reply text/);
  await assert.rejects(()=>store.claimDueMaxCommandReplies({limit:0}),/limit/);
  await assert.rejects(()=>store.failMaxCommandReply({eventDigest:'c'.repeat(64),leaseToken:'x',errorCode:'unsafe error'}),/error code/);
});

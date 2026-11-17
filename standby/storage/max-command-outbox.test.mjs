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
      const [digest,kind,actor,text,created,next]=values;
      if(replies.has(digest)) throw new Error('duplicate reply');
      replies.set(digest,{event_digest:digest,command_kind:kind,actor_id:actor,reply_text:text,status:'queued',created_at:created,next_attempt_at:next,lock_until:'',lease_token:'',attempts:0,last_error:''}); return [];
    }
    if (query.startsWith('INSERT INTO standby_operator_audit_events')) {
      if (values.length === 7) {
        const [id,occurred,actor,action,targetType,targetId,metadata]=values;
        audit.set(id,{event_id:id,occurred_at:occurred,actor_id:actor,actor_role:'operator',action,target_type:targetType,target_id:targetId,outcome:'accepted',metadata});
      } else if (values.length === 5) {
        const [id,occurred,actor,targetId,metadata]=values;
        const outcome=query.includes("'failed'")?'failed':'accepted';
        audit.set(id,{event_id:id,occurred_at:occurred,actor_id:actor,actor_role:'operator',action:'max.command.delivery',target_type:'max_command',target_id:targetId,outcome,metadata});
      } else {
        const [id,occurred,actor,role,action,targetType,targetId,outcome,metadata]=values;
        audit.set(id,{event_id:id,occurred_at:occurred,actor_id:actor,actor_role:role,action,target_type:targetType,target_id:targetId,outcome,metadata});
      }
      return [];
    }
    if (query.startsWith('SELECT event_digest FROM standby_max_command_replies WHERE event_digest =')) {
      const row=replies.get(values[0]); return row ? [[{event_digest:row.event_digest}]] : [];
    }
    if (query.startsWith('SELECT event_digest FROM standby_max_command_replies')) {
      const [now]=values;
      const rows=[...replies.values()].filter(row=>query.includes("status = 'queued'") ? row.status==='queued'&&row.next_attempt_at<=now : row.status==='sending'&&row.lock_until!==''&&row.lock_until<=now).map(row=>({event_digest:row.event_digest}));
      return [rows];
    }
    if (query.startsWith('SELECT * FROM standby_max_command_replies')) {
      const row=replies.get(values[0]); return row ? [[{...row}]] : [];
    }
    if (query.startsWith('SELECT status, lease_token, attempts, actor_id, command_kind FROM standby_max_command_replies')) {
      const row=replies.get(values[0]); return row ? [[{status:row.status,lease_token:row.lease_token,attempts:row.attempts,actor_id:row.actor_id,command_kind:row.command_kind}]] : [];
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
  let transactionChain=Promise.resolve();
  execute.begin=async(_options,callback)=>{
    const transaction=transactionChain.then(()=>callback(execute));
    transactionChain=transaction.catch(()=>{});
    return transaction;
  };
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
  assert.equal(fake.audit.get('audit-event-0001').target_type,'group');
  assert.equal(fake.audit.get('audit-event-0001').target_id,'group');
  assert.equal(JSON.stringify(fake.replies.get('a'.repeat(64))).includes('phone'),false);
  fake.receipts.delete('a'.repeat(64)); // simulate webhook-receipt retention
  assert.deepEqual(await store.recordMaxWebhookEvent(event()),{duplicate:true});
  assert.equal(fake.replies.size,1);
  assert.equal(fake.audit.size,1);
});

test('MAX status command audit is scoped to the request, not the group',async()=>{
  const fake=fakeSql(),store=createYdbRequestStore({sql:fake.sql,clock:()=>1800000000000});
  const requestId='abcd1234-1234-4234-8234-123456789abc';
  await store.recordMaxWebhookEvent(event('b'.repeat(64),{commandKind:'status',auditEvent:{eventId:'audit-status-0001',targetId:requestId}}));
  assert.equal(fake.audit.get('audit-status-0001').target_type,'request');
  assert.equal(fake.audit.get('audit-status-0001').target_id,requestId);
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
  assert.equal([...fake.audit.values()].filter(row=>row.action==='max.command.delivery'&&row.outcome==='accepted').length,1);
  assert.deepEqual(await store.claimDueMaxCommandReplies({now:1800000000200}),[]);
});

test('concurrent MAX reply claimers cannot both own the same outbox row',async()=>{
  const fake=fakeSql(); let id=0;
  const store=createYdbRequestStore({sql:fake.sql,clock:()=>1800000000000,idFactory:()=> 'parallel-'+(++id)});
  await store.recordMaxWebhookEvent(event());
  const [workerA,workerB]=await Promise.all([
    store.claimDueMaxCommandReplies({now:1800000000000,limit:1,leaseMs:60_000}),
    store.claimDueMaxCommandReplies({now:1800000000000,limit:1,leaseMs:60_000})
  ]);
  const claims=[...workerA,...workerB];
  assert.equal(claims.length,1);
  assert.equal(new Set(claims.map(item=>item.leaseToken)).size,1);
  assert.equal(fake.replies.get('a'.repeat(64)).status,'sending');
});

test('expired MAX reply lease is recovered with a new fencing token',async()=>{
  const fake=fakeSql(); let id=0;
  const store=createYdbRequestStore({sql:fake.sql,clock:()=>1800000000000,idFactory:()=> 'lease-recovery-'+(++id)});
  await store.recordMaxWebhookEvent(event());
  const [first]=await store.claimDueMaxCommandReplies({now:1800000000000,leaseMs:1000});
  assert.equal(first.leaseToken,'lease-recovery-1');
  assert.deepEqual(await store.claimDueMaxCommandReplies({now:1800000000999}),[]);
  const [recovered]=await store.claimDueMaxCommandReplies({now:1800000001000,leaseMs:1000});
  assert.equal(recovered.leaseToken,'lease-recovery-2');
  assert.equal(await store.completeMaxCommandReply({eventDigest:first.eventDigest,leaseToken:first.leaseToken,now:1800000001100}),null);
  assert.equal((await store.completeMaxCommandReply({eventDigest:recovered.eventDigest,leaseToken:recovered.leaseToken,now:1800000001200})).status,'sent');
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
  const deliveryAudit=[...fake.audit.values()].filter(row=>row.action==='max.command.delivery');
  assert.equal(deliveryAudit.length,2);
  assert.deepEqual(deliveryAudit.map(row=>row.outcome).sort(),['failed','failed']);
  assert.equal(deliveryAudit.some(row=>row.metadata.includes('max_network_error')),true);
});

test('outbox accepts a six-hour MAX Retry-After within the documented bound',async()=>{
  const fake=fakeSql(),now=1800000000000;
  const store=createYdbRequestStore({sql:fake.sql,clock:()=>now,idFactory:()=> 'lease-long-retry'});
  await store.recordMaxWebhookEvent(event());
  const [claim]=await store.claimDueMaxCommandReplies({now});
  const sixHours=6*60*60_000;
  const retry=await store.failMaxCommandReply({
    eventDigest:claim.eventDigest,leaseToken:claim.leaseToken,
    errorCode:'max_rate_limited',retryable:true,now,
    retryBaseMs:sixHours,retryMaxMs:sixHours
  });
  assert.equal(retry.status,'queued');
  assert.equal(Date.parse(retry.nextAttemptAt),now+sixHours);
});

test('outbox rejects unsafe reply data and invalid lease/retry inputs',async()=>{
  const store=createYdbRequestStore({sql:fakeSql().sql});
  await assert.rejects(()=>store.recordMaxWebhookEvent(event('b'.repeat(64),{text:'x'.repeat(4001)})),/reply text/);
  await assert.rejects(()=>store.claimDueMaxCommandReplies({limit:0}),/limit/);
  await assert.rejects(()=>store.failMaxCommandReply({eventDigest:'c'.repeat(64),leaseToken:'x',errorCode:'unsafe error'}),/error code/);
});


test('outbox retention prunes only sent replies and preserves queued and dead-letter rows',async()=>{
  const fake=fakeSql(); let id=0;
  const now=1800000000000;
  const store=createYdbRequestStore({sql:fake.sql,clock:()=>now,idFactory:()=> 'lease-'+(++id)});
  await store.recordMaxWebhookEvent(event('a'.repeat(64)));
  const [deadClaim]=await store.claimDueMaxCommandReplies({now});
  await store.failMaxCommandReply({eventDigest:deadClaim.eventDigest,leaseToken:deadClaim.leaseToken,retryable:false,errorCode:'max_request_rejected',now});
  await store.recordMaxWebhookEvent(event('c'.repeat(64)));
  const [sentClaim]=await store.claimDueMaxCommandReplies({now,limit:1});
  await store.completeMaxCommandReply({eventDigest:sentClaim.eventDigest,leaseToken:sentClaim.leaseToken,now});
  await store.recordMaxWebhookEvent(event('b'.repeat(64)));
  await store.pruneMaxCommandReplies({before:new Date(now+1000).toISOString(),limit:10});
  assert.equal(fake.replies.has('a'.repeat(64)),true);
  assert.equal(fake.replies.get('a'.repeat(64)).status,'dead');
  assert.equal(fake.replies.has('b'.repeat(64)),true);
  assert.equal(fake.replies.get('b'.repeat(64)).status,'queued');
  assert.equal(fake.replies.has('c'.repeat(64)),false);
});

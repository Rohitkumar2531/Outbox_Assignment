import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import {Worker} from 'bullmq';
import {randomUUID} from 'node:crypto';
import jwt from 'jsonwebtoken';
import {prisma} from '../src/config/db.js';
import {env} from '../src/config/env.js';
import {redis} from '../src/config/redis.js';
import {emailQueue} from '../src/services/emailQueue.js';

const enabled=process.env.RUN_EMAIL_INTEGRATION==='true';
const wait=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));

test('schedule API -> delayed BullMQ job -> Ethereal SMTP -> sent row and preview URL',{skip:!enabled,timeout:120_000},async()=>{
  assert.ok(env.ETHEREAL_USER&&env.ETHEREAL_PASS,'Ethereal credentials must be configured');
  const [user,sender]=await Promise.all([
    prisma.user.findFirst({select:{id:true,name:true,email:true,avatar:true}}),
    prisma.sender.findFirst({select:{id:true}}),
  ]);
  assert.ok(user,'A Google-authenticated user must exist');
  assert.ok(sender,'An Ethereal-configured sender must exist');
  const token=jwt.sign(user,env.JWT_SECRET,{expiresIn:'5m'});
  const startAt=new Date(Date.now()+30_000);
  const response=await fetch(`${env.SERVER_URL}/api/emails/schedule`,{
    method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${token}`},
    body:JSON.stringify({senderId:sender.id,subject:`ReachInbox pipeline test ${randomUUID()}`,body:'Ethereal integration test. Not delivered to a real inbox.',recipients:['reachinbox-test@example.invalid'],startAt:startAt.toISOString(),delaySeconds:2,idempotencyKey:randomUUID()}),
  });
  const payload:any=await response.json();assert.equal(response.status,201,`schedule endpoint: ${payload.error||response.status}`);
  const email=await prisma.email.findFirst({where:{campaignId:payload.campaignId},select:{id:true,scheduledAt:true}});
  assert.ok(email,'Email row is persisted by the scheduling transaction');
  const jobId=`email-${email.id}`;let job=await emailQueue.getJob(jobId);
  for(let i=0;!job&&i<20;i++){await wait(250);job=await emailQueue.getJob(jobId)}
  assert.ok(job,'Outbox dispatch creates the stable BullMQ job');
  assert.equal(await job.getState(),'delayed','Future email is delayed in Redis');
  assert.ok(email.scheduledAt.getTime()>Date.now());

  const deadline=Date.now()+90_000;
  let sent:Awaited<ReturnType<typeof prisma.email.findUnique>>=null;
  while(Date.now()<deadline){
    sent=await prisma.email.findUnique({where:{id:email.id}});
    if(sent?.status==='sent')break;
    if(sent?.status==='failed')assert.fail(`Worker exhausted retries: ${sent.errorMessage}`);
    await wait(500);
  }
  assert.equal(sent?.status,'sent','SMTP acceptance updates the database status');
  assert.ok(sent?.providerMessageId?.includes('@ethereal.email'));
  assert.ok(sent?.previewUrl?.startsWith('https://ethereal.email/message/'));
  assert.equal(await job.getState(),'completed','BullMQ completes only after SMTP acceptance and DB update');
});

test('future delayed job remains present across a worker disconnect/reconnect',{skip:!enabled,timeout:30_000},async()=>{
  const future=await prisma.email.findFirst({where:{status:'scheduled',scheduledAt:{gt:new Date()}},select:{id:true,scheduledAt:true},orderBy:{scheduledAt:'asc'}});
  assert.ok(future,'A future scheduled email is required for restart verification');
  const jobId=`email-${future.id}`;
  const firstRedis=redis.duplicate();
  const first=new Worker('emails',async()=>undefined,{connection:firstRedis,autorun:false});
  await first.waitUntilReady();await first.close();await firstRedis.quit();
  const restartedRedis=redis.duplicate();
  const restarted=new Worker('emails',async()=>undefined,{connection:restartedRedis,autorun:false});
  await restarted.waitUntilReady();
  try{const job=await emailQueue.getJob(jobId);assert.ok(job,'Future job remains persisted after worker reconnect');assert.equal(await job.getState(),'delayed')}
  finally{await restarted.close();await restartedRedis.quit()}
});

test.after(async()=>{await emailQueue.close();await redis.quit();await prisma.$disconnect()});

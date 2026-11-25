import 'dotenv/config';
import {randomUUID} from 'node:crypto';
import jwt from 'jsonwebtoken';
import {prisma} from './src/config/db.js';
import {env} from './src/config/env.js';
import {emailQueue} from './src/services/emailQueue.js';

const wait=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
try{
  const [user,sender]=await Promise.all([
    prisma.user.findFirst({select:{id:true,name:true,email:true,avatar:true}}),
    prisma.sender.findFirst({select:{id:true}}),
  ]);
  if(!user||!sender)throw new Error('A signed-in user and configured sender are required for the end-to-end check');
  const token=jwt.sign(user,env.JWT_SECRET,{expiresIn:'5m'});
  const startAt=new Date(Date.now()+30_000);
  const response=await fetch(`${env.SERVER_URL}/api/emails/schedule`,{
    method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${token}`},
    body:JSON.stringify({senderId:sender.id,subject:`ReachInbox scheduled delivery check ${new Date().toISOString()}`,body:'Ethereal SMTP integration check. This message is not delivered to a real inbox.',recipients:['reachinbox-test@example.invalid'],startAt:startAt.toISOString(),delaySeconds:2,idempotencyKey:randomUUID()}),
  });
  const payload:any=await response.json();if(!response.ok)throw new Error(`Schedule API returned ${response.status}: ${payload.error||'unknown error'}`);
  const email=await prisma.email.findFirst({where:{campaignId:payload.campaignId},select:{id:true,scheduledAt:true}});if(!email)throw new Error('Schedule API did not persist an email row');
  const jobId=`email-${email.id}`;let job=await emailQueue.getJob(jobId);
  for(let i=0;!job&&i<10;i++){await wait(500);job=await emailQueue.getJob(jobId)}
  if(!job)throw new Error('No BullMQ job found for the scheduled email');
  const initialState=await job.getState();console.log(JSON.stringify({phase:'scheduled',emailId:email.id,scheduledAt:email.scheduledAt.toISOString(),queueState:initialState,delayMs:Math.max(0,email.scheduledAt.getTime()-Date.now())}));
  if(initialState!=='delayed'&&email.scheduledAt.getTime()>Date.now())throw new Error(`Expected future email job to be delayed, got ${initialState}`);
  const deadline=Date.now()+90_000;let result:any;
  while(Date.now()<deadline){const [row,currentJob]=await Promise.all([prisma.email.findUnique({where:{id:email.id},select:{status:true,previewUrl:true,providerMessageId:true}}),emailQueue.getJob(jobId)]);if(row?.status==='sent'){result={row,jobState:currentJob?await currentJob.getState():'removed'};break}if(row?.status==='failed')throw new Error(`SMTP failure: ${row.providerMessageId||'no provider message'}; check worker logs.`);await wait(750)}
  if(!result)throw new Error('Email did not reach sent status within 90 seconds');
  if(!result.row.previewUrl||!result.row.providerMessageId)throw new Error('SMTP accepted email but its preview URL/message ID was not persisted');
  if(result.jobState!=='completed')throw new Error(`Expected completed BullMQ job, got ${result.jobState}`);
  console.log(JSON.stringify({phase:'sent',emailId:email.id,status:result.row.status,jobState:result.jobState,providerMessageId:result.row.providerMessageId,previewUrl:result.row.previewUrl}));
}finally{await emailQueue.close();await prisma.$disconnect()}

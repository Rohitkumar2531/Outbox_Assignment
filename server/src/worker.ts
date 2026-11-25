import { DelayedError, QueueEvents, UnrecoverableError, Worker } from 'bullmq';
import { redis } from './config/redis.js';
import { env } from './config/env.js';
import { prisma } from './config/db.js';
import { emailQueue, dispatchOutbox } from './services/emailQueue.js';
import { sendMail } from './services/mailer.js';
import { indexEmail } from './services/indexer.js';
import { alertSlack, decrypt } from './services/slack.js';
import { log } from './utils/logger.js';

const hourlyQuotaLua = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('EXPIRE', KEYS[1], 3600) end
if count > tonumber(ARGV[1]) then
  redis.call('DECR', KEYS[1])
  return 0
end
return count
`;

// Atomically claim the current send instant. A deferred job can retry at the
// returned timestamp without reserving another future slot on every retry.
const pacingLua = `
local now = tonumber(ARGV[1])
local previous = tonumber(redis.call('GET', KEYS[1]) or '0')
local readyAt = previous + tonumber(ARGV[2])
if now < readyAt then return readyAt end
redis.call('SET', KEYS[1], now, 'PX', 3600000)
return now
`;

const emitEmailUpdate = (userId: string, id: string, status: string) =>
  redis.publish('email:updated', JSON.stringify({ userId, email: { id, status } }));

export const worker = new Worker('emails', async job => {
  const emailId = String(job.data.emailId);
  log('info', 'WORKER', 'Processing email', { emailId, jobId: job.id, attempt: job.attemptsMade + 1 });

  const email = await prisma.email.findUnique({ where: { id: emailId }, include: { sender: true } });
  if (!email) {
    log('error', 'WORKER', 'Email record missing for queue job', { emailId, jobId: job.id });
    throw new Error(`Email record ${emailId} not found`);
  }
  if (email.status === 'sent' || email.status === 'cancelled') {
    log('info', 'WORKER', 'Skipping terminal email status', { emailId, status: email.status });
    return { skipped: true, status: email.status };
  }

  const now = Date.now();
  const minimumDelayMs = Math.max(env.EMAIL_MIN_DELAY_SECONDS, email.sender.minDelaySeconds) * 1000;
  const eligibleAt = Number(await redis.eval(pacingLua, 1, `sender:${email.senderId}:next`, now, minimumDelayMs));
  if (eligibleAt > now) {
    log('info', 'RATE LIMIT', 'Minimum delay; rescheduling', { emailId, eligibleAt: new Date(eligibleAt).toISOString() });
    await job.moveToDelayed(eligibleAt, job.token!);
    throw new DelayedError();
  }

  const hourKey = new Date().toISOString().slice(0, 13);
  const quota = Math.min(email.sender.hourlyLimit, env.MAX_EMAILS_PER_HOUR);
  const reservation = Number(await redis.eval(hourlyQuotaLua, 1, `sender:${email.senderId}:hour:${hourKey}`, quota));
  log('info', 'RATE LIMIT', 'Quota reservation', { emailId, senderId: email.senderId, hour: hourKey, quota, reserved: reservation > 0 });
  if (!reservation) {
    const nextHour = new Date();
    nextHour.setUTCHours(nextHour.getUTCHours() + 1, 0, 0, 0);
    await alertSlack(email.userId, email.senderId, hourKey).catch(error =>
      log('warn', 'SLACK', 'Hourly-limit notification failed', { emailId, error: error instanceof Error ? error.message : String(error) }),
    );
    log('info', 'RATE LIMIT', 'Hourly quota exhausted; rescheduling', { emailId, nextAttemptAt: nextHour.toISOString() });
    await job.moveToDelayed(nextHour.getTime(), job.token!);
    throw new DelayedError();
  }

  const processing = await prisma.email.update({ where: { id: email.id }, data: { status: 'processing' } });
  log('info', 'DATABASE', 'Email status updated', { emailId, status: processing.status });
  await emitEmailUpdate(email.userId, email.id, 'processing');

  try {
    const smtp = { ...(email.sender.smtpConfig as Record<string, any>) };
    if (smtp.passEncrypted) {
      smtp.pass = decrypt(smtp.passEncrypted);
      delete smtp.passEncrypted;
    }
    const { info, previewUrl } = await sendMail({
      emailId,
      smtp,
      from: email.sender.email,
      to: email.recipient,
      subject: email.subject,
      body: email.body,
    });

    // sendMail resolves only after the SMTP server accepts the message.
    const sent = await prisma.email.update({
      where: { id: email.id },
      data: { status: 'sent', sentAt: new Date(), providerMessageId: info.messageId, previewUrl },
    });
    log('info', 'DATABASE', 'Email status updated', { emailId, status: sent.status, messageId: info.messageId });
    void indexEmail(sent).catch(error => log('error', 'ELASTICSEARCH', 'Email indexing failed', { emailId, error: error instanceof Error ? error.message : String(error) }));
    await redis.publish('email:updated', JSON.stringify({ userId: email.userId, email: { id: sent.id, status: sent.status, sentAt: sent.sentAt, previewUrl } }));
    return { messageId: info.messageId, previewUrl };
  } catch (error) {
    const smtpError=error as Error&{code?:string;responseCode?:number};
    const permanentAuthFailure=smtpError.code==='EAUTH'||smtpError.responseCode===535;
    log('error', 'WORKER ERROR', permanentAuthFailure?'Permanent SMTP authentication failure':'Email attempt failed; BullMQ will retry when configured', {
      emailId,
      attempt: job.attemptsMade + 1,
      permanentAuthFailure,
      error: error instanceof Error ? error.message : String(error),
    });
    // Keep `processing` during retries. Mark failed only after BullMQ exhausts attempts.
    if(permanentAuthFailure)throw new UnrecoverableError('SMTP authentication failed; check the sender SMTP credentials');
    throw error;
  }
}, { connection: redis, concurrency: env.WORKER_CONCURRENCY });

const queueEvents = new QueueEvents('emails', { connection: redis.duplicate() });
queueEvents.on('waiting', event => log('info', 'QUEUE', 'Job waiting', { jobId: event.jobId, previousState: event.prev }));
queueEvents.on('delayed', event => log('info', 'QUEUE', 'Job delayed', { jobId: event.jobId, delayUntil: event.delay }));
queueEvents.on('error', error => log('error', 'QUEUE', 'Queue events connection error', { error: error.message }));

worker.on('ready', () => log('info', 'WORKER', 'Worker started', { queue: 'emails', concurrency: env.WORKER_CONCURRENCY }));
worker.on('active', job => log('info', 'WORKER', 'Job active', { emailId: job.data.emailId, jobId: job.id }));
worker.on('completed', (job, result) => log('info', 'WORKER', 'Job completed', { emailId: job.data.emailId, jobId: job.id, result }));
worker.on('failed', async (job, error) => {
  if (!job) return;
  const finalAttempt = error.name==='UnrecoverableError'||job.attemptsMade >= Number(job.opts.attempts || 1);
  log(finalAttempt ? 'error' : 'warn', 'WORKER', 'Job failed', { emailId: job.data.emailId, jobId: job.id, attempt: job.attemptsMade, finalAttempt, error: error.message });
  if (!finalAttempt) return;
  try {
    const changed = await prisma.email.updateMany({
      where: { id: job.data.emailId, status: { notIn: ['sent', 'cancelled'] } },
      data: { status: 'failed', errorMessage: error.message.slice(0, 1000) },
    });
    if (changed.count) {
      const email = await prisma.email.findUnique({ where: { id: job.data.emailId }, select: { userId: true } });
      if (email) await emitEmailUpdate(email.userId, job.data.emailId, 'failed');
      log('error', 'DATABASE', 'Email status updated', { emailId: job.data.emailId, status: 'failed' });
    }
  } catch (databaseError) {
    log('error', 'DATABASE', 'Failed to persist final email failure', { emailId: job.data.emailId, error: databaseError instanceof Error ? databaseError.message : String(databaseError) });
  }
});
worker.on('error', error => log('error', 'WORKER ERROR', 'Worker runtime error', { error: error.message }));

async function reconcileOutbox() {
  try { await dispatchOutbox(); }
  catch (error) { log('error', 'QUEUE', 'Outbox reconciliation failed', { error: error instanceof Error ? error.message : String(error) }); }
}
async function reconcileProcessingEmails() {
  const stuck = await prisma.email.findMany({ where: { status: 'processing' }, select: { id: true, scheduledAt: true }, take: 100 });
  for (const email of stuck) {
    const jobId = `email-${email.id}`;
    const existing = await emailQueue.getJob(jobId);
    if (existing) continue; // BullMQ will recover active/stalled jobs itself.
    const delay = Math.max(0, email.scheduledAt.getTime() - Date.now());
    await emailQueue.add('send', { emailId: email.id }, { jobId, delay });
    log('warn', 'QUEUE', 'Recovered processing email with no queue job', { emailId: email.id, jobId, delayMs: delay });
  }
}

const outboxRecovery = setInterval(() => void reconcileOutbox(), 5000);
outboxRecovery.unref();
const processingRecovery = setInterval(() => void reconcileProcessingEmails().catch(error => log('error', 'WORKER', 'Processing recovery failed', { error: error instanceof Error ? error.message : String(error) })), 30000);
processingRecovery.unref();
const indexRecovery = setInterval(async () => {
  if (!env.ELASTICSEARCH_NODE) return;
  try {
    const missing = await prisma.email.findMany({ where: { indexedAt: null }, take: 100, orderBy: { createdAt: 'asc' } });
    await Promise.allSettled(missing.map(indexEmail));
  } catch (error) { log('error', 'ELASTICSEARCH', 'Index reconciliation failed', { error: error instanceof Error ? error.message : String(error) }); }
}, 30000);
indexRecovery.unref();
void reconcileOutbox();
void reconcileProcessingEmails().catch(error => log('error', 'WORKER', 'Startup recovery failed', { error: error instanceof Error ? error.message : String(error) }));

async function stop() {
  clearInterval(outboxRecovery);
  clearInterval(processingRecovery);
  clearInterval(indexRecovery);
  await worker.close();
  await queueEvents.close();
  await redis.quit();
  await prisma.$disconnect();
  process.exit(0);
}
process.once('SIGTERM', stop);
process.once('SIGINT', stop);

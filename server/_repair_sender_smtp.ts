import 'dotenv/config';
import {prisma} from './src/config/db.js';
import {env} from './src/config/env.js';
import {encrypt} from './src/services/slack.js';
try {
  if(!env.ETHEREAL_USER||!env.ETHEREAL_PASS)throw new Error('Global Ethereal credentials are missing');
  const pending=await prisma.email.findFirst({where:{status:{in:['scheduled','processing']}},select:{senderId:true}});
  if(!pending)throw new Error('No pending sender found');
  const sender=await prisma.sender.findUnique({where:{id:pending.senderId},select:{smtpConfig:true}});
  if(!sender)throw new Error('Pending sender record not found');
  const config={...(sender.smtpConfig as Record<string,unknown>),host:env.ETHEREAL_HOST,port:env.ETHEREAL_PORT,secure:false,user:env.ETHEREAL_USER,passEncrypted:encrypt(env.ETHEREAL_PASS)};
  delete (config as any).pass;
  await prisma.sender.update({where:{id:pending.senderId},data:{smtpConfig:config}});
  console.log(`Updated SMTP settings on pending sender ${pending.senderId} to use the configured Ethereal account; password remains encrypted.`);
}finally{await prisma.$disconnect()}

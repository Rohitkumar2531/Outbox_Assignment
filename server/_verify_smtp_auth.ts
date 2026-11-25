import 'dotenv/config';
import nodemailer from 'nodemailer';
import {env} from './src/config/env.js';
import {prisma} from './src/config/db.js';
import {decrypt} from './src/services/slack.js';
const verify=async(name:string,config:any)=>{const transport=nodemailer.createTransport({host:config.host,port:config.port,secure:!!config.secure,requireTLS:config.port===587,auth:{user:config.user,pass:config.pass}});try{await transport.verify();return {name,ok:true}}catch(e:any){return {name,ok:false,code:e.code||null,responseCode:e.responseCode||null,message:e.message}}finally{transport.close()}};
try{const sender=await prisma.sender.findFirst({select:{smtpConfig:true}});const config=sender?.smtpConfig as any;const senderPass=config?.passEncrypted?decrypt(config.passEncrypted):config?.pass;const checks=[verify('global',{host:env.ETHEREAL_HOST,port:env.ETHEREAL_PORT,secure:false,user:env.ETHEREAL_USER,pass:env.ETHEREAL_PASS})];if(config)checks.push(verify('sender',{host:config.host||env.ETHEREAL_HOST,port:Number(config.port||env.ETHEREAL_PORT),secure:!!config.secure,user:config.user||env.ETHEREAL_USER,pass:senderPass||env.ETHEREAL_PASS}));console.log(JSON.stringify({credentialsMatchGlobal:!!config&&config.user===env.ETHEREAL_USER&&senderPass===env.ETHEREAL_PASS,checks:await Promise.all(checks)},null,2))}finally{await prisma.$disconnect()}

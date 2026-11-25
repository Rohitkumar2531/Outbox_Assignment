type Level='info'|'warn'|'error';
export function log(level:Level,tag:string,event:string,fields:Record<string,unknown>={}){
  const record={timestamp:new Date().toISOString(),level,tag,event,...fields};
  const line=JSON.stringify(record);
  if(level==='error')console.error(line);else if(level==='warn')console.warn(line);else console.log(line);
}

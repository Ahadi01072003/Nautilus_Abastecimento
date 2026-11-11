// Ferramentaria e Inventário · fase A: cadastros (unidades, categorias, locais, itens), consulta de saldo e
// movimentos de estoque. O saldo nunca é editado: cada movimento entra no livro (imutável) e o banco aplica o
// saldo. Acesso: perfil Almoxarife (acesso "ferramentaria") e Gestão. Ajuste de saldo é só da Gestão.
import {db,type Row} from './db';
import {AppError,required,text,milli} from './domain';
import {type Member,isManager,requireAny} from './permissions';
import {audit} from './registry';

export type Actor=Member&{capabilities:string[],org_scope:string[]};
const id=()=>crypto.randomUUID();
const now=()=>new Date().toISOString();
export const tools=async(m:Member)=>await requireAny(m,['ferramentaria']) as Actor;
export const MOVE_KINDS=['entrada','saida','perda','ajuste'] as const;
type MoveKind=typeof MOVE_KINDS[number];
const MOVE_LABEL:Record<MoveKind,string>={entrada:'Entrada',saida:'Saída',perda:'Perda',ajuste:'Ajuste'};
const PAGE=30;
const page=(url:URL)=>{const p=Math.max(1,Math.floor(Number(url.searchParams.get('page'))||1));return {page:p,limit:PAGE,offset:(p-1)*PAGE};};
const like=(q:string)=>'%'+q.replace(/[\\%_]/g,'\\$&')+'%';
const flag=(v:unknown)=>v===false||v===0||v==='0'?0:1;

/** Traduz as travas do banco para mensagens da tela. */
export function dbError(e:unknown):never{
 const m=(e as {message?:string}).message||'';
 if(/Saldo insuficiente/.test(m))throw new AppError('Saldo insuficiente para esta movimentação. Atualize a tela.',409,'INSUFFICIENT_BALANCE');
 if(/Item inativo/.test(m))throw new AppError('Este item está inativo.',409,'ITEM_INACTIVE');
 if(/quantidade inteira/.test(m))throw new AppError('Esta unidade só aceita quantidade inteira.',400,'INTEGRAL_UNIT');
 if(/tool_items_code_key/.test(m))throw new AppError('Já existe um item com este código.',409,'CODE_DUPLICATE','code');
 if(/tool_units_name_key/.test(m))throw new AppError('Já existe uma unidade com este nome.',409);
 if(/tool_categories_name_key/.test(m))throw new AppError('Já existe uma categoria com este nome.',409);
 if(/tool_locations_name_key/.test(m))throw new AppError('Já existe um local com este nome.',409);
 if(/Tipo e unidade não mudam/.test(m))throw new AppError('Tipo e unidade do item não mudam depois da primeira movimentação.',409);
 throw e;
}

const itemRow=(r:Row)=>({id:r.id,kind:r.kind,name:r.name,code:r.code||null,categoryId:r.category_id||null,categoryName:r.category_name||null,
 locationId:r.location_id||null,locationName:r.location_name||null,unitId:r.unit_id,unitAbbr:r.unit_abbr,unitName:r.unit_name,integral:Number(r.integral)===1,
 balance:Number(r.balance_milli)/1000,min:Number(r.min_milli)/1000,active:Number(r.active)===1,version:Number(r.version),
 low:Number(r.min_milli)>0&&Number(r.balance_milli)<=Number(r.min_milli),updatedAt:r.updated_at});
const ITEM_SELECT=`SELECT i.*,c.name category_name,l.name location_name,u.abbr unit_abbr,u.name unit_name,u.integral
 FROM tool_items i LEFT JOIN tool_categories c ON c.id=i.category_id LEFT JOIN tool_locations l ON l.id=i.location_id JOIN tool_units u ON u.id=i.unit_id`;
const moveRow=(r:Row)=>({id:r.id,itemId:r.item_id,itemName:r.item_name,unitAbbr:r.unit_abbr,kind:r.kind,delta:Number(r.delta_milli)/1000,balanceAfter:Number(r.balance_after_milli)/1000,
 reason:r.reason,refType:r.ref_type||null,refId:r.ref_id||null,occurredAt:r.occurred_at,authorName:r.author_name});
const MOVE_SELECT=`SELECT m.*,i.name item_name,u.abbr unit_abbr FROM tool_movements m JOIN tool_items i ON i.id=m.item_id JOIN tool_units u ON u.id=i.unit_id`;

/** Listas de apoio dos formulários. */
export async function toolsRefs(member:Member){
 await tools(member);
 const [units,categories,locations]=await Promise.all([
  db().all('SELECT * FROM tool_units ORDER BY lower(name)'),db().all('SELECT * FROM tool_categories ORDER BY lower(name)'),db().all('SELECT * FROM tool_locations ORDER BY lower(name)')]);
 return {units:units.map(u=>({id:u.id,name:u.name,abbr:u.abbr,integral:Number(u.integral)===1,active:Number(u.active)===1})),
  categories:categories.map(c=>({id:c.id,name:c.name,active:Number(c.active)===1})),locations:locations.map(l=>({id:l.id,name:l.name,active:Number(l.active)===1}))};
}

/** Painel: totais, itens abaixo do mínimo e o que se movimentou hoje. */
export async function toolsDashboard(member:Member){
 await tools(member);
 const dayStart=new Intl.DateTimeFormat('sv-SE',{timeZone:'America/Sao_Paulo'}).format(Date.now());
 const since=new Date(`${dayStart}T00:00:00-03:00`).toISOString();
 const [totals,low,today,recent,loans]=await Promise.all([
  db().first("SELECT count(*)::int total,count(*) FILTER (WHERE kind='ferramenta')::int ferramentas,count(*) FILTER (WHERE kind='material')::int materiais FROM tool_items WHERE active=1"),
  db().all(`${ITEM_SELECT} WHERE i.active=1 AND i.min_milli>0 AND i.balance_milli<=i.min_milli ORDER BY (i.balance_milli::float/i.min_milli),lower(i.name) LIMIT 20`),
  db().all('SELECT kind,count(*)::int n FROM tool_movements WHERE occurred_at>=? GROUP BY kind',since),
  db().all(`${MOVE_SELECT} ORDER BY m.occurred_at DESC,m.id DESC LIMIT 10`),
  db().first(`SELECT count(*)::int open,
    count(*) FILTER (WHERE l.expected_return<?)::int late,
    count(*) FILTER (WHERE l.signed_at IS NULL AND NOT EXISTS (SELECT 1 FROM tool_loan_files f WHERE f.loan_id=l.id AND f.return_id IS NULL) AND l.issued_at<?)::int unsigned
    FROM tool_loans l WHERE l.status IN ('emitido','parcial')`,dayStart,new Date(Date.now()-24*3600_000).toISOString())]);
 return {totals:{items:Number(totals!.total),ferramentas:Number(totals!.ferramentas),materiais:Number(totals!.materiais)},low:low.map(itemRow),
  today:Object.fromEntries((today as Row[]).map(r=>[r.kind,Number(r.n)])),recent:recent.map(moveRow),
  loans:{open:Number(loans!.open),late:Number(loans!.late),unsigned:Number(loans!.unsigned)},generatedAt:now()};
}

/** Inventário: busca e filtros, paginado. */
export async function toolsItems(member:Member,url:URL){
 await tools(member);
 const p=page(url),where:string[]=[],values:unknown[]=[];
 const q=(url.searchParams.get('q')||'').trim().slice(0,80);
 if(q){where.push('(i.name ILIKE ? OR i.code ILIKE ?)');values.push(like(q),like(q));}
 const kind=url.searchParams.get('kind');if(kind){if(!['ferramenta','material'].includes(kind))throw new AppError('Tipo inválido.');where.push('i.kind=?');values.push(kind);}
 for(const [param,col] of [['category','i.category_id'],['location','i.location_id']] as const){const v=url.searchParams.get(param);if(v){where.push(`${col}=?`);values.push(v);}}
 const status=url.searchParams.get('status')||'active';
 if(status==='active')where.push('i.active=1');
 else if(status==='inactive')where.push('i.active=0');
 else if(status==='low')where.push('i.active=1 AND i.min_milli>0 AND i.balance_milli<=i.min_milli');
 else if(status==='zero')where.push('i.active=1 AND i.balance_milli=0');
 else if(status==='available')where.push('i.active=1 AND i.balance_milli>0');
 else if(status!=='all')throw new AppError('Situação inválida.');
 const rows=await db().all(`${ITEM_SELECT}${where.length?' WHERE '+where.join(' AND '):''} ORDER BY lower(i.name),i.id LIMIT ? OFFSET ?`,...values,p.limit+1,p.offset);
 return {rows:rows.slice(0,p.limit).map(itemRow),page:p.page,limit:p.limit,hasMore:rows.length>p.limit};
}

/** Item com os últimos movimentos (o extrato). */
export async function toolsItem(member:Member,itemId:string){
 await tools(member);
 const r=await db().first(`${ITEM_SELECT} WHERE i.id=?`,itemId);
 if(!r)throw new AppError('Item não encontrado.',404,'ITEM_NOT_FOUND');
 const moves=await db().all(`${MOVE_SELECT} WHERE m.item_id=? ORDER BY m.occurred_at DESC,m.id DESC LIMIT 100`,itemId);
 return {item:itemRow(r),movements:moves.map(moveRow)};
}

/** Extrato geral com filtros. */
export async function toolsMovements(member:Member,url:URL){
 await tools(member);
 const p=page(url),where:string[]=[],values:unknown[]=[];
 const item=url.searchParams.get('item');if(item){where.push('m.item_id=?');values.push(item);}
 const kind=url.searchParams.get('kind');if(kind){if(![...MOVE_KINDS,'emprestimo','devolucao','contagem'].includes(kind))throw new AppError('Tipo de movimento inválido.');where.push('m.kind=?');values.push(kind);}
 for(const [param,op] of [['from','>='],['to','<']] as const){
  const v=url.searchParams.get(param);if(!v)continue;
  if(!/^\d{4}-\d{2}-\d{2}$/.test(v)||Number.isNaN(Date.parse(v+'T00:00:00Z'))||new Date(v+'T00:00:00Z').toISOString().slice(0,10)!==v)throw new AppError('Data inválida.');
  const d=param==='to'?new Date(Date.parse(v+'T00:00:00-03:00')+86400000):new Date(v+'T00:00:00-03:00');
  where.push(`m.occurred_at ${op} ?`);values.push(d.toISOString());
 }
 const rows=await db().all(`${MOVE_SELECT}${where.length?' WHERE '+where.join(' AND '):''} ORDER BY m.occurred_at DESC,m.id DESC LIMIT ? OFFSET ?`,...values,p.limit+1,p.offset);
 return {rows:rows.slice(0,p.limit).map(moveRow),page:p.page,limit:p.limit,hasMore:rows.length>p.limit};
}

export const key=(value:unknown)=>{const k=String(value??'');if(k.length<8||k.length>100)throw new AppError('Envio sem identificador. Atualize a tela e tente de novo.',400,'IDEMPOTENCY_KEY_REQUIRED');return k;};

/** Cadastro simples de nome (categoria e local). */
async function saveNamed(table:'tool_categories'|'tool_locations',a:Actor,b:Row,label:string){
 const name=required(b.name,`Nome d${label==='categoria'?'a':'o'} ${label}`,80),active=flag(b.active);
 return await db().tx(async tx=>{
  const old=b.id?await tx.first(`SELECT * FROM ${table} WHERE id=?`,String(b.id)):null;
  if(b.id&&!old)throw new AppError(`${label[0].toUpperCase()+label.slice(1)} não encontrad${label==='categoria'?'a':'o'}.`,404);
  const rid=old?.id||id();
  try{
   if(old)await tx.run(`UPDATE ${table} SET name=?,active=?,updated_at=? WHERE id=?`,name,active,now(),rid);
   else await tx.run(`INSERT INTO ${table}(id,name,active,created_at,updated_at) VALUES(?,?,?,?,?)`,rid,name,active,now(),now());
  }catch(e){dbError(e);}
  await audit(tx,a,`Ferramentaria: ${label} ${old?'atualizad':'cadastrad'}${label==='categoria'?'a':'o'}`,rid,{name,active:!!active});
  return {id:rid,message:`${label[0].toUpperCase()+label.slice(1)} ${old?'atualizad':'cadastrad'}${label==='categoria'?'a':'o'}.`};
 });
}

async function saveUnit(a:Actor,b:Row){
 const name=required(b.name,'Nome da unidade',40),abbr=required(b.abbr,'Sigla da unidade',8),integral=flag(b.integral),active=flag(b.active);
 return await db().tx(async tx=>{
  const old=b.id?await tx.first('SELECT * FROM tool_units WHERE id=?',String(b.id)):null;
  if(b.id&&!old)throw new AppError('Unidade não encontrada.',404);
  if(old&&integral===1&&await tx.first('SELECT 1 FROM tool_items WHERE unit_id=? AND balance_milli%1000<>0',old.id))
   throw new AppError('Há itens com saldo fracionado nesta unidade: ela não pode virar "só inteiros".',409);
  const rid=old?.id||id();
  try{
   if(old)await tx.run('UPDATE tool_units SET name=?,abbr=?,integral=?,active=?,updated_at=? WHERE id=?',name,abbr,integral,active,now(),rid);
   else await tx.run('INSERT INTO tool_units(id,name,abbr,integral,active,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',rid,name,abbr,integral,active,now(),now());
  }catch(e){dbError(e);}
  await audit(tx,a,`Ferramentaria: unidade ${old?'atualizada':'cadastrada'}`,rid,{name,abbr,integral:!!integral,active:!!active});
  return {id:rid,message:`Unidade ${old?'atualizada':'cadastrada'}.`};
 });
}

/** Cadastro do item. O saldo inicial entra como movimento "Saldo inicial", nunca como edição. */
async function saveItem(a:Actor,b:Row){
 const kind=String(b.kind||'');if(!['ferramenta','material'].includes(kind))throw new AppError('Escolha o tipo: Ferramenta ou Material.',400,'VALIDATION','kind');
 const name=required(b.name,'Nome do item',120),code=text(b.code,40)||null,active=flag(b.active);
 const opKey=b.id?'':key(b.idempotencyKey);
 return await db().tx(async tx=>{
  const unit=await tx.first('SELECT * FROM tool_units WHERE id=?',required(b.unitId,'Unidade',100));
  if(!unit)throw new AppError('Escolha uma unidade cadastrada.',400,'VALIDATION','unitId');
  const integral=Number(unit.integral)===1;
  for(const [field,table,label] of [['categoryId','tool_categories','Categoria'],['locationId','tool_locations','Local']] as const){
   const v=text(b[field],100);if(v&&!await tx.first(`SELECT 1 FROM ${table} WHERE id=?`,v))throw new AppError(`${label} não encontrad${label==='Categoria'?'a':'o'}.`,400,'VALIDATION',field);
  }
  const categoryId=text(b.categoryId,100)||null,locationId=text(b.locationId,100)||null;
  const min=b.min===undefined||b.min===''||b.min===null?0:milli(Number(b.min),integral,true);
  const old=b.id?await tx.first('SELECT * FROM tool_items WHERE id=?',String(b.id)):null;
  if(b.id&&!old)throw new AppError('Item não encontrado.',404,'ITEM_NOT_FOUND');
  if(!old){const prev=await tx.first('SELECT id FROM tool_items WHERE create_key=?',opKey);if(prev)return {id:prev.id as string,message:'Item já cadastrado.',replayed:true};}
  const rid=old?.id||id();
  try{
   if(old)await tx.run('UPDATE tool_items SET kind=?,name=?,code=?,category_id=?,location_id=?,unit_id=?,min_milli=?,active=?,updated_at=? WHERE id=?',kind,name,code,categoryId,locationId,unit.id,min,active,now(),rid);
   else{
    await tx.run('INSERT INTO tool_items(id,kind,name,code,category_id,location_id,unit_id,min_milli,active,create_key,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',rid,kind,name,code,categoryId,locationId,unit.id,min,active,opKey,a.id,now(),now());
    if(b.initialQty!==undefined&&b.initialQty!==''&&b.initialQty!==null&&Number(b.initialQty)!==0){
     const q=milli(Number(b.initialQty),integral);
     await tx.run("INSERT INTO tool_movements(id,operation_key,item_id,kind,delta_milli,reason,occurred_at,author_id,author_name) VALUES(?,?,?,'entrada',?,'Saldo inicial',?,?,?)",id(),`inicial:${rid}`,rid,q,now(),a.id,a.name);
    }
   }
  }catch(e){dbError(e);}
  await audit(tx,a,`Ferramentaria: item ${old?'atualizado':'cadastrado'}`,rid,{name,kind,code,unit:unit.abbr,active:!!active});
  return {id:rid,message:`Item ${old?'atualizado':'cadastrado'}.`};
 });
}

/** Movimento de estoque com vários itens (carrinho): tudo ou nada, idempotente. */
async function move(a:Actor,b:Row){
 const kind=String(b.kind||'') as MoveKind;
 if(!MOVE_KINDS.includes(kind))throw new AppError('Escolha o tipo de movimentação.',400,'VALIDATION','kind');
 if(kind==='ajuste'&&!isManager(a))throw new AppError('Ajuste de saldo é da Gestão.',403,'FORBIDDEN');
 const reason=required(b.reason,'Motivo',200),opKey=key(b.idempotencyKey);
 const lines=Array.isArray(b.lines)?b.lines as Row[]:[];
 if(!lines.length)throw new AppError('Inclua ao menos um item.',400,'VALIDATION','lines');
 if(lines.length>100)throw new AppError('Até 100 itens por movimentação.',400,'VALIDATION','lines');
 const ids=lines.map(l=>String(l?.itemId||''));
 if(ids.some(x=>!x))throw new AppError('Escolha o item de cada linha.',400,'VALIDATION','lines');
 if(new Set(ids).size!==ids.length)throw new AppError('Item repetido na lista: some as quantidades numa linha só.',400,'VALIDATION','lines');
 return await db().tx(async tx=>{
  const prior=await tx.all(`${MOVE_SELECT} WHERE m.operation_key LIKE ? ORDER BY m.operation_key`,opKey.replace(/[\\%_]/g,'\\$&')+':%');
  if(prior.length)return {replayed:true,movements:prior.map(moveRow),message:'Movimentação já registrada.'};
  const ordered=[...lines.keys()].sort((x,y)=>ids[x]<ids[y]?-1:1); // trava os itens sempre na mesma ordem
  for(const idx of ordered){
   const line=lines[idx],item=await tx.first(`${ITEM_SELECT} WHERE i.id=? FOR UPDATE OF i`,ids[idx]);
   if(!item)throw new AppError('Item não encontrado.',404,'ITEM_NOT_FOUND');
   if(Number(item.active)!==1)throw new AppError(`${item.name} está inativo.`,409,'ITEM_INACTIVE');
   const integral=Number(item.integral)===1,balance=Number(item.balance_milli);
   let delta:number;
   if(kind==='ajuste'){
    const counted=milli(Number(line.counted),integral,true);
    delta=counted-balance;
    if(delta===0)throw new AppError(`${item.name}: a quantidade contada é igual ao saldo.`,400,'NO_CHANGE');
   }else{
    const q=milli(Number(line.qty),integral);
    delta=kind==='entrada'?q:-q;
    if(delta<0&&balance+delta<0)throw new AppError(`${item.name}: saldo insuficiente (disponível ${balance/1000} ${item.unit_abbr}).`,409,'INSUFFICIENT_BALANCE');
   }
   try{
    await tx.run('INSERT INTO tool_movements(id,operation_key,item_id,kind,delta_milli,reason,occurred_at,author_id,author_name) VALUES(?,?,?,?,?,?,?,?,?)',id(),`${opKey}:${idx}`,item.id,kind,delta,reason,now(),a.id,a.name);
   }catch(e){dbError(e);}
   await audit(tx,a,`Ferramentaria: ${MOVE_LABEL[kind].toLowerCase()} registrada`,item.id,{item:item.name,delta:delta/1000,unit:item.unit_abbr,reason});
  }
  const rows=await tx.all(`${MOVE_SELECT} WHERE m.operation_key LIKE ? ORDER BY m.operation_key`,opKey.replace(/[\\%_]/g,'\\$&')+':%');
  return {movements:rows.map(moveRow),message:`${MOVE_LABEL[kind]} registrada: ${rows.length} ${rows.length===1?'item':'itens'}.`};
 });
}

export async function toolsGet(path:string,url:URL,member:Member):Promise<unknown>{
 switch(path){
  case 'tools/refs':return toolsRefs(member);
  case 'tools/dashboard':return toolsDashboard(member);
  case 'tools/items':return toolsItems(member,url);
  case 'tools/item':return toolsItem(member,url.searchParams.get('id')||'');
  case 'tools/movements':return toolsMovements(member,url);
 }
 throw new AppError('Página não encontrada.',404);
}

export async function toolsMutate(path:string,b:Row,member:Member):Promise<unknown>{
 const a=await tools(member);
 if(path==='tools/items/save')return saveItem(a,b);
 if(path==='tools/units/save')return saveUnit(a,b);
 if(path==='tools/categories/save')return saveNamed('tool_categories',a,b,'categoria');
 if(path==='tools/locations/save')return saveNamed('tool_locations',a,b,'local');
 if(path==='tools/move')return move(a,b);
 throw new AppError('Ação não encontrada.',404);
}

// Ferramentaria e Inventário · fase A: cadastros, saldo só por movimento, livro imutável, idempotência, acesso.
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {freshDatabase,addMember} from './helpers';
import {mutate,state} from '../lib/service';
import {centralState} from '../lib/central';
import {toolsGet,toolsMutate} from '../lib/tools';
import {type Member} from '../lib/permissions';
import type {Database,Row} from '../lib/db';

let ctx:Awaited<ReturnType<typeof freshDatabase>>,db:Database;
let manager:Member,almox:Member,operator:Member;
const key=()=>crypto.randomUUID();
const url=(q:Record<string,string>={})=>new URL('http://x/?'+new URLSearchParams(q));
const rejects=(p:Promise<unknown>,status:number,code?:string)=>assert.rejects(p,(e:{status?:number;code?:string;message:string})=>{assert.equal(e.status,status,e.message);if(code)assert.equal(e.code,code,e.message);return true;});
const set=async(who:Member,profile:string,caps:string[])=>{const m=await db.first('SELECT * FROM members WHERE id=?',who.id);await mutate('members',{id:who.id,username:m!.username,name:m!.name,role:profile,capabilities:caps},manager);return {...who,profile,capabilities:caps} as Member;};
const save=(path:string,b:Row,who:Member=almox)=>toolsMutate('tools/'+path,{idempotencyKey:key(),...b},who) as Promise<Row>;
const newItem=async(b:Row={})=>(await save('items/save',{kind:'material',name:'Parafuso M8',unitId:'un',...b})).id as string;
const balance=async(id:string)=>Number((await db.first('SELECT balance_milli FROM tool_items WHERE id=?',id))!.balance_milli)/1000;
const move=(kind:string,lines:Row[],reason='Teste',who:Member=almox,k=key())=>toolsMutate('tools/move',{idempotencyKey:k,kind,reason,lines},who) as Promise<Row>;

before(async()=>{
 ctx=await freshDatabase();db=ctx.database;
 manager=await addMember(db,'manager',{mustChange:false});
 almox=await set(await addMember(db,'almoxarife' as never),'almoxarife',[]);
 operator=await set(await addMember(db,'operator'),'operator',[]);
});
after(async()=>{await ctx.drop();});

test('acesso: almoxarife e gestão entram; outros perfis não',async()=>{
 await toolsGet('tools/dashboard',url(),almox);await toolsGet('tools/refs',url(),manager);
 await rejects(toolsGet('tools/dashboard',url(),operator),403);
 await rejects(toolsMutate('tools/move',{},operator),403);
 const s=await state(almox);assert.ok(s);await centralState(almox);
});

test('cadastro do item com saldo inicial; o saldo nasce de um movimento',async()=>{
 const id=await newItem({name:'Chave de fenda',kind:'ferramenta',code:'CF-01',initialQty:5,min:2});
 assert.equal(await balance(id),5);
 const {item,movements}=await toolsGet('tools/item',url({id}),almox) as {item:Row,movements:Row[]};
 assert.equal(item.balance,5);assert.equal(item.low,false);assert.equal(item.kind,'ferramenta');
 assert.equal(movements.length,1);assert.equal(movements[0].reason,'Saldo inicial');
 await rejects(newItem({code:'cf-01'}),409,'CODE_DUPLICATE');
});

test('cadastro do item é idempotente: o reenvio devolve o mesmo item',async()=>{
 const k=key(),b={kind:'material',name:'Fita isolante',unitId:'un',initialQty:3,idempotencyKey:k};
 const a1=await toolsMutate('tools/items/save',b,almox) as Row,a2=await toolsMutate('tools/items/save',b,almox) as Row;
 assert.equal(a1.id,a2.id);assert.equal(a2.replayed,true);
 assert.equal(Number((await db.first("SELECT count(*)::int n FROM tool_items WHERE name='Fita isolante'"))!.n),1);
 assert.equal(await balance(a1.id as string),3);
});

test('entrada, saída e perda movem o saldo; não sai mais do que há',async()=>{
 const id=await newItem({name:'Luva',unitId:'par',initialQty:10});
 await move('entrada',[{itemId:id,qty:5}]);assert.equal(await balance(id),15);
 await move('saida',[{itemId:id,qty:4}],'Consumo');assert.equal(await balance(id),11);
 await move('perda',[{itemId:id,qty:1}],'Extravio');assert.equal(await balance(id),10);
 await rejects(move('saida',[{itemId:id,qty:11}]),409,'INSUFFICIENT_BALANCE');
 assert.equal(await balance(id),10);
 const m=(await toolsGet('tools/movements',url({item:id}),almox) as {rows:Row[]}).rows;
 assert.deepEqual(m.map(r=>r.kind).reverse(),['entrada','entrada','saida','perda']);
 assert.equal(m[0].balanceAfter,10);
});

test('movimento com vários itens é tudo ou nada',async()=>{
 const a=await newItem({name:'Item A',initialQty:5}),b=await newItem({name:'Item B',initialQty:1});
 await rejects(move('saida',[{itemId:a,qty:2},{itemId:b,qty:2}]),409,'INSUFFICIENT_BALANCE');
 assert.equal(await balance(a),5,'a primeira linha não ficou gravada');
 const r=await move('saida',[{itemId:a,qty:2},{itemId:b,qty:1}]);
 assert.equal((r.movements as Row[]).length,2);assert.equal(await balance(a),3);assert.equal(await balance(b),0);
 await rejects(move('saida',[{itemId:a,qty:1},{itemId:a,qty:1}]),400,'VALIDATION');
});

test('reenvio da mesma movimentação devolve o mesmo resultado, sem duplicar',async()=>{
 const id=await newItem({name:'Broca',initialQty:10}),k=key();
 const r1=await move('saida',[{itemId:id,qty:3}],'Consumo',almox,k),r2=await move('saida',[{itemId:id,qty:3}],'Consumo',almox,k);
 assert.equal(r2.replayed,true);assert.equal((r2.movements as Row[])[0].id,(r1.movements as Row[])[0].id);
 assert.equal(await balance(id),7);
 await rejects(toolsMutate('tools/move',{kind:'saida',reason:'x',lines:[{itemId:id,qty:1}]},almox),400,'IDEMPOTENCY_KEY_REQUIRED');
});

test('unidade inteira recusa fração; unidade fracionada aceita',async()=>{
 const un=await newItem({name:'Rebite',initialQty:10}),kg=await newItem({name:'Graxa',unitId:'kg',initialQty:2.5});
 await rejects(move('saida',[{itemId:un,qty:1.5}]),400);
 await move('saida',[{itemId:kg,qty:0.75}]);assert.equal(await balance(kg),1.75);
});

test('ajuste de saldo é só da gestão e leva o saldo ao valor contado',async()=>{
 const id=await newItem({name:'Disco de corte',initialQty:10});
 await rejects(move('ajuste',[{itemId:id,counted:8}],'Contagem'),403,'FORBIDDEN');
 await move('ajuste',[{itemId:id,counted:8}],'Contagem',manager);
 assert.equal(await balance(id),8);
 await rejects(move('ajuste',[{itemId:id,counted:8}],'Contagem',manager),400,'NO_CHANGE');
});

test('banco: saldo só muda por movimento, livro não se altera e cadastro não se apaga',async()=>{
 const id=await newItem({name:'Trena',kind:'ferramenta',initialQty:2});
 await assert.rejects(db.run('UPDATE tool_items SET balance_milli=99000 WHERE id=?',id),/só muda por movimenta/);
 await assert.rejects(db.run('UPDATE tool_movements SET reason=? WHERE item_id=?','x',id),/não podem ser alteradas/);
 await assert.rejects(db.run('DELETE FROM tool_movements WHERE item_id=?',id),/não podem ser alteradas/);
 await assert.rejects(db.run('DELETE FROM tool_items WHERE id=?',id),/não pode ser apagado/);
 await assert.rejects(db.run("UPDATE tool_items SET kind='material' WHERE id=?",id),/Tipo e unidade/);
});

test('item inativo não movimenta; painel mostra o que está abaixo do mínimo',async()=>{
 const id=await newItem({name:'Cabo',initialQty:3,min:5});
 const d=await toolsGet('tools/dashboard',url(),almox) as {low:Row[],totals:Row,today:Row};
 assert.ok(d.low.some(r=>r.id===id));assert.ok(d.totals.items>=1);assert.ok(d.today.entrada>=1);
 const low=await toolsGet('tools/items',url({status:'low'}),almox) as {rows:Row[]};assert.ok(low.rows.every(r=>r.low));
 const zero=await newItem({name:'Cabo zerado',initialQty:0});
 const avail=(await toolsGet('tools/items',url({status:'available'}),almox) as {rows:Row[]}).rows;
 assert.ok(avail.some(r=>r.id===id)&&!avail.some(r=>r.id===zero),'disponível: só itens ativos com saldo');
 await save('items/save',{id,kind:'material',name:'Cabo',unitId:'un',min:5,active:false});
 await rejects(move('entrada',[{itemId:id,qty:1}]),409,'ITEM_INACTIVE');
 assert.equal((await toolsGet('tools/items',url({status:'inactive'}),almox) as {rows:Row[]}).rows.some(r=>r.id===id),true);
});

test('busca e filtros do inventário',async()=>{
 const cat=(await save('categories/save',{name:'Elétrica'})).id as string,loc=(await save('locations/save',{name:'Prateleira 1'})).id as string;
 const id=await newItem({name:'Alicate universal',kind:'ferramenta',categoryId:cat,locationId:loc,initialQty:1});
 const r=await toolsGet('tools/items',url({q:'alicate',kind:'ferramenta',category:cat,location:loc}),almox) as {rows:Row[]};
 assert.deepEqual(r.rows.map(x=>x.id),[id]);assert.equal(r.rows[0].categoryName,'Elétrica');
 await rejects(save('categories/save',{name:'elétrica'}),409);
 await rejects(toolsGet('tools/items',url({kind:'x'}),almox),400);
});

test('unidade configurável: não vira "só inteiros" com saldo fracionado',async()=>{
 const u=(await save('units/save',{name:'Rolo',abbr:'rl',integral:false})).id as string;
 const id=await newItem({name:'Corda',unitId:u,initialQty:2.5});
 await rejects(save('units/save',{id:u,name:'Rolo',abbr:'rl',integral:true}),409);
 assert.equal(await balance(id),2.5);
});

test('duas saídas ao mesmo tempo da última unidade: só uma passa e o saldo não fica negativo',async()=>{
 const id=await newItem({name:'Última peça',initialQty:1});
 const r=await Promise.allSettled([move('saida',[{itemId:id,qty:1}]),move('saida',[{itemId:id,qty:1}])]);
 assert.equal(r.filter(x=>x.status==='fulfilled').length,1);
 assert.equal(r.filter(x=>x.status==='rejected').length,1);
 assert.equal(await balance(id),0);
});

"""Converte o banco SQLite exportado da v7 (D1) em SQL para o Postgres da v8.

Uso: python3 -I scripts/import-v7.py <nautilus.sqlite> <senha-padrao> > dados.sql
O SQL gerado contém dados pessoais: nunca versionar. Aplicar DEPOIS de 0001_schema.sql
e ANTES de 0002_integrity.sql, para não repetir baixas de estoque.
Cada membro recebe um usuário (nome.sobrenome) e a senha padrão como senha provisória.
"""
import sqlite3, sys, json, hashlib, os, base64, unicodedata, re
from datetime import datetime, timezone

def lit(v):
    if v is None: return 'NULL'
    if isinstance(v, (int, float)): return str(int(v)) if float(v).is_integer() else repr(v)
    return "'" + str(v).replace("'", "''") + "'"

def arr(values): return 'ARRAY[' + ','.join(lit(v) for v in values) + ']::text[]'

def username(name, used):
    n = unicodedata.normalize('NFD', name).encode('ascii', 'ignore').decode().lower()
    parts = [p for p in re.sub(r'[^a-z0-9 ]', ' ', n).split() if p]
    base = (parts[0] + '.' + parts[-1]) if len(parts) > 1 else (parts[0] if parts else 'usuario')
    candidate, i = base[:40], 2
    while candidate in used: candidate, i = f'{base[:37]}{i}', i + 1
    used.add(candidate); return candidate

def pbkdf2(password):
    salt = os.urandom(16)
    key = hashlib.pbkdf2_hmac('sha256', unicodedata.normalize('NFKC', password).encode(), salt, 310000, 32)
    b64 = lambda b: base64.urlsafe_b64encode(b).decode().rstrip('=')
    return f'pbkdf2_sha256$310000${b64(salt)}${b64(key)}'

db = sqlite3.connect(sys.argv[1]); db.row_factory = sqlite3.Row
password = sys.argv[2]
now = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.') + f'{datetime.now(timezone.utc).microsecond // 1000:03d}Z'
out = []
def insert(table, cols, rows):
    if rows: out.append(f"INSERT INTO {table}({','.join(cols)}) VALUES\n" + ',\n'.join('(' + ','.join(r) + ')' for r in rows) + ';')

used = set(); report = []
members = db.execute('SELECT * FROM members ORDER BY created_at').fetchall()
rows = []
for m in members:
    u = username(m['name'], used); report.append((m['name'], u, m['profile']))
    rows.append([lit(m['id']), lit(u), lit(m['email'].lower() if m['email'] else None), lit(m['name']), lit(m['profile']), lit(m['notify_requests']), lit(m['notify_schedule']), lit(m['active']), lit(m['created_at']), lit(pbkdf2(password)), '1', lit(now)])
insert('members', ['id','username','email','name','profile','notify_requests','notify_schedule','active','created_at','password_hash','must_change_password','password_changed_at'], rows)

def copy(table, cols, transform=None, order='rowid'):
    rows = []
    for r in db.execute(f'SELECT * FROM {table} ORDER BY {order}').fetchall():
        rows.append([transform(c, r[c]) if transform else lit(r[c]) for c in cols])
    insert(table, cols, rows)

copy('fuels', ['id','name','unit','integral','capacity_milli','minimum_milli','stock_milli','lead_days','provisional','active','version'])
copy('operators', ['id','name','badge','active'])
copy('equipment', ['id','tag','description','type','fuel_ids','active'], lambda c, v: arr(json.loads(v)) if c == 'fuel_ids' else lit(v))
copy('appointments', ['id','operation_key','equipment_id','equipment_tag','equipment_name','fuel_id','fuel_name','hourmeter_milli','requester_id','requester_name','created_at','status','scheduled_at','assigned_member_id','assigned_name','scheduled_by_id','scheduled_by_name','updated_at','completed_at','cancel_reason','cancelled_by_id','cancelled_by_name','version'])
copy('supplies', ['id','appointment_id','operation_key','fuel_id','equipment_id','operator_id','quantity_milli','occurred_at','created_at','author_id','author_name','equipment_tag','equipment_name','operator_name','fuel_name','unit','hourmeter_milli','hourmeter_end_milli','notes','status','cancel_reason'])
copy('requests', ['id','fuel_id','requested_milli','received_milli','stock_reference_milli','opened_at','deadline','status'])
copy('movements', ['id','operation_key','fuel_id','delta_milli','kind','supply_id','request_id','balance_after_milli','expected_version','occurred_at','author_id','author_name','reason'])
copy('audits', ['id','action','entity_id','author_id','author_name','created_at','detail'])
copy('holidays', ['date','name'])
copy('notification_events', ['id','kind','entity_type','entity_id','version','created_at'])
# Avisos históricos não são reenviados: o que não foi concluído vira "skipped".
copy('notifications', ['id','event_id','member_id','status','attempts','locked_at','sent_at','last_error','created_at'],
     lambda c, v: lit('skipped' if c == 'status' and v in ('pending','sending','failed') else v))
print('\n'.join(out))
for name, u, profile in report: print(f'{name}\t{u}\t{profile}', file=sys.stderr)

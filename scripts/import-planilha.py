"""Gera SQL para importar o histórico da planilha CONTROLE_DE_ABASTECIMENTO.xlsx.

Uso: python3 -I scripts/import-planilha.py <planilha.xlsx> > historico.sql
Colunas esperadas: Data | Equipamento | Combustível | Horímetro Inicial | Horímetro Final | Quantidade.

Regras:
* Registros históricos (anteriores ao sistema) NÃO movimentam o estoque: o saldo físico
  atual já reflete esse consumo. Por isso o gatilho de baixa fica desligado só durante a carga.
* Data sem horário: registrada às 12:00 de Brasília (15:00 UTC) para não mudar de dia.
* Operador físico: Italo Souza. Lançamento em nome do gestor Thiago Almeida, com observação.
* Reexecutar não duplica: a chave de operação é derivada da linha e da data.
"""
import sys, hashlib
import openpyxl

TAGS = {'EG - 4,5-01': 'EMPG-001', 'ED - 16-02': 'EMPD-001', 'PTA-001': 'PTAG-001'}
FUELS = {'Gás': 'gas', 'Diesel': 'diesel'}
OPERATOR_ID = 'f728b302-2fe8-465b-bbbc-7188fce4a30b'   # Italo Souza
AUTHOR_ID = '45cd90b9-0326-4740-bb46-1ccc485b7e66'     # Thiago Almeida (gestor)
NOTE = 'Histórico importado da planilha CONTROLE_DE_ABASTECIMENTO (anterior ao sistema; não movimenta o estoque).'

def lit(v): return 'NULL' if v is None else "'" + str(v).replace("'", "''") + "'"
def milli(v): return None if v is None or v == '' else round(float(v) * 1000)

ws = openpyxl.load_workbook(sys.argv[1], data_only=True).worksheets[0]
rows = []
for n, (date, tag, fuel, h0, h1, qty) in enumerate(ws.iter_rows(min_row=2, values_only=True), 2):
    if date is None: continue
    if tag not in TAGS or fuel not in FUELS: sys.exit(f'Linha {n}: equipamento/combustível não mapeado ({tag}, {fuel})')
    day = date.strftime('%Y-%m-%d')
    key = 'planilha:' + hashlib.sha1(f'{n}|{day}|{tag}|{fuel}|{h0}|{h1}|{qty}'.encode()).hexdigest()[:16]
    start, end = milli(h0), milli(h1)
    if start is not None and end is not None and end < start: sys.exit(f'Linha {n}: horímetro final menor que o inicial')
    rows.append(f"({lit(key)},{lit(TAGS[tag])},{lit(FUELS[fuel])},{milli(qty)}::bigint,{lit(day + 'T15:00:00.000Z')},{start if start is not None else 'NULL'}::bigint,{end if end is not None else 'NULL'}::bigint)")

print(f"""SET ROLE nautilus_app;
SET search_path TO nautilus;
BEGIN;
ALTER TABLE supplies DISABLE TRIGGER supply_after_insert;
INSERT INTO supplies(id,appointment_id,operation_key,fuel_id,equipment_id,operator_id,quantity_milli,occurred_at,created_at,author_id,author_name,equipment_tag,equipment_name,operator_name,fuel_name,unit,hourmeter_milli,hourmeter_end_milli,notes,status,cancel_reason)
SELECT gen_random_uuid()::text,NULL,v.key,f.id,e.id,o.id,v.qty,v.occurred,to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),m.id,m.name,e.tag,e.description,o.name,f.name,f.unit,v.h0,v.h1,{lit(NOTE)},'confirmed',''
FROM (VALUES
{(','+chr(10)).join(rows)}
) AS v(key,tag,fuel,qty,occurred,h0,h1)
JOIN equipment e ON e.tag=v.tag JOIN fuels f ON f.id=v.fuel
JOIN operators o ON o.id={lit(OPERATOR_ID)} JOIN members m ON m.id={lit(AUTHOR_ID)}
ON CONFLICT (operation_key) DO NOTHING;
ALTER TABLE supplies ENABLE TRIGGER supply_after_insert;
DO $$ BEGIN
  IF (SELECT count(*) FROM supplies WHERE operation_key LIKE 'planilha:%') <> {len(rows)} THEN
    RAISE EXCEPTION 'Importação incompleta: verifique o mapeamento de equipamentos';
  END IF;
END $$;
INSERT INTO audits(id,action,entity_id,author_id,author_name,created_at,detail)
SELECT gen_random_uuid()::text,'Histórico importado da planilha','supplies',id,name,to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'{{"registros":{len(rows)},"operador":"Italo Souza","movimenta_estoque":false}}'
FROM members WHERE id={lit(AUTHOR_ID)};
COMMIT;
RESET search_path;
RESET ROLE;""")
print(f'{len(rows)} registros', file=sys.stderr)

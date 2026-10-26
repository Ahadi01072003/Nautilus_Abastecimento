-- OS cancelada não segura recurso: as reservas de equipamento que ainda estavam ativas (inclusive o
-- trecho já decorrido até o cancelamento) são liberadas. O uso real continua nos períodos das etapas.
UPDATE reservations r
   SET status = 'liberada', released_at = coalesce(w.cancelled_at, to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')), release_reason = 'OS cancelada'
  FROM plans p JOIN work_orders w ON w.id = p.work_order_id
 WHERE r.plan_id = p.id AND w.status = 'cancelada' AND r.status <> 'liberada';

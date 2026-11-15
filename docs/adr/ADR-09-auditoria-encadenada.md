# ADR-09: Registro de auditoría encadenado y de solo anexar, con un único administrador

| | |
|---|---|
| Estado | Aceptada e implementada |
| Fecha | 15 de noviembre de 2026 |
| Escenario | SEG-2 (no repudio) |
| Depende de | SEG-1 (la identidad sale del token), OBS-1 (identificador de correlación, Prometheus) |
| Evidencia | [SEG-2: Seguridad, no repudio](../quality/SEG-2-no-repudio.md) |

## Contexto

SEG-2 pide que cada petición al Back (HTTP y eventos de Socket.IO) deje un registro con usuario, IP, fecha y hora UTC del servidor, región y navegador; que ningún registro pueda modificarse o borrarse sin que se note; que toda acción se atribuya en menos de un minuto y que los registros se conserven al menos 90 días.

Las peticiones entran por dos puntos distintos: el API Gateway ve las HTTP y el Battle Service ve el handshake y los eventos de Socket.IO (el gateway solo reenvía la conexión). El Battle Service corre en varias réplicas. Los logs JSON de OBS-1 no bastan: viven en el recolector de logs, se pueden rotar o borrar y nadie puede demostrar que una línea no fue alterada.

## Decisión

1. **Un registro por petición en el punto que la atiende.** Un `WebFilter` global del gateway (envuelve la cadena de seguridad, así que también ve los 401, 403 y 429) y un registro en el Battle Service por handshake y por evento. El usuario siempre es el del token validado (SEG-1), nunca un identificador enviado por el cliente. La IP sale solo de las entradas de `X-Forwarded-For` que agregan proxies de confianza.
2. **Un único escritor de la cadena: users-service.** Los productores envían lotes cada segundo a `POST /internal/audit/events`. users-service toma un bloqueo consultivo de PostgreSQL, lee la cabeza de la cadena, resuelve la región (GeoIP local) y anexa: `hash = HMAC-SHA256(AUDIT_CHAIN_KEY, prev_hash ‖ registro)` con números de secuencia sin huecos. Varias instancias de users-service pueden recibir lotes a la vez sin romper la cadena.
3. **Solo anexar en la base de datos.** Triggers que rechazan `UPDATE`, `DELETE` y `TRUNCATE` sobre `audit_log`, incluso para el usuario de la aplicación. No hay purga: la retención es ilimitada (≥ 90 días).
4. **Verificación continua.** users-service recorre toda la cadena cada 5 minutos (y cuando el admin lo pide) y publica `audit_chain_valid` y `audit_chain_head_seq`; Prometheus alerta si la cadena se rompe o si su cabeza retrocede (cola borrada). Cada verificación deja una línea `audit.checkpoint` con la cabeza en el recolector de logs, fuera de la base de datos.
5. **Un único administrador**, identificado por el `oid` de Microsoft Entra ID en `ADMIN_USER_OID` (un valor, no una lista). El gateway le da `ROLE_ADMIN` y solo él llega a `/api/admin/**`; el gateway agrega el secreto interno que users-service exige en esas rutas, y quita el que intente mandar un cliente. El panel de administración (frontend `/admin`) muestra los registros, su integridad y las alertas.
6. **El registro no puede tumbar el servicio.** Los productores encolan en memoria (acotada) y reintentan con espera creciente; reenviar es seguro porque users-service descarta los `eventId` que ya tiene. Solo si el búfer se llena se pierden registros, y eso se cuenta y alerta.

## Alternativas descartadas

| Alternativa | Por qué no |
|---|---|
| Solo logs JSON (OBS-1) | Se pueden borrar o editar sin dejar rastro; no hay forma de verificar su integridad |
| Escribir cada registro de forma síncrona antes de atender la petición | Suma una escritura en PostgreSQL a cada evento (REN-1, p95 ≤ 300 ms) y haría que una caída de users-service detuviera las batallas |
| Que cada réplica encadene sus propios registros | Varias cadenas paralelas; borrar una réplica entera de registros no se detectaría y la verificación tendría que conocer todas las réplicas que existieron |
| Redis Streams como cola | Más durable ante la muerte de un productor, pero exige Redis también en el gateway y en desarrollo local; el lote HTTP con reintentos e idempotencia es suficiente para el alcance |
| Un evento de auditoría por cada evento descartado por SEG-3 | Un cliente que inunda con 200 eventos/s multiplicaría la carga sobre el registro: el ataque se trasladaría a la auditoría. Se registra un incidente por línea de SEG-3 con el conteo de descartados |
| Rol admin por lista o por grupo de Entra ID | El escenario pide un usuario único; un solo `oid` configurado lo garantiza sin depender de la administración del tenant |
| Credenciales propias para el admin | ADR-03 ya delega la identidad en Entra ID |

## Consecuencias

- **Positivas.** Cualquier alteración o borrado dentro de la cadena se detecta y se localiza (primer registro roto). Sin la clave HMAC, quien tenga acceso de escritura a la base no puede reconstruir una cadena válida. El panel atribuye cualquier acción en segundos.
- **Negativas.** Si un productor muere de golpe (SIGKILL) se pierde lo que tenía en cola (≤ 1 s de registros); con SIGTERM los entrega antes de salir. El borrado de la cola de la cadena por alguien con privilegios de superusuario solo se detecta comparando con los checkpoints externos o con la alerta de Prometheus. La tabla crece sin límite: archivarla requerirá un procedimiento que conserve el último hash como ancla.

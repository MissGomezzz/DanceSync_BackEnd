# ADR-10: Balanceador propio (nginx) también en Azure

| | |
|---|---|
| Estado | Aceptada e implementada en Azure (17 de noviembre de 2026) |
| Fecha | 17 de noviembre de 2026 |
| Escenarios | REN-1 (rendimiento y escalabilidad horizontal), DIS-1 (disponibilidad) |
| Reemplaza | La parte "Azure" de [ADR-02](ADR-02-balanceador-solo-websocket.md), que dejaba el reparto al ingreso de Container Apps |
| Evidencia | [REN-1, sección "Despliegue en Azure con el balanceador propio"](../quality/REN-1-rendimiento-latencia.md#despliegue-en-azure-con-el-balanceador-propio) |

## Contexto

Es un requisito del curso que el reparto de carga entre las réplicas lo haga **un balanceador nuestro**, no el de la plataforma. En el prototipo local ya era así (nginx con `least_conn`, ADR-02). En Azure, en cambio, `battle-service` era una sola Container App con 2 réplicas, y el ingreso de Container Apps elegía la réplica de cada conexión.

Una Container App con varias réplicas tiene una sola dirección. Desde fuera no se puede apuntar a una réplica concreta, así que un nginx delante de esa dirección solo reenviaría todo al ingreso de Azure, que seguiría eligiendo.

## Decisión

```
cliente → api-gateway → load-balancer (nginx, least_conn) ─┬→ battle-service-a (TCP 3001) ┐
                                                           └→ battle-service-b (TCP 3002) ┴→ Redis
```

- **Una Container App por réplica.** `battle-service-a` y `battle-service-b`, con 1 réplica cada una, la misma imagen, los mismos secretos y el mismo Redis.
- **Ingreso TCP interno en cada réplica** (puertos 3001 y 3002), el mismo tipo que ya usa Redis. Con TCP, Azure solo pasa bytes: no enruta por nombre de host ni elige destino. Con ingreso HTTP habría que enviar a cada réplica su propio `Host`, y un solo bloque `upstream` de nginx no puede hacerlo.
- **`load-balancer`:** nginx con la configuración de `load-balancer/azure/nginx.conf`, ingreso HTTP **interno** (solo el gateway llega a él), 1 réplica, 0,25 vCPU / 0,5 GiB. `least_conn`, verificación pasiva (1 fallo saca la réplica 10 s y el intento se repite en la otra, `proxy_connect_timeout 2s`) y una línea JSON por petición con la réplica que atendió (`replica`), para consultar el reparto en Log Analytics.
- **El gateway apunta a nginx:** `BATTLE_SERVICE_URL=http://load-balancer`.
- **`TRUSTED_PROXY_HOPS=4`** en las dos réplicas: delante de ellas están el ingreso del gateway, el gateway, el ingreso de nginx y nginx. Verificado: la IP registrada en `abuse.*` y en el panel de administración es la IP pública del cliente.
- **La app anterior (`battle-service`) queda en 0 réplicas** como respaldo: volver a ella es `BATTLE_SERVICE_URL=http://battle-service` en el gateway.
- **Pipeline:** `deploy-battle-service.yml` despliega la imagen en `battle-service-a` y `battle-service-b`; `deploy-load-balancer.yml` construye `load-balancer/azure/` cuando cambia.

## Alternativas consideradas

| Alternativa | Por qué se descartó |
|---|---|
| Seguir con el ingreso de Azure | No cumple el requisito: el reparto lo decide la plataforma |
| nginx delante de la app de 2 réplicas | nginx tendría un solo destino; quien elige la réplica seguiría siendo Azure |
| Ingreso HTTP en cada réplica | El ingreso de Azure enruta por `Host`; nginx no puede enviar un `Host` distinto a cada servidor de un mismo `upstream` |
| Dos réplicas de nginx | Entre ellas volvería a elegir el ingreso de Azure, y cada nginx contaría solo sus propias conexiones, así que `least_conn` sería aproximado. Por capacidad no hace falta: en la prueba de estrés nginx llegó como máximo al 28 % de CPU |
| nginx y las dos réplicas como contenedores de una misma app | Compartirían la CPU de una sola réplica y caerían juntos: no habría escalabilidad horizontal ni tolerancia a fallos |

## Consecuencias

**Positivas**

- El reparto lo decide nuestro nginx también en Azure, y queda registrado réplica por réplica.
- Azure se comporta como el prototipo donde se midieron REN-1 y DIS-1: el mismo balanceador, la misma verificación pasiva.
- Volver atrás es una variable del gateway.

**Negativas y riesgos**

- **nginx es un punto único de falla**, como Redis. Si su contenedor cae, Azure lo reinicia en segundos; no guarda estado y los clientes se reconectan solos, así que se pierden segundos de servicio, no salas ni puntajes. En producción se pondrían dos con un balanceador administrado delante, lo que devolvería a la plataforma la decisión de reparto.
- **Detección pasiva.** nginx descubre una réplica caída cuando falla una conexión hacia ella (hasta 2 s de espera). Las sondas de Azure reinician la réplica enferma, pero no la sacan de la rotación de nginx.
- **Escalar es agregar una app**, no subir `maxReplicas`: una tercera réplica es `battle-service-c` con otro puerto y una línea más en el `upstream`.
- **Un despliegue de nginx corta las conexiones WebSocket abiertas.** Por eso `deploy-load-balancer.yml` solo corre cuando cambia su configuración.

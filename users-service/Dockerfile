# Etapa 1: compilar con Maven y JDK 17
FROM maven:3.9-eclipse-temurin-17 AS build
WORKDIR /app
COPY pom.xml .
RUN mvn -B -q dependency:go-offline
COPY src ./src
RUN mvn -B -q -DskipTests package

# Etapa 2 (SEG-2): base GeoIP local para la región de cada dirección auditada. DB-IP "IP to City
# Lite" (CC BY 4.0, https://db-ip.com), en formato MaxMind. Se descarga al construir la imagen; si
# la descarga falla la imagen se construye igual y la región de las IP públicas queda "unknown"
# (la IP se guarda siempre). GEOIP_EDITION=country baja una base de ~8 MB en vez de ~130 MB.
FROM alpine:3.20 AS geoip
ARG GEOIP_EDITION=city
RUN apk add --no-cache curl >/dev/null \
 && mkdir -p /geoip \
 && year="$(date -u +%Y)" && month="$(date -u +%m | sed 's/^0//')" \
 && current="$(printf '%s-%02d' "$year" "$month")" \
 && previous="$(if [ "$month" -eq 1 ]; then printf '%s-12' "$((year - 1))"; else printf '%s-%02d' "$year" "$((month - 1))"; fi)" \
 && for when in "$current" "$previous"; do \
      if curl --proto =https --tlsv1.2 -fsSL "https://download.db-ip.com/free/dbip-${GEOIP_EDITION}-lite-${when}.mmdb.gz" -o /tmp/db.gz; then \
        gunzip -c /tmp/db.gz > /geoip/dbip-lite.mmdb && rm -f /tmp/db.gz && echo "GeoIP ${when} OK" && break; \
      fi; \
    done; \
    ls -la /geoip

# Etapa 3: imagen final, solo JRE
FROM eclipse-temurin:17-jre
WORKDIR /app
RUN useradd --system --create-home app
COPY --from=build /app/target/*.jar app.jar
COPY --from=geoip /geoip /app/geoip
# Si la base no se descargó, users-service arranca igual y lo avisa en el log.
ENV GEOIP_DB_PATH=/app/geoip/dbip-lite.mmdb
USER app
# 8081: API. 9081: actuator health and Prometheus (MANAGEMENT_PORT), internal only.
EXPOSE 8081 9081
ENV JAVA_TOOL_OPTIONS="-XX:+UseSerialGC -XX:TieredStopAtLevel=1 -XX:MaxRAMPercentage=75"
ENTRYPOINT ["java", "-jar", "/app/app.jar"]

# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Build stage: resolve dependencies, compile and package the executable jar.
# ---------------------------------------------------------------------------
FROM maven:3.9-eclipse-temurin-21 AS build
WORKDIR /workspace

# The POM is copied on its own first so the (slow) dependency download is cached
# in its own layer and only re-runs when the dependencies actually change.
COPY pom.xml .
RUN mvn -B -q dependency:go-offline

# Then the sources, which change far more often.
COPY src ./src
RUN mvn -B -q clean package -DskipTests

# ---------------------------------------------------------------------------
# Runtime stage: JRE only, non-root, just the jar.
# ---------------------------------------------------------------------------
FROM eclipse-temurin:21-jre-alpine
WORKDIR /app

# Run as an unprivileged user rather than root, so a compromise of the process
# does not come with root inside the container.
RUN addgroup -S app && adduser -S app -G app

# Only the packaged jar crosses the stage boundary: no build tools, no sources
# and no Maven cache end up in the final image.
COPY --from=build --chown=app:app /workspace/target/*.jar app.jar

USER app
EXPOSE 8080

# MaxRAMPercentage makes the JVM size its heap from the container memory limit
# rather than the host's total memory. No secrets are baked into the image: the
# task role supplies credentials at runtime, if the application ever needs them.
ENTRYPOINT ["java", "-XX:MaxRAMPercentage=75.0", "-jar", "/app/app.jar"]

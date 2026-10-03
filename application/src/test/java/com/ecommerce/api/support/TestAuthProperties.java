package com.ecommerce.api.support;

import org.springframework.test.context.DynamicPropertyRegistry;

/**
 * Registers the Phase 4 authentication properties the tests need.
 *
 * {@code application.properties} deliberately declares the issuer, client id and secret with no
 * default, so the container fails fast when they are missing. Tests therefore have to supply them
 * like any deployed environment would; the values are inert because
 * {@link TestSecurityConfiguration} replaces the registration they would otherwise configure.
 */
public final class TestAuthProperties {

    private TestAuthProperties() {
    }

    public static void register(DynamicPropertyRegistry registry) {
        registry.add("COGNITO_ISSUER_URI", () -> "https://cognito-idp.example.com");
        registry.add("COGNITO_CLIENT_ID", () -> "test-client-id");
        registry.add("COGNITO_CLIENT_SECRET", () -> "test-client-secret");
        registry.add("FRONTEND_URL", () -> "http://localhost:5173");
        registry.add("CORS_ALLOWED_ORIGINS", () -> "http://localhost:5173");
        registry.add("SESSION_TIMEOUT", () -> "PT30M");
    }
}

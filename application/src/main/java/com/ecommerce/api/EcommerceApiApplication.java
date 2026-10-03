package com.ecommerce.api;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

/**
 * Entry point of the e-commerce product API.
 *
 * The application serves product data over REST, backed by PostgreSQL through Spring Data JPA, and
 * exposes the Actuator health endpoint the load balancer health check depends on. The schema is
 * owned by Flyway; the credentials and the Cognito client secret come from the environment, injected
 * from Secrets Manager by ECS.
 *
 * From Phase 4 the application is also the OAuth client of the Cognito user pool (the Backend for
 * Frontend pattern): it runs the authorization code + PKCE flow server side and gives the browser
 * only an httpOnly session cookie. See {@code config/SecurityConfig}. There is no cache yet.
 */
@SpringBootApplication
public class EcommerceApiApplication {

    public static void main(String[] args) {
        SpringApplication.run(EcommerceApiApplication.class, args);
    }
}

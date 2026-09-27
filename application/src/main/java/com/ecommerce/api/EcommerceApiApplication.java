package com.ecommerce.api;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

/**
 * Entry point of the e-commerce product API.
 *
 * The application serves product data over REST, backed by PostgreSQL through Spring Data JPA, and
 * exposes the Actuator health endpoint the load balancer health check depends on. The schema is
 * owned by Flyway; the credentials come from the environment, injected from Secrets Manager by ECS.
 * There is no cache and no authentication in this phase.
 */
@SpringBootApplication
public class EcommerceApiApplication {

    public static void main(String[] args) {
        SpringApplication.run(EcommerceApiApplication.class, args);
    }
}

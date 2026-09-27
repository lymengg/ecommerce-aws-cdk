package com.ecommerce.api;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

/**
 * Entry point of the e-commerce product API.
 *
 * The application is intentionally minimal: it serves in-memory product data over REST and exposes
 * the Actuator health endpoint the load balancer health check depends on. There is no database, no
 * cache and no authentication in this phase.
 */
@SpringBootApplication
public class EcommerceApiApplication {

    public static void main(String[] args) {
        SpringApplication.run(EcommerceApiApplication.class, args);
    }
}

package com.ecommerce.api.repository;

import com.ecommerce.api.entity.Product;
import org.springframework.data.jpa.repository.JpaRepository;

/**
 * Spring Data JPA repository for {@link Product}.
 *
 * Extending {@link JpaRepository} is enough for this phase: it provides the CRUD operations the API
 * needs, and Spring Data writes the implementation at runtime, so there is no query code to test or
 * maintain. Derived queries or {@code @Query} methods belong here - not in the service - when a
 * later phase needs to filter or page products.
 */
public interface ProductRepository extends JpaRepository<Product, Long> {
}

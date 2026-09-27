package com.ecommerce.api.service;

import com.ecommerce.api.dto.ProductRequest;
import com.ecommerce.api.entity.Product;
import com.ecommerce.api.repository.ProductRepository;
import java.util.List;
import java.util.Optional;
import org.springframework.data.domain.Sort;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Product business operations.
 *
 * The service is the only place that knows both the API's request shape and the persistence layer:
 * the controller maps HTTP to a method call and holds no logic, and the repository does nothing but
 * query. Reads are marked read-only so Hibernate skips dirty checking, and writes run inside a
 * transaction that either commits as a whole or rolls back as a whole.
 */
@Service
public class ProductService {

    /** Stable ordering, so repeated calls return the same list in the same order. */
    private static final Sort BY_ID = Sort.by(Sort.Direction.ASC, "id");

    private final ProductRepository productRepository;

    public ProductService(ProductRepository productRepository) {
        this.productRepository = productRepository;
    }

    /** All products, ordered by id. */
    @Transactional(readOnly = true)
    public List<Product> findAll() {
        return productRepository.findAll(BY_ID);
    }

    @Transactional(readOnly = true)
    public Optional<Product> findById(long id) {
        return productRepository.findById(id);
    }

    /** Stores a new product and returns it with the id and timestamps the database assigned. */
    @Transactional
    public Product create(ProductRequest request) {
        Product product = new Product(
                request.name(),
                request.description(),
                request.price(),
                request.quantity() == null ? 0 : request.quantity());

        return productRepository.save(product);
    }
}

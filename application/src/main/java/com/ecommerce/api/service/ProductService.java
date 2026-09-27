package com.ecommerce.api.service;

import com.ecommerce.api.model.Product;
import java.math.BigDecimal;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;
import org.springframework.stereotype.Service;

/**
 * Product storage, held in memory.
 *
 * This is deliberately the simplest thing that works: a concurrent map seeded with two products and
 * an id sequence. State is lost when the task stops, which is acceptable in this phase because there
 * is exactly one task and no database. A later phase replaces this class with a real repository.
 */
@Service
public class ProductService {

    private final Map<Long, Product> products = new ConcurrentHashMap<>();
    private final AtomicLong nextId = new AtomicLong();

    public ProductService() {
        save("Laptop", new BigDecimal("1200.00"));
        save("Smartphone", new BigDecimal("800.00"));
    }

    /** All products, ordered by id so the response is stable between calls. */
    public List<Product> findAll() {
        return products.values().stream()
                .sorted(Comparator.comparing(Product::id))
                .toList();
    }

    public Optional<Product> findById(long id) {
        return Optional.ofNullable(products.get(id));
    }

    /** Stores a new product and returns it with the id the server assigned. */
    public Product create(String name, BigDecimal price) {
        return save(name, price);
    }

    private Product save(String name, BigDecimal price) {
        long id = nextId.incrementAndGet();
        Product product = new Product(id, name, price);
        products.put(id, product);
        return product;
    }
}

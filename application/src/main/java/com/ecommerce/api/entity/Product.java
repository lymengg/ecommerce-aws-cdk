package com.ecommerce.api.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.PrePersist;
import jakarta.persistence.PreUpdate;
import jakarta.persistence.Table;
import java.math.BigDecimal;
import java.time.Instant;

/**
 * A product, stored in the {@code products} table.
 *
 * The mapping is deliberately explicit. {@code price} is a {@link BigDecimal}, never a
 * {@code double} or a {@code float}: binary floating point cannot represent 0.10 exactly, so
 * monetary values would drift by fractions of a cent on every round trip. {@code createdAt} and
 * {@code updatedAt} are maintained by the entity itself, and {@code id} is assigned by the
 * database.
 *
 * The table is created by Flyway, not by Hibernate (see {@code db/migration}). This class describes
 * what already exists, and {@code spring.jpa.hibernate.ddl-auto=validate} makes the application
 * refuse to start if the two ever disagree.
 */
@Entity
@Table(name = "products")
public class Product {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(nullable = false)
    private String name;

    @Column(length = 1000)
    private String description;

    @Column(nullable = false, precision = 12, scale = 2)
    private BigDecimal price;

    @Column(nullable = false)
    private Integer quantity;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    /** Required by JPA to materialise rows; application code uses the constructor below. */
    protected Product() {
    }

    public Product(String name, String description, BigDecimal price, Integer quantity) {
        this.name = name;
        this.description = description;
        this.price = price;
        this.quantity = quantity;
    }

    /**
     * Stamps both timestamps on insert.
     *
     * {@link Instant} is an absolute point in time, so there is no zone to get wrong: it is stored
     * in a {@code timestamptz} column and read back as the same instant regardless of the region or
     * the JVM's default zone.
     */
    @PrePersist
    void stampCreated() {
        Instant now = Instant.now();
        this.createdAt = now;
        this.updatedAt = now;
    }

    /** Moves {@code updatedAt} forward whenever a managed instance is flushed after a change. */
    @PreUpdate
    void stampUpdated() {
        this.updatedAt = Instant.now();
    }

    public Long getId() {
        return id;
    }

    public String getName() {
        return name;
    }

    public String getDescription() {
        return description;
    }

    public BigDecimal getPrice() {
        return price;
    }

    public Integer getQuantity() {
        return quantity;
    }

    public Instant getCreatedAt() {
        return createdAt;
    }

    public Instant getUpdatedAt() {
        return updatedAt;
    }
}

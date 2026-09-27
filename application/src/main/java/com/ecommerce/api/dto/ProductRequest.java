package com.ecommerce.api.dto;

import jakarta.validation.constraints.Digits;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Positive;
import jakarta.validation.constraints.PositiveOrZero;
import jakarta.validation.constraints.Size;
import java.math.BigDecimal;

/**
 * The body of a create request.
 *
 * A dedicated request type rather than the entity: the client must not be able to choose the id or
 * the timestamps, and the validation rules describe the API's contract rather than the table's
 * columns. Bean Validation turns a violation into a {@code 400} before the controller body runs, so
 * no invalid product ever reaches the service.
 *
 * @param name        required, at most 255 characters
 * @param description optional, at most 1000 characters
 * @param price       required, greater than zero, at most two decimal places
 * @param quantity    optional, zero or greater; defaults to zero
 */
public record ProductRequest(
        @NotBlank(message = "name is required")
        @Size(max = 255, message = "name must be at most 255 characters")
        String name,

        @Size(max = 1000, message = "description must be at most 1000 characters")
        String description,

        @NotNull(message = "price is required")
        @Positive(message = "price must be greater than zero")
        @Digits(integer = 10, fraction = 2, message = "price must have at most 2 decimal places")
        BigDecimal price,

        @PositiveOrZero(message = "quantity must be zero or greater")
        Integer quantity) {
}

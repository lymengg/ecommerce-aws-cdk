package com.ecommerce.api.model;

import java.math.BigDecimal;

/**
 * A product as exposed by the API.
 *
 * A record keeps the model immutable and removes the getter/equals/hashCode boilerplate. The id is
 * assigned by the service, never by the client.
 */
public record Product(Long id, String name, BigDecimal price) {
}

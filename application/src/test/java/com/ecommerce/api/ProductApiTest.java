package com.ecommerce.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.ecommerce.api.repository.ProductRepository;
import com.jayway.jsonpath.JsonPath;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.http.MediaType;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.postgresql.PostgreSQLContainer;

/**
 * HTTP-level tests for the product API and the health endpoint, backed by a real PostgreSQL.
 *
 * The tests run against a Testcontainers PostgreSQL rather than an embedded database: the point of
 * this phase is that the application stores data in PostgreSQL, so the test should use the same
 * engine, the same dialect and the same Flyway migration that production does. The image tag
 * matches the major version the database stack deploys.
 *
 * The datasource properties are registered dynamically from the container, which overrides the
 * environment-driven values in {@code application.properties}. Flyway then migrates the container
 * and Hibernate validates the entity against the migrated schema before the first test runs, so a
 * broken migration or a stale entity fails the suite at startup.
 */
@SpringBootTest
@AutoConfigureMockMvc
@Testcontainers
class ProductApiTest {

    @Container
    static final PostgreSQLContainer POSTGRES = new PostgreSQLContainer("postgres:16-alpine");

    @DynamicPropertySource
    static void datasourceProperties(DynamicPropertyRegistry registry) {
        registry.add("spring.datasource.url", POSTGRES::getJdbcUrl);
        registry.add("spring.datasource.username", POSTGRES::getUsername);
        registry.add("spring.datasource.password", POSTGRES::getPassword);
    }

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private ProductRepository productRepository;

    /**
     * The context is shared between tests, so the table is emptied before each one rather than the
     * whole application being rebuilt: a product created by one test must not leak into the next.
     */
    @BeforeEach
    void emptyTheTable() {
        productRepository.deleteAll();
    }

    @Test
    void listsNothingWhenTheTableIsEmpty() throws Exception {
        mockMvc.perform(get("/api/products"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.length()").value(0));
    }

    @Test
    void createsAProductAndReadsItBackFromPostgres() throws Exception {
        String body = mockMvc.perform(post("/api/products")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {"name":"Laptop","description":"A 14 inch laptop","price":1200.00,"quantity":5}
                                """))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.name").value("Laptop"))
                .andExpect(jsonPath("$.description").value("A 14 inch laptop"))
                .andExpect(jsonPath("$.price").value(1200.00))
                .andExpect(jsonPath("$.quantity").value(5))
                // The timestamps are stamped by the entity on insert, not sent by the client.
                .andExpect(jsonPath("$.createdAt").isNotEmpty())
                .andExpect(jsonPath("$.updatedAt").isNotEmpty())
                .andReturn()
                .getResponse()
                .getContentAsString();

        long id = ((Number) JsonPath.read(body, "$.id")).longValue();

        // The row really is in PostgreSQL, not in a field of the controller.
        assertThat(productRepository.count()).isEqualTo(1);

        mockMvc.perform(get("/api/products/{id}", id))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.id").value(id))
                .andExpect(jsonPath("$.name").value("Laptop"));
    }

    @Test
    void listsProductsOrderedById() throws Exception {
        createProduct("Laptop", "1200.00", 1);
        createProduct("Smartphone", "800.00", 2);

        mockMvc.perform(get("/api/products"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.length()").value(2))
                .andExpect(jsonPath("$[0].name").value("Laptop"))
                .andExpect(jsonPath("$[1].name").value("Smartphone"));
    }

    @Test
    void defaultsAnOmittedQuantityToZero() throws Exception {
        mockMvc.perform(post("/api/products")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"name\":\"Cable\",\"price\":9.99}"))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.quantity").value(0));
    }

    @Test
    void returnsNotFoundForAnUnknownProduct() throws Exception {
        mockMvc.perform(get("/api/products/9999"))
                .andExpect(status().isNotFound());
    }

    @Test
    void rejectsAProductWithoutAName() throws Exception {
        mockMvc.perform(post("/api/products")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"price\":10.00}"))
                .andExpect(status().isBadRequest());

        mockMvc.perform(post("/api/products")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"name\":\"   \",\"price\":10.00}"))
                .andExpect(status().isBadRequest());

        assertThat(productRepository.count()).isZero();
    }

    @Test
    void rejectsAPriceThatIsNotPositive() throws Exception {
        mockMvc.perform(post("/api/products")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"name\":\"Freebie\",\"price\":0.00}"))
                .andExpect(status().isBadRequest());

        mockMvc.perform(post("/api/products")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"name\":\"Refund\",\"price\":-1.00}"))
                .andExpect(status().isBadRequest());

        mockMvc.perform(post("/api/products")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"name\":\"No price\"}"))
                .andExpect(status().isBadRequest());
    }

    @Test
    void rejectsANegativeQuantity() throws Exception {
        mockMvc.perform(post("/api/products")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"name\":\"Oversold\",\"price\":10.00,\"quantity\":-1}"))
                .andExpect(status().isBadRequest());
    }

    @Test
    void healthEndpointReportsUpIncludingTheDatabase() throws Exception {
        mockMvc.perform(get("/actuator/health"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("UP"));
    }

    private void createProduct(String name, String price, int quantity) throws Exception {
        mockMvc.perform(post("/api/products")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"name\":\"%s\",\"price\":%s,\"quantity\":%d}".formatted(name, price, quantity)))
                .andExpect(status().isCreated());
    }
}

package com.ecommerce.api.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.ecommerce.api.dto.ProductRequest;
import com.ecommerce.api.entity.Product;
import com.ecommerce.api.repository.ProductRepository;
import java.math.BigDecimal;
import java.util.List;
import java.util.Optional;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.data.domain.Sort;

/**
 * Unit tests for the service layer, with the repository mocked.
 *
 * These cover what the service is responsible for - turning a validated request into an entity and
 * deciding what an absent row means - without paying for a database. The persistence itself is
 * covered end to end by {@link com.ecommerce.api.ProductApiTest}.
 */
@ExtendWith(MockitoExtension.class)
class ProductServiceTest {

    @Mock
    private ProductRepository productRepository;

    @InjectMocks
    private ProductService productService;

    @Test
    void mapsTheRequestOntoAnEntityAndSavesIt() {
        when(productRepository.save(any(Product.class))).thenAnswer(invocation -> invocation.getArgument(0));

        productService.create(new ProductRequest("Tablet", "10 inch", new BigDecimal("450.00"), 3));

        ArgumentCaptor<Product> saved = ArgumentCaptor.forClass(Product.class);
        verify(productRepository).save(saved.capture());

        Product product = saved.getValue();
        assertThat(product.getName()).isEqualTo("Tablet");
        assertThat(product.getDescription()).isEqualTo("10 inch");
        assertThat(product.getPrice()).isEqualByComparingTo("450.00");
        assertThat(product.getQuantity()).isEqualTo(3);
    }

    @Test
    void defaultsAnOmittedQuantityToZero() {
        when(productRepository.save(any(Product.class))).thenAnswer(invocation -> invocation.getArgument(0));

        productService.create(new ProductRequest("Cable", null, new BigDecimal("9.99"), null));

        ArgumentCaptor<Product> saved = ArgumentCaptor.forClass(Product.class);
        verify(productRepository).save(saved.capture());

        assertThat(saved.getValue().getQuantity()).isZero();
    }

    @Test
    void returnsAnEmptyOptionalWhenTheRowDoesNotExist() {
        when(productRepository.findById(42L)).thenReturn(Optional.empty());

        assertThat(productService.findById(42)).isEmpty();
    }

    @Test
    void listsProductsOrderedById() {
        when(productRepository.findAll(any(Sort.class))).thenReturn(List.of());

        assertThat(productService.findAll()).isEmpty();

        ArgumentCaptor<Sort> sort = ArgumentCaptor.forClass(Sort.class);
        verify(productRepository).findAll(sort.capture());
        assertThat(sort.getValue().getOrderFor("id")).isNotNull();
        assertThat(sort.getValue().getOrderFor("id").getDirection()).isEqualTo(Sort.Direction.ASC);
    }
}

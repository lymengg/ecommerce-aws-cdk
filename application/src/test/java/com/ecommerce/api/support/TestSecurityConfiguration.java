package com.ecommerce.api.support;

import java.util.Map;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.webmvc.test.autoconfigure.MockMvcBuilderCustomizer;
import org.springframework.context.annotation.Bean;
import org.springframework.security.oauth2.client.registration.ClientRegistration;
import org.springframework.security.oauth2.client.registration.ClientRegistrationRepository;
import org.springframework.security.oauth2.client.registration.InMemoryClientRegistrationRepository;
import org.springframework.security.oauth2.core.AuthorizationGrantType;
import org.springframework.security.oauth2.core.ClientAuthenticationMethod;
import org.springframework.security.test.web.servlet.setup.SecurityMockMvcConfigurers;

/**
 * Test wiring for the security layer.
 *
 * <p>Two things are provided:
 *
 * <ul>
 *   <li>A {@link ClientRegistrationRepository} bean, which makes Boot's property-driven OIDC
 *       registration back off. The production configuration points the provider at a real Cognito
 *       issuer URI and Spring Security fetches its discovery document at startup; that would make
 *       every test depend on reaching Cognito. The endpoints below are never contacted by the
 *       tests.</li>
 *   <li>{@link SecurityMockMvcConfigurers#springSecurity()}, which connects Spring Security's test
 *       support to MockMvc so {@code @WithMockUser} actually reaches the filter chain. Boot 3 did
 *       this automatically for {@code @AutoConfigureMockMvc}; Boot 4 no longer ships that
 *       auto-configuration, so it is applied explicitly here.</li>
 * </ul>
 */
@TestConfiguration(proxyBeanMethods = false)
public class TestSecurityConfiguration {

    @Bean
    ClientRegistrationRepository clientRegistrationRepository() {
        ClientRegistration registration = ClientRegistration.withRegistrationId("cognito")
                .clientId("test-client-id")
                .clientSecret("test-client-secret")
                .clientAuthenticationMethod(ClientAuthenticationMethod.CLIENT_SECRET_BASIC)
                .authorizationGrantType(AuthorizationGrantType.AUTHORIZATION_CODE)
                .redirectUri("{baseUrl}/login/oauth2/code/cognito")
                .scope("openid", "email", "profile")
                .authorizationUri("https://cognito-idp.example.com/oauth2/authorize")
                .tokenUri("https://cognito-idp.example.com/oauth2/token")
                .jwkSetUri("https://cognito-idp.example.com/oauth2/jwks")
                .issuerUri("https://cognito-idp.example.com")
                .userNameAttributeName("cognito:username")
                .clientName("Cognito")
                // Cognito advertises its (non-standard) logout endpoint in discovery; the logout
                // handler reads it from here.
                .providerConfigurationMetadata(
                        Map.of("end_session_endpoint", "https://cognito-idp.example.com/logout"))
                .build();

        return new InMemoryClientRegistrationRepository(registration);
    }

    @Bean
    MockMvcBuilderCustomizer securityMockMvcBuilderCustomizer() {
        return builder -> builder.apply(SecurityMockMvcConfigurers.springSecurity());
    }
}

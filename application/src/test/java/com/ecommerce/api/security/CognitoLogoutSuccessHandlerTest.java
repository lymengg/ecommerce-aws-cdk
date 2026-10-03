package com.ecommerce.api.security;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.Map;
import java.util.Optional;
import org.junit.jupiter.api.Test;
import org.springframework.security.oauth2.client.registration.ClientRegistration;
import org.springframework.security.oauth2.core.AuthorizationGrantType;
import org.springframework.security.oauth2.core.ClientAuthenticationMethod;

/**
 * The logout handler's whole reason to exist is the parameter it sends, so that is what is asserted:
 * Cognito's {@code logout_uri}, and never the OIDC parameters it does not understand.
 */
class CognitoLogoutSuccessHandlerTest {

    private static ClientRegistration registration(Map<String, Object> providerMetadata) {
        return ClientRegistration.withRegistrationId("cognito")
                .clientId("client-123")
                .clientSecret("secret")
                .clientAuthenticationMethod(ClientAuthenticationMethod.CLIENT_SECRET_BASIC)
                .authorizationGrantType(AuthorizationGrantType.AUTHORIZATION_CODE)
                .redirectUri("{baseUrl}/login/oauth2/code/cognito")
                .scope("openid", "email", "profile")
                .authorizationUri("https://example.auth.ap-southeast-1.amazoncognito.com/oauth2/authorize")
                .tokenUri("https://example.auth.ap-southeast-1.amazoncognito.com/oauth2/token")
                .providerConfigurationMetadata(providerMetadata)
                .build();
    }

    @Test
    void sendsCognitosLogoutUriAndNotTheOidcParameters() {
        Optional<String> url = CognitoLogoutSuccessHandler.cognitoLogoutUrl(
                registration(Map.of(
                        "end_session_endpoint", "https://example.auth.ap-southeast-1.amazoncognito.com/logout")),
                "https://dev.example.com");

        assertThat(url).isPresent();
        assertThat(url.get()).startsWith("https://example.auth.ap-southeast-1.amazoncognito.com/logout?");
        assertThat(url.get()).contains("client_id=client-123");
        assertThat(url.get()).contains("logout_uri=https://dev.example.com");
        // Cognito ignores these; sending them is the bug this handler exists to avoid.
        assertThat(url.get()).doesNotContain("post_logout_redirect_uri");
        assertThat(url.get()).doesNotContain("id_token_hint");
    }

    @Test
    void returnsEmptyWhenTheProviderDoesNotAdvertiseAnEndSessionEndpoint() {
        assertThat(CognitoLogoutSuccessHandler.cognitoLogoutUrl(registration(Map.of()), "https://dev.example.com"))
                .isEmpty();
    }
}

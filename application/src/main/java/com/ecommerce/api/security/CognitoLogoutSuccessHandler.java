package com.ecommerce.api.security;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.util.Optional;
import org.springframework.security.core.Authentication;
import org.springframework.security.oauth2.client.registration.ClientRegistration;
import org.springframework.security.oauth2.client.registration.ClientRegistrationRepository;
import org.springframework.security.oauth2.client.authentication.OAuth2AuthenticationToken;
import org.springframework.security.web.authentication.logout.SimpleUrlLogoutSuccessHandler;
import org.springframework.web.util.UriComponentsBuilder;

/**
 * Ends the session at the identity provider as well as locally.
 *
 * <p>Spring Security ships {@code OidcClientInitiatedLogoutSuccessHandler}, which implements
 * <a href="https://openid.net/specs/openid-connect-rpinitiated-1_0.html">OIDC RP-Initiated Logout</a>
 * and therefore sends {@code post_logout_redirect_uri}. <strong>Amazon Cognito does not implement
 * that specification.</strong> Its {@code /logout} endpoint requires {@code logout_uri} (or
 * {@code redirect_uri}) and does not recognise {@code post_logout_redirect_uri} at all. Using the
 * Spring handler against Cognito would end the local session and then fail at the provider - the
 * Cognito session and the refresh token would survive, so "sign out" would be half a logout.
 *
 * <p>This handler is the same idea, built for Cognito's proprietary endpoint:
 *
 * <pre>
 *   https://&lt;prefix&gt;.auth.&lt;region&gt;.amazoncognito.com/logout?client_id=…&amp;logout_uri=…
 * </pre>
 *
 * <p>Two deliberate omissions:
 *
 * <ul>
 *   <li>No {@code id_token_hint} - Cognito's endpoint takes {@code client_id} and {@code logout_uri}
 *       only. (It is not a session-invalidation security control: {@code logout_uri} is validated
 *       against the app client's registered sign-out URLs, so it cannot be used as an open
 *       redirect.)</li>
 *   <li>No {@code post_logout_redirect_uri} - Cognito ignores it, and sending it would only make the
 *       failure harder to see.</li>
 * </ul>
 *
 * <p>The endpoint comes from the provider's OIDC discovery document ({@code end_session_endpoint}),
 * which Cognito does publish, so there is nothing to configure. If it is ever absent the handler
 * falls back to the configured frontend URL: the local session is still ended, the user still lands
 * on the SPA, and only the provider-side logout is skipped.
 */
public class CognitoLogoutSuccessHandler extends SimpleUrlLogoutSuccessHandler {

    /** Provider metadata key holding the end-session endpoint (from OIDC discovery). */
    static final String END_SESSION_ENDPOINT = "end_session_endpoint";

    private final ClientRegistrationRepository clientRegistrationRepository;
    private final String frontendUrl;

    public CognitoLogoutSuccessHandler(ClientRegistrationRepository clientRegistrationRepository, String frontendUrl) {
        this.clientRegistrationRepository = clientRegistrationRepository;
        this.frontendUrl = frontendUrl;
        // Used when there is no OIDC session to end: the user still has to land somewhere sensible.
        setDefaultTargetUrl(frontendUrl);
    }

    @Override
    protected String determineTargetUrl(
            HttpServletRequest request, HttpServletResponse response, Authentication authentication) {
        if (authentication instanceof OAuth2AuthenticationToken token) {
            ClientRegistration registration =
                    clientRegistrationRepository.findByRegistrationId(token.getAuthorizedClientRegistrationId());
            if (registration != null) {
                Optional<String> logoutUrl = cognitoLogoutUrl(registration, frontendUrl);
                if (logoutUrl.isPresent()) {
                    return logoutUrl.get();
                }
            }
        }
        return super.determineTargetUrl(request, response, authentication);
    }

    /**
     * Builds Cognito's logout URL, or an empty result when the provider does not advertise an
     * end-session endpoint.
     *
     * <p>Package-private and static so it can be tested without a servlet request.
     */
    static Optional<String> cognitoLogoutUrl(ClientRegistration registration, String logoutUri) {
        Object endpoint = registration.getProviderDetails().getConfigurationMetadata().get(END_SESSION_ENDPOINT);
        if (!(endpoint instanceof String endSessionEndpoint) || endSessionEndpoint.isBlank()) {
            return Optional.empty();
        }

        // `logout_uri` must exactly match one of the app client's registered sign-out URLs; the
        // frontend URL is registered there. Both query values are URL-safe as-is.
        String url = UriComponentsBuilder.fromUriString(endSessionEndpoint)
                .queryParam("client_id", registration.getClientId())
                .queryParam("logout_uri", logoutUri)
                .build()
                .toUriString();

        return Optional.of(url);
    }
}

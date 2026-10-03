package com.ecommerce.api.config;

import com.ecommerce.api.security.CognitoAuthoritiesMapper;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.security.authentication.AnonymousAuthenticationToken;
import org.springframework.security.authentication.InsufficientAuthenticationException;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configuration.EnableWebSecurity;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.oauth2.client.oidc.web.logout.OidcClientInitiatedLogoutSuccessHandler;
import org.springframework.security.oauth2.client.registration.ClientRegistrationRepository;
import org.springframework.security.oauth2.client.web.DefaultOAuth2AuthorizationRequestResolver;
import org.springframework.security.oauth2.client.web.OAuth2AuthorizationRequestCustomizers;
import org.springframework.security.oauth2.client.web.OAuth2AuthorizationRequestResolver;
import org.springframework.security.web.AuthenticationEntryPoint;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.access.AccessDeniedHandler;
import org.springframework.security.web.authentication.DelegatingAuthenticationEntryPoint;
import org.springframework.security.web.authentication.HttpStatusEntryPoint;
import org.springframework.security.web.authentication.LoginUrlAuthenticationEntryPoint;
import org.springframework.security.web.util.matcher.RequestMatcher;
import org.springframework.web.cors.CorsConfiguration;
import org.springframework.web.cors.CorsConfigurationSource;
import org.springframework.web.cors.UrlBasedCorsConfigurationSource;

/**
 * Web security for the Backend for Frontend.
 *
 * The browser holds only an {@code httpOnly} session cookie; the OAuth tokens stay on the server.
 * The authorization rules below are the single place the API's access policy is expressed, so a
 * later phase (orders, admin tooling) inherits the same deny-by-default posture instead of inventing
 * a second one:
 *
 * <ul>
 *   <li>{@code GET /api/**} and {@code /actuator/health} are public - reads are anonymous and the
 *       load balancer's health check cannot authenticate.</li>
 *   <li>Everything else under {@code /api/**} (the writes) requires the {@code admin} Cognito group,
 *       enforced server side by claim, never by hiding a button in the UI.</li>
 *   <li>Anything not matched is authenticated - deny by default, not allow by default.</li>
 * </ul>
 *
 * Two details exist only because the frontend is a browser client and the API is reached through a
 * load balancer:
 *
 * <ul>
 *   <li>An unauthenticated call to {@code /api/**} answers <strong>401</strong>, not a redirect to
 *       the hosted UI, so a JavaScript {@code fetch} gets a status it can act on. A call to any
 *       other protected path still redirects, which is how the manual browser login flow starts.</li>
 *   <li>CORS allows only the exact configured frontend origins, with credentials, so the session
 *       cookie is accepted. A wildcard origin with credentials is both invalid and dangerous.</li>
 * </ul>
 *
 * The session is deliberately <strong>in memory</strong> for this phase. That is why the service
 * must run as a single task (enforced by {@code application.desiredCount} validation in the CDK
 * config): a second task would hold a second, empty session store. Sessions move to Redis /
 * ElastiCache in Phase 6, and only then may auto scaling be enabled.
 */
@Configuration
@EnableWebSecurity
public class SecurityConfig {

    /** Path the OAuth2 authorization request starts from, for the registration named `cognito`. */
    private static final String AUTHORIZATION_REQUEST_BASE_URI = "/oauth2/authorization/cognito";

    private final ClientRegistrationRepository clientRegistrationRepository;
    private final List<String> allowedOrigins;
    private final String logoutUri;

    public SecurityConfig(
            ClientRegistrationRepository clientRegistrationRepository,
            @Value("${app.cors.allowed-origins}") List<String> allowedOrigins,
            @Value("${app.auth.logout-uri}") String logoutUri) {
        this.clientRegistrationRepository = clientRegistrationRepository;
        this.allowedOrigins = allowedOrigins;
        this.logoutUri = logoutUri;
    }

    @Bean
    public SecurityFilterChain securityFilterChain(
            HttpSecurity http,
            CognitoAuthoritiesMapper authoritiesMapper,
            OAuth2AuthorizationRequestResolver authorizationRequestResolver)
            throws Exception {
        AuthenticationEntryPoint entryPoint = authenticationEntryPoint();

        http.authorizeHttpRequests(authorize -> authorize
                        // The load balancer health check is anonymous by necessity.
                        .requestMatchers("/actuator/health")
                        .permitAll()
                        // Product reads stay public, exactly as they were before this phase.
                        .requestMatchers(HttpMethod.GET, "/api/**")
                        .permitAll()
                        // Everything else under /api is a write: admin only, by Cognito group claim.
                        .requestMatchers("/api/**")
                        .hasRole("admin")
                        .anyRequest()
                        .authenticated())
                .oauth2Login(oauth -> oauth
                        .authorizationEndpoint(endpoint -> endpoint.authorizationRequestResolver(authorizationRequestResolver))
                        // Turn the cognito:groups claim into authorities. This is the central
                        // enforce-by-claim mechanism a future write endpoint inherits.
                        .userInfoEndpoint(userInfo -> userInfo.userAuthoritiesMapper(authoritiesMapper)))
                // RP-initiated logout: end the session here, then end the Cognito session, so a
                // stolen cookie cannot be used after logout. Token revocation is enabled on the app
                // client, so the refresh token is invalidated too. Cognito then returns the browser
                // to the SPA (COGNITO_LOGOUT_URI), which is a registered logout URI - the API has no
                // logout landing of its own.
                .logout(logout -> logout.logoutSuccessHandler(oidcLogoutSuccessHandler()))
                // CSRF stays on, using Spring Security's single-page-application handling: the token
                // is delivered in a cookie the SPA reads and echoes back in a header.
                .csrf(csrf -> csrf.spa())
                .cors(Customizer.withDefaults())
                .exceptionHandling(exceptions -> exceptions
                        .authenticationEntryPoint(entryPoint)
                        // The CSRF filter reports through this handler too. An anonymous request that
                        // fails CSRF is really "you are not signed in", so it answers 401 through the
                        // same entry point; an authenticated one is genuinely forbidden (403).
                        .accessDeniedHandler(accessDeniedHandler(entryPoint)));
        return http.build();
    }

    /**
     * Adds PKCE (S256) to the authorization request.
     *
     * Spring Security only adds PKCE automatically for a **public** client (one that authenticates
     * with {@code none}); this app client is confidential, so it has to be requested explicitly. It
     * is required anyway by OAuth 2.0 Security BCP (RFC 9700) even for a confidential client: it
     * binds the authorization code to the client that started the flow, so a stolen code cannot be
     * redeemed by anyone else.
     */
    @Bean
    public OAuth2AuthorizationRequestResolver authorizationRequestResolver(ClientRegistrationRepository repository) {
        DefaultOAuth2AuthorizationRequestResolver resolver =
                new DefaultOAuth2AuthorizationRequestResolver(repository, "/oauth2/authorization");
        resolver.setAuthorizationRequestCustomizer(OAuth2AuthorizationRequestCustomizers.withPkce());
        return resolver;
    }

    /**
     * CORS for the separately built frontend. Origins are an exact allowlist from configuration and
     * credentials are allowed, so the browser will attach the session cookie.
     *
     * Cross-site cookies are increasingly blocked by browsers, so the frontend is expected to be
     * same-site with the API (or to use a development proxy); CORS only makes the same-origin-ish
     * case work for the preflight.
     */
    @Bean
    public CorsConfigurationSource corsConfigurationSource() {
        CorsConfiguration configuration = new CorsConfiguration();
        configuration.setAllowedOrigins(allowedOrigins);
        configuration.setAllowedMethods(List.of("GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"));
        configuration.setAllowedHeaders(List.of("*"));
        configuration.setAllowCredentials(true);
        configuration.setMaxAge(Duration.ofHours(1));

        UrlBasedCorsConfigurationSource source = new UrlBasedCorsConfigurationSource();
        source.registerCorsConfiguration("/**", configuration);
        return source;
    }

    /**
     * An unauthenticated request to {@code /api/**} gets a 401; anything else is redirected to the
     * hosted UI, which is how the browser login flow begins.
     */
    private AuthenticationEntryPoint authenticationEntryPoint() {
        LinkedHashMap<RequestMatcher, AuthenticationEntryPoint> entryPoints = new LinkedHashMap<>();
        entryPoints.put(apiRequestMatcher(), new HttpStatusEntryPoint(HttpStatus.UNAUTHORIZED));

        DelegatingAuthenticationEntryPoint entryPoint = new DelegatingAuthenticationEntryPoint(entryPoints);
        entryPoint.setDefaultEntryPoint(new LoginUrlAuthenticationEntryPoint(AUTHORIZATION_REQUEST_BASE_URI));
        return entryPoint;
    }

    /**
     * Returns 401 for an anonymous caller and 403 for an authenticated one. Used both for
     * authorization denials and for CSRF rejections, so an anonymous POST without a CSRF token is
     * reported as "authenticate first" rather than "forbidden".
     */
    private AccessDeniedHandler accessDeniedHandler(AuthenticationEntryPoint entryPoint) {
        return (request, response, accessDeniedException) -> {
            Authentication authentication = SecurityContextHolder.getContext().getAuthentication();
            if (authentication == null || authentication instanceof AnonymousAuthenticationToken) {
                entryPoint.commence(
                        request,
                        response,
                        new InsufficientAuthenticationException("Authentication required", accessDeniedException));
                return;
            }
            response.sendError(HttpStatus.FORBIDDEN.value());
        };
    }

    /** Matches the API surface. A lambda avoids depending on a specific path-matcher implementation. */
    private RequestMatcher apiRequestMatcher() {
        return request -> request.getRequestURI().startsWith("/api");
    }

    /**
     * Ends the Cognito session when the user logs out, then returns the browser to the configured
     * logout URI. Without this, "logout" would only clear the local session and the Cognito session
     * would live on.
     */
    private OidcClientInitiatedLogoutSuccessHandler oidcLogoutSuccessHandler() {
        OidcClientInitiatedLogoutSuccessHandler handler =
                new OidcClientInitiatedLogoutSuccessHandler(clientRegistrationRepository);
        handler.setPostLogoutRedirectUri(logoutUri);
        return handler;
    }
}

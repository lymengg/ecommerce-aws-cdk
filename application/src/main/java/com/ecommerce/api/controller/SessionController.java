package com.ecommerce.api.controller;

import java.util.List;
import java.util.Map;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.core.oidc.user.OidcUser;
import org.springframework.security.web.csrf.CsrfToken;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * The authenticated session endpoint of the Backend for Frontend.
 *
 * {@code GET /me} is the protected endpoint that starts the browser login flow: an anonymous call
 * is redirected to the Cognito hosted UI, and once the authorization code has been exchanged the
 * SPA can call it with the session cookie to read who it is and what authorities it holds. It is
 * the human-verifiable proof that the {@code cognito:groups} claim reached Spring Security.
 *
 * {@code GET /csrf} hands the SPA the CSRF token. The double-submit cookie Spring writes is scoped
 * to the API host, so a SPA served from another origin cannot read it; returning the token here
 * (behind the CORS allowlist) is the cross-origin equivalent of reading the cookie. The token is
 * not a secret in its own right - it only means anything together with the session cookie - and the
 * response is unreadable to any origin not on the allowlist.
 *
 * The value returned is the **raw** token, taken from the deferred token the CSRF filter placed on
 * the request. Spring's SPA CSRF handling exposes only the BREACH-masked form as a request
 * attribute; the double-submit header the SPA sends is compared against the raw value, so the raw
 * one is what has to be returned.
 *
 * There is deliberately no logout landing here: logout is a {@code POST} handled by Spring
 * Security's logout filter, and after Cognito ends its session it returns the browser to the SPA,
 * not to the API.
 */
@RestController
public class SessionController {

    @GetMapping("/me")
    public Map<String, Object> me(@AuthenticationPrincipal OidcUser user) {
        List<String> authorities = user.getAuthorities().stream()
                .map(GrantedAuthority::getAuthority)
                .sorted()
                .toList();

        return Map.of("name", user.getName(), "authorities", authorities);
    }

    /**
     * Hands the SPA the CSRF token, the header it belongs in, and the form field it belongs in.
     *
     * The token is the BREACH-masked one Spring exposes as a request attribute. The request handler
     * decodes it on the way back in - from the header on a write, from the form field on logout - so
     * one value serves both, and the SPA never has to know how the token is stored. It cannot read
     * the double-submit cookie anyway: that cookie is scoped to the API host, which the SPA cannot
     * see across origins. The response is unreadable to any origin outside the CORS allowlist.
     */
    @GetMapping("/csrf")
    public Map<String, String> csrf(CsrfToken token) {
        return Map.of(
                "headerName", token.getHeaderName(),
                "parameterName", token.getParameterName(),
                "token", token.getToken());
    }
}

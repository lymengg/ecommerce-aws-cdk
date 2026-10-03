package com.ecommerce.api.controller;

import java.util.List;
import java.util.Map;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.core.oidc.user.OidcUser;
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
}

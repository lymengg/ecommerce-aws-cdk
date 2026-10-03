package com.ecommerce.api.security;

import java.util.Collection;
import java.util.LinkedHashSet;
import java.util.Set;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.core.authority.mapping.GrantedAuthoritiesMapper;
import org.springframework.security.oauth2.core.oidc.user.OidcUserAuthority;
import org.springframework.stereotype.Component;

/**
 * Turns the Cognito {@code cognito:groups} claim into Spring Security authorities.
 *
 * This is the platform's single enforce-by-claim mechanism: Cognito is the source of truth for who
 * is in the {@code admin} group, the ID token carries the claim, and this mapper makes it an
 * authority the authorization rules can check ({@code hasRole("admin")}). Nothing is inferred from
 * the endpoint or hidden in the UI, so a rule added for a later write endpoint inherits the same
 * mechanism rather than inventing a second one.
 *
 * Cognito puts the claim in the ID token as a JSON array of group names. Each group becomes an
 * authority named {@code ROLE_<group>}, which is the {@code ROLE_} convention {@code hasRole}
 * expects.
 */
@Component
public class CognitoAuthoritiesMapper implements GrantedAuthoritiesMapper {

    /** Claim Cognito populates with the user's group membership. */
    static final String GROUPS_CLAIM = "cognito:groups";

    /** Prefix that makes a group name usable by {@code hasRole}/{@code hasAnyRole}. */
    static final String ROLE_PREFIX = "ROLE_";

    @Override
    public Collection<? extends GrantedAuthority> mapAuthorities(Collection<? extends GrantedAuthority> authorities) {
        // Keep whatever the OIDC user service already produced (OIDC_USER, scopes) and add to it.
        Set<GrantedAuthority> mapped = new LinkedHashSet<>(authorities);

        for (GrantedAuthority authority : authorities) {
            if (!(authority instanceof OidcUserAuthority oidcAuthority)) {
                continue;
            }
            Object groups = oidcAuthority.getAttributes().get(GROUPS_CLAIM);
            if (groups instanceof Collection<?> groupNames) {
                for (Object group : groupNames) {
                    mapped.add(new SimpleGrantedAuthority(ROLE_PREFIX + group));
                }
            }
        }

        return mapped;
    }
}

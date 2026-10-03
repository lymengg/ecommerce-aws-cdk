package com.ecommerce.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.csrf;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.options;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.redirectedUrl;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.ecommerce.api.repository.ProductRepository;
import com.ecommerce.api.support.TestAuthProperties;
import com.ecommerce.api.support.TestSecurityConfiguration;
import com.jayway.jsonpath.JsonPath;
import jakarta.servlet.http.Cookie;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.annotation.Import;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.mock.web.MockHttpSession;
import org.springframework.security.test.context.support.WithMockUser;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.postgresql.PostgreSQLContainer;

/**
 * The Phase 4 access-control contract, at the HTTP layer.
 *
 * These are the checks a reviewer would run against a deployed environment: reads are anonymous,
 * writes are refused without a session (401, not a redirect to the hosted UI), a signed-in user who
 * is not in the admin group is forbidden (403), and an admin is allowed (201). The role rules are
 * enforced by the security filter chain, not by the controller, so the same test would pass against
 * any endpoint added under the same rule.
 *
 * The full OIDC round trip cannot be exercised without a real Cognito, so the browser session is
 * simulated with {@code @WithMockUser} and the CSRF token with the Spring Security test
 * post-processor. The manual hosted-UI flow is documented in the README.
 */
@SpringBootTest
@AutoConfigureMockMvc
@Testcontainers
@Import(TestSecurityConfiguration.class)
class SecurityTest {

    @Container
    static final PostgreSQLContainer POSTGRES = new PostgreSQLContainer("postgres:16-alpine");

    @DynamicPropertySource
    static void properties(DynamicPropertyRegistry registry) {
        registry.add("spring.datasource.url", POSTGRES::getJdbcUrl);
        registry.add("spring.datasource.username", POSTGRES::getUsername);
        registry.add("spring.datasource.password", POSTGRES::getPassword);
        TestAuthProperties.register(registry);
    }

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private ProductRepository productRepository;

    @BeforeEach
    void emptyTheTable() {
        productRepository.deleteAll();
    }

    @Test
    void readsProductsWithoutAuthenticating() throws Exception {
        mockMvc.perform(get("/api/products"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.length()").value(0));
    }

    @Test
    void healthCheckStaysAnonymous() throws Exception {
        mockMvc.perform(get("/actuator/health"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("UP"));
    }

    @Test
    void exposesTheCsrfTokenForTheCrossOriginSpa() throws Exception {
        // The SPA is served from another origin and cannot read the XSRF-TOKEN cookie, so it fetches
        // the token here (anonymously, before signing in) and echoes it in the header on writes.
        mockMvc.perform(get("/csrf"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.headerName").isNotEmpty())
                .andExpect(jsonPath("$.token").isNotEmpty());
    }

    @Test
    @WithMockUser(roles = "admin")
    void acceptsTheTokenFromTheCsrfEndpointOnAWrite() throws Exception {
        // Proves the cross-origin flow end to end: the token comes from GET /csrf, exactly as the
        // SPA would use it, and the write is accepted. The session and the cookie are both carried
        // so the test does not care which store the server keeps the token in.
        MockHttpSession session = new MockHttpSession();
        MvcResult csrfResult = mockMvc.perform(get("/csrf").session(session))
                .andExpect(status().isOk())
                .andReturn();
        Cookie xsrfCookie = csrfResult.getResponse().getCookie("XSRF-TOKEN");
        String body = csrfResult.getResponse().getContentAsString();
        // The SPA reads both values from the response rather than assuming the names.
        String headerName = JsonPath.read(body, "$.headerName");
        String token = JsonPath.read(body, "$.token");

        MockHttpServletRequestBuilder request = post("/api/products")
                .session(session)
                .header(headerName, token)
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"name\":\"Laptop\",\"price\":1200.00}");
        if (xsrfCookie != null) {
            request = request.cookie(xsrfCookie);
        }

        mockMvc.perform(request).andExpect(status().isCreated());
    }

    @Test
    void refusesAnAnonymousWriteWithUnauthorizedNotARedirect() throws Exception {
        // No CSRF token and no session: the request is refused before it reaches the controller,
        // and because the caller is anonymous the answer is 401 rather than a login redirect.
        mockMvc.perform(post("/api/products")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"name\":\"Sneaky\",\"price\":10.00}"))
                .andExpect(status().isUnauthorized());

        assertThat(productRepository.count()).isZero();
    }

    @Test
    @WithMockUser(roles = "user")
    void forbidsAnAuthenticatedNonAdminWrite() throws Exception {
        mockMvc.perform(post("/api/products")
                        .with(csrf())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"name\":\"Sneaky\",\"price\":10.00}"))
                .andExpect(status().isForbidden());

        assertThat(productRepository.count()).isZero();
    }

    @Test
    @WithMockUser(roles = "admin")
    void allowsAnAdminWrite() throws Exception {
        mockMvc.perform(post("/api/products")
                        .with(csrf())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"name\":\"Laptop\",\"price\":1200.00,\"quantity\":5}"))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.name").value("Laptop"));

        assertThat(productRepository.count()).isEqualTo(1);
    }

    @Test
    void answers401ForAnAnonymousMeRatherThanRedirectingIntoTheLoginFlow() throws Exception {
        // /me is called by the SPA with fetch. A 302 into the hosted UI would be a cross-origin
        // error for the SPA and a dead end for any other client, so it answers 401 like /api/**.
        mockMvc.perform(get("/me"))
                .andExpect(status().isUnauthorized())
                .andExpect(header().doesNotExist("Location"));
    }

    @Test
    @WithMockUser
    void logoutLandsOnTheFrontendWhenThereIsNoOidcSessionToEnd() throws Exception {
        // Proves the custom logout handler is wired: the default Spring behaviour would redirect to
        // /login?logout, but a signed-out user has to end up back on the SPA.
        mockMvc.perform(post("/logout").with(csrf()))
                .andExpect(status().is3xxRedirection())
                .andExpect(redirectedUrl("http://localhost:5173"));
    }

    @Test
    void authorizationRequestUsesPkceAndState() throws Exception {
        String location = mockMvc.perform(get("/oauth2/authorization/cognito"))
                .andExpect(status().is3xxRedirection())
                .andReturn()
                .getResponse()
                .getRedirectedUrl();

        // PKCE S256 binds the authorization code to this client; state and nonce stay on.
        assertThat(location).startsWith("https://cognito-idp.example.com/oauth2/authorize");
        assertThat(location).contains("code_challenge=");
        assertThat(location).contains("code_challenge_method=S256");
        assertThat(location).contains("state=");
        assertThat(location).contains("nonce=");
    }

    @Test
    void redirectsAPageRequestToTheHostedUiWhenUnauthenticated() throws Exception {
        // A browser navigating to a protected page must be sent to Cognito to sign in; only the
        // storefront's fetch endpoints (/api/**, /me, /csrf) answer 401 instead.
        mockMvc.perform(get("/account"))
                .andExpect(status().is3xxRedirection())
                .andExpect(redirectedUrl("/oauth2/authorization/cognito"));
    }

    @Test
    void allowsTheConfiguredFrontendOriginWithCredentials() throws Exception {
        mockMvc.perform(options("/api/products")
                        .header(HttpHeaders.ORIGIN, "http://localhost:5173")
                        .header(HttpHeaders.ACCESS_CONTROL_REQUEST_METHOD, "POST"))
                .andExpect(status().isOk())
                .andExpect(header().string(HttpHeaders.ACCESS_CONTROL_ALLOW_ORIGIN, "http://localhost:5173"))
                .andExpect(header().string(HttpHeaders.ACCESS_CONTROL_ALLOW_CREDENTIALS, "true"));
    }

    @Test
    void refusesAnOriginThatIsNotOnTheAllowlist() throws Exception {
        mockMvc.perform(options("/api/products")
                        .header(HttpHeaders.ORIGIN, "https://evil.example.com")
                        .header(HttpHeaders.ACCESS_CONTROL_REQUEST_METHOD, "POST"))
                .andExpect(status().isForbidden());
    }
}

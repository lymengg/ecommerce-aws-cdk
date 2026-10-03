import { CfnOutput, Duration, Stack, StackProps } from 'aws-cdk-lib';
import { CfnUserPoolClient, OAuthScope, UserPool, UserPoolClient, UserPoolDomain } from 'aws-cdk-lib/aws-cognito';
import { ComparisonOperator, Metric, TreatMissingData } from 'aws-cdk-lib/aws-cloudwatch';
import { ISecret, Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

import { EnvironmentConfig } from '../config/types';
import { applyPlatformTags } from '../tags';

/**
 * Path Spring Security's OAuth2 client handles the authorization code callback on. The value is not
 * invented here: it is the default redirect path of the `spring-boot-starter-oauth2-client`
 * (`{baseUrl}/login/oauth2/code/{registrationId}`) with the registration named `cognito`.
 */
const CALLBACK_PATH = '/login/oauth2/code/cognito';

/** Port the API listens on when it is run locally, outside the container. */
const LOCAL_API_PORT = 8080;

/** Baseline alarm: sign-ins throttled by Cognito over a five minute window. */
const SIGN_IN_THROTTLE_THRESHOLD = 25;

export interface CognitoStackProps extends StackProps {
  /** Environment specific configuration. No environment value is hardcoded in this stack. */
  readonly config: EnvironmentConfig;
}

/**
 * Phase 4 authentication: a Cognito user pool and the confidential app client the Spring Boot BFF
 * authenticates as.
 *
 * ```
 *   browser ──session cookie──▶ Spring Boot BFF ──authorization code + PKCE──▶ Cognito
 *                                      │                                          │
 *                                      └──────────── ID/access tokens ─────────────┘
 *                                      (held server side, never sent to the browser)
 * ```
 *
 * The platform uses the Backend for Frontend pattern, so this stack deliberately exposes a
 * **confidential** client (`generateSecret: true`): the token endpoint is not open to anyone who can
 * read a client id out of a browser, and logout/revocation become real server-side operations. The
 * IETF browser-based apps BCP recommends this shape, and OAuth 2.0 Security BCP (RFC 9700) forbids
 * putting tokens where a script can reach them.
 *
 * Only the **authorization code + PKCE** flow is enabled. The implicit flow is rejected because it
 * exposes tokens in the URL fragment, the client credentials flow is rejected because there is no
 * machine-to-machine caller here, and the resource owner password credentials grant is rejected
 * because RFC 9700 deprecates it - which is why `ALLOW_USER_PASSWORD_AUTH` never appears and no
 * scriptable password login exists.
 *
 * There is deliberately **no identity pool**. An identity pool exchanges a user token for temporary
 * AWS credentials; nothing in this platform does that - the BFF talks to Cognito and to PostgreSQL,
 * never to an AWS API as the user - so creating one would only widen the blast radius.
 *
 * A **Cognito prefix domain** is used rather than a custom domain: a custom domain needs its own
 * certificate in `us-east-1` and a DNS record, which is branding rather than security and is
 * explicitly a non-goal this phase. The prefix is globally unique per region, so it embeds the
 * environment name; if it is ever taken, change it here.
 *
 * The user pool is **stateful** - it holds users - so it takes the environment's removal policy
 * (dev destroys it, uat and prod retain it). Deletion protection is deliberately not enabled, so the
 * pool can always be torn down with its stack.
 */
export class CognitoStack extends Stack {
  /** The user pool that holds the platform's users. */
  public readonly userPool: UserPool;

  /** The confidential app client the BFF authenticates as. */
  public readonly userPoolClient: UserPoolClient;

  /** The Cognito prefix domain hosting the managed login pages. */
  public readonly userPoolDomain: UserPoolDomain;

  /**
   * OIDC issuer URL of the user pool (`https://cognito-idp.<region>.amazonaws.com/<poolId>`), which
   * the BFF uses to discover the endpoints and to validate token signatures.
   */
  public readonly issuerUrl: string;

  /**
   * Secret holding the app client secret under the `clientSecret` key. The application stack grants
   * its ECS execution role read access and injects it into the container at start.
   */
  public readonly clientSecret: ISecret;

  constructor(scope: Construct, id: string, props: CognitoStackProps) {
    super(scope, id, props);

    const { config } = props;
    const { dns, auth } = config;
    const namePrefix = `ecommerce-${config.environment}`;

    if (dns === undefined) {
      // The app only creates this stack when the environment has a domain, and the validator refuses
      // an authentication-enabled environment without one. This guard turns a programming mistake
      // into a clear synth-time error rather than an app client with a nonsense callback URL.
      throw new Error(`CognitoStack requires config.dns to be set for environment "${config.environment}".`);
    }
    const apiDomainName = `${dns.apiSubdomain}.${dns.zoneName}`;

    this.userPool = new UserPool(this, 'UserPool', {
      userPoolName: `${namePrefix}-users`,
      selfSignUpEnabled: auth.selfSignUpEnabled,
      // The password policy is configuration, not a magic number: production asks for a long
      // password across all four character classes, dev asks for the shortest Cognito allows.
      passwordPolicy: {
        minLength: auth.passwordMinimumLength,
        requireUppercase: auth.requireUppercase,
        requireLowercase: auth.requireLowercase,
        requireDigits: auth.requireDigits,
        requireSymbols: auth.requireSymbols,
      },
      mfa: auth.mfa,
      // Time-based one-time passwords only. SMS MFA would need a verified phone number and an SNS
      // role, and TOTP is both stronger and free of those moving parts.
      mfaSecondFactor: { sms: false, otp: true },
      // The pool holds users, so it is stateful: the removal policy follows the environment (dev
      // destroys it, uat and prod retain it). Deletion protection is deliberately not set, so the
      // pool can always be torn down with its stack. The L2 UserPool supports a removal policy
      // directly, so no escape hatch is needed here.
      removalPolicy: config.removalPolicy,
    });

    this.userPoolDomain = new UserPoolDomain(this, 'Domain', {
      userPool: this.userPool,
      cognitoDomain: { domainPrefix: `${namePrefix}-users` },
    });

    this.userPoolClient = this.userPool.addClient('ApiClient', {
      userPoolClientName: `${namePrefix}-api-client`,
      // Confidential client. The secret is generated by Cognito, stored in Secrets Manager and
      // injected into the container by ECS; it never reaches the browser and never enters config.
      generateSecret: true,
      // Authorization code only. The BFF adds PKCE (S256) to the authorization request explicitly
      // (Spring only adds it automatically for a public client); every other flow is explicitly off
      // so a future edit cannot quietly re-enable one.
      oAuth: {
        flows: {
          authorizationCodeGrant: true,
          implicitCodeGrant: false,
          clientCredentials: false,
        },
        // Scope minimisation: the BFF needs the user's identity and email, nothing more.
        scopes: [OAuthScope.OPENID, OAuthScope.EMAIL, OAuthScope.PROFILE],
        // Exact redirect URIs, never wildcards: a wildcard callback would let an attacker redirect
        // the authorization code to a host they control. The localhost entry is the Spring Boot
        // app running on a developer machine, which is the only non-HTTPS origin Cognito allows.
        callbackUrls: [
          `https://${apiDomainName}${CALLBACK_PATH}`,
          `http://localhost:${LOCAL_API_PORT}${CALLBACK_PATH}`,
        ],
        // RP-initiated logout: after Cognito clears its session the browser returns to the SPA, not
        // the API. The registered set is the deployed frontend URL plus every origin the frontend
        // legitimately runs on (the CORS allowlist) - in dev and uat that adds the local Vite dev
        // server, so a developer can log out locally as well as from the deployed SPA. Exact URLs,
        // never wildcards.
        logoutUrls: [...new Set([auth.frontendUrl, ...auth.allowedOrigins])],
      },
      accessTokenValidity: auth.accessTokenValidity,
      idTokenValidity: auth.idTokenValidity,
      refreshTokenValidity: auth.refreshTokenValidity,
      // Refresh token rotation is not optional: a refresh token is single-use, and Cognito accepts
      // a short grace period so an in-flight request that raced the rotation is not rejected.
      refreshTokenRotationGracePeriod: Duration.seconds(60),
      // Revocation on logout is on by default; set explicitly so it cannot be turned off by accident.
      enableTokenRevocation: true,
    });

    // The explicit auth flows are pinned to the single one the platform uses. SRP is how the
    // managed login pages sign a user in.
    //
    // `ALLOW_REFRESH_TOKEN_AUTH` is deliberately **absent**, and Cognito enforces that: it rejects
    // the combination with an error - "ALLOW_REFRESH_TOKEN_AUTH is not a permitted ExplicitAuthFlow
    // when refresh token rotation is enabled". Refresh still works; with rotation on, the refresh
    // token is single-use and the refresh flow is implicit. (This is also why the L2 `authFlows`
    // property omits it when a rotation grace period is set.)
    //
    // `ALLOW_USER_PASSWORD_AUTH` is absent because RFC 9700 deprecates the resource owner password
    // credentials grant - no scriptable password login exists - as is
    // `ALLOW_ADMIN_USER_PASSWORD_AUTH`. `ALLOW_CUSTOM_AUTH` is absent because no Lambda triggers are
    // configured; Cognito's own default would otherwise enable it.
    const cfnClient = this.userPoolClient.node.defaultChild as CfnUserPoolClient;
    cfnClient.addPropertyOverride('ExplicitAuthFlows', ['ALLOW_USER_SRP_AUTH']);

    this.issuerUrl = this.userPool.userPoolProviderUrl;

    // The client secret, wrapped in a Secrets Manager secret so the ECS agent can inject it the
    // same way it injects the database credentials. `secretObjectValue` renders the generated value
    // into the secret at deploy time; the value never appears in the template or in source.
    this.clientSecret = new Secret(this, 'ClientSecret', {
      description: `Client secret of the ${namePrefix} Cognito app client`,
      secretObjectValue: { clientSecret: this.userPoolClient.userPoolClientSecret },
      removalPolicy: config.removalPolicy,
    });

    // Baseline observability: every new component ships with at least one alarm. Sign-ins throttled
    // by Cognito is the cheapest meaningful signal that the pool is being hammered (credential
    // stuffing) or misconfigured; Phase 7 is where the alarm fan-out and dashboards land.
    const signInThrottles = new Metric({
      namespace: 'AWS/Cognito',
      metricName: 'SignInThrottles',
      dimensionsMap: { UserPool: this.userPool.userPoolId },
      statistic: 'Sum',
      period: Duration.minutes(5),
    });
    signInThrottles.createAlarm(this, 'SignInThrottlesAlarm', {
      alarmDescription: `Sign-ins throttled by the ${namePrefix} user pool`,
      threshold: SIGN_IN_THROTTLE_THRESHOLD,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      // Cognito only publishes a data point when there is activity, so a quiet pool must not be
      // treated as an outage.
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });

    applyPlatformTags(this, config);
    this.createOutputs(config, namePrefix);
  }

  /**
   * Publishes the identifiers the application stack consumes by reference and an operator needs.
   * The client secret ARN is an identifier, not a credential: the value it points at is never
   * exported. Export names are environment specific so dev, uat and prod coexist in one account.
   */
  private createOutputs(config: EnvironmentConfig, namePrefix: string): void {
    const exportPrefix = `ecommerce-${config.environment}`;

    new CfnOutput(this, 'UserPoolId', {
      value: this.userPool.userPoolId,
      description: `Id of the ${namePrefix} Cognito user pool`,
      exportName: `${exportPrefix}-user-pool-id`,
    });

    new CfnOutput(this, 'UserPoolClientId', {
      value: this.userPoolClient.userPoolClientId,
      description: `Id of the ${namePrefix} Cognito app client`,
      exportName: `${exportPrefix}-user-pool-client-id`,
    });

    new CfnOutput(this, 'IssuerUrl', {
      value: this.issuerUrl,
      description: 'OIDC issuer URL of the user pool',
      exportName: `${exportPrefix}-cognito-issuer-url`,
    });

    new CfnOutput(this, 'ClientSecretArn', {
      value: this.clientSecret.secretArn,
      description: `ARN of the Secrets Manager secret holding the ${namePrefix} app client secret`,
      exportName: `${exportPrefix}-client-secret-arn`,
    });
  }
}

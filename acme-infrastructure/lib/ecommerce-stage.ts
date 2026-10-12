import { App, Stage, StageProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';

import { EnvironmentConfig, resolveImageTag } from './config';
import { ApplicationStack } from './stacks/application-stack';
import { AuthCertificateStack } from './stacks/auth-certificate-stack';
import { AuthDomainStack } from './stacks/auth-domain-stack';
import { CognitoStack } from './stacks/cognito-stack';
import { CostStack } from './stacks/cost-stack';
import { DatabaseStack } from './stacks/database-stack';
import { EcrStack, RegistryLocation } from './stacks/ecr-stack';
import { FrontendStack } from './stacks/frontend-stack';
import { EcommerceSecurityStack } from './stacks/security-stack';

/**
 * The one region Cognito custom domains can read a certificate from. A custom domain is fronted by
 * a Cognito-managed CloudFront distribution, and CloudFront - a global service - only reads ACM
 * certificates from `us-east-1`, wherever the user pool itself lives. This is a fixed AWS
 * constraint, not an environment decision, which is why it is a constant and not configuration.
 */
const COGNITO_CUSTOM_DOMAIN_CERTIFICATE_REGION = 'us-east-1';

/**
 * Merges the deploy-time image tag override (`-c imageTag=` / `IMAGE_TAG`) into the configuration,
 * so both images carry one release tag. In the pipeline the tag is the commit SHA; locally it falls
 * back to the configured default.
 */
function withResolvedImageTag(config: EnvironmentConfig, scope: Construct): EnvironmentConfig {
  const root = App.of(scope);
  return {
    ...config,
    application: { ...config.application, imageTag: resolveImageTag(config, root) },
    frontend: { ...config.frontend, imageTag: resolveImageTag(config, root, config.frontend.imageTag) },
  };
}

export interface SharedRegistryStageProps extends StageProps {
  /**
   * Where the shared registry lives: the tooling account. The stage's environment is derived from
   * this - the registry does not belong to any one deployment environment.
   */
  readonly registry: RegistryLocation;

  /**
   * Accounts allowed to pull from the registry - every environment's account. Forwarded to
   * {@link EcrStackProps.pullAccountIds}.
   */
  readonly pullAccountIds: string[];
}

/**
 * The shared container registry, in a stage of its own and deployed exactly once - not once per
 * environment. An image is a build artifact that outlives any environment it runs in, so one
 * repository pair serves dev, uat and prod, and a pipeline promotion moves the identical image
 * forward rather than rebuilding it per stage.
 *
 * Even stack-level references cannot cross a stage boundary (`addStackDependency` throws), so the
 * service stage imports the repositories by ARN built from {@link RegistryLocation} - names and
 * account ids are configuration, not deploy-time values. Ordering is the pipeline's job: this
 * stage is added before the first environment, so the repositories exist before the build runs.
 */
export class SharedRegistryStage extends Stage {
  public readonly registry: EcrStack;

  constructor(scope: Construct, id: string, props: SharedRegistryStageProps) {
    super(scope, id, {
      ...props,
      env: { account: props.registry.account, region: props.registry.region },
    });

    const env = { account: props.registry.account, region: props.registry.region };

    this.registry = new EcrStack(this, 'acme-ecr', {
      env,
      stackName: 'acme-ecr',
      pullAccountIds: props.pullAccountIds,
      description: 'Shared container registry for all services',
    });
  }
}

export interface EcommerceStageProps extends StageProps {
  /** Environment specific configuration. No environment value is hardcoded in this stage. */
  readonly config: EnvironmentConfig;

  /**
   * The shared registry this environment pulls its images from. Passed to the compute stacks as a
   * location rather than a construct, for the same boundary reason the stage comments describe.
   */
  readonly registry: RegistryLocation;
}

/**
 * The ecommerce service in one environment: database, authentication and both compute services.
 * These are the stacks the service team owns - `ecommerce-*` resources inside the shared
 * environment account.
 *
 * The service attaches to platform-owned foundations rather than building its own: the shared
 * VPC and the hosted zone and certificate are imported by `Fn.importValue` in
 * {@link EcommerceSecurityStack}, the one stack that touches the `acme-<env>-*` exports. The
 * service still OWNS its own security posture: its security groups are created in that stack, not
 * shared - sharing the tier groups would let any service in the environment reach this one's
 * database.
 */
export class EcommerceStage extends Stage {
  public readonly security: EcommerceSecurityStack;
  public readonly database: DatabaseStack;
  public readonly authCertificate: AuthCertificateStack;
  public readonly cognito: CognitoStack;
  public readonly application: ApplicationStack;
  public readonly frontend: FrontendStack;
  public readonly authDomain: AuthDomainStack;
  public readonly cost: CostStack;

  constructor(scope: Construct, id: string, props: EcommerceStageProps) {
    super(scope, id, props);

    const config = withResolvedImageTag(props.config, this);
    const { environment } = config;
    const env = { account: config.account, region: config.region };

    // Phase 4 onwards: authentication requires a `Secure` session cookie and therefore an HTTPS
    // origin, so an environment without a delegated domain cannot host the application at all.
    if (config.dns === undefined) {
      throw new Error(`Phase 4 authentication requires a delegated domain for environment "${environment}".`);
    }

    // The attachment point is created FIRST: it is the only stack that imports the platform's
    // `acme-<env>-*` exports, and it creates the service's own security groups in the shared VPC.
    // Every later stack consumes the imported vpc/zone/certificate and the service-owned security
    // groups as ordinary cross-stack references within the stage.
    this.security = new EcommerceSecurityStack(this, `ecommerce-security-${environment}`, {
      env,
      stackName: `ecommerce-security-${environment}`,
      config,
      description: `E-commerce service security groups and shared-foundation imports (${environment})`,
    });

    // Phase 4 authentication. The user pool and the confidential app client the BFF authenticates
    // as live ahead of the compute that consumes them, so the pool can be retained and its users
    // survive a redeployment of the application.
    //
    // The app client needs the API's fully qualified domain name for its exact callback URIs, so it
    // is derived from `config.dns` (never imported as a string). Deploy order is therefore
    // dns -> cognito -> application.
    this.cognito = new CognitoStack(this, `ecommerce-cognito-${environment}`, {
      env,
      stackName: `ecommerce-cognito-${environment}`,
      config,
      description: `E-commerce platform authentication (${environment})`,
    });

    // The database stack owns the RDS instance and the secret holding its credentials. It needs the
    // network (VPC and database security group) and nothing else, so it can be deployed
    // independently of the compute that consumes it.
    this.database = new DatabaseStack(this, `ecommerce-database-${environment}`, {
      env,
      stackName: `ecommerce-database-${environment}`,
      config,
      vpc: this.security.vpc,
      databaseSecurityGroup: this.security.securityGroups.database,
      description: `E-commerce platform PostgreSQL database (${environment})`,
    });

    // The certificate for the Cognito custom domain lives in `us-east-1`, the only region a
    // Cognito-managed CloudFront distribution can read it from. Deploy order: dns ->
    // auth-certificate -> auth-domain.
    this.authCertificate = new AuthCertificateStack(this, `ecommerce-auth-cert-${environment}`, {
      env: { account: config.account, region: COGNITO_CUSTOM_DOMAIN_CERTIFICATE_REGION },
      crossRegionReferences: true,
      stackName: `ecommerce-auth-cert-${environment}`,
      config,
      zone: this.security.zone,
      description: `E-commerce platform Cognito custom domain certificate (${environment})`,
    });

    // The app client needs the API's fully qualified domain name for its exact callback URIs, so it
    // is derived from `config.dns` (never imported as a string). Deploy order is therefore
    // dns -> cognito -> application.
    //
    // The SPA: where the browser lands after login and after logout, and a registered logout URI.
    const frontendUrl = config.auth.frontendUrl;

    // The application stack consumes the imported VPC and security groups, the registry, the
    // database stack's endpoint and credentials secret, the imported hosted zone and certificate,
    // and the Cognito stack's user pool, app client and client secret.
    this.application = new ApplicationStack(this, `ecommerce-application-${environment}`, {
      env,
      stackName: `ecommerce-application-${environment}`,
      config,
      vpc: this.security.vpc,
      registry: props.registry,
      albSecurityGroup: this.security.securityGroups.alb,
      applicationSecurityGroup: this.security.securityGroups.application,
      database: {
        host: this.database.instance.dbInstanceEndpointAddress,
        port: this.database.instance.dbInstanceEndpointPort,
        databaseName: config.database.databaseName,
        secret: this.database.credentialsSecret,
      },
      dns: {
        zone: this.security.zone,
        certificate: this.security.certificate,
        domainName: this.security.apiDomainName,
      },
      auth: {
        issuerUrl: this.cognito.issuerUrl,
        userPoolClientId: this.cognito.userPoolClient.userPoolClientId,
        clientSecret: this.cognito.clientSecret,
        frontendUrl,
      },
      description: `E-commerce platform application compute (${environment})`,
    });

    // The frontend consumes the ECS cluster, the HTTPS listener, the load balancer, the application
    // security group and the frontend repository, all by reference - so it is deployed after the
    // application and can be redeployed on its own.
    const httpsListener = this.application.api.httpsListener;
    if (httpsListener === undefined) {
      // config.dns is required, so the certificate and the HTTPS listener always exist.
      throw new Error(`The frontend requires the HTTPS listener for environment "${environment}".`);
    }

    this.frontend = new FrontendStack(this, `ecommerce-frontend-${environment}`, {
      env,
      stackName: `ecommerce-frontend-${environment}`,
      config,
      registry: props.registry,
      cluster: this.application.cluster,
      applicationSecurityGroup: this.security.securityGroups.application,
      loadBalancer: this.application.api.loadBalancer,
      albSecurityGroup: this.security.securityGroups.alb,
      httpsListener,
      zone: this.security.zone,
      description: `E-commerce platform frontend hosting (${environment})`,
    });

    // The Cognito custom domain (`auth.<zone>`) is a leaf stack deployed last on purpose. Cognito
    // verifies at domain creation that the parent domain resolves an A record, and the frontend
    // stack is what publishes the apex alias - so the domain cannot exist before the frontend.
    // Object references already force this stack after cognito (the pool) and auth-certificate
    // (the cert, via a cross-region reference); only the apex-record ordering is not expressible
    // as a value, hence the explicit dependency.
    this.authDomain = new AuthDomainStack(this, `ecommerce-auth-domain-${environment}`, {
      env,
      crossRegionReferences: true,
      stackName: `ecommerce-auth-domain-${environment}`,
      config,
      userPool: this.cognito.userPool,
      certificate: this.authCertificate.certificate,
      zone: this.security.zone,
      description: `E-commerce platform Cognito custom domain (${environment})`,
    });
    this.authDomain.addStackDependency(this.frontend);

    // Phase 9 guardrails. No dependencies on the rest of the service - the budget, anomaly monitor
    // and alert topic exist whether or not a workload is running, which is the point: cost
    // guardrails must outlive and predate the things they watch.
    this.cost = new CostStack(this, `ecommerce-cost-${environment}`, {
      env,
      stackName: `ecommerce-cost-${environment}`,
      config,
      description: `E-commerce platform cost guardrails (${environment})`,
    });
  }
}

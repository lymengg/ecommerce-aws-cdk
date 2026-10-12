import { App, Fn, Stage, StageProps } from 'aws-cdk-lib';
import { Certificate, ICertificate } from 'aws-cdk-lib/aws-certificatemanager';
import { ISecurityGroup, IVpc, SecurityGroup, Vpc } from 'aws-cdk-lib/aws-ec2';
import { HostedZone, IHostedZone } from 'aws-cdk-lib/aws-route53';
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
import { availabilityZoneTokens } from './stacks/network-stack';

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

/**
 * The platform exports a service stage imports, resolved through `Fn.importValue` at deploy time.
 * They are construct imports rather than construct references for the same boundary reason as the
 * registry: the platform foundation lives in {@link PlatformStage} (`acme-network-*`,
 * `acme-dns-*`), deployed by `bin/platform.ts`, and stack references cannot cross a stage
 * boundary. The exports are the contract - if the platform stage has not been deployed, the
 * service deploy fails on the missing export instead of drifting silently.
 */
interface ImportedFoundation {
  readonly vpc: IVpc;
  readonly albSecurityGroup: ISecurityGroup;
  readonly applicationSecurityGroup: ISecurityGroup;
  readonly databaseSecurityGroup: ISecurityGroup;
  readonly zone: IHostedZone;
  readonly certificate: ICertificate;
  readonly apiDomainName: string;
}

function importFoundation(scope: Construct, config: EnvironmentConfig): ImportedFoundation {
  const { environment, dns } = config;
  const exportPrefix = `acme-${environment}`;
  const importValue = (name: string) => Fn.importValue(`${exportPrefix}-${name}`);

  // The zone names are resolved exactly as the platform stack creates them: the first `maxAzs`
  // zones of the region. The subnet lists are exported comma-joined, so each id is selected by
  // index - the list must be `maxAzs` long at synth time or `fromVpcAttributes` cannot pair each
  // subnet with its zone. The count must match the platform's subnet count or the imported VPC's
  // subnet-to-AZ mapping is wrong.
  const subnetIds = (exportName: string) => {
    const joined = Fn.split(',', importValue(exportName));
    return Array.from({ length: config.maxAzs }, (_, index) => Fn.select(index, joined));
  };

  const vpc = Vpc.fromVpcAttributes(scope, 'SharedVpc', {
    vpcId: importValue('vpc-id'),
    availabilityZones: availabilityZoneTokens(config.maxAzs),
    publicSubnetIds: subnetIds('public-subnet-ids'),
    privateSubnetIds: subnetIds('private-subnet-ids'),
    isolatedSubnetIds: subnetIds('database-subnet-ids'),
  });

  const securityGroup = (id: string, exportName: string) =>
    SecurityGroup.fromSecurityGroupId(scope, id, importValue(exportName));

  return {
    vpc,
    albSecurityGroup: securityGroup('SharedAlbSg', 'alb-security-group-id'),
    applicationSecurityGroup: securityGroup('SharedApplicationSg', 'application-security-group-id'),
    databaseSecurityGroup: securityGroup('SharedDatabaseSg', 'database-security-group-id'),
    // zoneName comes from configuration, not an export: it is a known value (`ouklymeng.qzz.io`),
    // only the zone id is a deploy-time fact.
    zone: HostedZone.fromHostedZoneAttributes(scope, 'SharedZone', {
      hostedZoneId: importValue('hosted-zone-id'),
      zoneName: dns!.zoneName,
    }),
    certificate: Certificate.fromCertificateArn(scope, 'SharedCertificate', importValue('certificate-arn')),
    apiDomainName: `${dns!.apiSubdomain}.${dns!.zoneName}`,
  };
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
 * The service attaches to platform-owned foundations rather than building its own: the VPC and
 * tier security groups come from `acme-network-<env>`, the hosted zone and certificate from
 * `acme-dns-<env>` - both imported by `Fn.importValue` (see {@link importFoundation}). The service
 * still OWNS its own records and its own security posture: it writes `api.<zone>` and the apex
 * alias into the shared zone, and the tier security groups are the shared contract every service
 * in the environment attaches to.
 */
export class EcommerceStage extends Stage {
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

    // Phase 4 authentication is created FIRST: the user pool and the confidential app client the
    // BFF authenticates as need nothing from the platform foundation, and every later stack
    // consumes the pool.
    this.cognito = new CognitoStack(this, `ecommerce-cognito-${environment}`, {
      env,
      stackName: `ecommerce-cognito-${environment}`,
      config,
      description: `E-commerce platform authentication (${environment})`,
    });

    // Imported constructs must live in a stack scope (a Stage is not one). Cognito is the anchor
    // because it is the only service stack with no foundation inputs of its own: the imported VPC,
    // security groups, zone and certificate are created inside it and handed to the other stacks
    // as ordinary cross-stack references within the stage.
    const foundation = importFoundation(this.cognito, config);

    // The database stack owns the RDS instance and the secret holding its credentials. It needs the
    // network (VPC and database security group) and nothing else, so it can be deployed
    // independently of the compute that consumes it.
    this.database = new DatabaseStack(this, `ecommerce-database-${environment}`, {
      env,
      stackName: `ecommerce-database-${environment}`,
      config,
      vpc: foundation.vpc,
      databaseSecurityGroup: foundation.databaseSecurityGroup,
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
      zone: foundation.zone,
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
      vpc: foundation.vpc,
      registry: props.registry,
      albSecurityGroup: foundation.albSecurityGroup,
      applicationSecurityGroup: foundation.applicationSecurityGroup,
      database: {
        host: this.database.instance.dbInstanceEndpointAddress,
        port: this.database.instance.dbInstanceEndpointPort,
        databaseName: config.database.databaseName,
        secret: this.database.credentialsSecret,
      },
      dns: {
        zone: foundation.zone,
        certificate: foundation.certificate,
        domainName: foundation.apiDomainName,
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
      applicationSecurityGroup: foundation.applicationSecurityGroup,
      loadBalancer: this.application.api.loadBalancer,
      albSecurityGroup: foundation.albSecurityGroup,
      httpsListener,
      zone: foundation.zone,
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
      zone: foundation.zone,
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
